// services/dmQueue.js — Instagram DM queue with per-user rate limiting
//
// Instagram Graph API hard limits:
//   • 200 DMs per hour per account (Meta enforced)
//   • Minimum spacing between sends to avoid spam signals
//
// This queue:
//   1. Accepts jobs from webhook.js instead of sending DMs directly
//   2. Processes one job every 5 s per user (configurable delay per automation)
//   3. Enforces per-user hourly cap (default 100, max 200)
//   4. Blocks duplicate sends within a configurable window
//   5. Keeps running even when no web traffic (Render doesn't kill this)
//
// FIX #2:  Comment reply is sent AFTER DM succeeds (job carries commentId +
//          commentReplyText set by webhook.js).
// FIX #3:  Stats are updated via atomic $inc (findByIdAndUpdate) so concurrent
//          saves on different in-memory copies cannot overwrite each other.
// FIX #6:  sentGuard is backed by MongoDB (ProcessedDm collection) so it
//          survives server restarts / Render sleep-wake cycles.
// FIX #7:  Jobs carry autoId (string) not a live Mongoose doc. The queue
//          reloads the doc fresh when it needs to save stats.
// FIX #10: {{name}} placeholder is resolved from recipient's IG profile, not
//          silently erased.

const axios     = require('axios');
const mongoose  = require('mongoose');

const IG_API_VERSION = 'v21.0';

// ── Persistent dedup store ────────────────────────────────────────────────────
// FIX #6: Replace in-memory sentGuard Map with a MongoDB collection so the
// guard survives restarts.  Schema: { key: String, sentAt: Date (TTL index) }
const processedDmSchema = new mongoose.Schema({
  key:    { type: String, required: true, unique: true },
  sentAt: { type: Date, default: Date.now, expires: 7 * 24 * 3600 }, // TTL 7 days
});
// Guard against model re-registration during hot-reload
const ProcessedDm = mongoose.models.ProcessedDm ||
  mongoose.model('ProcessedDm', processedDmSchema);

// ── Per-user job queues ───────────────────────────────────────────────────────
// Map<userId_string, Job[]>
const queues = new Map();

