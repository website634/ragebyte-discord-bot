# RageByte Discord Bot v2 — 24/7 on Railway

Real-time ticket transcripts · AI auto-reply · Staff presence · Voice support · Auto-mod

## Deploy

1. **Push these files to your GitHub repo** (replace your existing `index.js`, `package.json`):
   ```
   git add . && git commit -m "v2: full feature bot" && git push
   ```
   Railway auto-redeploys on push.

2. **Add these env vars in Railway → Variables**:

   | Variable | Value | Required |
   |---|---|---|
   | `DISCORD_BOT_TOKEN` | from Discord Developer Portal | ✅ |
   | `SUPABASE_EDGE_BASE` | `https://kwfhmxfqormzobzbdhmm.supabase.co/functions/v1` | ✅ |
   | `SUPABASE_ANON_KEY` | your anon key (already in your `.env`) | ✅ |
   | `STAFF_ROLE_IDS` | comma-separated Discord role IDs for staff (e.g. `123,456,789`) | ✅ for presence |
   | `TICKET_CHANNEL_PREFIXES` | default `ticket-,support-` — channel name prefixes the bot treats as tickets | optional |

3. **Discord Developer Portal → Bot → Privileged Gateway Intents** — enable ALL three:
   - ✅ Presence Intent
   - ✅ Server Members Intent
   - ✅ Message Content Intent

4. **Bot permissions** (when inviting/updating bot in your server):
   `Send Messages`, `Read Messages`, `Read Message History`, `Manage Messages` (for auto-mod delete),
   `Manage Roles` (for reaction roles), `Connect`, `Speak` (for voice).

## What it does

| Feature | How |
|---|---|
| **Real-time transcripts** | Every message in ticket channels is forwarded to `discord-bot-realtime` and stored in `rageauth_ticket_channel_state.messages` |
| **AI auto-reply** | When a non-staff user posts in a ticket, the edge function searches `rageauth_qa_examples` for a >88% similar past Q&A. If found and no AI reply in the last 10 min, the bot posts the answer. |
| **Staff presence** | Tracks online/idle/dnd/offline for users with `STAFF_ROLE_IDS`. Visible in Admin Panel → **Staff Presence** tab. |
| **Voice support** | `/joincall` (staff in voice) makes the bot join. `/leavecall` to disconnect. Sessions logged in `discord_voice_sessions`. |
| **Reaction roles** | Add rows to `discord_reaction_roles` table (message_id + emoji → role_id). The bot auto-applies/removes roles when users react. |
| **Auto-mod** | Spam (>5 msgs in 8s) and unapproved links are auto-deleted. Logged in `discord_automod_events`. Staff are exempt. |

## Logs

- **Railway dashboard → Deployments → Logs** — bot heartbeat, errors
- **Admin Panel → Audit Logs / Staff Presence** — what the edge function recorded
