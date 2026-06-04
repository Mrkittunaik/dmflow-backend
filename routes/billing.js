// routes/billing.js  — Razorpay billing (plans, order, verify)
const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const User        = require('../models/User');

const PLANS = [
  { id: 'free',     name: 'Free',     price: 0,    dmLimit: 500,   features: ['500 DMs/month','1 automation','Basic analytics'] },
  { id: 'pro',      name: 'Pro',      price: 999,  dmLimit: 5000,  features: ['5,000 DMs/month','Unlimited automations','Advanced analytics','Priority support'] },
  { id: 'business', name: 'Business', price: 2499, dmLimit: 25000, features: ['25,000 DMs/month','Unlimited automations','Full analytics','Dedicated support','API access'] },
];

// GET /api/billing/plans
router.get('/plans', requireAuth, async (req, res) => {
  res.json(PLANS);
});

// POST /api/billing/order
router.post('/order', requireAuth, async (req, res) => {
  try {
    const { planId } = req.body;
    const plan = PLANS.find(p => p.id === planId);
    if (!plan || plan.price === 0)
      return res.status(400).json({ error: 'Invalid plan.' });

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)
      return res.status(503).json({ error: 'Payment not configured.' });

    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const order = await razorpay.orders.create({
      amount:   plan.price * 100,   // paise
      currency: 'INR',
      receipt:  `dmflow_${req.user._id}_${Date.now()}`,
      notes:    { userId: req.user._id.toString(), planId },
    });

    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, planId });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/billing/verify
router.post('/verify', requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const crypto = require('crypto');

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Payment verification failed.' });

    // Fetch planId from Razorpay order notes — never trust user-supplied planId
    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    const order    = await razorpay.orders.fetch(razorpay_order_id);
    const planId   = order?.notes?.planId;

    const plan = PLANS.find(p => p.id === planId);
    if (!plan) return res.status(400).json({ error: 'Invalid plan.' });

    const user = await User.findByIdAndUpdate(req.user._id, {
      plan:    plan.id,
      dmLimit: plan.dmLimit,
    }, { new: true }).select('-password -instagram.accessToken');

    res.json({ message: 'Payment verified. Plan upgraded!', user });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