// ── Per-user hourly rate tracker ──────────────────────────────────────────────
// Map<userId_string, { count: Number, windowStart: Number }>
const hourlyTracker = new Map();

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: enqueue(userId, job)
//  job = { token, igUserId, recipientId, text, autoId, commentId?,
//          commentReplyText?, triggerSource }
//  FIX #7: job carries autoId (string), NOT a live Mongoose doc.
// ─────────────────────────────────────────────────────────────────────────────
async function enqueue(userId, job) {
  const uid = userId.toString();

  // ── Duplicate guard (FIX #6: DB-backed) ──────────────────────────────────
  if (job.autoId) {
    // Load settings from DB to check skipDuplicate / duplicateWindowHours
    const Automation = require('../models/Automation');
    const autoSettings = await Automation.findById(job.autoId, 'settings').lean();
    const skipDup   = autoSettings?.settings?.skipDuplicate !== false; // default true
    const dupWindow = (autoSettings?.settings?.duplicateWindowHours ?? 24) * 3600 * 1000;

    if (skipDup) {
      const guardKey  = `${uid}::${job.autoId}::${job.recipientId}`;
      const cutoff    = new Date(Date.now() - dupWindow);

      // FIX #6b: Claim the guard atomically at enqueue time, not just after
      // send. The old code only wrote ProcessedDm AFTER the DM succeeded —
      // that left a race window: two comments from the same person within
      // the same ~5s queue tick would both pass findOne() (since neither had
      // sent yet), and both would get queued, causing two real DMs sent.
      // We now try to "reclaim" an expired guard atomically; if none exists
      // we create one, using the unique index to resolve any concurrent race.
      const reclaimed = await ProcessedDm.findOneAndUpdate(
        { key: guardKey, sentAt: { $lt: cutoff } },
        { sentAt: new Date() }
      );
      const recentlyClaimed = await ProcessedDm.findOne({ key: guardKey, sentAt: { $gte: cutoff } });

      if (!reclaimed && recentlyClaimed) {
        console.log(`[Queue] 🚫 Duplicate blocked → user ${uid}, recipient ${job.recipientId}`);
        return;
      }
      if (!reclaimed && !recentlyClaimed) {
        // No prior record at all — claim it now before queuing.
        try {
          await ProcessedDm.create({ key: guardKey, sentAt: new Date() });
        } catch (e) {
          if (e.code === 11000) {
            // Another concurrent request claimed it a moment earlier — block.
            console.log(`[Queue] 🚫 Duplicate blocked (race) → user ${uid}, recipient ${job.recipientId}`);
            return;
          }
          throw e;
        }
      }
    }
  }

  if (!queues.has(uid)) queues.set(uid, []);
  queues.get(uid).push(job);

  const qSize = queues.get(uid).length;
  console.log(`[Queue] ✅ Enqueued DM for user ${uid} → ${job.recipientId}. Queue depth: ${qSize}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL: rate-limit helpers
// ─────────────────────────────────────────────────────────────────────────────
function canSend(uid, maxPerHour) {
  const cap = Math.min(Math.max(maxPerHour || 100, 1), 200); // clamp 1–200
  const now  = Date.now();
  let t = hourlyTracker.get(uid);

  if (!t || now - t.windowStart > 3600 * 1000) {
    // Start fresh window
    t = { count: 0, windowStart: now };
    hourlyTracker.set(uid, t);
    return true;
  }
  return t.count < cap;
}

function recordSent(uid) {
  const t = hourlyTracker.get(uid);
  if (t) t.count++;
}

function getHourlyUsage(uid) {
  const t = hourlyTracker.get(uid);
  if (!t || Date.now() - t.windowStart > 3600 * 1000) return 0;
  return t.count;
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL: process one job
// ─────────────────────────────────────────────────────────────────────────────
async function processJob(uid, job) {
  const { token, igUserId, recipientId, text } = job;

  // FIX #7: Load fresh automation doc for settings; never use a shared reference
  const Automation = require('../models/Automation');
  const auto = job.autoId ? await Automation.findById(job.autoId) : null;

  const maxPerHour = auto?.settings?.maxDmsPerHour ?? 100;

  if (!canSend(uid, maxPerHour)) {
    // Put back at front — will retry next tick
    queues.get(uid).unshift(job);
    const usage = getHourlyUsage(uid);
    console.log(`[Queue] ⏳ Hourly limit (${usage}/${maxPerHour}) reached for user ${uid}. Retry next cycle.`);
    return;
  }

  try {
    await _sendDm(token, igUserId, recipientId, text, auto, job);
    recordSent(uid);

    // FIX #2: Post comment reply AFTER DM is confirmed sent.
    // webhook.js no longer fires the reply inline — it passes commentId +
    // commentReplyText on the job so we control the order here.
    if (job.commentId && job.commentReplyText) {
      // FIX #12: Warn if comment reply length may be rejected by Instagram
      if (job.commentReplyText.length > 2200) {
        console.warn(`[Queue] ⚠️ Comment reply text is ${job.commentReplyText.length} chars (limit ~2200). Instagram may reject it.`);
      }
      try {
        await axios.post(
          `https://graph.instagram.com/${IG_API_VERSION}/${job.commentId}/replies`,
          null,
          {
            params:  { message: job.commentReplyText, access_token: token },
            timeout: 8000,
          }
        );
        // FIX #3: Use atomic $inc to update repliesSent — no race condition
        if (job.autoId) {
          await Automation.findByIdAndUpdate(job.autoId, {
            $inc: { 'stats.repliesSent': 1 }
          });
        }
        console.log(`[Queue] 💬 Comment reply sent after DM → comment ${job.commentId}`);
      } catch (e) {
        console.error('[Queue] Comment reply after DM failed:', e.response?.data || e.message);
      }
    }

    // FIX #6: Persist duplicate guard to DB so it survives restarts
    if (job.autoId) {
      const guardKey = `${uid}::${job.autoId}::${recipientId}`;
      await ProcessedDm.findOneAndUpdate(
        { key: guardKey },
        { sentAt: new Date() },
        { upsert: true }
      );
    }

    // FIX #3: Update dmsSent via atomic $inc — no shared-doc race condition
    await _updateStats(job.autoId, true);
    await _incUserDmCount(uid);

    console.log(`[Queue] 📨 DM delivered → user ${uid}, recipient ${recipientId}`);
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    console.error(`[Queue] ❌ DM failed → user ${uid}, recipient ${recipientId}: ${errMsg}`);
    await _updateStats(job.autoId, false);

    // FIX #6b: We claimed the dedup guard optimistically in enqueue(). Since
    // the DM never actually sent, release the claim so a legitimate retry
    // (next comment, or manual resend) isn't blocked as a "duplicate" for
    // the rest of the dedupe window.
    if (job.autoId) {
      const guardKey = `${uid}::${job.autoId}::${recipientId}`;
      await ProcessedDm.deleteOne({ key: guardKey }).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: startProcessor()  — call once from server.js
// ─────────────────────────────────────────────────────────────────────────────
function startProcessor() {
  // Runs every 5 seconds. For each user queue, fires one job.
  // This keeps spacing ≥ 5 s between DMs per user even at full rate.
  setInterval(async () => {
    for (const [uid, queue] of queues.entries()) {
      if (!queue.length) continue;

      const job   = queue.shift();
      const delay = (job.dmDelay ?? 0) * 1000; // seconds → ms (set on job at enqueue if needed)

      if (delay > 0) {
        // Fire after delay but don't block the loop
        setTimeout(() => processJob(uid, job), delay);
      } else {
        await processJob(uid, job);
      }
    }
  }, 5000);

  console.log('✅  DM Queue processor started (5 s tick, max 200 DMs/hr per Instagram rules)');
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL: send DM via Instagram Graph API
//  FIX #10: Resolve {{name}} from recipient's IG profile instead of erasing it.
// ─────────────────────────────────────────────────────────────────────────────
async function _sendDm(token, igUserId, recipientId, text, auto, job) {
  // FIX #15: Comment-triggered DMs MUST use Instagram's "Private Reply" API,
  // which requires recipient: { comment_id }, NOT recipient: { id }.
  // Using { id: recipientId } for a comment-triggered send is what caused the
  // "Invalid message id" error — Instagram only allows a normal { id } DM when
  // the user has actually messaged you directly (a real messaging session).
  // A comment is not a messaging session, so it must go through the comment_id
  // path instead. Per Meta docs, Private Replies are also text-only — no
  // button/template attachments are supported — so we skip the link-card
  // attempt entirely for these and always send plain text with the link appended.
  const isCommentTriggered = !!job?.commentId &&
    (job.triggerSource === 'comment' || job.triggerSource === 'live_comment');

  const recipient = isCommentTriggered
    ? { comment_id: job.commentId }
    : { id: recipientId };

  // FIX #10: Attempt to resolve {{name}} from the IG profile
  let recipientName = '';
  if ((text || '').includes('{{name}}') || (text || '').includes('{{username}}')) {
    try {
      const profileRes = await axios.get(
        `https://graph.instagram.com/${recipientId}`,
        { params: { fields: 'username,name', access_token: token }, timeout: 5000 }
      );
      recipientName = profileRes.data.name || profileRes.data.username || '';
    } catch (_) {
      // Profile fetch failed — use empty string fallback (keeps existing behaviour)
      console.warn(`[Queue] Could not fetch profile for ${recipientId} — {{name}} will be blank`);
    }
  }

  const resolved = (text || '')
    .replace(/\{\{name\}\}/g, recipientName)
    .replace(/\{\{username\}\}/g, recipientName)
    .replace(/\{\{post\}\}/g, '');

  const linkUrl   = auto?.actions?.dm?.linkUrl   || '';
  const linkTitle = auto?.actions?.dm?.linkTitle  || '';

  // Try link-card (generic template) first — but ONLY for normal DM-session
  // sends. Private Replies (comment-triggered) don't support template
  // attachments, so we go straight to plain text for those.
  if (!isCommentTriggered && linkUrl && linkUrl.startsWith('http')) {
    try {
      await axios.post(
        `https://graph.instagram.com/${IG_API_VERSION}/${igUserId}/messages`,
        {
          recipient,
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'generic',
                elements: [{
                  title:    linkTitle || 'Check this out',
                  subtitle: resolved,
                  buttons:  [{ type: 'web_url', url: linkUrl, title: linkTitle || 'Open Link' }],
                }],
              },
            },
          },
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return; // success
    } catch (e) {
      console.warn('[Queue] Template DM failed, falling back to text+link');
    }
  }

  // Plain text (with link appended if present)
  const fullText = linkUrl
    ? `${resolved}\n\n${linkTitle ? linkTitle + ': ' : ''}${linkUrl}`
    : resolved;

  await axios.post(
    `https://graph.instagram.com/${IG_API_VERSION}/${igUserId}/messages`,
    {
      recipient,
      message: { text: fullText.substring(0, 1000) },
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL: update automation stats via atomic $inc
//  FIX #3: No longer mutates a shared in-memory doc — uses findByIdAndUpdate
//          so concurrent saves cannot overwrite each other.
// ─────────────────────────────────────────────────────────────────────────────
async function _updateStats(autoId, success) {
  if (!autoId) return;
  try {
    const Automation = require('../models/Automation');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (success) {
      // Atomic increment on dmsSent + today's dailyLog entry
      const result = await Automation.findOneAndUpdate(
        { _id: autoId, 'stats.dailyLog.date': today },
        { $inc: { 'stats.dmsSent': 1, 'stats.dailyLog.$.dmsSent': 1 } }
      );
      // If today's dailyLog entry didn't exist yet, push a new one
      if (!result) {
        await Automation.findByIdAndUpdate(autoId, {
          $inc:  { 'stats.dmsSent': 1 },
          $push: { 'stats.dailyLog': { date: today, dmsSent: 1 } },
        });
      }
    } else {
      await Automation.findByIdAndUpdate(autoId, {
        $inc: { 'stats.failed': 1 }
      });
    }
  } catch (e) {
    console.error('[Queue] Stats update error:', e.message);
  }
}

async function _incUserDmCount(uid) {
  try {
    const User = require('../models/User');
    await User.findByIdAndUpdate(uid, { $inc: { dmsSentMonth: 1 } });
  } catch (e) { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: getStatus() — for health/debug endpoint
// ─────────────────────────────────────────────────────────────────────────────
function getStatus() {
  const status = {};
  for (const [uid, q] of queues.entries()) {
    status[uid] = {
      queued:      q.length,
      sentThisHour: getHourlyUsage(uid),
    };
  }
  return status;
}

module.exports = { enqueue, startProcessor, getStatus };
