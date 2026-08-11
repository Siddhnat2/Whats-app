'use strict';

/**
 * Message-template rendering with per-contact personalisation variables.
 * Faithful port of templating.py.
 *
 * Supported placeholders (case-insensitive):
 *   {name} {first_name} {company} {designation} {phone}
 */

const VAR_RE = /\{\s*([a-zA-Z_]+)\s*\}/g;

const AVAILABLE_VARIABLES = ['name', 'first_name', 'company', 'designation', 'phone'];

const HONORIFICS = ['Mr.', 'Mr', 'Mrs.', 'Mrs', 'Ms.', 'Ms', 'Dr.', 'Dr', 'Prof.', 'Prof'];

function cleanName(name) {
  let n = (name || '').trim();
  for (const pref of HONORIFICS) {
    if (n.toLowerCase().startsWith(pref.toLowerCase() + ' ')) {
      n = n.slice(pref.length).trim();
      break;
    }
  }
  return n;
}

function render(body, contact) {
  if (!body) return '';
  const get = (key) => String((contact && contact[key]) || '').trim();

  const name = get('name');
  const cleaned = cleanName(name);
  const first = cleaned ? cleaned.split(' ')[0] : '';

  const values = {
    name: cleaned || name,
    first_name: first,
    company: get('company'),
    designation: get('designation'),
    phone: get('phone'),
  };

  return body.replace(VAR_RE, (match, rawKey) => {
    const key = rawKey.toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

function preview(body) {
  const sample = {
    name: 'Mr. Prashant Karhade',
    company: 'Avantza Technologies',
    designation: 'Founder & CEO',
    phone: '919822378284',
  };
  return render(body, sample);
}

module.exports = { render, preview, AVAILABLE_VARIABLES };
