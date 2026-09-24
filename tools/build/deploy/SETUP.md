# Deploy the Basiq Agent to basiq.51st.media

**Migrating to a brand-new droplet? Read "Full-stack droplet migration"
first** — it covers everything this guide alone doesn't (the frontend,
Caddy from scratch, DNS cutover) and tells you where to jump into the
steps below. If you're only adding the agent to a droplet that's already
serving the web app and already has LucidLink mounted, skip straight to
Step 1.

This covers deploying the agent to a DigitalOcean droplet. Caddy proxies
`basiq.51st.media` → `127.0.0.1:3000` for the web app, and LucidLink mounts
at `/mnt/lucidlink`. This guide only adds the agent alongside the web app —
it does not touch your existing Caddy site block except to insert one new
`handle_path` block into it.

---

## Full-stack droplet migration (do this section first)

Everything currently running on one droplet — the agent, the Next.js web
app under `pm2`, Caddy, LucidLink — moving to a new, bigger droplet, same
domain. Order matters; do it in this sequence.

**Sizing** (confirmed 2026-09-24, see "Sizing the droplet" at the bottom
of this file for the real math): **8 vCPU / 16GB RAM, CPU-Optimized
(dedicated vCPU, not shared/burstable)** for real headroom at 10 users ×
10 clips/hour. 4 vCPU / 8GB is the bare floor for that exact number with
no margin — only go there if cost is the deciding constraint.

1. **Provision the new droplet** (your DigitalOcean account — same region
   as the old one is a fine default unless you have a reason to move
   regions). Note its IP.
2. **Base packages + Node.js + Caddy + pm2:**
   ```bash
   apt update && apt install -y git curl build-essential ffmpeg
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -   # matches the current droplet's Node 22
   apt install -y nodejs
   npm install -g pm2
   # Caddy's official apt repo:
   apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
   apt update && apt install -y caddy
   ```
3. **Install and mount LucidLink** — Step 0.5 below. Verify the library is
   actually readable before doing anything else; nothing downstream works
   without this.
4. **Clone the repo** to the same path the old droplet used
   (`/var/www/basiq-studio-web`), so nothing in either app's config
   (working directories, systemd units) needs path edits:
   ```bash
   git clone https://github.com/YOUR_GITHUB_ORG/basiq-studio-web.git /var/www/basiq-studio-web
   cd /var/www/basiq-studio-web
   ```
