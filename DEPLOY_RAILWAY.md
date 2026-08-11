# Deploying to Railway — step by step

This app is a single Node.js service with a `Dockerfile`. Railway builds the
Docker image, runs one container, and gives you a public HTTPS URL.

Total time: ~10 minutes. You need a Railway account (railway.com) and a place to
host the code (GitHub repo recommended).

---

## 1. Put the code in a Git repo

Railway deploys best from a GitHub repo (it auto-redeploys on push).

```bash
cd whatsapp-campaign-studio-web
git init
git add .
git commit -m "WhatsApp Campaign Studio — web edition"
# create an empty repo on GitHub, then:
git remote add origin https://github.com/<you>/whatsapp-campaign-studio.git
git branch -M main
git push -u origin main
```

> Prefer no GitHub? Install the Railway CLI (`npm i -g @railway/cli`), run
> `railway login`, then `railway init` and `railway up` from this folder. The
> steps below (volume + variables) are the same, done in the dashboard.

---

## 2. Create the Railway project

1. Railway dashboard → **New Project** → **Deploy from GitHub repo**.
2. Pick your repo. Railway detects the `Dockerfile` and starts the first build.
3. Let the first build finish (it installs Chromium — a few minutes the first time).

---

## 3. Add a Volume (so data survives redeploys) — **important**

Without a volume, every redeploy wipes the database **and** the WhatsApp login,
forcing a re-scan and losing contacts/history.

1. Open your service → **Variables/Settings** area → **Volumes** → **New Volume**.
2. Set the **Mount path** to:

   ```
   /data
   ```

3. Save. Railway will redeploy with the volume attached.

---

## 4. Set environment variables

Service → **Variables** → add these:

| Variable | Value |
|---|---|
| `ADMIN_PASSWORD` | a strong password you'll use to log in |
| `SESSION_SECRET` | a long random string (see below) |
| `DATA_DIR` | `/data` |

Generate a good `SESSION_SECRET` locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

You do **not** need to set `PORT` — Railway injects it and the app reads it.
`NODE_ENV=production` is already set by the Dockerfile.

> If `ADMIN_PASSWORD` is missing in production, the app refuses to start — this is
> deliberate, so you never expose an open WhatsApp sender to the internet.

---

## 5. Generate a public URL

Service → **Settings** → **Networking** → **Generate Domain**.
You'll get something like `https://your-app.up.railway.app`.

---

## 6. First run

1. Open the URL → you'll see the **sign-in** screen. Enter your `ADMIN_PASSWORD`.
2. Go to **Connect** → click **Connect** → a QR code appears.
3. On your phone: **WhatsApp → Settings → Linked devices → Link a device** →
   scan the QR. The page flips to **Connected**.
4. Go to **Contacts** → **Import Excel / CSV** (or add contacts manually).
5. Go to **Templates** → create a message; optionally upload attachments.
6. Go to **Compose** → pick recipients + template → **Send campaign**. Watch
   live progress; results land in **History**.

The WhatsApp session is stored on the volume, so after a redeploy you stay
linked — no re-scan needed.

---

## Notes, tips & troubleshooting

**QR never appears / "Starting engine…" forever.**
Chromium failed to launch. Check the deploy **Logs**. The provided `Dockerfile`
installs everything Chromium needs; if you changed the base image, make sure the
`libnss3 … libgbm1` packages are still installed and
`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` is set.

**Healthcheck.** Railway pings `/healthz`. If deploys are marked unhealthy,
confirm the service is listening on Railway's `PORT` (it is by default) and that
the first Chromium-heavy build finished.

**Memory.** Headless Chromium is memory-hungry. If the container is killed under
load (OOM), bump the service's memory in Railway settings. A single Chromium
session is fine on the smaller tiers; very large campaigns benefit from more RAM.

**Bans / rate limits.** Keep the randomised delays (Compose → Pace). Sending a
large volume quickly, or to people who never opted in, risks WhatsApp banning the
number. Start small.

**Backups.** Everything important is in `/data` (`campaign.db`, `.wwebjs_auth`,
`uploads/`). To back up, download the volume contents or copy `campaign.db`.

**Re-linking a different number.** Connect page → **Unlink / Log out**, then
**Connect** again and scan with the new phone.

**Custom domain.** Railway → Networking → add your own domain and point DNS as
instructed.
