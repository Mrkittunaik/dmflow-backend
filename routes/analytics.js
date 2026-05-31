// routes/analytics.js  — aggregates data from existing Automation model
const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const Automation  = require('../models/Automation');
const Contact     = require('../models/Contact');

// GET /api/analytics?range=7d|30d|90d
router.get('/', requireAuth, async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const days  = range === '30d' ? 30 : range === '90d' ? 90 : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const automations = await Automation.find({ userId: req.user._id });
    const contacts    = await Contact.countDocuments({ userId: req.user._id, createdAt: { $gte: since } });

    const activeAutomations = automations.filter(a => a.active).length;
    const totalDmsSent      = automations.reduce((s, a) => s + (a.stats?.dmsSent || 0), 0);
    const totalTriggered    = automations.reduce((s, a) => s + (a.stats?.triggered || 0), 0);
    const deliveryRate      = totalTriggered > 0 ? Math.round((totalDmsSent / totalTriggered) * 100) : 0;

    // Build daily series (spread total evenly for now — replace with real daily logs later)
    const barCount = Math.min(days, 10);
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const now      = new Date();
    const series   = [];
    for (let i = barCount - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const label = days <= 7 ? dayNames[d.getDay()] : `${d.getDate()}/${d.getMonth() + 1}`;
      const value = Math.floor(totalDmsSent / barCount);
      series.push({ label, value });
    }

    // By type breakdown from Automation.type
    const byType = { keywordDm: 0, emailCollect: 0, storyDm: 0 };
    automations.forEach(a => {
      if (a.type === 'keyword_dm' || a.type === 'discount_code' || a.type === 'comment_reply')
        byType.keywordDm += a.stats?.dmsSent || 0;
      else if (a.type === 'email_collect')
        byType.emailCollect += a.stats?.dmsSent || 0;
      else if (a.type === 'story_dm')
        byType.storyDm += a.stats?.dmsSent || 0;
    });

    // Top keywords from Automation.trigger.keywords
    const keywordMap = {};
    automations.forEach(a => {
      (a.trigger?.keywords || []).forEach(kw => {
        keywordMap[kw] = (keywordMap[kw] || 0) + (a.stats?.triggered || 0);
      });
    });
    const keywords = Object.entries(keywordMap)
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Per-automation table rows
    const automationRows = automations.map(a => ({
      name:      a.name,
      type:      a.type,
      triggered: a.stats?.triggered || 0,
      dmsSent:   a.stats?.dmsSent   || 0,
      active:    a.active,
    }));

    res.json({
      dmsSent:           totalDmsSent,
      triggered:         totalTriggered,
      deliveryRate,
      activeAutomations,
      contacts,
      dmsDelta:          '+0%',   // placeholder — wire up real delta with daily logs
      series,
      byType,
      keywords,
      automations:       automationRows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
