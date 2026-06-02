const Template = require('../models/Template');

const DEFAULT_TEMPLATES = [
  {
    order: 1,
    title: 'Send link on keyword',
    description: 'Someone comments "LINK" → they get your link in DMs.',
    icon: '🔗',
    badge: 'MOST POPULAR',
    type: 'keyword_dm',
    trigger: { onComment: true, onStoryReply: false, onDmKeyword: false, keywords: ['LINK'] },
    actions: {
      commentReply: { enabled: true, text: 'Check your DMs! I sent you the link 📩' },
      dm: { enabled: true, text: 'Hey! Here\'s the link you asked for:', linkTitle: 'Shop the look', linkUrl: '' },
    },
  },
  {
    order: 2,
    title: 'Story reaction DM',
    description: 'Someone reacts 🔥 or replies → they get your link in DMs.',
    icon: '📸',
    badge: 'STORY REPLY',
    type: 'story_dm',
    trigger: { onComment: false, onStoryReply: true, onDmKeyword: false, keywords: [] },
    actions: {
      commentReply: { enabled: false, text: '' },
      dm: { enabled: true, text: 'Thanks for reacting! Here\'s the link:', linkTitle: 'Shop now', linkUrl: '' },
    },
  },
  {
    order: 3,
    title: 'Auto-reply all comments',
    description: 'Auto-reply a thank you to every comment on your post.',
    icon: '💬',
    badge: 'ENGAGEMENT',
    type: 'comment_reply',
    trigger: { onComment: true, onStoryReply: false, onDmKeyword: false, keywords: [] },
    actions: {
      commentReply: { enabled: true, text: 'Thank you so much! 🙏 Check your DMs for more info.' },
      dm: { enabled: false, text: '', linkTitle: '', linkUrl: '' },
    },
  },
  {
    order: 4,
    title: 'Send discount code',
    description: 'Someone comments "CODE" → DM them an exclusive discount.',
    icon: '🏷',
    badge: 'SALES',
    type: 'discount_code',
    trigger: { onComment: true, onStoryReply: false, onDmKeyword: true, keywords: ['CODE','DISCOUNT','DEAL'] },
    actions: {
      commentReply: { enabled: true, text: 'Check your DMs for your exclusive code! 🎁' },
      dm: { enabled: true, text: 'Here is your exclusive discount code: SAVE20\nUse it at checkout for 20% off!', linkTitle: 'Shop now', linkUrl: '' },
    },
  },
  {
    order: 5,
    title: 'Collect email via DM',
    description: 'Someone DMs "JOIN" → ask for their email to grow your list.',
    icon: '📧',
    badge: 'LEAD GEN',
    type: 'email_collect',
    trigger: { onComment: false, onStoryReply: false, onDmKeyword: true, keywords: ['JOIN','EMAIL','LIST'] },
    actions: {
      commentReply: { enabled: false, text: '' },
      dm: { enabled: true, text: 'Welcome! 🎉 Reply with your email to join the VIP list and get exclusive deals first.', linkTitle: '', linkUrl: '' },
    },
  },
];

async function seed() {
  try {
    const count = await Template.countDocuments();
    if (count > 0) return; // already seeded
    await Template.insertMany(DEFAULT_TEMPLATES);
    console.log('✅  Default templates seeded');
  } catch (e) {
    console.error('Template seed error:', e.message);
  }
}

module.exports = { seed };
