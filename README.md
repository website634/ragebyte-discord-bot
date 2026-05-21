# RageByte Discord Bot

24/7 Discord bot that maintains a live Gateway connection and forwards events to Lovable Cloud edge functions.

## Deploy on Railway

1. Push this repo to GitHub
2. In Railway: **New Project → Deploy from GitHub repo**
3. Add these environment variables in Railway dashboard:
   - `DISCORD_BOT_TOKEN` — from Discord Developer Portal
   - `SUPABASE_ANON_KEY` — your Supabase anon key
   - `SUPABASE_EDGE_BASE` — `https://<project-ref>.supabase.co/functions/v1`
4. Deploy — bot comes online in ~30 seconds

## What this bot does

- Stays connected to Discord 24/7 (Gateway connection)
- Forwards messages, thread creations, and DMs to edge functions
- Edge functions handle the heavy lifting (AI, DB, webhooks)
