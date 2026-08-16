---
description: Activity feed — live view or kept scrollback (same switch as /feed in Telegram)
allowed-tools: Read, Edit, Bash(cat:*)
argument-hint: "[live|mirror|on|off]"
---

Switch the Telegram activity feed's mode, or report it.

The mode lives as `feedMode` in the channel's access file:
`~/.claude/channels/telegram/access.json`. It is read on every step by
`hooks/activity.mjs`, which is a separate process — so a change bites on the
next step and needs no restart.

The two modes:

- `live` — the feed is a live view of the current turn. Steps are edited in
  place and the whole feed is deleted from the chat when the turn ends. What
  stands afterwards is the answer alone.
- `mirror` — the feed is scrollback. Nothing is deleted, so the thinking and
  the tool calls stay in the chat next to the answer.

Argument given: `$ARGUMENTS`

Do this:

1. Read `~/.claude/channels/telegram/access.json`.
2. If the argument is empty, report the current `feedMode` (defaulting to
   `live` when the key is absent), name the other mode, and stop — do not
   write anything.
3. Otherwise map the argument: `live` and `off` → `live`; `mirror` and `on` →
   `mirror`. Anything else: say which words are accepted and stop.
4. If the value already matches, say so and stop.
5. Otherwise Edit only the `feedMode` line — leave the rest of the file byte
   for byte as it was; it holds the allowlist and the heartbeat wordlists.
6. Confirm in one line which mode is now set and that it takes effect on the
   next step.
