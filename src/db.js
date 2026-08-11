'use strict';

/**
 * SQLite persistence layer — contacts, templates, attachments, send history,
 * settings. Same schema as the desktop app (database.py), implemented with
 * better-sqlite3 (synchronous, fast, zero external service).
 */

const Database = require('better-sqlite3');
const { DB_PATH } = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company      TEXT DEFAULT '',
    name         TEXT DEFAULT '',
    designation  TEXT DEFAULT '',
    phone        TEXT NOT NULL UNIQUE,
    phone_raw    TEXT DEFAULT '',
    valid        INTEGER DEFAULT 1,
    reason       TEXT DEFAULT '',
    created_at   REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    body        TEXT DEFAULT '',
    position    INTEGER DEFAULT 0,
    created_at  REAL DEFAULT 0,
    updated_at  REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT NOT NULL,
    filename    TEXT DEFAULT '',
    size_bytes  INTEGER DEFAULT 0,
    added_at    REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS send_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id   TEXT DEFAULT '',
    contact_id    INTEGER,
    phone         TEXT DEFAULT '',
    name          TEXT DEFAULT '',
    template_id   INTEGER,
    template_name TEXT DEFAULT '',
    status        TEXT DEFAULT '',
    error         TEXT DEFAULT '',
    media_count   INTEGER DEFAULT 0,
    sent_at       REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_hist_contact  ON send_history(contact_id);
