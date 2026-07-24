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

  // ── Duplicate guard ───────────────────────────────────────────────────────
  // Per user request: always resend DM+reply, even if the same person
  // commented before (no 24h "already messaged them" blocking anymore).
  //
  // We still guard against the narrow race where the SAME comment event
  // gets enqueued twice within the same instant (e.g. Meta redelivering a
  // webhook a few ms apart before either job has been processed) — that's
  // not "they commented again," it's the same event landing twice, and
  // sending two DMs for one comment would still look broken to the user.
  // Window is intentionally tiny (10s) so real repeat comments — even
  // seconds apart — always go through.
  if (job.autoId) {
    const guardKey = `${uid}::${job.autoId}::${job.recipientId}::${job.commentId || 'nocomment'}`;
    const cutoff   = new Date(Date.now() - 10 * 1000);

    const reclaimed = await ProcessedDm.findOneAndUpdate(
      { key: guardKey, sentAt: { $lt: cutoff } },
      { sentAt: new Date() }
    );
    const recentlyClaimed = await ProcessedDm.findOne({ key: guardKey, sentAt: { $gte: cutoff } });

    if (!reclaimed && recentlyClaimed) {
      console.log(`[Queue] 🚫 Same event re-fired within 10s, blocked → user ${uid}, recipient ${job.recipientId}`);
      return;
    }
    if (!reclaimed && !recentlyClaimed) {
      try {
        await ProcessedDm.create({ key: guardKey, sentAt: new Date() });
      } catch (e) {
        if (e.code === 11000) {
          console.log(`[Queue] 🚫 Same event re-fired (race), blocked → user ${uid}, recipient ${job.recipientId}`);
          return;
        }
        throw e;
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

  // FIX #19: A job sits in the in-memory `queues` Map for up to one 5s tick
  // (longer if dmDelay is set, or if the hourly cap pushes it back to the
  // front for a later retry) between when it was enqueued and when it
  // actually runs. If the user deletes the automation — or just deactivates
  // it — during that window, the DB record is gone/inactive, but the job
  // object itself already has everything it needs (text, recipientId,
  // token) captured at enqueue time, so without this check it would send
  // the DM anyway: a deleted automation going right on sending messages.
  // We treat "had an autoId but it no longer resolves to a live, active
  // automation" as a hard stop — drop the job silently, do not retry it.
  if (job.autoId && !auto) {
    console.log(`[Queue] 🗑️ Dropping job — automation ${job.autoId} no longer exists (deleted). Recipient: ${recipientId}`);
    return;
  }
  if (job.autoId && auto && !auto.active) {
    console.log(`[Queue] ⏸️ Dropping job — automation ${job.autoId} is no longer active. Recipient: ${recipientId}`);
    return;
  }

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

    // FIX #3: Update dmsSent via atomic $inc — no shared-doc race condition
    await _updateStats(job.autoId, true);
    await _incUserDmCount(uid);

    console.log(`[Queue] 📨 DM delivered → user ${uid}, recipient ${recipientId}`);
  } catch (err) {
    const igErr = err.response?.data?.error;
    const errMsg = igErr?.message || err.message;
    console.error(`[Queue] ❌ DM failed → user ${uid}, recipient ${recipientId}: ${errMsg}` +
      (igErr ? ` (code: ${igErr.code}, subcode: ${igErr.error_subcode})` : ''));
    await _updateStats(job.autoId, false);

    // Release the short-window race guard claimed in enqueue() so a
    // legitimate retry isn't blocked by the 10s same-event window.
    if (job.autoId) {
      const guardKey = `${uid}::${job.autoId}::${recipientId}::${job.commentId || 'nocomment'}`;
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
  // A comment is not an open messaging session, so the regular { id } shape
  // gets rejected with "Invalid message id".
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
      console.warn(`[Queue] Could not fetch profile for ${recipientId} — {{name}} will be blank`);
    }
  }

  const resolved = (text || '')
    .replace(/\{\{name\}\}/g, recipientName)
    .replace(/\{\{username\}\}/g, recipientName)
    .replace(/\{\{post\}\}/g, '');

  const linkUrl   = auto?.actions?.dm?.linkUrl   || '';
  const linkTitle = (auto?.actions?.dm?.linkTitle || 'Open Link').substring(0, 20); // Button title has no hard documented cap, but keep it short/clean

  // FIX #18: Use Instagram's Button Template (template_type: 'button'), NOT
  // the generic card template, and NOT plain text with a raw URL appended.
  // Per Meta's docs, a button template message contains a `text` prompt and
  // up to 3 buttons — exactly the clean "message + tappable button" look,
  // with no auto-generated link-preview card. This IS supported on Private
  // Replies (comment-triggered DMs) — confirmed via Meta's own docs and
  // real working examples; the earlier assumption that Private Replies were
  // text-only was incorrect. Using a button instead of a raw link in the
  // text is also the recommended pattern to avoid Meta's spam-pattern
  // detection on repeated identical first messages containing links.
  if (linkUrl && linkUrl.startsWith('http')) {
    try {
      await axios.post(
        `https://graph.instagram.com/${IG_API_VERSION}/${igUserId}/messages`,
        {
          recipient,
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'button',
                text:    resolved.substring(0, 640), // Button template text limit
                buttons: [{ type: 'web_url', url: linkUrl, title: linkTitle }],
              },
            },
          },
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return; // success
    } catch (e) {
      console.warn('[Queue] Button template DM failed, falling back to plain text:', e.response?.data?.error?.message || e.message);
      // Fall through to plain text below — better to deliver SOMETHING than
      // nothing if the button template is rejected for any reason.
    }
  }

  // Plain text (with link appended only as a last-resort fallback)
  const fullText = linkUrl
    ? `${resolved}\n\n${linkTitle}: ${linkUrl}`
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
