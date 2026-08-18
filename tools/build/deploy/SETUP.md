# Deploy the Basiq Agent to basiq.51st.media

This covers deploying the agent to the DigitalOcean droplet that's already
running — Caddy is already live proxying `basiq.51st.media` → `127.0.0.1:3000`
for the web app, and LucidLink is already mounted at `/mnt/lucidlink`. This
guide only adds the agent alongside what's already there. It does not touch
your existing Caddy site block for the web app except to insert one new
`handle_path` block into it.

The agent will be reachable at `https://basiq.51st.media/agent` — no new DNS
record needed, since it rides the domain you already have.

---

## Step 0: Generate an auth token (once)

From any machine with Python:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Save the output — you'll paste it into two places below (the server and the
web app's env vars). Anyone with this token can hit the agent, so treat it
like a password.

---

## Step 1: SSH in and locate (or clone) the repo

```bash
ssh root@YOUR_DROPLET_IP
```

Check whether the repo is already checked out somewhere on the box:

```bash
find / -maxdepth 4 -iname "basiq-studio-web" -type d 2>/dev/null
```

**If it found a path** (e.g. it's what's already serving the web app on
:3000), `cd` into it and skip to Step 2. **If nothing is found**, clone a
fresh copy for the agent to run from:

```bash
apt update && apt install -y python3 python3-venv python3-pip git ffmpeg
mkdir -p /opt/basiq-studio-web
git clone https://github.com/YOUR_GITHUB_ORG/basiq-studio-web.git /opt/basiq-studio-web
cd /opt/basiq-studio-web
```

Either way, pull the latest with the auth changes:

```bash
git pull
```

---

## Step 2: Install the agent's Python environment

```bash
cd /opt/basiq-studio-web/tools   # adjust if your checkout lives elsewhere
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
```

This pulls in torch + transformers for the intelligence layer (~2GB) — takes
a few minutes on a $6 droplet. It's optional; the agent runs fine without it
(Key Moments falls back to keyword labels, tags fall back to metadata only).
Skip installing `torch`/`transformers`/`spacy`/`keybert`/`sentence-transformers`
from `requirements.txt` if you'd rather keep the droplet lean — nothing else
depends on them.

Models download on first real use (`setup_models.py` pre-fetches them if you
want to warm the cache now):

```bash
.venv/bin/python setup_models.py
```

---

## Step 3: Create the `basiq` service user and set ownership

```bash
useradd -r -s /usr/sbin/nologin basiq 2>/dev/null || true
chown -R basiq:basiq /opt/basiq-studio-web
# LucidLink must be readable/writable by this user too:
usermod -aG "$(stat -c '%G' /mnt/lucidlink)" basiq 2>/dev/null || true
```

Verify `basiq` can actually see the media folder before moving on:

```bash
sudo -u basiq ls "/mnt/lucidlink/51st Media"
```

If that lists files, you're good. If it's empty or "Permission denied", fix
LucidLink's mount permissions before continuing — the agent will otherwise
report an empty library with no error.

---

## Step 4: Store the auth token outside the (world-readable) service file

```bash
cat > /etc/basiq-agent.env <<'EOF'
AUTH_TOKEN=PASTE_YOUR_TOKEN_FROM_STEP_0_HERE
EOF
chmod 600 /etc/basiq-agent.env
chown root:root /etc/basiq-agent.env
```

---

## Step 5: Install and start the systemd service

From your local machine:

```bash
scp tools/build/deploy/basiq-agent.service root@YOUR_DROPLET_IP:/etc/systemd/system/
```

Back on the droplet — **the shipped unit file assumes the repo lives at
`/opt/basiq-studio-web`; edit `WorkingDirectory`/`ExecStart` in
`/etc/systemd/system/basiq-agent.service` first if yours is elsewhere**:

```bash
systemctl daemon-reload
systemctl enable basiq-agent
systemctl start basiq-agent
systemctl status basiq-agent
```

Watch the logs until you see it come up clean:

```bash
journalctl -u basiq-agent -f
```

Expect:
```
Basiq agent listening on http://127.0.0.1:8000
  whisper: ready   yt-dlp: ready
```

**Test it locally on the droplet before touching Caddy** — this isolates
agent problems from proxy problems:

```bash
# No token: must be 401
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/health
# With token: must be 200
curl -s -H "Authorization: Bearer PASTE_YOUR_TOKEN" http://127.0.0.1:8000/health
```

---

## Step 6: Add the agent route to your existing Caddyfile

Open the live config:

```bash
nano /etc/caddy/Caddyfile
```

Find the `basiq.51st.media { ... }` block. Insert the `handle_path` block
from `tools/build/deploy/Caddyfile` (in this repo) **above** the line that
proxies to `127.0.0.1:3000`, so it looks like:

```
basiq.51st.media {
    handle_path /agent/* {
        reverse_proxy 127.0.0.1:8000 {
            header_up -X-Forwarded-For
            header_up -X-Forwarded-Proto
            transport http {
                keep_alive 30s
            }
        }
    }

    reverse_proxy 127.0.0.1:3000   # <- your existing line, unchanged
}
```

Order matters: Caddy checks handlers top to bottom, and the bare
`reverse_proxy 127.0.0.1:3000` has no path matcher, so it would swallow
`/agent/*` requests too if it came first.

Validate and reload (reload, not restart — it doesn't drop the web app's
existing connections):

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

---

## Step 7: Test from outside the droplet

```bash
# No token: must be 401
curl -s -o /dev/null -w "%{http_code}\n" https://basiq.51st.media/agent/health
# With token: must be 200 with a JSON health payload
curl -s -H "Authorization: Bearer PASTE_YOUR_TOKEN" https://basiq.51st.media/agent/health
```

