'use strict';

/**
 * REST API — contacts, templates, attachments, campaign control, history,
 * settings and dashboard stats. All routes are mounted behind requireAuth.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const db = require('../db');
const engine = require('../whatsapp');
const templating = require('../lib/templating');
const { loadContacts } = require('../lib/contacts');
const { normalizePhone } = require('../lib/phone');
const campaign = require('../campaign');

const router = express.Router();

// ------------------------------------------------------------------ uploads
// Contact-file imports are parsed from memory; attachments are stored on disk.
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^\w.-]+/g, '_').slice(0, 60);
    const stamp = crypto.randomBytes(6).toString('hex');
    cb(null, `${base}-${stamp}${ext.toLowerCase()}`);
  },
});
const attachUpload = multer({
  storage: diskStorage,
  limits: { fileSize: config.MAX_ATTACH_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (config.ALLOWED_ATTACH_EXT.has(ext)) return cb(null, true);
    cb(new Error(`File type ${ext || '(none)'} is not allowed`));
  },
});

const asInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

// ================================================================ dashboard
router.get('/stats', (_req, res) => {
  res.json({
    ok: true,
    contacts: db.contactCounts(),
    history: db.historyStats(),
    templates: db.listTemplates().length,
    attachments: db.listAttachments().length,
    connection: engine.snapshot(),
  });
});

// ================================================================= contacts
router.get('/contacts', (req, res) => {
  const search = req.query.search || '';
  const onlyValid = req.query.onlyValid === '1' || req.query.onlyValid === 'true';
  res.json({ ok: true, contacts: db.allContacts(search, onlyValid), counts: db.contactCounts() });
});

router.post('/contacts', (req, res) => {
  const { company = '', name = '', designation = '', phone = '' } = req.body || {};
  const r = db.addSingleContact(company.trim(), name.trim(), designation.trim(), phone.trim());
  if (r.result === 'invalid') return res.status(400).json({ ok: false, error: r.detail });
  res.json({ ok: true, ...r, counts: db.contactCounts() });
});

router.post('/contacts/import', memUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
  let result;
  try {
    result = loadContacts(req.file.buffer, req.file.originalname);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Could not read file: ' + (e.message || e) });
  }
  const validContacts = result.contacts.filter((c) => c.valid);
  const { inserted, updated } = db.upsertContacts(validContacts);
  res.json({
    ok: true,
    summary: {
      total: result.total_rows,
      valid: result.valid_count,
      invalid: result.invalid_count,
      duplicate: result.duplicate_count,
      inserted, updated,
    },
    counts: db.contactCounts(),
  });
});

router.delete('/contacts', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(asInt).filter((x) => x !== null) : [];
  if (req.body.all) db.clearContacts();
  else db.deleteContacts(ids);
  res.json({ ok: true, counts: db.contactCounts() });
});

// ================================================================ templates
router.get('/templates', (_req, res) => {
  res.json({ ok: true, templates: db.listTemplates(), variables: templating.AVAILABLE_VARIABLES });
});

router.post('/templates', (req, res) => {
  const name = (req.body.name || '').trim();
  const body = req.body.body || '';
  if (!name) return res.status(400).json({ ok: false, error: 'Template name is required' });
  const id = db.addTemplate(name, body);
  res.json({ ok: true, id, template: db.getTemplate(id) });
});

router.put('/templates/:id', (req, res) => {
  const id = asInt(req.params.id);
  if (id === null || !db.getTemplate(id)) return res.status(404).json({ ok: false, error: 'not found' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Template name is required' });
  db.updateTemplate(id, name, req.body.body || '');
  res.json({ ok: true, template: db.getTemplate(id) });
});

router.delete('/templates/:id', (req, res) => {
  const id = asInt(req.params.id);
  if (id !== null) db.deleteTemplate(id);
  res.json({ ok: true });
});

router.post('/templates/preview', (req, res) => {
  res.json({ ok: true, preview: templating.preview(req.body.body || '') });
});

// ============================================================== attachments
router.get('/attachments', (_req, res) => {
  res.json({ ok: true, attachments: db.listAttachments() });
});

router.post('/attachments', attachUpload.array('files', 10), (req, res) => {
  const added = [];
  for (const f of req.files || []) {
    const id = db.addAttachment(f.path, f.originalname, f.size);
    added.push({ id, filename: f.originalname, size_bytes: f.size });
  }
  res.json({ ok: true, added, attachments: db.listAttachments() });
});

router.delete('/attachments/:id', (req, res) => {
  const id = asInt(req.params.id);
  const row = id !== null ? db.getAttachment(id) : null;
  if (row) {
    try { fs.rmSync(row.path, { force: true }); } catch (_) { /* ignore */ }
    db.deleteAttachment(id);
  }
  res.json({ ok: true, attachments: db.listAttachments() });
});

