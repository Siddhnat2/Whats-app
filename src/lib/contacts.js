'use strict';

/**
 * Excel/CSV import and header mapping — port of contacts_io.py.
 *
 * The reference sheet has columns: Company Name, Contact Person, Designation,
 * Phone Number. We detect columns by header name so the importer also works
 * with differently-ordered or differently-named sheets, and fall back to a
 * canonical positional order for header-less files.
 */

const XLSX = require('xlsx');
const { normalizePhone } = require('./phone');

const HEADER_ALIASES = {
  company: ['company name', 'company', 'organisation', 'organization', 'org', 'firm'],
  name: ['contact person', 'contact name', 'name', 'person', 'contact', 'full name'],
  designation: ['designation', 'title', 'role', 'position'],
  phone: ['phone number', 'phone', 'mobile', 'mobile number', 'number',
    'whatsapp', 'whatsapp number', 'contact number', 'cell'],
};

function matchHeader(cell) {
  if (cell === null || cell === undefined) return null;
  const c = String(cell).trim().toLowerCase();
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(c)) return key;
  }
  return null;
}

function mapColumns(headerRow) {
  const mapping = {};
  headerRow.forEach((cell, idx) => {
    const key = matchHeader(cell);
    if (key && !(key in mapping)) mapping[key] = idx;
  });
  // Fallback for a header-less / unrecognised sheet: assume canonical order.
  if (!('phone' in mapping)) {
    ['company', 'name', 'designation', 'phone'].forEach((key, i) => {
      if (!(key in mapping)) mapping[key] = i;
    });
  }
  return mapping;
}

function rowLooksLikeHeader(row) {
  return row.some((c) => matchHeader(c));
}

function readRows(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  // SheetJS reads xlsx, xlsm, csv, tsv, txt from a buffer transparently.
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
  const wsName = wb.SheetNames[0];
  if (!wsName) return [];
  const ws = wb.Sheets[wsName];
  // header:1 -> array of arrays; defval keeps column positions stable.
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
}

/**
 * Parse an uploaded contacts file buffer into a structured result.
 * @returns {{contacts: Array, total_rows, valid_count, invalid_count, duplicate_count, source}}
 */
function loadContacts(buffer, filename) {
  const rows = readRows(buffer, filename);
  const result = {
    contacts: [],
    total_rows: 0,
    valid_count: 0,
    invalid_count: 0,
    duplicate_count: 0,
    source: filename,
  };
  if (!rows.length) return result;

  let mapping, dataRows;
  const header = rows[0] || [];
  if (rowLooksLikeHeader(header)) {
    mapping = mapColumns(header);
    dataRows = rows.slice(1);
  } else {
    mapping = mapColumns([]);
    dataRows = rows;
  }

  const seen = new Set();
  for (const row of dataRows) {
    if (!row) continue;
    if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;

    const get = (key) => {
      const i = mapping[key];
      if (i === undefined || i >= row.length || row[i] === null || row[i] === undefined) return '';
      return String(row[i]).trim();
    };

    const c = {
      company: get('company'),
      name: get('name'),
      designation: get('designation'),
      phone_raw: get('phone'),
      phone: '',
      valid: false,
      reason: '',
    };
    const norm = normalizePhone(c.phone_raw);
    c.phone = norm.phone;
    c.valid = norm.valid;
    c.reason = norm.reason;

    result.total_rows += 1;
    if (c.valid) {
      if (seen.has(c.phone)) {
        c.valid = false;
        c.reason = 'duplicate';
        result.duplicate_count += 1;
      } else {
        seen.add(c.phone);
        result.valid_count += 1;
      }
    } else {
      result.invalid_count += 1;
    }
    result.contacts.push(c);
  }

  return result;
}

module.exports = { loadContacts, HEADER_ALIASES };
