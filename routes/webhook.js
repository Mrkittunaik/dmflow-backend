// routes/webhook.js — DMFlow Instagram Webhook Handler
// ─────────────────────────────────────────────────────────────────────────────
// Handles all incoming Instagram webhook events:
//   • DMs          → inbox thread + contact update + keyword automation trigger
//   • Comments     → comment reply + DM to commenter (via queue)
//   • Mentions     → optional DM to mentioner
//   • Story replies→ DM to replier
//   • Live comments→ live_reply automation trigger
//
// Design principles:
//   1. Always 200 immediately — Meta retries if we're slow
//   2. All DMs go through dmQueue (rate-limited, deduplicated)
//   3. Never send DMs to yourself (owner account)
//   4. Comment replies are enqueued WITH the DM job (sent after DM succeeds)
//   5. Full error isolation — one bad event never kills others
//   6. Every trigger logs to automation.stats for the analytics dashboard
// ─────────────────────────────────────────────────────────────────────────────

const express    = require('express');
const router     = express.Router();
const axios      = require('axios');
const User       = require('../models/User');
const Automation = require('../models/Automation');
const Contact    = require('../models/Contact');
const Thread     = require('../models/Thread');
const dmQueue    = require('../services/dmQueue');

const IG_API     = 'https://graph.instagram.com';
const IG_VERSION = 'v21.0';

