'use strict';

/**
 * WhatsApp engine — web edition.
 *
 * This is the SAME whatsapp-web.js logic that the desktop app ran in a separate
 * Node worker (engine/worker.js). Instead of talking over stdin/stdout to a
 * PySide6 GUI, it now lives in-process and emits events on an EventEmitter that
 * the Express/Socket.IO layer forwards to the browser.
 *
 * The real sending path — getNumberId() validation, MessageMedia.fromFilePath(),
 * sendMessage() with caption, per-file gaps and randomised inter-message delays
 * — is preserved byte-for-byte from the original worker so behaviour is identical.
 *
 * Set MOCK=1 to run a fully simulated engine with no real WhatsApp connection.
 */

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const config = require('./config');

// ---------------------------------------------------------------- helpers
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randBetween(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sanitizeNumber(n) { return String(n || '').replace(/[^\d]/g, ''); }

class WhatsAppEngine extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.clientReady = false;
    this.sending = false;
    this.cancelRequested = false;
    this.initializing = false;
    // Cached connection snapshot the web layer serves to new browser tabs.
    this.state = {
      status: 'disconnected', // disconnected | initializing | qr | authenticated | ready
      qr: null,               // last raw QR string
      loading: null,          // {percent, message}
      info: null,             // {pushname, wid}
      mock: config.MOCK,
    };
  }

  log(level, message) { this.emit('log', { level, message: String(message) }); }

  _setStatus(status, extra = {}) {
    this.state.status = status;
    Object.assign(this.state, extra);
    this.emit('status', this.snapshot());
  }

  snapshot() {
    return {
      status: this.state.status,
      qr: this.state.qr,
      loading: this.state.loading,
      info: this.state.info,
      ready: this.clientReady,
      sending: this.sending,
      mock: config.MOCK,
    };
  }

  isConnected() { return this.clientReady; }

  // ==================================================================== init
  async init() {
    if (this.clientReady || this.initializing) {
      // Re-broadcast current state so a fresh browser tab syncs up.
      this.emit('status', this.snapshot());
      return;
    }
    this.initializing = true;
    this.state.qr = null;
    this._setStatus('initializing');
    try {
      if (config.MOCK) await this._mockInit();
      else await this._realInit();
    } catch (e) {
      this.initializing = false;
      this.emit('fatal', { message: 'init failed: ' + (e && e.message || e) });
      this._setStatus('disconnected');
    }
  }

  // ---------------------------------------------------- MOCK (no real WhatsApp)
  async _mockInit() {
    this.log('info', 'MOCK engine starting');
    await sleep(300);
    this.state.qr = 'MOCK-QR-CODE-SCAN-ME-1';
    this._setStatus('qr');
    this.emit('qr', { data: this.state.qr });
    await sleep(1200);
    this.state.loading = { percent: 40, message: 'Linking device' };
    this._setStatus('authenticated', { loading: this.state.loading });
    this.emit('authenticated');
    await sleep(600);
    this.clientReady = true;
    this.initializing = false;
    this.state.qr = null;
    this.state.info = { pushname: 'Mock User', wid: '910000000000@c.us' };
    this._setStatus('ready', { info: this.state.info });
    this.emit('ready', this.state.info);
  }

  async _mockSend(jobs, minDelay, maxDelay) {
    this.emit('send_start', { total: jobs.length });
    for (let i = 0; i < jobs.length; i++) {
      if (this.cancelRequested) { this.emit('cancelled', { sent: i, total: jobs.length }); return; }
      const job = jobs[i];
      const num = sanitizeNumber(job.number);
      await sleep(120);
      let status = 'sent';
      let error = null;
      if (!num || num.length < 8) { status = 'failed'; error = 'invalid number'; }
      else if (num.endsWith('0000')) { status = 'not_registered'; }
      else if (num.endsWith('9999')) { status = 'failed'; error = 'simulated failure'; }
      this.emit('send_progress', {
        id: job.id, number: num, index: i + 1, total: jobs.length,
        status, error, mediaCount: (job.media || []).length,
      });
      if (i < jobs.length - 1 && !this.cancelRequested) {
        await sleep(Math.min(300, randBetween(minDelay, maxDelay)));
      }
    }
    this.emit('send_done', { total: jobs.length });
  }

  // ------------------------------------------------------- REAL (whatsapp-web.js)
  async _realInit() {
    const { Client, LocalAuth } = require('whatsapp-web.js');

    const puppeteer = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',

      ],
    };
    if (config.CHROMIUM_PATH) puppeteer.executablePath = config.CHROMIUM_PATH;

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: config.AUTH_DIR }),
      puppeteer,
    });

    this.client.on('qr', (qr) => {
      this.state.qr = qr;
      this._setStatus('qr');
      this.emit('qr', { data: qr });
    });
    this.client.on('loading_screen', (percent, message) => {
      this.state.loading = { percent: Number(percent) || 0, message: message || '' };
      this.emit('loading', this.state.loading);
      this._setStatus(this.state.status, { loading: this.state.loading });
    });
    this.client.on('authenticated', () => {
      this._setStatus('authenticated');
      this.emit('authenticated');
    });
    this.client.on('auth_failure', (msg) => {
      this.emit('auth_failure', { message: String(msg) });
      this._setStatus('disconnected');
    });
    this.client.on('change_state', (state) => this.emit('state', { state }));
    this.client.on('disconnected', (reason) => {
      this.clientReady = false;
      this.state.info = null;
      this.state.qr = null;
      this.emit('disconnected', { reason: String(reason) });
      this._setStatus('disconnected');
      // whatsapp-web.js destroys its browser on disconnect; allow re-init.
      this.client = null;
    });
    this.client.on('ready', () => {
      this.clientReady = true;
      this.initializing = false;
      let info = {};
      try {
        info = {
          pushname: this.client.info && this.client.info.pushname,
          wid: this.client.info && this.client.info.wid && this.client.info.wid._serialized,
        };
      } catch (_) { /* ignore */ }
      this.state.info = info;
      this.state.qr = null;
      this._setStatus('ready', { info });
      this.emit('ready', info);
    });

    this.log('info', 'Initializing WhatsApp client (headless Chromium)…');
    await this.client.initialize();
  }

  async _realSend(jobs, minDelay, maxDelay) {
    const { MessageMedia } = require('whatsapp-web.js');
    this.emit('send_start', { total: jobs.length });

    for (let i = 0; i < jobs.length; i++) {
      if (this.cancelRequested) { this.emit('cancelled', { sent: i, total: jobs.length }); return; }

      const job = jobs[i];
      const num = sanitizeNumber(job.number);
      const chatId = `${num}@c.us`;
      const media = Array.isArray(job.media) ? job.media : [];
      const message = job.message || '';
      let status = 'sent';
      let error = null;

      try {
        if (!num || num.length < 8) throw new Error('invalid number');

        const numberId = await this.client.getNumberId(num); // resolves & validates registration
        if (!numberId) {
          status = 'not_registered';
        } else {
          const target = numberId._serialized || chatId;
          const validMedia = media.filter((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });

          if (validMedia.length === 0) {
            if (message.trim()) await this.client.sendMessage(target, message);
          } else {
            // First attachment carries the message as its caption; rest sent bare.
            for (let m = 0; m < validMedia.length; m++) {
              const mm = MessageMedia.fromFilePath(validMedia[m]);
              const opts = (m === 0 && message.trim()) ? { caption: message } : {};
              await this.client.sendMessage(target, mm, opts);
              if (m < validMedia.length - 1) await sleep(1200);
            }
          }
          status = 'sent';
        }
      } catch (err) {
        status = 'failed';
        error = err && err.message ? err.message : String(err);
      }

      this.emit('send_progress', {
        id: job.id, number: num, index: i + 1, total: jobs.length,
        status, error, mediaCount: media.length,
      });

      if (i < jobs.length - 1 && !this.cancelRequested) {
        await sleep(randBetween(minDelay, maxDelay));
      }
    }
    this.emit('send_done', { total: jobs.length });
  }

  // ================================================================== commands
  async send(jobs, minDelay, maxDelay) {
    if (this.sending) { this.log('warn', 'send ignored — already sending'); return; }
    if (!this.clientReady) { this.emit('auth_failure', { message: 'not connected' }); return; }
    const minD = Number(minDelay) || config.DEFAULT_MIN_DELAY_MS;
    const maxD = Math.max(minD, Number(maxDelay) || config.DEFAULT_MAX_DELAY_MS);
    this.sending = true;
    this.cancelRequested = false;
    this.emit('status', this.snapshot());
    try {
      if (config.MOCK) await this._mockSend(jobs, minD, maxD);
      else await this._realSend(jobs, minD, maxD);
    } catch (e) {
      this.emit('fatal', { message: 'send failed: ' + (e && e.message || e) });
    } finally {
      this.sending = false;
      this.cancelRequested = false;
      this.emit('status', this.snapshot());
    }
  }

  cancel() {
    if (this.sending) { this.cancelRequested = true; this.log('info', 'cancel requested'); }
  }

  async logout() {
    if (config.MOCK) {
      this.clientReady = false;
      this.state.info = null;
      this.state.qr = null;
      this.emit('disconnected', { reason: 'logout' });
      this._setStatus('disconnected');
      return;
    }
    try {
      if (this.client) { await this.client.logout(); await this.client.destroy(); }
    } catch (e) { this.log('warn', 'logout: ' + (e.message || e)); }
    this.client = null;
    this.clientReady = false;
    this.state.info = null;
    this.state.qr = null;
    // Best-effort wipe of the auth folder so next init shows a fresh QR.
    try { fs.rmSync(config.AUTH_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    try { fs.mkdirSync(config.AUTH_DIR, { recursive: true }); } catch (_) { /* ignore */ }
    this.emit('disconnected', { reason: 'logout' });
    this._setStatus('disconnected');
  }

  async shutdown() {
    try { if (this.client) await this.client.destroy(); } catch (_) { /* ignore */ }
    this.client = null;
    this.clientReady = false;
  }
}

// Single shared engine instance for the whole process.
const engine = new WhatsAppEngine();
module.exports = engine;
