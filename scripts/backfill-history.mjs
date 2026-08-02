#!/usr/bin/env node
/**
 * Seed the history log from Claude Code transcripts.
 *
 * The plugin only logs messages it handled, so switching it on leaves
 * everything before that invisible. The transcripts have it, though: inbound
 * messages arrive as `<channel source="plugin:telegram-unleashed…">` tags, and
 * outbound ones are the arguments of the reply/say tool calls that sent them.
 *
 * Idempotent — an entry already in the log is skipped, so running it twice is
 * harmless.
 *
 *   node scripts/backfill-history.mjs [--dry] [--channel telegram]
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const channel = valueOf('--channel') ?? process.env.TELEGRAM_CHANNEL ?? 'telegram'

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', channel)
const HISTORY_DIR = join(STATE_DIR, 'history')
const PROJECTS = join(homedir(), '.claude', 'projects')

function valueOf(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

// ---------------------------------------------------------------------------

const collected = new Map() // chat_id -> Entry[]

function add(chat_id, entry) {
  if (!entry.text?.trim()) return
  if (!collected.has(chat_id)) collected.set(chat_id, [])
  collected.get(chat_id).push(entry)
}

/** Flatten a transcript entry's content to searchable text. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('\n')
}

for (const dir of listDirs(PROJECTS)) {
  for (const file of listFiles(join(PROJECTS, dir), '.jsonl')) {
    let lines
    try {
      lines = readFileSync(join(PROJECTS, dir, file), 'utf8').split('\n')
    } catch {
      continue
    }

    for (const line of lines) {
      if (!line.trim()) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }

      // --- inbound: the channel tag itself -------------------------------
      const raw = textOf(e?.message?.content ?? e?.content)
      if (raw) {
        const tag = /<channel[^>]*\bsource="plugin:telegram-unleashed[^"]*"[^>]*>/.exec(raw)
        if (tag) {
          const chat = attr(tag[0], 'chat_id')
          // The docs placeholder uses literal "..." for every attribute.
          if (chat && /^-?\d+$/.test(chat)) {
            const after = raw.slice(raw.indexOf(tag[0]) + tag[0].length)
            add(chat, {
              ts: attr(tag[0], 'ts') ?? '',
              dir: 'in',
              id: attr(tag[0], 'message_id') ?? undefined,
              from: attr(tag[0], 'user') ?? undefined,
              text: after.replace(/<\/channel>[\s\S]*$/, '').trim(),
            })
          }
        }
      }

      // --- outbound: the arguments we passed to the sending tools --------
      if (e?.type === 'assistant' && Array.isArray(e?.message?.content)) {
        for (const block of e.message.content) {
          if (block?.type !== 'tool_use') continue
          if (!/telegram-unleashed__(reply|say|send_code)$/.test(block.name ?? '')) continue
          const chat = String(block.input?.chat_id ?? '')
          if (!/^-?\d+$/.test(chat)) continue
          add(chat, {
            ts: e.timestamp ?? '',
            dir: 'out',
            text: String(block.input?.text ?? block.input?.code ?? ''),
          })
        }
      }
    }
  }
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m && m[1] !== '...' ? m[1] : null
}

function listDirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

function listFiles(p, ext) {
  try {
    return readdirSync(p).filter((f) => f.endsWith(ext))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Merge into the log, oldest first, skipping what is already there.
// ---------------------------------------------------------------------------

if (!collected.size) {
  console.log('nothing found — no Telegram messages in any transcript')
  process.exit(0)
}

if (!dry) mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 })

for (const [chat_id, found] of collected) {
  const file = join(HISTORY_DIR, `${chat_id.replace(/[^\w-]/g, '_')}.jsonl`)

  const existing = []
  const known = new Set()
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        existing.push(e)
        known.add(key(e))
      } catch {}
    }
  }

  const fresh = []
  for (const e of found) {
    if (known.has(key(e))) continue
    known.add(key(e))
    fresh.push(e)
  }

  const merged = [...existing, ...fresh].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))

  console.log(`${chat_id}: ${fresh.length} new, ${merged.length} total${dry ? ' (dry run)' : ''}`)
  if (!dry) writeFileSync(file, merged.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
}

/** Identity of a message: its Telegram id where known, else direction + text. */
function key(e) {
  return e.id ? `${e.dir}:${e.id}` : `${e.dir}:${String(e.text).slice(0, 120)}`
}
