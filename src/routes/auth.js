'use strict';

/**
 * Authentication routes + guard middleware.
 *
 * A single shared ADMIN_PASSWORD (set in Railway) protects the whole app.
 * Login state is kept in a signed, server-side session cookie. Comparison is
 * timing-safe. A rate limiter throttles brute-force attempts.
 */

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Try again in a few minutes.' },
});

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still spend the compare to avoid leaking length via timing.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// Guard for API routes: 401 JSON when not authenticated.
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// Guard for page routes: redirect to /login.
function requirePage(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect('/login');
}

router.post('/api/login', loginLimiter, (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (!config.ADMIN_PASSWORD) {
    // No password configured (dev only) — allow through but flag it.
    req.session.authed = true;
    return res.json({ ok: true, warning: 'no-password-set' });
  }
  if (timingSafeEqual(password, config.ADMIN_PASSWORD)) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Incorrect password' });
});

router.post('/api/logout', (req, res) => {
  if (req.session) req.session.destroy(() => {});
  res.json({ ok: true });
});

router.get('/api/me', (req, res) => {
  res.json({
    ok: true,
    authed: !!(req.session && req.session.authed),
    passwordRequired: !!config.ADMIN_PASSWORD,
  });
});

module.exports = { router, requireAuth, requirePage };
