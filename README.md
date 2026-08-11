# WhatsApp Campaign Studio — Web Edition

Bulk, **personalised** WhatsApp campaigns from your browser. Import contacts from
Excel/CSV, write reusable templates with variables like `{first_name}` and
`{company}`, attach files, and send at a safe, randomised pace — with live
progress and full send history.

This is the **web edition** of the original desktop app, rebuilt as a single
Node.js service so it deploys cleanly to **Railway** (or any Docker host). The
actual WhatsApp sending core (`whatsapp-web.js`) is **unchanged** — same
number-validation, media handling, captions and pacing as before.

> ⚠️ **Use responsibly.** This automates a real WhatsApp account via WhatsApp
> Web. Mass unsolicited messaging can get a number banned by WhatsApp. Keep the
> delays on, respect opt-outs, and only message people who expect to hear from you.

---

## What changed from the desktop app

| Desktop app | Web edition |
|---|---|
| PySide6 GUI (Windows only) | Browser UI (any device) |
| Python controls a Node worker over stdin/stdout | One Node.js process; engine runs in-process |
| SQLite on the local machine | SQLite on a mounted volume |
| Session/DB in `%APPDATA%` | Session/DB under `DATA_DIR` (e.g. `/data`) |
| No login (single-user desktop) | Password login (`ADMIN_PASSWORD`) |

The WhatsApp logic itself (QR pairing, `getNumberId` validation,
`MessageMedia.fromFilePath`, captions, per-message delays, cancel) is a faithful
carry-over of the original engine.

---

## Features

- **Contacts** — import `.xlsx` / `.csv` (auto-detects columns; normalises phone
  numbers to `country code + number`), add manually, search, dedupe, delete.
- **Templates** — reusable messages with `{name} {first_name} {company}
  {designation} {phone}`, live preview.
- **Attachments** — upload files once, reuse across campaigns (first file carries
  the message as its caption, exactly like the desktop app).
- **Compose** — pick recipients, template and files; set min/max delay; send.
- **Live progress** — real-time per-recipient status over WebSockets, with a log
  and a Stop button.
- **History** — every message with outcome (sent / not-on-WhatsApp / failed).
- **Connect** — scan the QR from the browser; session persists across restarts.
- **Security** — single-password login, timing-safe compare, login rate-limit,
  server-side sessions.

---

## Quick start (local)

```bash
npm install
cp .env.example .env        # set ADMIN_PASSWORD (optional locally)
npm start                   # http://localhost:3000
```

Try it **without a real WhatsApp** using the built-in simulator:

```bash
npm run mock                # fake engine: QR, fake sends, deterministic results
```

Local Chromium note: `whatsapp-web.js` needs Chromium. Locally, `npm install`
downloads one automatically. The Docker image installs system Chromium instead
(see `Dockerfile`), which is what Railway uses.

---

## Deploy to Railway

See **[DEPLOY_RAILWAY.md](./DEPLOY_RAILWAY.md)** for the full step-by-step.
Short version:

1. Push this folder to a Git repo and create a Railway project **from the repo**
   (Railway auto-detects the `Dockerfile`).
2. Add a **Volume** mounted at `/data`.
3. Set variables: `ADMIN_PASSWORD`, `SESSION_SECRET`, `DATA_DIR=/data`.
4. Deploy, open the URL, sign in, go to **Connect** and scan the QR.

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ADMIN_PASSWORD` | **yes (prod)** | – | Password for the login screen. Server refuses to start in production without it. |
| `SESSION_SECRET` | recommended | random | Signs login cookies; set a fixed value so logins survive restarts. |
| `DATA_DIR` | recommended | `./data` | Where DB, WhatsApp session and uploads live. Point at your volume (`/data`). |
| `PORT` | no | `3000` | Provided automatically by Railway. |
| `DEFAULT_MIN_DELAY_MS` | no | `4000` | Default min gap between messages. |
| `DEFAULT_MAX_DELAY_MS` | no | `9000` | Default max gap between messages. |
| `DEFAULT_DAILY_CAP` | no | `200` | Soft daily-volume warning. |
| `DEFAULT_COUNTRY_CODE` | no | `91` | Prefixed to bare 10-digit numbers. |
| `MAX_ATTACH_MB` | no | `64` | Per-file attachment limit. |
| `MOCK` | no | `0` | `1` runs the simulated engine (no real WhatsApp). |
| `PUPPETEER_EXECUTABLE_PATH` | no | (Docker sets it) | Path to Chromium. |

---

## Architecture

```
Browser (public/) ──HTTP + WebSocket──►  Express + Socket.IO (src/server.js)
                                          │
                    ┌─────────────────────┼───────────────────────┐
                    ▼                     ▼                         ▼
             REST API (routes/)     WhatsApp engine          SQLite (better-sqlite3)
             auth, contacts,        (src/whatsapp.js —        contacts, templates,
             templates, campaign    whatsapp-web.js,          attachments, history,
             history, settings      unchanged logic)          settings   → DATA_DIR
```

- `src/lib/phone.js`, `templating.js`, `contacts.js` — business logic ported 1:1
  from the desktop app's Python.
- `src/campaign.js` — records every send result to history as the engine reports it.
- One process, one port — ideal for a single Railway service.

---

## Project layout

```
├── Dockerfile            # Chromium + Node, Railway build
├── railway.json          # build + healthcheck config
├── .env.example          # all env vars documented
├── src/
│   ├── server.js         # Express + Socket.IO + auth wiring
│   ├── config.js         # env-driven config & paths
│   ├── db.js             # SQLite schema + queries
│   ├── whatsapp.js       # whatsapp-web.js engine (unchanged logic)
│   ├── campaign.js       # history recording
│   ├── lib/              # phone, templating, contact import
│   └── routes/           # auth.js, api.js
└── public/               # login.html, index.html, app.js, styles.css
```

---

## Health check

`GET /healthz` → `{ "ok": true, ... }` (used by Railway's healthcheck).

---

Built for **AskMyCFO**. WhatsApp is a trademark of Meta; this project is not
affiliated with or endorsed by WhatsApp/Meta.
