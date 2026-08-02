/**
 * Conversation history.
 *
 * Telegram hands a bot nothing but the updates it is online for. There is no
 * API to fetch what was said before, and `getUpdates` forgets within a day, so
 * an agent restarted mid-conversation has no idea what it just agreed to.
 *
 * The only way to have a history is to keep one. Every message in and out is
 * appended here as JSONL, one file per chat, alongside the channel's other
 * state — local, never uploaded, and readable with `tail`.
 */

import { appendFileSync, readFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, loadAccess } from './config.js'

const HISTORY_DIR = join(STATE_DIR, 'history')

export type Entry = {
  ts: string
  dir: 'in' | 'out'
  /** Telegram message id, when there is one. */
  id?: string
  /** Sender handle for inbound; absent for our own messages. */
  from?: string
  text: string
}

/** History is on unless access.json turns it off. */
function enabled(): boolean {
  return loadAccess().history !== false
}

function fileFor(chat_id: string): string {
  // Chat ids are numeric (possibly negative) — safe as a filename, but pin it
  // down anyway so a malformed id can't escape the directory.
  return join(HISTORY_DIR, `${String(chat_id).replace(/[^\w-]/g, '_')}.jsonl`)
}

/** Record one message. Never throws — losing a log line must not drop a reply. */
export function record(chat_id: string, entry: Entry): void {
  if (!enabled()) return
  try {
    mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(fileFor(chat_id), JSON.stringify(entry) + '\n', { mode: 0o600 })
  } catch {
    // A history that fails is still better than a bridge that fails.
  }
}

/**
 * Read a chat's history, newest last.
 *
 * `search` filters case-insensitively before `limit` is applied, so searching
 * reaches past the tail instead of only within it.
 */
export function read(chat_id: string, opts: { limit?: number; search?: string } = {}): Entry[] {
  let lines: string[]
  try {
    lines = readFileSync(fileFor(chat_id), 'utf8').split('\n')
  } catch {
    return []
  }

  const needle = opts.search?.toLowerCase()
  const out: Entry[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as Entry
      if (needle && !e.text.toLowerCase().includes(needle)) continue
      out.push(e)
    } catch {}
  }

  const limit = opts.limit ?? 50
  return limit > 0 ? out.slice(-limit) : out
}

/** Chats that have a history, with size and last activity. */
export function chats(): { chat_id: string; messages: number; last?: string }[] {
  let files: string[]
  try {
    files = readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  return files.map((f) => {
    const chat_id = f.replace(/\.jsonl$/, '')
    const entries = read(chat_id, { limit: 0 })
    return {
      chat_id,
      messages: entries.length,
      last: entries[entries.length - 1]?.ts,
    }
  })
}

/** Bytes on disk, for `channel_info`. */
export function size(): number {
  try {
    return readdirSync(HISTORY_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .reduce((n, f) => n + statSync(join(HISTORY_DIR, f)).size, 0)
  } catch {
    return 0
  }
}

/** Render entries for reading, oldest first. */
export function format(entries: Entry[]): string {
  if (!entries.length) return '(no history)'
  return entries
    .map((e) => {
      const who = e.dir === 'in' ? (e.from ?? 'them') : 'me'
      return `[${e.ts.slice(0, 19).replace('T', ' ')}] ${who}: ${e.text}`
    })
    .join('\n')
}
