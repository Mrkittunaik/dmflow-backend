// routes/webhook.js — Handles incoming Instagram webhook events
// Instagram sends events here when users comment or DM your connected accounts

const express    = require('express');
const router     = express.Router();
const User       = require('../models/User');
const Automation = require('../models/Automation');
const Contact    = require('../models/Contact');
const Thread     = require('../models/Thread');

// ── GET /webhook — Meta verification handshake ──────────────────────────────
// When you add the webhook URL in Meta dashboard, Meta sends this to verify
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
  // Always respond 200 immediately so Meta doesn't retry
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (!body || body.object !== 'instagram') return;

    for (const entry of (body.entry || [])) {
      const igAccountId = entry.id; // the Instagram account ID that received the event

      // Find which user owns this IG account
      const user = await User.findOne({ 'instagram.userId': igAccountId });
      if (!user || !user.instagram?.connected) continue;

      const token = user.decryptIgToken();

      // ── Handle incoming direct messages ────────────────────────────────
      for (const messagingEvent of (entry.messaging || [])) {
        if (messagingEvent.message && !messagingEvent.message.is_echo) {
          await handleIncomingDm(user, token, messagingEvent);
        }
      }

      // ── Handle comments on posts ────────────────────────────────────────
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
async function handleIncomingDm(user, token, event) {
  try {
    const senderId  = event.sender?.id;
    const text      = event.message?.text || '';
    const timestamp = new Date(event.timestamp);

    if (!senderId || !text) return;

    // Save/update thread in inbox
    let thread = await Thread.findOne({ userId: user._id, igUserId: senderId });
    if (!thread) {
      thread = new Thread({
        userId:      user._id,
        igUserId:    senderId,
        username:    senderId, // will be updated below
        lastMessage: text,
        lastAt:      timestamp,
        unread:      true,
        unreadCount: 1,
        messages:    [],
      });

      // Try to get sender's username from Instagram
      try {
        const axios = require('axios');
        const profileRes = await axios.get(
          `https://graph.instagram.com/${senderId}?fields=username,name&access_token=${token}`
        );
        thread.username = profileRes.data.username || senderId;
        thread.name     = profileRes.data.name || thread.username;
      } catch (e) {}
    } else {
      thread.lastMessage = text;
      thread.lastAt      = timestamp;
      thread.unread      = true;
      thread.unreadCount = (thread.unreadCount || 0) + 1;
    }

    thread.messages.push({ from: 'them', text, sentAt: timestamp });
    await thread.save();

    // ── Check if any automation keyword matches this DM ─────────────────
    const automations = await Automation.find({
      userId: user._id,
      active: true,
      type:   { $in: ['keyword_dm', 'email_collect', 'discount_code'] },
    });

    for (const auto of automations) {
      const keywords = auto.trigger?.keywords || (auto.keyword ? [auto.keyword] : []);
      const matched  = keywords.some(kw =>
        text.toUpperCase().includes(kw.toUpperCase())
      );
      if (!matched && !auto.trigger?.anyComment) continue;

      // Send auto-reply DM
      const replyText = auto.dmText || auto.firstDm || '';
      if (replyText) {
        await sendDm(token, user.instagram.userId, senderId, replyText);
        auto.stats = auto.stats || {};
        auto.stats.dmsSent   = (auto.stats.dmsSent || 0) + 1;
        auto.stats.triggered = (auto.stats.triggered || 0) + 1;
        // Log daily stat
        const today = new Date().toDateString();
        auto.stats.dailyLog = auto.stats.dailyLog || [];
        const todayEntry = auto.stats.dailyLog.find(e => new Date(e.date).toDateString() === today);
        if (todayEntry) { todayEntry.dmsSent = (todayEntry.dmsSent || 0) + 1; }
        else { auto.stats.dailyLog.push({ date: new Date(), dmsSent: 1 }); }
        auto.markModified('stats');
        await auto.save();

        // Update user DM count
        user.dmsSentMonth = (user.dmsSentMonth || 0) + 1;
        await user.save();
      }

      // Save contact if email_collect
      if (auto.type === 'email_collect') {
        const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
          await Contact.findOneAndUpdate(
            { userId: user._id, igUserId: senderId },
            { $set: { email: emailMatch[0], username: thread.username, lastAt: new Date() } },
            { upsert: true, new: true }
          );
        }
      }

      break; // only fire first matching automation per message
    }

    // Save/update contact record
    await Contact.findOneAndUpdate(
      { userId: user._id, igUserId: senderId },
      {
        $set:  { username: thread.username, name: thread.name, lastAt: timestamp },
        $inc:  { dmCount: 1 },
        $setOnInsert: { source: 'dm', createdAt: new Date() },
      },
      { upsert: true }
    );

  } catch (err) {
    console.error('handleIncomingDm error:', err.message);
  }
}

