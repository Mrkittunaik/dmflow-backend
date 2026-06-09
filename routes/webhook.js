// routes/webhook.js — Handles incoming Instagram webhook events
// DMs are queued via services/dmQueue.js (respects 200 DMs/hr limit).
//
// STORAGE POLICY:
//   - We ONLY store what the user configured: DM text and comment reply text.
//   - We do NOT store comment events, commenter profiles, or reel data.
//   - We DO store incoming DM conversations in Threads (inbox feature).
//   - Contacts are only created/updated from real incoming DMs, not comments.

const express    = require('express');
const router     = express.Router();
const User       = require('../models/User');
const Automation = require('../models/Automation');
const Contact    = require('../models/Contact');
const Thread     = require('../models/Thread');
const axios      = require('axios');
const dmQueue    = require('../services/dmQueue');

const IG_API_VERSION = 'v21.0';

// ── GET /webhook — Meta verification handshake ──────────────────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'Verification failed.' });
});

// ── POST /webhook — incoming Instagram events ───────────────────────────────
router.post('/', async (req, res) => {
  // Always 200 immediately so Meta doesn't retry
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (!body || body.object !== 'instagram') return;

    for (const entry of (body.entry || [])) {
      const igAccountId = entry.id;
      const user = await User.findOne({ 'instagram.userId': igAccountId });
      if (!user || !user.instagram?.connected) continue;

      const token = user.decryptIgToken();

      // Incoming DMs → store in inbox + trigger keyword automations
      for (const msgEvent of (entry.messaging || [])) {
        if (msgEvent.message && !msgEvent.message.is_echo) {
          await handleIncomingDm(user, token, msgEvent);
        }
      }

      // Post/reel comments → trigger automations (send DM + comment reply)
      // We do NOT store the comment itself, only the automation outcome.
      for (const change of (entry.changes || [])) {
        if (change.field === 'comments' && change.value) {
          await handleComment(user, token, change.value);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

// ── Handle incoming DM ───────────────────────────────────────────────────────
// Stores the message in the inbox Thread and updates the Contact record.
// Also triggers any keyword-based DM automations if the message matches.
async function handleIncomingDm(user, token, event) {
  try {
    const senderId  = event.sender?.id;
    const text      = event.message?.text || '';
    const timestamp = new Date(event.timestamp);
    if (!senderId || !text) return;

    // ── Update inbox thread ────────────────────────────────────────────────
    let thread = await Thread.findOne({ userId: user._id, igUserId: senderId });
    if (!thread) {
      thread = new Thread({
        userId:      user._id,
        igUserId:    senderId,
        username:    senderId,
        lastMessage: text,
        lastAt:      timestamp,
        unread:      true,
        unreadCount: 1,
        messages:    [],
      });
      // Try to get their username (best-effort; don't block on failure)
      try {
        const p = await axios.get(
          `https://graph.instagram.com/${senderId}?fields=username,name&access_token=${token}`,
          { timeout: 5000 }
        );
        thread.username = p.data.username || senderId;
        thread.name     = p.data.name     || thread.username;
      } catch(e) {}
    } else {
      thread.lastMessage  = text;
      thread.lastAt       = timestamp;
      thread.unread       = true;
      thread.unreadCount  = (thread.unreadCount || 0) + 1;
    }
    thread.messages.push({ from: 'them', text, sentAt: timestamp });
    await thread.save();

    // ── Update contact record ──────────────────────────────────────────────
    await Contact.findOneAndUpdate(
      { userId: user._id, igUserId: senderId },
      {
        $set:         { username: thread.username, name: thread.name, lastAt: timestamp },
        $inc:         { dmCount: 1 },
        $setOnInsert: { source: 'dm', createdAt: new Date() },
      },
      { upsert: true }
    );

    // ── Keyword DM automations ─────────────────────────────────────────────
    const automations = await Automation.find({
      userId: user._id,
      active: true,
      type:   { $in: ['keyword_dm', 'email_collect', 'discount_code', 'product_link_dm'] },
    });

    for (const auto of automations) {
      const keywords = auto.trigger?.keywords || (auto.keyword ? [auto.keyword] : []);
      const anyMatch = auto.trigger?.allComments || auto.trigger?.anyComment || keywords.length === 0;
      const matched  = anyMatch || keywords.some(kw => text.toUpperCase().includes(kw.toUpperCase()));
      if (!matched) continue;

      // Bump triggered stat
      auto.stats = auto.stats || {};
      auto.stats.triggered = (auto.stats.triggered || 0) + 1;
      auto.markModified('stats');
      await auto.save();

      const dmText = _getDmText(auto);
      if (dmText) {
        dmQueue.enqueue(user._id, {
          token,
          igUserId:    user.instagram.userId,
          recipientId: senderId,
          text:        dmText,
          auto,
          triggerSource: 'dm',
        });
      }

      // Email collect: scrape email from incoming message and save to contact
      if (auto.type === 'email_collect') {
        const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
          await Contact.findOneAndUpdate(
            { userId: user._id, igUserId: senderId },
            { $set: { email: emailMatch[0] } },
            { upsert: true }
          );
        }
      }

      break; // first matching automation wins
    }
  } catch (err) {
    console.error('handleIncomingDm error:', err.message);
  }
}

// ── Handle comment on post/reel ──────────────────────────────────────────────
// Checks automations the user has configured and:
//   1. Sends a DM to the commenter (via queue, rate-limited)
//   2. Posts a public comment reply (if the user set one up)
// We do NOT store the comment text, commenter profile, or any reel data.
// Stat counters on the Automation document are updated.
async function handleComment(user, token, value) {
  try {
    const commentId   = value.id;
    const commentText = value.text || '';
    const commenterId = value.from?.id;
    const mediaId     = value.media?.id;

    if (!commenterId || !commentText) return;

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
    });

    for (const auto of automations) {
      // Does this automation apply to the post/reel that was commented on?
      const appliesToPost = !auto.mediaId || auto.applyAll || auto.mediaId === mediaId;
      if (!appliesToPost) continue;

      // Does the comment match the trigger keywords (or is it "all comments")?
      const keywords = auto.trigger?.keywords || (auto.keyword ? [auto.keyword] : []);
      const anyMatch = auto.trigger?.allComments || auto.trigger?.anyComment || keywords.length === 0;
      const matched  = anyMatch || keywords.some(kw => commentText.toUpperCase().includes(kw.toUpperCase()));
      if (!matched) continue;

      // Bump triggered stat
      auto.stats = auto.stats || {};
      auto.stats.triggered = (auto.stats.triggered || 0) + 1;
      auto.markModified('stats');
      await auto.save();

      // ── Public comment reply ─────────────────────────────────────────────
      const commentReplyText = _getCommentReplyText(auto);
      if (commentReplyText) {
        try {
          await axios.post(
            `https://graph.instagram.com/${IG_API_VERSION}/${commentId}/replies`,
            { message: commentReplyText },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
          );
          auto.stats.repliesSent = (auto.stats.repliesSent || 0) + 1;
          auto.markModified('stats');
          await auto.save();
        } catch (e) {
          console.error('Comment reply error:', e.response?.data || e.message);
        }
      }

      // ── DM to commenter ──────────────────────────────────────────────────
      const dmText = _getDmText(auto);
      if (dmText) {
        dmQueue.enqueue(user._id, {
          token,
          igUserId:    user.instagram.userId,
          recipientId: commenterId,
          text:        dmText,
          auto,
          triggerSource: 'comment',
        });
      }

      break; // first matching automation wins per comment
    }
  } catch (err) {
    console.error('handleComment error:', err.message);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Get the DM text from the automation (supports old and new schema)
function _getDmText(auto) {
  if (auto.actions?.dm?.message) return auto.actions.dm.message;
  return auto.dmText || auto.firstDm || '';
}

// Get the comment reply text (only if the user enabled it)
function _getCommentReplyText(auto) {
  if (auto.actions?.commentReply?.enabled && auto.actions.commentReply.text) {
    return auto.actions.commentReply.text;
  }
  return ''; // do NOT fall back to auto.commentReply — respect user's toggle
}

module.exports = router;
