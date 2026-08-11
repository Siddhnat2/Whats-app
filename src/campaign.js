'use strict';

/**
 * Campaign controller — holds the metadata for the in-flight campaign and
 * persists each per-recipient result to send_history as the engine reports it.
 *
 * Mirrors page_compose._on_progress from the desktop app: every send_progress
 * event is written to the DB against the originating contact + template.
 */

const crypto = require('crypto');
const db = require('./db');
const engine = require('./whatsapp');

let current = null; // { id, jobmap: Map<id, contact>, templateId, templateName, counters }

function begin(contacts, template) {
  const id = crypto.randomBytes(6).toString('hex');
  const jobmap = new Map(contacts.map((c) => [c.id, c]));
  current = {
    id,
    jobmap,
    templateId: template.id,
    templateName: template.name,
    counters: { sent: 0, not_registered: 0, failed: 0 },
    total: contacts.length,
  };
  return id;
}

function _onProgress(evt) {
  if (!current) return;
  const status = evt.status || 'failed';
  current.counters[status] = (current.counters[status] || 0) + 1;
  const contact = current.jobmap.get(evt.id);
  if (contact) {
    db.recordSend(current.id, contact, current.templateId, current.templateName,
      status, evt.error || '', evt.mediaCount || 0);
  }
}

function _finish() {
  current = null;
}

// Wire once at startup. History recording happens here so it works no matter
// which client kicked the campaign off.
engine.on('send_progress', _onProgress);
engine.on('send_done', _finish);
engine.on('cancelled', _finish);

module.exports = { begin, get current() { return current; } };
