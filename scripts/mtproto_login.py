#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""One-time MTProto login for the big-file fallback.

Interactive by necessity — Telegram sends a login code to the account and may
ask for a 2FA password, so this runs in the user's own terminal, never from
the agent:

  python scripts/mtproto_login.py <api_id> <api_hash> <phone> <session_path>

api_id/api_hash come from https://my.telegram.org -> API development tools.
On success the Telethon session file lands at <session_path>.session; point
TELEGRAM_MTPROTO_SESSION at it (without the extension) in the channel .env.
"""
import sys

from telethon.sync import TelegramClient


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__)
        return 2
    api_id, api_hash, phone, session = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
    with TelegramClient(session, api_id, api_hash) as client:
        client.start(phone=phone)
        me = client.get_me()
        print(f"logged in as {me.first_name} (@{me.username}) — session: {session}.session")
    return 0


if __name__ == "__main__":
    sys.exit(main())
