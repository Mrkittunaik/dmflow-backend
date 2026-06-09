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

const axios = require('axios');

const IG_API_VERSION = 'v21.0';

// ── Per-user job queues ───────────────────────────────────────────────────────
// Map<userId_string, Job[]>
const queues = new Map();

// ── Per-user hourly rate tracker ──────────────────────────────────────────────
// Map<userId_string, { count: Number, windowStart: Number }>
const hourlyTracker = new Map();

// ── Duplicate send guard ──────────────────────────────────────────────────────
// Map<`${userId}::${autoId}::${recipientId}`, timestamp_ms>
const sentGuard = new Map();
// Clean sentGuard every hour so it doesn't grow unbounded
setInterval(() => {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000; // keep 7 days max
  for (const [k, ts] of sentGuard.entries()) {
    if (ts < cutoff) sentGuard.delete(k);
  }
}, 3600 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC: enqueue(userId, job)
//  job = { token, igUserId, recipientId, text, auto, triggerSource }
// ─────────────────────────────────────────────────────────────────────────────
function enqueue(userId, job) {
  const uid = userId.toString();

  // ── Duplicate guard ───────────────────────────────────────────────────────
  const skipDup   = job.auto?.settings?.skipDuplicate !== false; // default true
  const dupWindow = (job.auto?.settings?.duplicateWindowHours ?? 24) * 3600 * 1000;
  if (skipDup && job.auto?._id) {
    const guardKey = `${uid}::${job.auto._id}::${job.recipientId}`;
    const lastSent = sentGuard.get(guardKey);
    if (lastSent && Date.now() - lastSent < dupWindow) {
      console.log(`[Queue] 🚫 Duplicate blocked → user ${uid}, recipient ${job.recipientId}`);
      return;
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
  const { token, igUserId, recipientId, text, auto } = job;
  const maxPerHour = auto?.settings?.maxDmsPerHour ?? 100;

  if (!canSend(uid, maxPerHour)) {
    // Put back at front — will retry next tick
    queues.get(uid).unshift(job);
    const usage = getHourlyUsage(uid);
    console.log(`[Queue] ⏳ Hourly limit (${usage}/${maxPerHour}) reached for user ${uid}. Retry next cycle.`);
    return;
  }

  try {
    await _sendDm(token, igUserId, recipientId, text, auto);
    recordSent(uid);

    // Mark duplicate guard
    if (auto?.settings?.skipDuplicate !== false && auto?._id) {
      const guardKey = `${uid}::${auto._id}::${recipientId}`;
      sentGuard.set(guardKey, Date.now());
    }

    // Update automation stats
    await _updateStats(auto, true);
    await _incUserDmCount(uid);

    console.log(`[Queue] 📨 DM delivered → user ${uid}, recipient ${recipientId}`);
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    console.error(`[Queue] ❌ DM failed → user ${uid}, recipient ${recipientId}: ${errMsg}`);
    await _updateStats(auto, false);
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
      const delay = (job.auto?.settings?.dmDelay ?? 0) * 1000; // seconds → ms

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
// ─────────────────────────────────────────────────────────────────────────────
async function _sendDm(token, igUserId, recipientId, text, auto) {
  const resolved = (text || '')
    .replace(/\{\{name\}\}/g, '')
    .replace(/\{\{username\}\}/g, '')
    .replace(/\{\{post\}\}/g, '');

  const linkUrl   = auto?.actions?.dm?.linkUrl   || '';
  const linkTitle = auto?.actions?.dm?.linkTitle  || '';

  // Try link-card (generic template) first
  if (linkUrl && linkUrl.startsWith('http')) {
    try {
      await axios.post(
        `https://graph.instagram.com/${IG_API_VERSION}/${igUserId}/messages`,
        {
          recipient: { id: recipientId },
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
      recipient: { id: recipientId },
      message:   { text: fullText.substring(0, 1000) },
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL: update automation stats (dmsSent / failed / dailyLog)
// ─────────────────────────────────────────────────────────────────────────────
async function _updateStats(auto, success) {
  if (!auto) return;
  try {
    if (!auto.stats) auto.stats = {};
    if (success) {
      auto.stats.dmsSent = (auto.stats.dmsSent || 0) + 1;
    } else {
      auto.stats.failed  = (auto.stats.failed  || 0) + 1;
    }

    const today = new Date().toDateString();
    auto.stats.dailyLog = auto.stats.dailyLog || [];
    const entry = auto.stats.dailyLog.find(e => new Date(e.date).toDateString() === today);
    if (entry) {
      if (success) entry.dmsSent = (entry.dmsSent || 0) + 1;
    } else {
      auto.stats.dailyLog.push({ date: new Date(), dmsSent: success ? 1 : 0 });
    }
    auto.markModified('stats');
    await auto.save();
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