// ================================================================= history
router.get('/history', (req, res) => {
  const limit = asInt(req.query.limit) || 500;
  res.json({ ok: true, history: db.history(limit), stats: db.historyStats() });
});

router.delete('/history', (_req, res) => {
  db.clearHistory();
  res.json({ ok: true, stats: db.historyStats() });
});

// ================================================================= settings
router.get('/settings', (_req, res) => {
  res.json({
    ok: true,
    settings: {
      min_delay_ms: asInt(db.getSetting('min_delay_ms', config.DEFAULT_MIN_DELAY_MS)),
      max_delay_ms: asInt(db.getSetting('max_delay_ms', config.DEFAULT_MAX_DELAY_MS)),
      daily_cap: asInt(db.getSetting('daily_cap', config.DEFAULT_DAILY_CAP)),
      country_code: db.getSetting('country_code', config.DEFAULT_COUNTRY_CODE),
    },
    defaults: {
      min_delay_ms: config.DEFAULT_MIN_DELAY_MS,
      max_delay_ms: config.DEFAULT_MAX_DELAY_MS,
      daily_cap: config.DEFAULT_DAILY_CAP,
    },
  });
});

router.post('/settings', (req, res) => {
  const { min_delay_ms, max_delay_ms, daily_cap } = req.body || {};
  if (min_delay_ms !== undefined) db.setSetting('min_delay_ms', asInt(min_delay_ms) || config.DEFAULT_MIN_DELAY_MS);
  if (max_delay_ms !== undefined) db.setSetting('max_delay_ms', asInt(max_delay_ms) || config.DEFAULT_MAX_DELAY_MS);
  if (daily_cap !== undefined) db.setSetting('daily_cap', asInt(daily_cap) || config.DEFAULT_DAILY_CAP);
  res.json({ ok: true });
});

// ============================================================ connection ctl
router.post('/connect', async (_req, res) => {
  engine.init().catch(() => {});
  res.json({ ok: true, connection: engine.snapshot() });
});

router.post('/logout-whatsapp', async (_req, res) => {
  await engine.logout();
  res.json({ ok: true, connection: engine.snapshot() });
});

router.get('/connection', (_req, res) => {
  res.json({ ok: true, connection: engine.snapshot() });
});

// ================================================================ campaign
router.post('/campaign/send', (req, res) => {
  if (engine.sending) return res.status(409).json({ ok: false, error: 'A campaign is already running' });
  if (!engine.isConnected()) {
    return res.status(400).json({ ok: false, error: 'WhatsApp is not connected. Connect it first.' });
  }

  const ids = Array.isArray(req.body.contactIds)
    ? req.body.contactIds.map(asInt).filter((x) => x !== null) : [];
  const templateId = asInt(req.body.templateId);
  const attachmentIds = Array.isArray(req.body.attachmentIds)
    ? req.body.attachmentIds.map(asInt).filter((x) => x !== null) : [];

  if (!ids.length) return res.status(400).json({ ok: false, error: 'Select at least one recipient' });
  const template = templateId !== null ? db.getTemplate(templateId) : null;
  if (!template) return res.status(400).json({ ok: false, error: 'Pick a message template' });

  const minDelay = asInt(req.body.minDelayMs) || asInt(db.getSetting('min_delay_ms', config.DEFAULT_MIN_DELAY_MS));
  const maxDelay = Math.max(minDelay, asInt(req.body.maxDelayMs) || asInt(db.getSetting('max_delay_ms', config.DEFAULT_MAX_DELAY_MS)));
  db.setSetting('min_delay_ms', minDelay);
  db.setSetting('max_delay_ms', maxDelay);

  const contacts = db.contactsByIds(ids);
  const media = [];
  for (const aid of attachmentIds) {
    const row = db.getAttachment(aid);
    if (row && fs.existsSync(row.path)) media.push(row.path);
  }

  const jobs = contacts.map((c) => ({
    id: c.id,
    number: c.phone,
    message: templating.render(template.body, c),
    media,
  }));

  const campaignId = campaign.begin(contacts, template);
  engine.send(jobs, minDelay, maxDelay).catch(() => {});

  res.json({
    ok: true,
    campaignId,
    total: jobs.length,
    template: template.name,
    attachments: media.length,
    minDelay, maxDelay,
  });
});

router.post('/campaign/cancel', (_req, res) => {
  engine.cancel();
  res.json({ ok: true });
});

module.exports = router;
