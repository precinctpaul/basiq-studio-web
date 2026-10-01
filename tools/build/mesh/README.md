# Backup worker mesh

**What it is.** The droplet does every GRAB itself first. When all of its cloud routes are blocked (YouTube bot-check, 403, 429, timeouts), the grab is **not failed**: it goes to a *worker* — a small program on a teammate's machine or a dedicated always-on node — which downloads it over that machine's own home/office connection. Nobody picks anything; it's automatic and invisible to whoever clicked GRAB.

Code: `tools/mesh.py` (cloud side, inside `basiq_agent.py`), `tools/mesh_worker.py` (the worker), `app/admin` (admin console).

## How a grab flows

1. Cloud: up to 4 attempts across the proxy pool (per-IP health, `basiq_agent._pick_proxy`).
2. All cloud routes fail for a retryable reason → job status **"Trying a backup route…"**.
   - If every pool IP is already benched for video and a worker is online, step 1 is skipped entirely.
3. Routing, automatic:
   1. a worker on the **same network** as the person who clicked GRAB (matched by public IP — the app has no logins), immediately;
   2. **always-on** nodes (flag in the admin console), immediately if (1) has nobody online, else after `MESH_TIER_GRACE_SECONDS` (8s);
   3. any other online worker, after another grace period.
4. The worker runs the droplet's own `run_grab()` (`WORKER_MODE`), files the video straight into **its own LucidLink** archive folder, and reports back.
5. The droplet waits until it can see that file in **its own** LucidLink mount at full size, then writes the `videos` row and marks the job Complete. Workers never hold a Supabase key.
   - If the file isn't visible within `MESH_VERIFY_TIMEOUT_SECONDS` (8 min), or the worker's LucidLink is down, the worker uploads it over HTTPS and the droplet files it.
6. No worker online → the cloud retries every `MESH_CLOUD_RETRY_SECONDS` (5 min). The job only errors after `MESH_MAX_WAIT_SECONDS` (6 h), or after `MESH_MAX_WORKER_TRIES` (4) worker failures, or immediately for things no network can fix (private/deleted video, 404).

Unfinished grabs are saved to `tools/pending_grabs.json` and resumed after an agent restart.

## One-time server setup

1. **Agent** — add to `/etc/basiq-agent.env`, then `systemctl restart basiq-agent`:
   ```
   ADMIN_TOKEN=<long random string>
   ```
2. **Web app** — add to the web app's env on the droplet (same file `next build` reads), then rebuild + `pm2 restart basiq-web`:
   ```
   ADMIN_PASSWORD=<the password you'll type into /admin>
   AGENT_ADMIN_TOKEN=<same value as ADMIN_TOKEN>
   ```
   `AGENT_INTERNAL_URL` defaults to `http://127.0.0.1:8000` (web app and agent share the droplet). Optional `ADMIN_SESSION_SECRET` signs the session cookie (defaults to `AGENT_ADMIN_TOKEN`).
3. Open `https://basiq.51st.media/admin`, sign in, **Workers → Add a worker → Create code**.

## Adding the always-on Mac node

On the Mac (needs Homebrew, LucidLink installed and signed in, and a clone of this repo):
```
git clone https://github.com/precinctpaul/basiq-studio-web.git ~/basiq-studio-web
bash ~/basiq-studio-web/tools/build/mesh/install-mac-node.sh BQ-XXXX-XXXX-XXXX "Basiq Mac Node"
```
It installs the worker in its own venv, enrolls, and registers a login item (launchd, `caffeinate -is` so it doesn't sleep on power). Then flag it **ALWAYS-ON** in the admin console. In macOS settings: prevent automatic sleeping when the display is off (on power adapter).

The teammate double-click installer (Mac + Windows, sets up LucidLink, no terminal) is stage 2 — not built yet.

## Admin console (`/admin`)

- **Workers:** status, owner, machine, LucidLink state, last seen, done/failed. Pause/Resume, Drain (finish current job, take no more), Update, Restart, **Recall** (key revoked instantly; self-uninstalls on next check-in), Always-on toggle, rename.
- **Add a worker:** enrollment codes (50 uses / 30 days by default, revocable). Codes are only shown once.
- **Queue:** in-flight and recent grabs, which route handled them, cancel / retry-cloud-now.
- **Cloud routes:** per-proxy health for video and captions.
- **Settings:** master switch for the whole mesh; auto-update (idle workers follow the droplet's git version — deploying to the droplet deploys to every worker).

## Operations

- Worker log: Mac `~/Library/Application Support/BasiqWorker/worker.log`, Windows `%LOCALAPPDATA%\BasiqWorker\worker.log`.
- Worker status: `python tools/mesh_worker.py status`.
- Grab outcomes by route: `cd /var/www/basiq-studio-web/tools && .venv/bin/python grab_ledger_report.py --since 24` (worker grabs are recorded too, as `route: worker:<name>`).
- Mesh state on the droplet: `tools/mesh.json` (workers, hashed keys, codes, settings), `tools/pending_grabs.json`.
