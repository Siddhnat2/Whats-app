'use strict';

/**
 * Application-wide configuration, paths and constants.
 *
 * Everything that used to be hard-coded for the desktop build is now driven by
 * environment variables so the exact same image runs locally and on Railway.
 */

const path = require('path');
const fs = require('fs');

// Load .env for local development (no-op if the file is absent / on Railway).
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const APP_NAME = 'WhatsApp Campaign Studio';
const APP_VERSION = '2.0.0';
const ORG_NAME = 'AskMyCFO';

// ---------------------------------------------------------------- runtime mode
const MOCK = process.env.MOCK === '1' || process.argv.includes('--mock');
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// --------------------------------------------------------------- writable data
// On Railway you attach a Volume and mount it at DATA_DIR (default /data). All
// state that must survive a redeploy — the SQLite DB, the WhatsApp Web session,
// uploaded attachments and sessions — lives under here.
function resolveDataDir() {
  const fromEnv = process.env.DATA_DIR && process.env.DATA_DIR.trim();
  if (fromEnv) return path.resolve(fromEnv);
  // Local fallback: ./data next to the project root.
  return path.resolve(__dirname, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');       // attachments + imports
const AUTH_DIR = path.join(DATA_DIR, '.wwebjs_auth');    // whatsapp-web.js LocalAuth
const CACHE_DIR = path.join(DATA_DIR, '.wwebjs_cache');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');     // express-session store
const DB_PATH = path.join(DATA_DIR, 'campaign.db');

// Make sure every writable path exists before anything touches it.
for (const dir of [DATA_DIR, UPLOAD_DIR, AUTH_DIR, CACHE_DIR, SESSION_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
}

// ----------------------------------------------------------------- networking
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ------------------------------------------------------------------- security
// Set ADMIN_PASSWORD in Railway to lock the app. If unset in production the
// server refuses to start (see server.js) rather than exposing an open sender.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// SESSION_SECRET signs the login cookie. A stable value keeps users logged in
// across restarts; a random fallback is fine but logs everyone out on reboot.
const SESSION_SECRET =
  process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS) || 12;

// ------------------------------------------------------------------ campaigns
// Sending defaults (milliseconds between messages, randomised in this range).
const DEFAULT_MIN_DELAY_MS = Number(process.env.DEFAULT_MIN_DELAY_MS) || 4000;
const DEFAULT_MAX_DELAY_MS = Number(process.env.DEFAULT_MAX_DELAY_MS) || 9000;
const DEFAULT_DAILY_CAP = Number(process.env.DEFAULT_DAILY_CAP) || 200;
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '91'; // India

// ---------------------------------------------------------------- attachments
const ALLOWED_ATTACH_EXT = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.mp4', '.mov', '.avi', '.mp3', '.wav', '.ogg', '.zip',
]);
const MAX_ATTACH_MB = Number(process.env.MAX_ATTACH_MB) || 64;

// Puppeteer / Chromium executable. On the Docker image we install Chromium and
// point at it; locally whatsapp-web.js falls back to its bundled download.
const CHROMIUM_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_BIN ||
  '';

module.exports = {
  APP_NAME, APP_VERSION, ORG_NAME,
  MOCK, NODE_ENV, IS_PROD,
  DATA_DIR, UPLOAD_DIR, AUTH_DIR, CACHE_DIR, SESSION_DIR, DB_PATH,
  PORT, HOST,
  ADMIN_PASSWORD, SESSION_SECRET, SESSION_TTL_HOURS,
  DEFAULT_MIN_DELAY_MS, DEFAULT_MAX_DELAY_MS, DEFAULT_DAILY_CAP, DEFAULT_COUNTRY_CODE,
  ALLOWED_ATTACH_EXT, MAX_ATTACH_MB,
  CHROMIUM_PATH,
};
