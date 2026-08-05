---
name: account
description: Connect the user's own Telegram account (MTProto) so the bridge can fetch files past the 20 MB Bot API cap. Use when a download failed with "file is too big", when the user asks to set up the account fallback, or says "/telegram-unleashed:account".
---

# Account fallback — files past 20 MB

Telegram caps **bot** downloads at 20 MB. A logged-in **user account** has no
such cap. This skill connects the user's own account once; afterwards
`download_attachment` falls back to it automatically whenever the Bot API
refuses a file.

## What the agent does vs. what the user does

The login is interactive — Telegram texts a code to the account and may ask a
2FA password. **The agent never runs the login itself**; it prepares the
command and the user runs it in their terminal (`! <command>` in Claude Code).

## Setup

1. **Check Python + Telethon** (agent may do this):
   `python -c "import telethon; print(telethon.__version__)"` — if missing:
   `pip install telethon`

2. **API credentials** (user): https://my.telegram.org → *API development
   tools* → create an app → note `api_id` and `api_hash`. These identify the
   application, not the login; they are not secret enough to panic over but
   belong in the channel `.env`, not in a repo.

3. **Login** (user, in their own terminal):
   ```
   python <plugin>/scripts/mtproto_login.py <api_id> <api_hash> <phone> ~/.claude/channels/telegram/mtproto
   ```
   Telegram sends a code; enter it (and the 2FA password if asked). This
   writes `~/.claude/channels/telegram/mtproto.session`.

4. **Wire it up** (agent): add to `~/.claude/channels/telegram/.env`:
   ```
   TELEGRAM_MTPROTO_SESSION=C:/Users/<you>/.claude/channels/telegram/mtproto
   TELEGRAM_MTPROTO_API_ID=<api_id>
   TELEGRAM_MTPROTO_API_HASH=<api_hash>
   TELEGRAM_MTPROTO_PYTHON=<python path, optional — default "python">
   ```
   (Session path **without** the `.session` extension.)

5. **Restart the bridge** (user: `/mcp` reconnect or `/reload-plugins`), then
   send a >20 MB video and call `download_attachment` — it should land in the
   inbox via the fallback.

## How the fallback matches files

Bot-API file_ids mean nothing to MTProto and the two number messages
differently. The helper finds the file by **chat + size (+ name)** among the
last 50 messages of the same chat — exact size match, newest first.

## Security notes

- The session file **is** the account login. It stays in the channel state
  directory (outside any repo), same protection level as the bot token.
- The fallback only ever **downloads from chats the bridge already saw the
  attachment in** — it sends nothing and reads nothing else.
- Revoke anytime: Telegram → Settings → Devices → terminate that session.