CREATE INDEX IF NOT EXISTS idx_hist_campaign ON send_history(campaign_id);
CREATE INDEX IF NOT EXISTS idx_hist_template ON send_history(template_id);
`;

const now = () => Date.now() / 1000; // seconds, matching Python time.time()

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA);

// ------------------------------------------------------------------ contacts
function upsertContacts(contacts) {
  let inserted = 0;
  let updated = 0;
  const findStmt = db.prepare('SELECT id FROM contacts WHERE phone=?');
  const updateStmt = db.prepare(
    `UPDATE contacts SET company=?, name=?, designation=?, phone_raw=?, valid=?, reason=? WHERE id=?`);
  const insertStmt = db.prepare(
    `INSERT INTO contacts (company, name, designation, phone, phone_raw, valid, reason, created_at)
     VALUES (?,?,?,?,?,?,?,?)`);
  const t = now();
  const tx = db.transaction((rows) => {
    for (const c of rows) {
      if (!c.phone) continue;
      const row = findStmt.get(c.phone);
      const valid = c.valid ? 1 : 0;
      if (row) {
        updateStmt.run(c.company || '', c.name || '', c.designation || '',
          c.phone_raw || '', valid, c.reason || '', row.id);
        updated += 1;
      } else {
        insertStmt.run(c.company || '', c.name || '', c.designation || '', c.phone,
          c.phone_raw || '', valid, c.reason || '', t);
        inserted += 1;
      }
    }
  });
  tx(contacts);
  return { inserted, updated };
}

function allContacts(search = '', onlyValid = false) {
  let q = `
    SELECT c.*,
           (SELECT COUNT(*) FROM send_history h
              WHERE h.contact_id=c.id AND h.status='sent') AS sent_count,
           (SELECT h2.status FROM send_history h2
              WHERE h2.contact_id=c.id ORDER BY h2.sent_at DESC LIMIT 1) AS last_status,
           (SELECT h3.template_id FROM send_history h3
              WHERE h3.contact_id=c.id ORDER BY h3.sent_at DESC LIMIT 1) AS last_template_id
    FROM contacts c`;
  const clauses = [];
  const params = [];
  if (onlyValid) clauses.push('c.valid=1');
  if (search) {
    const like = `%${String(search).trim()}%`;
    clauses.push('(c.company LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR c.designation LIKE ?)');
    params.push(like, like, like, like);
  }
  if (clauses.length) q += ' WHERE ' + clauses.join(' AND ');
  q += ' ORDER BY c.company COLLATE NOCASE, c.name COLLATE NOCASE';
  return db.prepare(q).all(...params);
}

function contactsByIds(ids) {
  if (!ids || !ids.length) return [];
  const byId = new Map(allContacts().map((c) => [c.id, c]));
  return ids.map((i) => byId.get(i)).filter(Boolean);
}

function addSingleContact(company, name, designation, phoneRaw) {
  const { normalizePhone } = require('./lib/phone');
  const { phone, valid, reason } = normalizePhone(phoneRaw);
  if (!valid) return { result: 'invalid', detail: reason || 'invalid number' };
  const row = db.prepare('SELECT id FROM contacts WHERE phone=?').get(phone);
  if (row) {
    db.prepare(`UPDATE contacts SET company=?, name=?, designation=?, phone_raw=?, valid=1, reason='' WHERE id=?`)
      .run(company, name, designation, phoneRaw, row.id);
    return { result: 'updated', detail: phone };
  }
  db.prepare(`INSERT INTO contacts (company, name, designation, phone, phone_raw, valid, reason, created_at)
              VALUES (?,?,?,?,?,1,'',?)`)
    .run(company, name, designation, phone, phoneRaw, now());
  return { result: 'added', detail: phone };
}

function deleteContacts(ids) {
  if (!ids || !ids.length) return;
  const stmt = db.prepare('DELETE FROM contacts WHERE id=?');
  const tx = db.transaction((list) => { for (const i of list) stmt.run(i); });
  tx(ids);
}

function clearContacts() {
  db.prepare('DELETE FROM contacts').run();
}

function contactCounts() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  const valid = db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE valid=1').get().n;
  return { total, valid, invalid: total - valid };
}

// ----------------------------------------------------------------- templates
function listTemplates() {
  return db.prepare('SELECT * FROM templates ORDER BY position, id').all();
}
function addTemplate(name, body = '') {
  const t = now();
  const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM templates').get().p;
  const info = db.prepare(
    'INSERT INTO templates (name, body, position, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(name, body, pos, t, t);
  return info.lastInsertRowid;
}
function updateTemplate(tid, name, body) {
  db.prepare('UPDATE templates SET name=?, body=?, updated_at=? WHERE id=?')
    .run(name, body, now(), tid);
}
function deleteTemplate(tid) {
  db.prepare('DELETE FROM templates WHERE id=?').run(tid);
}
function getTemplate(tid) {
  return db.prepare('SELECT * FROM templates WHERE id=?').get(tid);
}

// --------------------------------------------------------------- attachments
function listAttachments() {
  return db.prepare('SELECT * FROM attachments ORDER BY added_at DESC').all();
}
function addAttachment(path, filename, sizeBytes) {
  const existing = db.prepare('SELECT id FROM attachments WHERE path=?').get(path);
  if (existing) return existing.id;
  const info = db.prepare(
    'INSERT INTO attachments (path, filename, size_bytes, added_at) VALUES (?,?,?,?)')
    .run(path, filename, sizeBytes, now());
  return info.lastInsertRowid;
}
function getAttachment(aid) {
  return db.prepare('SELECT * FROM attachments WHERE id=?').get(aid);
}
function deleteAttachment(aid) {
  db.prepare('DELETE FROM attachments WHERE id=?').run(aid);
}

// ----------------------------------------------------------- send history
function recordSend(campaignId, contact, templateId, templateName, status, error, mediaCount) {
  db.prepare(
    `INSERT INTO send_history
       (campaign_id, contact_id, phone, name, template_id, template_name, status, error, media_count, sent_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(campaignId, contact.id, contact.phone, contact.name, templateId,
      templateName, status, error, mediaCount, now());
}
function history(limit = 500) {
  return db.prepare('SELECT * FROM send_history ORDER BY sent_at DESC LIMIT ?').all(limit);
}
function historyStats() {
  const row = db.prepare(
    `SELECT
       SUM(status='sent')           AS sent,
       SUM(status='not_registered') AS not_reg,
       SUM(status='failed')         AS failed,
       COUNT(*)                     AS total
     FROM send_history`).get();
  return {
    sent: row.sent || 0,
    not_registered: row.not_reg || 0,
    failed: row.failed || 0,
    total: row.total || 0,
  };
}
function clearHistory() {
  db.prepare('DELETE FROM send_history').run();
}

// ----------------------------------------------------------------- settings
function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

module.exports = {
  db,
  upsertContacts, allContacts, contactsByIds, addSingleContact, deleteContacts,
  clearContacts, contactCounts,
  listTemplates, addTemplate, updateTemplate, deleteTemplate, getTemplate,
  listAttachments, addAttachment, getAttachment, deleteAttachment,
  recordSend, history, historyStats, clearHistory,
  getSetting, setSetting,
};
