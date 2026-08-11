'use strict';

/**
 * WhatsApp Campaign Studio — web server (Railway-ready).
 *
 * One Node.js process serves:
 *   • the browser UI (public/)
 *   • a REST API (routes/api.js)
 *   • password login (routes/auth.js)
 *   • real-time engine events over Socket.IO (QR, send progress, status)
 *
 * The whatsapp-web.js engine (src/whatsapp.js) runs in-process; its logic is
 * unchanged from the original desktop Node worker.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const config = require('./config');
const engine = require('./whatsapp');
require('./campaign'); // wires history recording to engine events

const { router: authRouter, requireAuth, requirePage } = require('./routes/auth');
const apiRouter = require('./routes/api');

// ------------------------------------------------------ fail-fast on prod misconfig
if (config.IS_PROD && !config.ADMIN_PASSWORD) {
  // Refuse to expose an open WhatsApp sender to the internet.
  console.error(
    '\n[FATAL] ADMIN_PASSWORD is not set. Set it in your Railway variables ' +
    'before deploying (the app is publicly reachable).\n');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // behind Railway's proxy — needed for secure cookies

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

// ---------------------------------------------------------------- middleware
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: config.SESSION_DIR }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.IS_PROD,
    maxAge: config.SESSION_TTL_HOURS * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

// ------------------------------------------------------------- health check
app.get('/healthz', (_req, res) => res.json({ ok: true, app: config.APP_NAME, version: config.APP_VERSION }));

// --------------------------------------------------------------- auth routes
app.use(authRouter);

// ------------------------------------------------------------------ pages
const PUB = path.join(__dirname, '..', 'public');
app.get('/login', (req, res) => {
  if (req.session && req.session.authed) return res.redirect('/');
  res.sendFile(path.join(PUB, 'login.html'));
});
app.get('/', requirePage, (_req, res) => res.sendFile(path.join(PUB, 'index.html')));

// Static assets (css/js) are public; the app shell itself is guarded above.
app.use(express.static(PUB, { index: false }));

// -------------------------------------------------------------- protected API
app.use('/api', requireAuth, apiRouter);

// ---------------------------------------------------------- 404 + error guard
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ ok: false, error: 'not found' });
  res.redirect('/');
});
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || (err.message && /not allowed|too large|LIMIT_FILE_SIZE/i.test(err.message) ? 400 : 500);
  res.status(status).json({ ok: false, error: err.message || 'server error' });
});

// ============================================================ Socket.IO layer
// Only authenticated sessions may open a socket.
io.engine.use((req, res, next) => sessionMiddleware(req, res, next));
io.use((socket, next) => {
  const sess = socket.request.session;
  if (sess && sess.authed) return next();
  next(new Error('unauthorized'));
});

io.on('connection', async (socket) => {
  // Sync the newcomer with the current engine state (+ QR image if present).
  const snap = engine.snapshot();
  socket.emit('status', snap);
  // Only push a QR to a fresh tab if we are actually waiting on a scan.
  if (snap.qr && snap.status === 'qr' && !snap.ready) {
    try { socket.emit('qr', { data: snap.qr, image: await toQrImage(snap.qr) }); } catch (_) { /* ignore */ }
  }

  socket.on('connect_whatsapp', () => engine.init().catch(() => {}));
  socket.on('logout_whatsapp', () => engine.logout().catch(() => {}));
  socket.on('cancel_campaign', () => engine.cancel());
});

async function toQrImage(data) {
  return QRCode.toDataURL(data, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
}

// Forward every engine event to all connected browsers.
engine.on('qr', async (evt) => {
  let image = null;
  try { image = await toQrImage(evt.data); } catch (_) { /* ignore */ }
  io.emit('qr', { data: evt.data, image });
});
engine.on('status', (snap) => io.emit('status', snap));
engine.on('loading', (p) => io.emit('loading', p));
engine.on('authenticated', () => io.emit('authenticated'));
engine.on('ready', (info) => io.emit('ready', info));
engine.on('auth_failure', (e) => io.emit('auth_failure', e));
engine.on('disconnected', (e) => io.emit('disconnected', e));
engine.on('state', (e) => io.emit('state', e));
engine.on('send_start', (e) => io.emit('send_start', e));
engine.on('send_progress', (e) => io.emit('send_progress', e));
engine.on('send_done', (e) => io.emit('send_done', e));
engine.on('cancelled', (e) => io.emit('cancelled', e));
engine.on('log', (e) => io.emit('log', e));
engine.on('fatal', (e) => io.emit('fatal', e));

// ------------------------------------------------------------------- startup
server.listen(config.PORT, config.HOST, () => {
  console.log(`\n${config.APP_NAME} v${config.APP_VERSION}`);
  console.log(`  mode        : ${config.MOCK ? 'MOCK (no real WhatsApp)' : 'LIVE (whatsapp-web.js)'}`);
  console.log(`  listening   : http://${config.HOST}:${config.PORT}`);
  console.log(`  data dir    : ${config.DATA_DIR}`);
  console.log(`  auth        : ${config.ADMIN_PASSWORD ? 'password-protected' : 'OPEN (no ADMIN_PASSWORD set)'}`);
  console.log('');
});

// -------------------------------------------------------------- graceful stop
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down…`);
  try { await engine.shutdown(); } catch (_) { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('rejection:', e));

module.exports = { app, server };