// ── In-process comment dedup guard ───────────────────────────────────────────
// Prevents duplicate comment replies when Meta re-delivers the same event.
// Key: commentId, Value: timestamp of first processing
// FIX #1 / #9: deduplication for comment events (mirrors DM igMsgId guard)
const processedComments = new Map();
// Clean up entries older than 48 hours every hour
setInterval(() => {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  for (const [k, ts] of processedComments.entries()) {
    if (ts < cutoff) processedComments.delete(k);
  }
}, 3600 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook — Meta verification handshake
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('[Webhook] ✅ Verified by Meta');
    return res.status(200).send(challenge);
  }
  console.warn('[Webhook] ❌ Verification failed — token mismatch');
  res.status(403).json({ error: 'Verification failed.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook — incoming Instagram events
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // Respond 200 immediately — Meta retries on timeout
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (!body || body.object !== 'instagram') return;

    for (const entry of (body.entry || [])) {
      await processEntry(entry).catch(err =>
        console.error(`[Webhook] Entry ${entry.id} error:`, err.message)
      );
    }
  } catch (err) {
    console.error('[Webhook] Top-level error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// processEntry — route each event type to its handler
// ─────────────────────────────────────────────────────────────────────────────
async function processEntry(entry) {
  const igAccountId = entry.id;

  // Load the user that owns this IG account
  const user = await User.findOne({
    $or: [
      { 'instagram.userId': igAccountId },
      { 'instagram.webhookUserId': igAccountId }
    ]
  });
  if (!user || !user.instagram?.connected) {
    console.log(`[Webhook] No connected user for IG account ${igAccountId} — skipping`);
    return;
  }
  // Save webhookUserId on first match so future lookups are fast
  if (!user.instagram.webhookUserId || user.instagram.webhookUserId !== igAccountId) {
    await User.findByIdAndUpdate(user._id, {
      'instagram.webhookUserId': igAccountId
    });
  }

  const token = user.decryptIgToken();
  if (!token) {
    console.warn(`[Webhook] Could not decrypt token for user ${user._id}`);
    return;
  }

  // ── Direct Messages ────────────────────────────────────────────────────────
  // FIX #4: Story replies arrive in entry.messaging too. Track which events we
  // handle as story replies so we do NOT also process them as plain DMs.
  const storyReplyEventIds = new Set();

  for (const msgEvent of (entry.messaging || [])) {
    if (!msgEvent.message) continue;
    if (msgEvent.message.is_echo) continue;

    // FIX #4: If this is a story reply, mark it and skip the DM handler here.
    // handleStoryReply calls handleIncomingDm internally — no double processing.
    if (msgEvent.message?.reply_to) {
      storyReplyEventIds.add(msgEvent.sender?.id + ':' + (msgEvent.message?.mid || ''));
      await handleStoryReply(user, token, msgEvent).catch(err =>
        console.error('[Webhook] handleStoryReply (messaging) error:', err.message)
      );
      continue; // do NOT also call handleIncomingDm for this event
    }

    await handleIncomingDm(user, token, msgEvent).catch(err =>
      console.error('[Webhook] handleIncomingDm error:', err.message)
    );
  }

  // ── Changes (comments, mentions, story replies, live) ─────────────────────
  for (const change of (entry.changes || [])) {
    const { field, value } = change;
    if (!value) continue;

    if (field === 'comments') {
      await handleComment(user, token, value, false).catch(err =>
        console.error('[Webhook] handleComment error:', err.message)
      );
    } else if (field === 'live_comments') {
      await handleComment(user, token, value, true).catch(err =>
        console.error('[Webhook] handleLiveComment error:', err.message)
      );
    } else if (field === 'mentions') {
      await handleMention(user, token, value).catch(err =>
        console.error('[Webhook] handleMention error:', err.message)
      );
    } else if (field === 'story_insights' || field === 'stories') {
      // story reply events arrive here in some API versions
      if (value.messaging) {
        for (const storyEvent of value.messaging) {
          await handleStoryReply(user, token, storyEvent).catch(err =>
            console.error('[Webhook] handleStoryReply error:', err.message)
          );
        }
      }
    }
  }
  // NOTE: The old second loop over entry.messaging for story replies is removed.
  // It caused every story reply to be processed twice (FIX #4).
}

// ─────────────────────────────────────────────────────────────────────────────
// handleIncomingDm
// - Saves to inbox (Thread)
// - Upserts Contact
// - Fires keyword / email-collect automations
// ─────────────────────────────────────────────────────────────────────────────
async function handleIncomingDm(user, token, event) {
  const senderId   = event.sender?.id;
  const text       = (event.message?.text || '').trim();
  const igMsgId    = event.message?.mid || '';
  const timestamp  = event.timestamp ? new Date(Number(event.timestamp)) : new Date();

  if (!senderId || !text) return;

  // Never process messages from the account itself
  if (senderId === user.instagram.userId) return;

  // ── Upsert inbox thread ──────────────────────────────────────────────────
  let thread = await Thread.findOne({ userId: user._id, igUserId: senderId });

  if (!thread) {
    thread = new Thread({
      userId:      user._id,
      igUserId:    senderId,
      username:    senderId,       // placeholder until we fetch profile
      lastMessage: text,
      lastAt:      timestamp,
      unread:      true,
      unreadCount: 1,
      messages:    [],
    });

    // Best-effort profile fetch — don't block on failure
    try {
      const profile = await axios.get(
        `${IG_API}/${senderId}`,
        { params: { fields: 'username,name,profile_picture_url', access_token: token }, timeout: 5000 }
      );
      thread.username = profile.data.username || senderId;
      thread.name     = profile.data.name     || thread.username;
      thread.avatar   = profile.data.profile_picture_url || '';
    } catch (_) {}
  } else {
    thread.lastMessage  = text;
    thread.lastAt       = timestamp;
    thread.unread       = true;
    thread.unreadCount  = (thread.unreadCount || 0) + 1;
  }

  // Avoid duplicate messages (Meta sometimes re-delivers)
  const alreadyStored = igMsgId && thread.messages.some(m => m.igMsgId === igMsgId);
  if (!alreadyStored) {
    thread.messages.push({ from: 'contact', text, sentAt: timestamp, igMsgId });
  }
  await thread.save();

  // ── Upsert contact ────────────────────────────────────────────────────────
  await Contact.findOneAndUpdate(
    { userId: user._id, igUserId: senderId },
    {
      $set:         { username: thread.username, name: thread.name, avatar: thread.avatar, lastContact: timestamp },
      $inc:         { dmCount: 1 },
      $setOnInsert: { source: 'dm', createdAt: new Date() },
    },
    { upsert: true, new: true }
  );

  // ── Keyword / email-collect automations ──────────────────────────────────
  const dmAutomations = await Automation.find({
    userId: user._id,
    active: true,
    type:   { $in: ['keyword_dm', 'email_collect', 'collect_email', 'discount_code', 'product_link_dm'] },
  }).lean();

  for (const auto of dmAutomations) {
    const keywords = auto.trigger?.keywords || (auto.keyword ? [auto.keyword] : []);
    const anyMatch = auto.trigger?.allComments || auto.trigger?.anyComment || keywords.length === 0;
    const matched  = anyMatch || keywords.some(kw => text.toUpperCase().includes(kw.toUpperCase()));
    if (!matched) continue;

    // FIX #7: Always reload a fresh Mongoose doc from DB — never mutate the
    // .lean() plain object or a shared reference from another code path.
    const liveAuto = await Automation.findById(auto._id);
    if (!liveAuto) continue;

    _bumpTriggered(liveAuto, text, senderId, false);
    await liveAuto.save();

    const dmText = _getDmText(liveAuto);
    if (dmText) {
      dmQueue.enqueue(user._id, {
        token,
        igUserId:      user.instagram.userId,
        recipientId:   senderId,
        text:          dmText,
        autoId:        liveAuto._id.toString(), // FIX #7: pass ID not live doc
        triggerSource: 'dm',
      });
    }

    // Email collect: extract from text and save to contact
    if (auto.type === 'email_collect' || auto.type === 'collect_email') {
      const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) {
        await Contact.findOneAndUpdate(
          { userId: user._id, igUserId: senderId },
          { $set: { email: emailMatch[0] } },
          { upsert: true }
        );
      }
    }

    break; // first matching automation wins per DM
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleComment
// - Enqueues DM to commenter (comment reply is sent AFTER DM, inside the queue)
// - isLive = true for live_comments field
// FIX #2: comment reply is no longer sent inline here — it's attached to the
//         queue job so it fires only after the DM succeeds.
// FIX #1/#9: commentId deduplication guard prevents double-fire on Meta retry.
// ─────────────────────────────────────────────────────────────────────────────
async function handleComment(user, token, value, isLive = false) {
  const commentId   = value.id;
  const commentText = (value.text || '').trim();
  const commenterId = value.from?.id;
  const mediaId     = value.media?.id || value.media_id || '';

  if (!commenterId || !commentText || !commentId) return;

  // FIX #1 / #9: Deduplicate comment events — Meta re-delivers the same event
  const commentDedupeKey = `${user._id}::${commentId}`;
  if (processedComments.has(commentDedupeKey)) {
    console.log(`[Webhook] 🚫 Duplicate comment event blocked: ${commentId}`);
    return;
  }
  processedComments.set(commentDedupeKey, Date.now());

  // Never react to your own comments
  if (commenterId === user.instagram.userId) {
    console.log(`[Webhook] Skipping self-comment by owner on media ${mediaId}`);
    return;
  }

  // FIX #12: Validate comment reply length before sending (Instagram limit ~2200 chars)
  // (checked below when replyText is resolved)

  const automations = await Automation.find({
    userId: user._id,
    active: true,
    type: {
      $in: [
        'comment_reply',
        'keyword_dm',
        'product_link_dm',
        'auto_reply_comment',
        'live_reply',
      ],
    },
  }).lean(); // FIX #7: use .lean() to get plain objects; reload fresh doc before saving

  for (const auto of automations) {
    const isLiveAuto = auto.type === 'live_reply';

    // ── Post/media match check ──────────────────────────────────────────────
    // FIX #5: Empty string mediaId ('') was falsy — now we require applyAll OR
    // an explicit match. An empty mediaId with applyAll=false does NOT match all.
    let appliesToPost;
    if (isLiveAuto && isLive) {
      appliesToPost = true; // Live automations skip mediaId check
    } else if (auto.applyAll) {
      appliesToPost = true;
    } else if (auto.mediaId && auto.mediaId !== '') {
      appliesToPost = auto.mediaId === mediaId;
    } else {
      // No mediaId set and applyAll=false — skip (don't match everything)
      appliesToPost = false;
    }
    if (!appliesToPost) continue;

    // ── Keyword match ─────────────────────────────────────────────────────
    const keywords = auto.trigger?.keywords || (auto.keyword ? [auto.keyword] : []);
    const anyMatch = auto.trigger?.allComments || auto.trigger?.anyComment || keywords.length === 0;
    const matched  = anyMatch || keywords.some(kw => commentText.toUpperCase().includes(kw.toUpperCase()));
    if (!matched) continue;

    // FIX #7/#8: Reload fresh doc before mutating stats
    const liveAuto = await Automation.findById(auto._id);
    if (!liveAuto) continue;

    // ── Stats ─────────────────────────────────────────────────────────────
    _bumpTriggered(liveAuto, commentText, commenterId, isLive);
    await liveAuto.save();

    // ── Comment reply text ────────────────────────────────────────────────
    const replyText = _getCommentReplyText(liveAuto);

    // FIX #12: Warn if reply text exceeds Instagram limit
    if (replyText && replyText.length > 2200) {
      console.warn(`[Webhook] ⚠️ Comment reply for automation ${liveAuto._id} exceeds 2200 chars (${replyText.length}). Instagram may reject it.`);
    }

    // ── DM to commenter ───────────────────────────────────────────────────
    // FIX #2: Comment reply is attached to the queue job and sent AFTER the DM
    // succeeds — no longer fired inline here before the DM is sent.
    const dmText = _getDmText(liveAuto);
    console.log(`[Webhook] DM debug — dmText: "${dmText}", commenterId: ${commenterId}, autoId: ${liveAuto._id}`);

    if (dmText || replyText) {
      dmQueue.enqueue(user._id, {
        token,
        igUserId:         user.instagram.userId,
        recipientId:      commenterId,
        text:             dmText,
        autoId:           liveAuto._id.toString(), // FIX #7: ID not live doc
        commentId:        replyText ? commentId : null,   // FIX #2
        commentReplyText: replyText || null,               // FIX #2
        triggerSource:    isLive ? 'live_comment' : 'comment',
      });
    }

    break; // first matching automation wins per comment
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleMention
// - Fires any automation targeting mentions (type keyword_dm with mention trigger)
// ─────────────────────────────────────────────────────────────────────────────
async function handleMention(user, token, value) {
  const mentionerId = value.sender?.id || value.from?.id;
  const mediaId     = value.media?.id  || value.media_id || '';

  if (!mentionerId || mentionerId === user.instagram.userId) return;

  // Find automations that explicitly target mentions
  const automations = await Automation.find({
    userId: user._id,
    active: true,
    'trigger.onMention': true,
  }).lean();

  for (const auto of automations) {
    const liveAuto = await Automation.findById(auto._id);
    if (!liveAuto) continue;

    _bumpTriggered(liveAuto, '@mention', mentionerId, false);
    await liveAuto.save();

    const dmText = _getDmText(liveAuto);
    if (dmText) {
      dmQueue.enqueue(user._id, {
        token,
        igUserId:      user.instagram.userId,
        recipientId:   mentionerId,
        text:          dmText,
        autoId:        liveAuto._id.toString(),
        triggerSource: 'mention',
      });
    }
    break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleStoryReply
// - Fires automations with trigger.onStoryReply = true
// FIX #4: This function is the ONLY place story replies are handled.
//         processEntry no longer calls handleIncomingDm separately for them.
// ─────────────────────────────────────────────────────────────────────────────
async function handleStoryReply(user, token, event) {
  const senderId = event.sender?.id;
  const text     = (event.message?.text || '').trim();

  if (!senderId || senderId === user.instagram.userId) return;

  // Save the reply to inbox thread (single call — not duplicated)
  await handleIncomingDm(user, token, event);

  const automations = await Automation.find({
    userId: user._id,
    active: true,
    $or: [
      { type: 'story_dm' },
      { type: 'story_reaction_dm' },
      { 'trigger.onStoryReply': true },
    ],
  }).lean();

  for (const auto of automations) {
    const keywords = auto.trigger?.keywords || (auto.keyword ? [auto.keyword] : []);
    const anyMatch = auto.trigger?.allComments || auto.trigger?.anyComment || keywords.length === 0;
    const matched  = anyMatch || keywords.some(kw => text.toUpperCase().includes(kw.toUpperCase()));
    if (!matched) continue;

    const liveAuto = await Automation.findById(auto._id);
    if (!liveAuto) continue;

    _bumpTriggered(liveAuto, text, senderId, false);
    await liveAuto.save();

    const dmText = _getDmText(liveAuto);
    if (dmText) {
      dmQueue.enqueue(user._id, {
        token,
        igUserId:      user.instagram.userId,
        recipientId:   senderId,
        text:          dmText,
        autoId:        liveAuto._id.toString(),
        triggerSource: 'story_reply',
      });
    }
    break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Bump triggered counter + rolling recent log (used in analytics + live builder view)
function _bumpTriggered(auto, text, fromId, isLive) {
  if (!auto.stats) auto.stats = {};
  auto.stats.triggered      = (auto.stats.triggered || 0) + 1;
  auto.stats.lastTriggeredAt = new Date();

  auto.stats.recentLog = auto.stats.recentLog || [];
  auto.stats.recentLog.unshift({
    at:   new Date(),
    text: (text || '').substring(0, 80),
    from: fromId,
    live: isLive,
  });
  if (auto.stats.recentLog.length > 20) auto.stats.recentLog.length = 20;

  auto.markModified('stats');
}

// FIX #13: _getDmText now correctly reads actions.dm.text (not .message)
// Falls back to legacy dmText / firstDm fields for old documents.
function _getDmText(auto) {
  if (auto.actions?.dm?.text) return auto.actions.dm.text;       // new schema field
  if (auto.actions?.dm?.message) return auto.actions.dm.message; // legacy alias (if any)
  return auto.dmText || auto.firstDm || '';
}

// Get comment reply text — supports new schema + legacy commentReply string
// If actions.commentReply.enabled is explicitly false, respect it.
// If it's missing/undefined (legacy doc), treat as enabled when text is present.
function _getCommentReplyText(auto) {
  const cr = auto.actions?.commentReply;
  if (cr?.text) {
    if (cr.enabled === false) return '';   // user explicitly disabled it
    return cr.text;                        // enabled or unset (legacy) — send it
  }
  // Legacy: direct commentReply string field on the automation
  if (auto.commentReply) return auto.commentReply;
  return '';
}

module.exports = router;
