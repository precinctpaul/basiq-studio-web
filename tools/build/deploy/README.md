# Basiq Agent — Remote Deployment

Move from "local agent on each person's machine" to "one shared agent in the cloud, everyone uses the same link."

## Files

- **`BUSINESS_CASE.md`** — For your boss. Cost, why, what it does.
- **`SETUP.md`** — Step-by-step guide to add the agent to the existing
  basiq.51st.media droplet (Caddy + LucidLink are already live there).
- **`Caddyfile`** — Not a file to copy over `/etc/caddy/Caddyfile`. It's the
  `handle_path /agent/*` block to insert into the *existing*
  `basiq.51st.media { ... }` site block, so the agent rides the same domain
  with no new DNS record.
- **`basiq-agent.service`** — Systemd unit (copies to `/etc/systemd/system/`).

## Before You Start

Generate an auth token:
```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

## Quick Path

```bash
# 1. Read BUSINESS_CASE.md and show your boss
# 2. Follow SETUP.md step-by-step
# 3. Set NEXT_PUBLIC_WHISPER_URL=https://basiq.51st.media/agent and
#    NEXT_PUBLIC_WHISPER_AUTH_TOKEN=<token> wherever the web app is built
#    (Vercel env vars, or .env.local + rebuild if self-hosted), then rebuild
# 4. Share the link with your team
```

## Cost

~$6/month (DigitalOcean Droplet) + what you already pay for LucidLink.

## Support

See SETUP.md troubleshooting section, or check Caddy/LucidLink docs for their specific issues.