5. **Frontend:**
   ```bash
   npm install
   ```
   Copy `.env.local` itself over from the old droplet (`scp`, not `git` —
   it's full of real secrets):
   ```bash
   scp root@OLD_DROPLET_IP:/var/www/basiq-studio-web/.env.local .env.local
   ```
   Its `NEXT_PUBLIC_WHISPER_URL=https://basiq.51st.media/agent` and every
   other value stay correct as-is — they're all domain-based, not
   IP-based, so nothing here needs editing just because the IP changed.
   ```bash
   npm run build
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup   # run the one-line command it prints, to survive reboots
   ```
6. **Agent** — Steps 1 through 5 below, in this same
   `/var/www/basiq-studio-web` checkout. Copy `/etc/basiq-agent.env` and
   `cookies.txt`/`tve_session.json` over the same way as `.env.local`
   above (`scp` from the old droplet, real secrets, never `git`).
7. **Caddy** — write the full site block (this is the old droplet's real,
   currently-live config, safe to copy verbatim):
   ```bash
   cat > /etc/caddy/Caddyfile <<'EOF'
   basiq.51st.media {
       encode zstd gzip {
           match {
               header Content-Type text/html*
               header Content-Type application/json*
               header Content-Type text/css*
               header Content-Type text/javascript*
               header Content-Type application/javascript*
           }
       }

       handle_path /agent/* {
           reverse_proxy 127.0.0.1:8000
       }
       handle {
           reverse_proxy 127.0.0.1:3000
       }
   }
   EOF
   caddy validate --config /etc/caddy/Caddyfile
   systemctl enable --now caddy
   ```
   Caddy can't get a real TLS cert for `basiq.51st.media` until DNS
   actually points at this box (next step) — that's expected, not a
   misconfiguration, and is exactly why testing everything by IP first
   (below) matters.
8. **Test on the new box BEFORE touching DNS** — from your own machine,
   force a request to resolve to the new droplet without changing real
   DNS yet (add a temporary line to your own `/etc/hosts` /
   `C:\Windows\System32\drivers\etc\hosts`: `NEW_DROPLET_IP
   basiq.51st.media`), then hit it in a real browser. Expect a cert
   warning (self-signed/no cert yet, since DNS doesn't point here) —
   click through it just to confirm the app itself loads, the library
   shows real files, and a transcribe job completes. Remove that hosts
   line once done either way.
9. **Cut over DNS** — update `basiq.51st.media`'s A record (wherever DNS
   is managed) to the new droplet's IP. Propagation is usually fast but
   not instant; recheck from a real browser (not a machine that still has
   the old IP cached) after a few minutes.
10. **Don't destroy the old droplet immediately.** Leave it powered off
    (not deleted) for a few days as a rollback path — flipping DNS back is
    much faster than rebuilding from scratch if something's wrong. Once
    confident, deauthorize its LucidLink device from the LucidLink
    dashboard (see Step 0.5) before finally destroying it, so it doesn't
    keep occupying a device slot on your filespace plan for no reason.

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

## Step 0.5: Install and mount LucidLink (skip if it's already mounted)

Everything downstream — the library, GRAB, transcribe, clip export — reads
and writes through this mount. Get it working and verified *before* moving
on to the agent itself; every other step below assumes it's already there.

**Before installing on a NEW box:** check LucidLink's own dashboard
(lucidlink.com account) for how many devices your filespace plan allows
authorized at once. If migrating off an old droplet for good, deauthorize
that old device there once the new one is confirmed working — don't just
let the old one keep running unmounted, some plans cap concurrent devices.

1. Download the Linux installer `.deb` from your LucidLink account
   dashboard (Downloads → Linux) onto the new droplet, then:
   ```bash
   apt update
   dpkg -i lucidinstaller.deb || apt -f install -y   # resolves any missing deps, then re-run dpkg -i
   ```
2. Fuse needs `allow_other` explicitly enabled system-wide, or the daemon's
   own `--fuse-allow-other` flag (used below, since the systemd service
   runs as root but the agent runs as an unprivileged user that also needs
   read/write) fails silently:
   ```bash
   echo "user_allow_other" >> /etc/fuse.conf
   ```
3. Store the LucidLink account password outside the (world-readable) unit
   file:
   ```bash
   cat > /etc/lucidlink.env <<'EOF'
   LUCID_PASSWORD=PASTE_THE_LUCIDLINK_ACCOUNT_PASSWORD_HERE
   EOF
   chmod 600 /etc/lucidlink.env
   ```
4. Install the systemd service (adjust `--fs` to your own filespace name
   and `--user` to your own LucidLink account email if different):
   ```bash
   mkdir -p /mnt/lucidlink
   cat > /etc/systemd/system/lucid-mount.service <<'EOF'
   [Unit]
   Description=LucidLink Mount Service
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   EnvironmentFile=/etc/lucidlink.env
   ExecStart=/opt/lucidlink/resources/Lucid.bin daemon --fs media.md-pac --user paul@precinct.us --password ${LUCID_PASSWORD} --mount-point /mnt/lucidlink --fuse-allow-other
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   EOF
   systemctl daemon-reload
   systemctl enable --now lucid-mount
   ```
5. Verify before doing anything else:
   ```bash
   df -h /mnt/lucidlink            # should show a real (large) filesystem, not "No such file"
   ls /mnt/lucidlink/Archive/Basiq-Studio-Hub | head -5   # should list real files
   ```
   If it's empty or hangs, the daemon likely hasn't finished its first
   sync/index yet on a brand-new device authorization — give it a few
   minutes and retry before assuming something's broken.

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

Also install Playwright's **Firefox** browser (not Chromium) — the generic
live-source resolver and the login-session helper (`save_browser_login.py`)
both use Firefox specifically, since Akamai Bot Manager (fronting at least
one real login-gated source) challenges automated Chromium with an
unsolvable "confirm you're human" loop that Firefox isn't targeted by
nearly as often:

```bash
.venv/bin/python -m playwright install firefox --with-deps
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
sudo -u basiq ls "/mnt/lucidlink/Archive/Basiq-Studio-Hub"
```

If that lists files, you're good. If it's empty or "Permission denied", fix
LucidLink's mount permissions before continuing — the agent will otherwise
report an empty library with no error.

---

## Step 4: Store the auth token outside the (world-readable) service file

The agent needs its own Supabase credentials here too — every grab, tag,
transcript, and clip it writes goes through its own `_db_request()` call,
independent of the web app's. Use the same values as the web app's
`.env.local` (Supabase dashboard -> Settings -> Data API for the URL,
Settings -> API Keys for the service role key):

```bash
cat > /etc/basiq-agent.env <<'EOF'
AUTH_TOKEN=PASTE_YOUR_TOKEN_FROM_STEP_0_HERE
SUPABASE_URL=PASTE_YOUR_SUPABASE_PROJECT_URL_HERE
SUPABASE_SERVICE_ROLE_KEY=PASTE_YOUR_SUPABASE_SERVICE_ROLE_KEY_HERE
MEDIA_ROOT=/mnt/lucidlink/Archive/Basiq-Studio-Hub
LUCID_MOUNT_PATH=/mnt/lucidlink

# Optional, only if the old droplet had them set -- copy the SAME values,
# don't regenerate/reissue unless you mean to invalidate the old ones:
# YTDLP_PROXY=http://user:pass@host:port1,http://user:pass@host:port2,...
# COOKIES_FILE=/opt/basiq-studio-web/tools/cookies.txt
# DEEPGRAM_API_KEY=...
# PLAYWRIGHT_STORAGE_STATE=/opt/basiq-studio-web/tools/tve_session.json

# Live capture is quarantined (off) by default as of 2026-09-24 -- this
# product is a speed-clipping tool first, live capture second. Leave unset
# (or explicitly "0") unless deliberately re-enabling it:
# LIVE_CAPTURE_ENABLED=1
EOF
chmod 600 /etc/basiq-agent.env
chown root:root /etc/basiq-agent.env
```

If the old droplet had `cookies.txt` and/or `tve_session.json`, copy those
two files themselves over too (`scp`, not `git` — both are real session
credentials and are deliberately gitignored, never committed):

```bash
scp root@OLD_DROPLET_IP:/opt/basiq-studio-web/tools/cookies.txt tools/cookies.txt
scp root@OLD_DROPLET_IP:/opt/basiq-studio-web/tools/tve_session.json tools/tve_session.json  # if it exists
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

**Also add the OOM-protection override** — this droplet has a real history
of the kernel's OOM killer taking down the whole agent process (and every
in-flight job with it) under memory pressure, not just whatever specific
job tipped it over:

```bash
mkdir -p /etc/systemd/system/basiq-agent.service.d
cat > /etc/systemd/system/basiq-agent.service.d/override.conf <<'EOF'
[Service]
Environment="LUCID_MOUNT_PATH=/mnt/lucidlink"
EnvironmentFile=-/etc/basiq-agent.env
OOMScoreAdjust=-500
EOF
systemctl daemon-reload
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

Set these three env vars wherever the Next.js app is actually built —
**Vercel** (Project → Settings → Environment Variables) if it's hosted
there, or `.env.local` on the droplet + a rebuild if `:3000` is a self-hosted
`next start` process on the same box:

```
NEXT_PUBLIC_WHISPER_URL=https://basiq.51st.media/agent
NEXT_PUBLIC_WHISPER_AUTH_TOKEN=PASTE_YOUR_TOKEN_FROM_STEP_0
MEDIA_ROOT=/mnt/lucidlink/Archive/Basiq-Studio-Hub
```

`NEXT_PUBLIC_*` vars are baked in at build time, not read at runtime — a
plain restart won't pick up the change. Redeploy (Vercel) or rebuild + restart
(self-hosted: `npm run build && systemctl restart <your-app-service>` or
however :3000 is managed).

`MEDIA_ROOT` is read at runtime by the `/api/transcribe` endpoint, which writes
uploaded files directly to the shared drive. If hosting on Vercel, uploads won't
work unless Vercel can write to the shared drive (unlikely); for Vercel+Droplet
setup, run the Next.js app on the droplet as `next start` instead, with
`MEDIA_ROOT` set in `.env.local`.

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

## Step 10: Fix YouTube 403s

YouTube doesn't block a normal residential connection — only the droplet's
own datacenter IP (confirmed: YouTube specifically blocks DigitalOcean's
ranges, [yt-dlp/yt-dlp#13336](https://github.com/yt-dlp/yt-dlp/issues/13336)).
There are two ways to work around that; **Option A is the current
recommendation** now that a paid proxy is in budget — it removes the
always-on local machine entirely. Option B (delegate to a worker) is the
older approach, kept working as a fallback.

### Option A (recommended): route YouTube grabs through a paid proxy

Buy a handful of static/ISP residential proxy IPs, US-geo-targeted
(confirmed pricing 2026-09: ~$2.50-3/IP/month, unlimited bandwidth, from
providers like Decodo or IPRoyal — a few IPs comfortably covers this
project's grab volume for $10-40/month total). This is an account the
**user** has to create and pay for directly — get the proxy connection
string from the provider's dashboard after signup, in the form
`http://user:pass@host:port`.

**On the droplet**, set it and make sure delegation is OFF:

```bash
echo "YTDLP_PROXY=http://user:pass@host:port1,http://user:pass@host:port2,http://user:pass@host:port3" >> /etc/basiq-agent.env
sed -i '/DELEGATE_TO_WORKER/d' /etc/basiq-agent.env
systemctl restart basiq-agent
```

A comma-separated list, one entry per dedicated IP the proxy plan hands
out (same user/pass, different port per IP for Decodo's ISP proxies) —
`base_opts()` picks one at random per grab, so no single IP carries all
the traffic.

`YTDLP_PROXY` is never used on a grab's first attempt — only a retry
(meaning the direct attempt already failed with a transient/blocking-
shaped error, see `_retryable()` in `tools/basiq_agent.py`) adds it. This
is deliberate, not a hardcoded per-site list: it self-adapts to whichever
site actually needs a clean IP (YouTube today, possibly something else
later) without spending proxy bandwidth on the great majority of grabs
that never need it, and without anyone having to remember to add a new
site to an allowlist. Verify with exactly **one**
real, human-initiated GRAB from the actual web UI — never an automated
test call against YouTube, per the standing rule in `HANDOFF.md`. If that
works and holds up over a few days, Step 10's Option B below (the worker
machine, LucidLink-on-Windows, the tray supervisor, the pipeline doctor)
is no longer needed for GRAB at all.

**Two hardening pieces, install both once Option A is proven working**
(real-world incident that prompted them: 2026-09-14, see HANDOFF.md):

```bash
cd /var/www/basiq-studio-web
cp tools/build/deploy/basiq-ytdlp-update.service tools/build/deploy/basiq-ytdlp-update.timer \
   tools/build/deploy/basiq-grab-doctor.service tools/build/deploy/basiq-grab-doctor.timer \
   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now basiq-ytdlp-update.timer basiq-grab-doctor.timer
```

- **`basiq-ytdlp-update.timer`** — weekly `pip install -r requirements.txt`, a yt-dlp upgrade, and a playwright/chromium install, then an agent restart. Covers two related drift problems: `requirements.txt`'s floors never force a re-upgrade once satisfied (how the droplet ran a month-stale yt-dlp for weeks with zero errors, which alone triggered YouTube's bot-check regardless of a clean proxy IP or valid cookies), and a plain install never adds a package added to `requirements.txt` *after* the venv already existed (how the droplet's generic live-stream resolver — CBS, ABC, anything without a dedicated yt-dlp extractor — silently could never work at all, since playwright had never actually been installed there). The worker machine gets these by hand when someone remembers; the droplet doesn't have anyone watching it day-to-day.
- **`basiq-grab-doctor.timer`** — every 30 minutes, checks whether the last 3 *real* GRAB jobs all hit YouTube's bot-check error (`tools/cloud_grab_doctor.py`) — something a single job's own 3x internal retry can't distinguish from "the fix broke again." Read-only, journal-log-only, never contacts YouTube itself. An alert shows up as a failed run in `systemctl --failed`.

### Option B (fallback): delegate GRAB/GO LIVE to a local worker

GRAB and GO LIVE run on one designated always-on Windows or Mac machine
instead of the droplet. The droplet still creates and tracks the job — the
worker just does the actual download and reports back, so the web UI's
queue, library, and everything downstream is unaffected.

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
   MEDIA_ROOT=<this machine's path to the Archive/Basiq-Studio-Hub folder, e.g. Z:\Archive\Basiq-Studio-Hub>
   SUPABASE_URL=<same value as .env.local's NEXT_PUBLIC_SUPABASE_URL>
   SUPABASE_SERVICE_ROLE_KEY=<same value as .env.local's SUPABASE_SERVICE_ROLE_KEY>
   ```
   The last two matter even though the worker never talks to Supabase
   directly: it imports `basiq_agent.py` and calls its job functions
   in-process, including the final DB write that registers the finished
   video. Without them, that write fails silently — see "Library doesn't
   show new grabs" below.
2. Double-click `start-tray.bat` (Windows). This installs `pystray`/`Pillow`
   the first time it runs (one-time), then starts the worker with **no
   console window at all** — look for a small tray icon near the clock
   instead. Right-click it for status (running/starting/hung), a manual
   restart, and the log (`worker_tray.log`, since there's no console to
   read output from anymore). `start-worker.bat`/`start-worker.command`
   still exist if you want to watch raw output directly instead (e.g. while
   debugging) — closing that window stops the worker, same as before; any
   queued jobs just wait for it to come back either way.
3. Tray icon colors: green = running, amber = starting up (up to 60s while
   heavy ML imports load), red = down or hung and about to auto-restart.

**Test it**: click GRAB in the web app with a real YouTube URL. The queue
should progress exactly as it did locally before deployment, the file
should land in the shared drive, **and the video should actually show up in
the library** — that last part is the one a missing `SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY` won't stop from *looking* like it worked. If it
doesn't move past "Queued," the worker isn't reaching the droplet — check
`worker_tray.log` (or the tray icon's tooltip) for connection errors and
confirm `AUTH_TOKEN` matches exactly.

**Always-on later**: once a team is relying on grabs/captures completing
unattended, a crashed worker silently stalls *everyone's* queue until
someone notices, and nobody should have to leave a console window open (or
remember to) just to keep it alive. Two layers handle this together:
`worker_tray.py` itself relaunches `basiq_worker.py` underneath it — if the
worker process exits for any reason, or is still alive but its heartbeat
has gone stale (hung, not actually iterating) — and `tools/build/deploy/
basiq-worker-task.xml` is a ready-to-import Windows Task Scheduler
definition that starts the *tray* at logon and auto-restarts it (up to 999
times, 1 minute apart) if the tray process itself ever exits unexpectedly.
That's defense in depth, not redundancy: the tray catches a hung/crashed
*worker* without needing a whole process relaunch; Task Scheduler catches
the tray (and therefore everything under it) if the tray itself goes down,
or the machine reboots:

1. Open the XML and edit the `<WorkingDirectory>` and the `<Command>`/
   `<Arguments>` paths under `<Actions>` to this machine's actual path to
   `tools/` — it ships with this repo's own dev machine's path, not
   necessarily yours.
2. Import and run it (elevated Command Prompt):
   ```
   schtasks /create /tn "Basiq Worker" /xml "C:\path\to\tools\build\deploy\basiq-worker-task.xml" /f
   schtasks /change /tn "Basiq Worker" /enable
   schtasks /run /tn "Basiq Worker"
   ```
3. Confirm it's running: `schtasks /query /tn "Basiq Worker" /v /fo list` —
   or just look for the tray icon near the clock.

**Two things this does *not* cover**, so they're not silently assumed fixed:
- If `worker_config.txt` is missing or missing a required value,
  `worker_tray.py` raises `SystemExit` with a message -- but there's no
  console to see that message on either, so it just looks like the tray
  never appeared. Check `worker_tray.log` (or run `python worker_tray.py`
  directly in a terminal once) if the icon doesn't show up after a logon.
- This is still only *this one designated machine*. It doesn't turn the
  worker into something any teammate can run from their own laptop — see
  the `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` note earlier in this step
  for why a second worker instance needs its own config, not just its own
  Task Scheduler entry.

(macOS: `worker_tray.py` depends on Windows' `tasklist`/`taskkill` for its
own single-instance check and hasn't been ported; launchd with a
`KeepAlive` key is the equivalent always-on primitive for the worker itself,
but none of this project's shipped files cover either the tray or launchd
yet -- same idea, different mechanism, still todo.)

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
two different causes with the same symptom. If the *file itself* is in the
wrong place, `MEDIA_ROOT` in `worker_config.txt` must point at the *same*
shared drive the droplet's `MEDIA_ROOT` (Step 3) points at, just via this
machine's own path to it (a mapped drive letter on Windows, a mount point
on Mac). If the file lands correctly but the video never appears in the
library at all, `worker_config.txt` is missing `SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY` — `start-worker.bat` should have refused to
start over this, so check you're running the current version of the file.

---

## Sizing the droplet

**Confirmed 2026-09-24, the hard way:** the 1 vCPU / ~1.9GB droplet this
guide used to assume as "fine for ~14 people" is not adequate for this
product's actual stated priority (fast, concurrent team clipping, live
capture a secondary backup). Real numbers from that night: a single 720p60
remux ran at over 2x realtime CPU time alone; a 1080p `veryfast` clip
export cost ~2x realtime regardless of any code setting (measured directly,
old vs. new encode flags made no difference); routine background library
scanning plus 1-2 concurrent operations pushed the system load average to
18+ on a 1-core box; LucidLink itself logged real request-latency
degradation during that same window.

The app's own existing concurrency caps are the honest floor to size
against, not a guess: `MAX_CONCURRENT_EXPORTS=2` + `MAX_CONCURRENT_GRABS=4`
+ `MAX_CONCURRENT_TRANSCRIBES=2` (`tools/basiq_agent.py`) means up to 8
heavy operations can legitimately be in flight at once at real peak team
usage, on top of LucidLink's own daemon (observed ~500MB+ resident) and
whatever ML models are loaded. **Recommend at minimum 4 vCPUs / 8GB RAM**
for the new droplet, sized up further if real usage after migration still
shows load average consistently above the vCPU count. This is a cost/
infrastructure decision for the account owner to make directly (provisioning
a bigger droplet costs more per month) — not something to default down from
to save money without deliberately deciding to accept the tradeoff.

If transcription specifically gets slow as the team grows further, a GPU
droplet for faster Whisper inference is the next lever after CPU/RAM sizing
alone stops being enough.
