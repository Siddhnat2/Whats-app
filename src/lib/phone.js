'use strict';

/**
 * Phone-number normalisation — a faithful port of contacts_io.normalize_phone
 * from the desktop app. Accepts messy input like '+91-98223 78284',
 * '098223-78284', '9822378284'.
 *
 * Returns { phone, valid, reason }.
 */

const { DEFAULT_COUNTRY_CODE } = require('../config');

function normalizePhone(raw, defaultCC = DEFAULT_COUNTRY_CODE) {
  if (raw === null || raw === undefined) {
    return { phone: '', valid: false, reason: 'empty' };
  }
  let s = String(raw).trim();
  if (!s || ['none', 'nan', '-'].includes(s.toLowerCase())) {
    return { phone: '', valid: false, reason: 'empty' };
  }

  const hadPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return { phone: '', valid: false, reason: 'no digits' };

  // Strip a leading trunk '0' used for domestic dialling (common in IN/UK).
  if (!hadPlus && digits.length > 10 && digits.startsWith('0')) {
    digits = digits.replace(/^0+/, '');
  }

  // A bare local 10-digit number -> prefix the default country code.
  if (!hadPlus && digits.length === 10) {
    digits = String(defaultCC) + digits;
  }

  if (digits.length < 8) return { phone: digits, valid: false, reason: 'too short' };
  if (digits.length > 15) return { phone: digits, valid: false, reason: 'too long' };
  return { phone: digits, valid: true, reason: '' };
}

// Digits-only sanitiser used by the send path (mirrors worker.js sanitizeNumber).
function sanitizeNumber(n) {
  return String(n || '').replace(/[^\d]/g, '');
}

module.exports = { normalizePhone, sanitizeNumber };
