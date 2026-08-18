# Basiq Studio Hub — Remote Deployment Business Case

## What

A single cloud server running the Basiq agent, shared by all 14 team members. One click, one link — no local installs.

## Why

- **14 team members, all Mac users.** Local installers are Windows/Mac-specific and fragile. Centralizing eliminates setup complexity.
- **Tool works great locally.** Already proven on one Windows dev machine; now scale it to the whole team with near-zero friction.
- **Shared transcription queue.** One instance means everyone benefits from the pre-loaded AI models; faster for the second person queued up.

## What It Does

- Grab YouTube videos, C-SPAN hearings, live streams → Transcribe + auto-tag → Clip + export
- Shared media library on LucidLink; clip exports go to cloud storage for sharing
- All from a single shareable link; no software to install on anyone's machine

## Cost

**$0 in new spend.** The agent runs on the droplet that's already paying
for itself hosting the web app:

| Item | Cost | Notes |
|------|------|-------|
| DigitalOcean Droplet | $6/month (existing) | Already running the web app |
| HTTPS certificate | $0 | Automatic (Caddy), already issued for the domain |
| LucidLink mount | $0 | Already mounted, uses existing account |
| **Additional cost** | **$0/month** | Just adding a second process to the same box |

Cheaper than one person buying an external SSD to hold transcripts.

## Timeline

The droplet, Caddy, and LucidLink mount are already live for the web app.
Adding the agent alongside them: **~45 minutes**, one-off.
- 15 min: Install agent dependencies, verify LucidLink permissions
- 10 min: Enable the systemd service, test locally on the droplet
- 10 min: Add the agent's route to the existing Caddy config, test over HTTPS
- 10 min: Point the web app at the new agent URL, test with the team

## Next Steps

1. Confirm the existing $6/month droplet cost (no new infrastructure)
2. Run the setup guide (SETUP.md) — takes ~45 minutes, one-time
3. Share the link with the team

Questions? See `SETUP.md` for detailed instructions, or ask.
