#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fetch one attachment the Bot API refuses to hand over.

Telegram caps bot downloads at 20 MB; a logged-in USER account has no such
cap. This helper is spawned by the bridge when getFile answers "file is too
big": it opens the user's MTProto session, finds the message carrying the
attachment in the same chat, downloads it, and prints the absolute path as
its only stdout line.

Bot-API file_ids mean nothing to MTProto, and the two number their messages
differently — so the match runs on what both sides can see: the newest media
message in the chat whose file size (and, when known, name) equals the one
the bot was told about. Size alone is 32 bits of entropy; a collision within
the last 50 messages of one chat is not a case worth engineering for.

Usage:
  mtproto_fetch.py --session S --api-id N --api-hash H --entity E
                   --size BYTES [--name FILENAME] --out DIR

--entity is the chat as the USER account sees it: the bot's @username for a
private chat (the bridge's own bot), or the numeric chat id for groups.
Exit 0 with a path on success; exit 1 with an error line on stderr.
"""
import argparse
import sys
from pathlib import Path

from telethon.sync import TelegramClient


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--api-id", required=True, type=int)
    ap.add_argument("--api-hash", required=True)
    ap.add_argument("--entity", required=True)
    ap.add_argument("--size", required=True, type=int)
    ap.add_argument("--name", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--depth", default=50, type=int)
    args = ap.parse_args()

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    entity: object = args.entity
    if isinstance(entity, str) and entity.lstrip("-").isdigit():
        entity = int(entity)

    with TelegramClient(args.session, args.api_id, args.api_hash) as client:
        ent = client.get_entity(entity)
        for m in client.iter_messages(ent, limit=args.depth):
            if not m.media:
                continue
            doc = getattr(m, "document", None) or getattr(m, "video", None)
            size = getattr(doc, "size", None)
            if size != args.size:
                continue
            if args.name:
                attrs = getattr(doc, "attributes", []) or []
                names = [a.file_name for a in attrs if hasattr(a, "file_name")]
                if names and args.name not in names:
                    continue
            path = m.download_media(file=str(outdir))
            if path:
                print(str(Path(path).resolve()))
                return 0
    print(f"no media matching size={args.size} name={args.name!r} in last {args.depth} messages", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
