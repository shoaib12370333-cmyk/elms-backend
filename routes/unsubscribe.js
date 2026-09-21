const express = require('express');
const router = express.Router();
const User = require('../models/schemas/User');
const { verifyUnsubscribe } = require('../services/announcementService');

const page = (title, msg) => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title></head><body style="font-family:Arial,sans-serif;background:#f4f6fb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><div style="background:#fff;border-radius:14px;padding:32px;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)"><h2 style="margin-top:0">' + title + '</h2><p style="line-height:1.55;color:#374151">' + msg + '</p></div></body></html>';

/** GET /api/unsubscribe?u=<userId>&t=<token> - one click, no login. Only turns off announcement mails. */
router.get('/', async (req, res) => {
  const { u, t } = req.query;
  if (!u || !/^[a-f0-9]{24}$/i.test(String(u)) || !verifyUnsubscribe(u, t)) {
    return res.status(400).send(page('Invalid link', 'This unsubscribe link is not valid.'));
  }
  await User.updateOne({ _id: u }, { marketingOptOut: true });
  res.send(page('You are unsubscribed', 'You will no longer get announcement emails. Account and security emails (password reset, new-device alerts, receipts) will still be sent.'));
});

module.exports = router;