---

## Step 8: Point the web app at the deployed agent

Set these two env vars wherever the Next.js app is actually built —
**Vercel** (Project → Settings → Environment Variables) if it's hosted
there, or `.env.local` on the droplet + a rebuild if `:3000` is a self-hosted
`next start` process on the same box:

```
NEXT_PUBLIC_WHISPER_URL=https://basiq.51st.media/agent
NEXT_PUBLIC_WHISPER_AUTH_TOKEN=PASTE_YOUR_TOKEN_FROM_STEP_0
```

`NEXT_PUBLIC_*` vars are baked in at build time, not read at runtime — a
plain restart won't pick up the change. Redeploy (Vercel) or rebuild + restart
(self-hosted: `npm run build && systemctl restart <your-app-service>` or
however :3000 is managed).

---

## Step 9: Verify end-to-end in a browser

Open the deployed web app, and check:
- The library loads (proves `/library` + auth works)
- A video actually plays (proves `/media/*` + the query-param token fallback
  works — video and download links can't send an `Authorization` header, so
  the agent also accepts `?token=` on `/media/*` only)
- A transcribe/tag/summarize job runs to completion (proves `/jobs/<id>`)

**GRAB and GO LIVE will fail here** — YouTube bot-blocks the droplet's
datacenter IP (403s, "sign in to confirm you're not a bot", PO-token
warnings) even though `/health` and everything else works fine. That's
expected; Step 10 fixes it.

---

## Step 10: Fix YouTube 403s — delegate GRAB/GO LIVE to a local worker

YouTube doesn't block a normal residential connection, so GRAB and GO LIVE
run on one designated always-on Windows or Mac machine instead of the
droplet. The droplet still creates and tracks the job — the worker just
does the actual download and reports back, so the web UI's queue, library,
and everything downstream is unaffected.

**On the droplet**, turn on delegation:

```bash
echo "DELEGATE_TO_WORKER=1" >> /etc/basiq-agent.env
systemctl restart basiq-agent
```

From this point on, `/grab` and `/capture` leave jobs `"Queued"` instead of
running them — nothing will download until a worker is running (Step 10
continues below). If the worker machine is ever off, flip this back to
confirm the rest of the app still works (`sed -i '/DELEGATE_TO_WORKER/d'
/etc/basiq-agent.env && systemctl restart basiq-agent`) — that's the
rollback lever.

**On the designated worker machine** (needs the same local install any
teammate would run — see [tools/README.md](../../README.md) if it isn't
set up yet):

1. In `tools/`, copy `worker_config.txt.example` to `worker_config.txt` and
   fill in:
   ```
   AGENT_URL=https://basiq.51st.media/agent
   AUTH_TOKEN=PASTE_YOUR_TOKEN_FROM_STEP_0     # must match exactly
   MEDIA_ROOT=<this machine's path to the same shared drive, e.g. Z:\51st Media>
   ```
2. Double-click `start-worker.bat` (Windows) or `start-worker.command`
   (Mac). Leave the window open — closing it stops the worker, and any
   queued jobs just wait for it to come back.
3. You should see:
   ```
   Basiq worker '<hostname>' polling https://basiq.51st.media/agent every 4s
     MEDIA_ROOT=<your path>
   ```

**Test it**: click GRAB in the web app with a real YouTube URL. The queue
should progress exactly as it did locally before deployment, and the file
should land in the shared drive. If it doesn't move past "Queued," the
worker isn't reaching the droplet — check its window for connection errors
and confirm `AUTH_TOKEN` matches exactly.

**Always-on later**: for the proof-of-concept, leaving the window open is
fine. To survive reboots without a person present, wire the launcher into
Windows Task Scheduler ("run at log on") or macOS launchd — not covered
here since it's optional for a first working test.

---

## Troubleshooting

**"Connection refused" on step 5's local curl** — agent not running. Check
`systemctl status basiq-agent` and `journalctl -u basiq-agent -f`.

**401 even with the right token** — token mismatch. `cat /etc/basiq-agent.env`
on the server and confirm it matches `NEXT_PUBLIC_WHISPER_AUTH_TOKEN` exactly
(no trailing newline/whitespace from a copy-paste).

**Video won't play but /health works** — check the URL the browser is
actually requesting (devtools → Network). It must include `?token=...`; if
it doesn't, the web app wasn't rebuilt after Step 8, or `.env.local`/Vercel
env is missing `NEXT_PUBLIC_WHISPER_AUTH_TOKEN`.

**Library is empty** — LucidLink permissions. Re-run the `sudo -u basiq ls`
check from Step 3.

**Caddy won't reload** — `caddy validate --config /etc/caddy/Caddyfile` first;
fix the syntax error it reports, then `systemctl reload caddy`.

**GRAB stays "Queued" forever** — either `DELEGATE_TO_WORKER` isn't set on
the droplet (`grep DELEGATE /etc/basiq-agent.env`), or the worker isn't
running/can't reach the droplet. Check the worker's own window for errors;
a 401 there means `AUTH_TOKEN` in `worker_config.txt` doesn't match the
droplet's exactly.

**Worker downloads to the wrong folder / library doesn't show new grabs** —
`MEDIA_ROOT` in `worker_config.txt` must point at the *same* shared drive
the droplet's `MEDIA_ROOT` (Step 3) points at, just via this machine's own
path to it (a mapped drive letter on Windows, a mount point on Mac).

---

## Scaling later

If transcription gets slow as the team grows, resize the droplet (more
CPU/RAM) or move to a GPU droplet for faster Whisper inference. The current
$6/mo droplet is fine for occasional grabs/transcriptions across ~14 people.
