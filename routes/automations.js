// routes/automations.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX #16: Accepts and validates the new media[] array (multi-post/reel
// targeting) instead of a single mediaId string. Validates applyAll/media
// don't silently conflict, validates URL fields, and whitelists every field
// explicitly so a malformed or malicious payload can never write arbitrary
// keys (e.g. stats, userId) into an automation document via PATCH.
// ─────────────────────────────────────────────────────────────────────────────

const express     = require('express');
const router       = express.Router();
const mongoose     = require('mongoose');
const requireAuth  = require('../middleware/auth');
const Automation   = require('../models/Automation');

// ── Validation helpers ───────────────────────────────────────────────────────

function isValidObjectId(id) {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

// FIX #16: Normalizes whatever the frontend sends for media targeting into
// the new media[] shape. Accepts:
//   - the new shape directly:  media: [{ mediaId, mediaType, mediaUrl, caption }]
//   - a bare array of IDs:     media: ["123", "456"]   (legacy/simple payload)
//   - the old single field:    mediaId: "123"          (legacy single-select)
// Anything else is rejected with a clear validation error instead of being
// silently cast (which is what caused FIX #16's original bug).
function normalizeMediaInput(body) {
  const errors = [];
  let media = [];

  if (body.media !== undefined) {
    if (!Array.isArray(body.media)) {
      errors.push('media must be an array.');
      return { media, errors };
    }
    for (const item of body.media) {
      if (typeof item === 'string') {
        if (!item.trim()) { errors.push('media[] contains an empty mediaId.'); continue; }
        media.push({ mediaId: item.trim(), mediaType: '', mediaUrl: '', caption: '' });
      } else if (item && typeof item === 'object') {
        if (!item.mediaId || typeof item.mediaId !== 'string' || !item.mediaId.trim()) {
          errors.push('Each media[] object requires a non-empty mediaId.');
          continue;
        }
        media.push({
          mediaId:   item.mediaId.trim(),
          mediaType: ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM', 'REEL'].includes(item.mediaType) ? item.mediaType : '',
          mediaUrl:  typeof item.mediaUrl === 'string' ? item.mediaUrl : '',
          caption:   typeof item.caption  === 'string' ? item.caption.substring(0, 80) : '',
        });
      } else {
        errors.push('media[] entries must be strings or objects with mediaId.');
      }
    }
    // De-duplicate by mediaId — selecting the same post twice in the UI
    // should not create duplicate targets.
    const seen = new Set();
    media = media.filter(m => {
      if (seen.has(m.mediaId)) return false;
      seen.add(m.mediaId);
      return true;
    });
  } else if (typeof body.mediaId === 'string' && body.mediaId.trim()) {
    // Legacy single-select payload — still supported.
    media = [{
      mediaId:   body.mediaId.trim(),
      mediaType: typeof body.mediaType === 'string' ? body.mediaType : '',
      mediaUrl:  typeof body.mediaUrl  === 'string' ? body.mediaUrl  : '',
      caption:   '',
    }];
  }

  if (media.length > 50) {
    errors.push('An automation can target at most 50 posts/reels.');
  }

  return { media, errors };
}

function validateLinkUrl(url) {
  if (!url) return true;
  return /^https?:\/\/.+/i.test(url);
}

// FIX #16: Explicit whitelist for the fields a client is allowed to set.
// Anything not listed here (stats, userId, createdAt, _id, etc.) is dropped
// even if present in the request body — prevents privilege/field injection.
const WRITABLE_FIELDS = [
  'name', 'type', 'active', 'trigger', 'actions',
  'mediaType', 'mediaUrl', // legacy passthroughs, kept for old clients
  'keyword', 'keywords', 'commentReply', 'dmEnabled', 'dmText', 'firstDm',
  'thankyouDm', 'discountCode', 'linkEnabled', 'settings',
];

function pickWritableFields(body) {
  const out = {};
  for (const key of WRITABLE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

// FIX #16: Validates the combined applyAll / media state and any link URLs
// before we touch the database, returning a list of human-readable problems.
function validatePayload(body, media) {
  const errors = [];

  if (body.applyAll !== undefined && typeof body.applyAll !== 'boolean') {
    errors.push('applyAll must be a boolean.');
  }
  if (body.applyAll === true && media.length > 0) {
    // Not a hard error — just means "apply to all" wins — but worth flagging
    // back to the client so the builder UI can correct its own state.
    errors.push('applyAll=true was set together with specific media[] — applyAll will take priority and media[] will be ignored.');
  }

  const linkUrl = body.actions?.dm?.linkUrl;
  if (linkUrl && !validateLinkUrl(linkUrl)) {
    errors.push('actions.dm.linkUrl must be a valid http(s) URL.');
  }
  const flowButtons = body.actions?.flow?.buttons;
  if (Array.isArray(flowButtons)) {
    flowButtons.forEach((b, i) => {
      if (b?.type === 'link' && b?.linkUrl && !validateLinkUrl(b.linkUrl)) {
        errors.push(`actions.flow.buttons[${i}].linkUrl must be a valid http(s) URL.`);
      }
    });
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automations — list, with pagination + optional filters
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page, 10)  || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const filter = { userId: req.user._id };

    if (req.query.active === 'true')  filter.active = true;
    if (req.query.active === 'false') filter.active = false;
    if (req.query.type) filter.type = req.query.type;

    const [automations, total] = await Promise.all([
      Automation.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Automation.countDocuments(filter),
    ]);

    // FIX #17: Reverted to returning a bare array — the frontend dashboard
    // (and possibly other pages) call API.getAutomations() expecting a plain
    // array (automations.map(...), automations.length, etc.). Wrapping the
    // response in { automations, pagination } broke that contract and caused
    // "No automations yet" / dashed-out stat cards even when automations
    // existed and were actively sending DMs. Pagination metadata is still
    // available, just via response headers instead of changing the body
    // shape, so nothing that currently works can break.
    res.set('X-Total-Count', String(total));
    res.set('X-Page', String(page));
    res.set('X-Pages', String(Math.ceil(total / limit)));
    res.json(automations);
  } catch (err) {
    console.error('[Automations] List error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automations/:id — single automation
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid automation id.' });
    }
    const automation = await Automation.findOne({ _id: req.params.id, userId: req.user._id });
    if (!automation) return res.status(404).json({ error: 'Automation not found.' });
    res.json(automation);
  } catch (err) {
    console.error('[Automations] Get error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/automations — create
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { media, errors: mediaErrors } = normalizeMediaInput(req.body);
    const payloadErrors = validatePayload(req.body, media);
    const errors = [...mediaErrors, ...payloadErrors.filter(e => !e.includes('will take priority'))];

    if (errors.length) {
      return res.status(400).json({ error: 'Validation failed.', details: errors });
    }

    const applyAll = !!req.body.applyAll;
    const fields = pickWritableFields(req.body);

    const automation = await Automation.create({
      ...fields,
      applyAll,
      media: applyAll ? [] : media, // FIX #16: applyAll wins; don't store stale media targets alongside it
      mediaId: media[0]?.mediaId || '', // keep legacy field in sync for any old code paths
      userId: req.user._id,
    });

    res.status(201).json(automation);
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Validation failed.', details: Object.values(err.errors).map(e => e.message) });
    }
    console.error('[Automations] Create error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/automations/:id — update
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid automation id.' });
    }

    const fields = pickWritableFields(req.body);

    // Only touch media targeting if the client actually sent something
    // related to it — avoids accidentally wiping media[] on unrelated PATCH
    // calls (e.g. just toggling a setting) that don't include media fields.
    const touchesMedia = req.body.media !== undefined || req.body.mediaId !== undefined || req.body.applyAll !== undefined;

    if (touchesMedia) {
      const { media, errors: mediaErrors } = normalizeMediaInput(req.body);
      const payloadErrors = validatePayload(req.body, media);
      const errors = [...mediaErrors, ...payloadErrors.filter(e => !e.includes('will take priority'))];
      if (errors.length) {
        return res.status(400).json({ error: 'Validation failed.', details: errors });
      }

      const existing = await Automation.findOne({ _id: req.params.id, userId: req.user._id }, 'applyAll media');
      if (!existing) return res.status(404).json({ error: 'Automation not found.' });

      const applyAll = req.body.applyAll !== undefined ? !!req.body.applyAll : existing.applyAll;
      fields.applyAll = applyAll;
      fields.media     = applyAll ? [] : (req.body.media !== undefined || req.body.mediaId !== undefined ? media : existing.media);
      fields.mediaId   = fields.media[0]?.mediaId || '';
    } else {
      // Validate non-media fields (e.g. link URLs) even when media isn't touched
      const payloadErrors = validatePayload(req.body, []).filter(e => !e.includes('will take priority'));
      if (payloadErrors.length) {
        return res.status(400).json({ error: 'Validation failed.', details: payloadErrors });
      }
    }

    Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

    const automation = await Automation.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      fields,
      { new: true, runValidators: true }
    );
    if (!automation) return res.status(404).json({ error: 'Automation not found.' });
    res.json(automation);
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Validation failed.', details: Object.values(err.errors).map(e => e.message) });
    }
    console.error('[Automations] Update error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/automations/:id/toggle
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/toggle', requireAuth, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid automation id.' });
    }
    const automation = await Automation.findOne({ _id: req.params.id, userId: req.user._id });
    if (!automation) return res.status(404).json({ error: 'Automation not found.' });

    // FIX #16: Warn (don't block) if the user is activating an automation
    // that will never trigger — better surfaced here than discovered via
    // silent non-delivery days later.
    if (!automation.active && !automation.applyAll && (!automation.media || automation.media.length === 0) && !automation.mediaId) {
      console.warn(`[Automations] ⚠️ Activating automation ${automation._id} with no targeted media — it will never trigger.`);
    }

    automation.active = !automation.active;
    await automation.save();
    res.json(automation);
  } catch (err) {
    console.error('[Automations] Toggle error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/automations/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid automation id.' });
    }
    const automation = await Automation.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!automation) return res.status(404).json({ error: 'Automation not found.' });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    console.error('[Automations] Delete error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automations/:id/stats — live stats for the builder page
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/stats', requireAuth, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid automation id.' });
    }
    const automation = await Automation.findOne(
      { _id: req.params.id, userId: req.user._id },
      'stats active applyAll media mediaId'
    );
    if (!automation) return res.status(404).json({ error: 'Automation not found.' });
    const s = automation.stats || {};
    res.json({
      triggered:       s.triggered       || 0,
      dmsSent:         s.dmsSent         || 0,
      repliesSent:     s.repliesSent     || 0,
      dmsFailed:       s.failed          || 0,
      lastTriggeredAt: s.lastTriggeredAt || null,
      recentLog:       (s.recentLog || []).slice(0, 20),
      active:          automation.active,
      // FIX #16: Surface targeting state directly so the builder UI can show
      // a clear warning banner ("This automation has no posts selected") instead
      // of the user only finding out via zero triggers days later.
      targeting: {
        applyAll:      automation.applyAll,
        mediaCount:    automation.applyAll ? null : (automation.media?.length || (automation.mediaId ? 1 : 0)),
        hasNoTargets:  !automation.applyAll && (!automation.media || automation.media.length === 0) && !automation.mediaId,
      },
    });
  } catch (err) {
    console.error('[Automations] Stats error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