// ── Handle comment on post ───────────────────────────────────────────────────
async function handleComment(user, token, value) {
  try {
    const commentId  = value.id;
    const commentText = value.text || '';
    const commenterId = value.from?.id;
    const mediaId    = value.media?.id;

    if (!commenterId || !commentText) return;

    // Find active comment_reply automations that match this media or are "any post"
    const automations = await Automation.find({
      userId: user._id,
      active: true,
      type:   'comment_reply',
    });

    for (const auto of automations) {
      // Check if this automation applies to this post (or all posts)
      const appliesToPost = !auto.mediaId || auto.mediaId === mediaId;
      if (!appliesToPost) continue;

      const keywords = auto.trigger?.keywords || (auto.keyword ? [auto.keyword] : []);
      const anyComment = auto.trigger?.anyComment || keywords.length === 0;
      const matched = anyComment || keywords.some(kw =>
        commentText.toUpperCase().includes(kw.toUpperCase())
      );
      if (!matched) continue;

      const axios = require('axios');

      // Reply to comment publicly if commentReply set
      if (auto.commentReply) {
        try {
          await axios.post(
            `https://graph.instagram.com/v19.0/${commentId}/replies`,
            { message: auto.commentReply },
            { headers: { Authorization: `Bearer ${token}` } }
          );
        } catch (e) {
          console.error('Comment reply error:', e.response?.data || e.message);
        }
      }

      // Send DM to commenter
      if (auto.dmText || auto.firstDm) {
        const dmText = auto.dmText || auto.firstDm;
        await sendDm(token, user.instagram.userId, commenterId, dmText);
        auto.stats = auto.stats || {};
        auto.stats.dmsSent   = (auto.stats.dmsSent || 0) + 1;
        auto.stats.triggered = (auto.stats.triggered || 0) + 1;
        const today = new Date().toDateString();
        auto.stats.dailyLog = auto.stats.dailyLog || [];
        const todayEntry = auto.stats.dailyLog.find(e => new Date(e.date).toDateString() === today);
        if (todayEntry) { todayEntry.dmsSent = (todayEntry.dmsSent || 0) + 1; }
        else { auto.stats.dailyLog.push({ date: new Date(), dmsSent: 1 }); }
        auto.markModified('stats');
        await auto.save();

        user.dmsSentMonth = (user.dmsSentMonth || 0) + 1;
        await user.save();
      }

      // Save commenter as contact
      let commenterUsername = commenterId;
      try {
        const profileRes = await axios.get(
          `https://graph.instagram.com/${commenterId}?fields=username,name&access_token=${token}`
        );
        commenterUsername = profileRes.data.username || commenterId;
      } catch (e) {}

      await Contact.findOneAndUpdate(
        { userId: user._id, igUserId: commenterId },
        {
          $set:  { username: commenterUsername, lastAt: new Date() },
          $inc:  { dmCount: 1 },
          $setOnInsert: { source: 'comment', createdAt: new Date() },
        },
        { upsert: true }
      );

      break; // only fire first matching automation per comment
    }
  } catch (err) {
    console.error('handleComment error:', err.message);
  }
}

// ── Send DM via Instagram Messenger API ─────────────────────────────────────
async function sendDm(token, igUserId, recipientId, text) {
  const axios = require('axios');
  try {
    await axios.post(
      `https://graph.instagram.com/v19.0/${igUserId}/messages`,
      {
        recipient: { id: recipientId },
        message:   { text },
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  } catch (err) {
    console.error('sendDm error:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = router;
