#!/usr/bin/env node
/**
 * Live activity feed for Telegram-driven sessions.
 *
 * Claude Code never hands its model output to a hook or an MCP server, so
 * token-by-token streaming is not available. What *is* available is the
 * transcript: it grows as the turn runs, and every assistant paragraph and
 * tool call lands in it within milliseconds. This hook tails that file and
 * keeps one Telegram message in sync with it — the user watches the work
 * happen instead of waiting for the summary.
 *
 * Wired to PreToolUse / PostToolUse / UserPromptSubmit / Stop. Each event is a
 * fresh process, so all state lives on disk next to the channel credentials.
 *
 * Silent by design: a session that never received a Telegram message writes
 * nothing and costs one transcript stat. Any failure exits 0 — a broken feed
 * must never break the turn.
 */

import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, fstatSync, closeSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'

const CHANNEL = process.env.TELEGRAM_CHANNEL ?? 'telegram'
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', CHANNEL)
const FEED_DIR = join(STATE_DIR, 'activity')

/**
 * Minimum ms between edits. Telegram starts rate-limiting message edits around
 * one per second; a rejected edit is harmless here because the next event
 * carries the same text plus whatever arrived since.
 */
const EDIT_INTERVAL_MS = 900
/** Telegram's cap is 4096; leave room for the header and the trailing marker. */
const MAX_CHARS = 3600
/** How long a finished card stays editable before the next turn opens a new one. */
const CARD_IDLE_MS = 90_000

main().catch(() => process.exit(0))

async function main() {
  const payload = await readStdin()
  if (!payload) return

  const event = payload.hook_event_name ?? ''
  const sessionId = payload.session_id
  const transcript = payload.transcript_path
  if (!sessionId || !transcript) return

  const token = loadToken()
  if (!token) return

  mkdirSync(FEED_DIR, { recursive: true })
  const stateFile = join(FEED_DIR, `${sanitize(sessionId)}.json`)
  const st = loadState(stateFile)

  // Pull everything the transcript gained since the last event. This is where
  // the assistant's own prose comes from — the hook payload only carries tool
  // metadata, never the model's words.
  const { entries, offset } = readTranscriptTail(transcript, st.offset ?? 0)
  st.offset = offset

  for (const entry of entries) ingest(st, entry)

  // A tool call is visible in the payload before it is in the transcript, so
  // PreToolUse gets the line out roughly a second earlier than the tail would.
  if (event === 'PreToolUse' && payload.tool_name) {
    pushLine(st, toolLine(payload.tool_name, payload.tool_input ?? {}))
  }

  if (event === 'UserPromptSubmit') {
    // New turn — retire the previous card so the next line opens a fresh one.
    st.messageId = null
    st.lines = []
    st.done = false
  }

  const finished = event === 'Stop'
  if (finished) st.done = true

  if (!st.chatId || !st.lines.length) {
    saveState(stateFile, st)
    return
  }

  const now = Date.now()
  const due = finished || now - (st.lastEdit ?? 0) >= EDIT_INTERVAL_MS
  if (!due) {
    saveState(stateFile, st)
    return
  }

  // A card that has gone quiet for a while belongs to a turn the user has
  // already read past; start a new one rather than resurrecting it.
  if (st.messageId && now - (st.lastEdit ?? 0) > CARD_IDLE_MS) st.messageId = null

  const body = render(st)
  if (body === st.lastBody) {
    saveState(stateFile, st)
    return
  }

  const sent = await publish(token, st, body)
  if (sent) {
    st.messageId = sent
    st.lastBody = body
    st.lastEdit = now
  }

  // The card belongs to the turn that produced it. Once the turn ends, let it
  // stand as a record and start the next one in its own message.
  if (finished) {
    st.messageId = null
    st.lines = []
  }
  saveState(stateFile, st)
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/**
 * Read new JSONL entries from `offset`. Returns the parsed entries and the
 * offset of the last complete line — a partial trailing line is left for the
 * next call so a half-flushed write is never parsed.
 */
function readTranscriptTail(path, offset) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    // A shrunken file means a new transcript at the same path.
    if (size < offset) offset = 0
    if (size === offset) return { entries: [], offset }

    const len = size - offset
    const buf = Buffer.allocUnsafe(len)
    readSync(fd, buf, 0, len, offset)
    const text = buf.toString('utf8')

    const lastNl = text.lastIndexOf('\n')
    if (lastNl === -1) return { entries: [], offset }

    const entries = []
    for (const line of text.slice(0, lastNl).split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
      } catch {}
    }
    return { entries, offset: offset + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8') }
  } catch {
    return { entries: [], offset }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

/** Fold one transcript entry into the card. */
function ingest(st, entry) {
  // The same inbound message shows up under several entry types — as a `user`
  // entry when it starts a turn, and as `queue-operation` when it arrives
  // mid-turn, often repeated. Keying on its message_id collapses all of that
  // into one new card per actual message.
  const inbound = findInbound(entry)
  if (inbound) {
    st.chatId = inbound.chatId
    // The two forms are not adjacent — a message queued mid-turn reappears as
    // a `user` entry once it is actually processed — so remembering only the
    // previous id would open a second card for the same message.
    st.seenInbound = st.seenInbound ?? []
    if (inbound.messageId && !st.seenInbound.includes(inbound.messageId)) {
      st.seenInbound.push(inbound.messageId)
      if (st.seenInbound.length > 50) st.seenInbound = st.seenInbound.slice(-50)
      st.messageId = null
      st.lines = []
      st.done = false
    }
    return
  }

  const msg = entry?.message
  if (!msg) return
  if (entry.type !== 'assistant' || !Array.isArray(msg.content)) return
  for (const block of msg.content) {
    // Thinking stays private; tool_use is already covered by PreToolUse.
    if (block?.type === 'text' && block.text?.trim()) pushLine(st, { kind: 'text', text: block.text.trim() })
  }
}

/** Chat and message id of an inbound channel tag, or null if this isn't one. */
function findInbound(entry) {
  const content = entry?.message?.content ?? entry?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((b) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('\n')
        : ''
  if (!text) return null

  const tag = /<channel[^>]*\bsource="plugin:telegram-unleashed[^"]*"[^>]*>/.exec(text)
  if (!tag) return null
  const chatId = /\bchat_id="(-?\d+)"/.exec(tag[0])?.[1]
  if (!chatId) return null
  return { chatId, messageId: /\bmessage_id="(\d+)"/.exec(tag[0])?.[1] ?? null }
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function pushLine(st, line) {
  if (!line) return
  st.lines = st.lines ?? []
  const prev = st.lines[st.lines.length - 1]
  // Consecutive identical entries are noise (retries, repeated reads).
  if (prev && prev.kind === line.kind && prev.text === line.text) return
  st.lines.push(line)
  if (st.lines.length > 60) st.lines = st.lines.slice(-60)
}

/** One compact line describing a tool call. */
function toolLine(name, input) {
  // Sending to Telegram is what produces this feed; echoing it is a loop.
  if (/telegram-unleashed/.test(name)) return null

  const short = name.replace(/^mcp__[^_]*__/, '').replace(/^mcp__/, '')
  const file = (p) => (typeof p === 'string' ? basename(p) : '')

  switch (short) {
    case 'Read':
      return { kind: 'tool', text: `read ${file(input.file_path)}` }
    case 'Write':
      return { kind: 'tool', text: `write ${file(input.file_path)}` }
    case 'Edit':
      return { kind: 'tool', text: `edit ${file(input.file_path)}` }
    case 'NotebookEdit':
      return { kind: 'tool', text: `edit ${file(input.notebook_path)}` }
    case 'Bash':
    case 'PowerShell':
      // The command itself, not the description — a paraphrase of a shell
      // command is strictly less information than the command.
      return { kind: 'tool', text: clip(input.command || input.description || short, 160) }
    case 'Grep':
      return { kind: 'tool', text: `grep "${clip(input.pattern ?? '', 50)}"` }
    case 'Glob':
      return { kind: 'tool', text: `find ${clip(input.pattern ?? '', 50)}` }
    case 'Agent':
      return { kind: 'tool', text: `subagent: ${clip(input.description ?? '', 70)}` }
    case 'Task':
      return { kind: 'tool', text: clip(input.description ?? short, 70) }
    case 'WebFetch':
      return { kind: 'tool', text: `fetch ${clip(input.url ?? '', 70)}` }
    case 'WebSearch':
      return { kind: 'tool', text: `search: ${clip(input.query ?? '', 60)}` }
    case 'Skill':
      return { kind: 'tool', text: `skill ${input.skill ?? ''}` }
    case 'ToolSearch':
      return null
    default:
      return { kind: 'tool', text: short }
  }
}

function clip(s, n) {
  const one = String(s).replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(st) {
  const parts = []
  for (const line of st.lines ?? []) {
    if (line.kind === 'tool') parts.push(`<code>› ${esc(line.text)}</code>`)
    else parts.push(esc(line.text))
  }
  let body = parts.join('\n')
  if (body.length > MAX_CHARS) body = '…\n' + body.slice(-(MAX_CHARS - 2))

  const marker = st.done ? '\n\n<i>done</i>' : '\n\n<i>working…</i>'
  return body + marker
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function publish(token, st, body) {
  const root = (process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org').replace(/\/+$/, '')
  const base = `${root}/bot${token}`

  if (st.messageId) {
    const res = await call(`${base}/editMessageText`, {
      chat_id: st.chatId,
      message_id: st.messageId,
      text: body,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
    // "not modified" is fine; anything else means the message is gone and a
    // fresh one should take its place.
    if (res?.ok) return st.messageId
    if (/not modified/i.test(res?.description ?? '')) return st.messageId
  }

  const res = await call(`${base}/sendMessage`, {
    chat_id: st.chatId,
    text: body,
    parse_mode: 'HTML',
    disable_notification: true,
    link_preview_options: { is_disabled: true },
  })
  return res?.ok ? res.result.message_id : null
}

async function call(url, payload) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 4000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    })
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function loadToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  try {
    for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^TELEGRAM_BOT_TOKEN=(.*)$/)
      if (m) return m[1].trim()
    }
  } catch {}
  return null
}

function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { lines: [], offset: 0 }
  }
}

function saveState(file, st) {
  try {
    writeFileSync(file, JSON.stringify(st))
  } catch {}
}

function sanitize(s) {
  return String(s).replace(/[^\w.-]/g, '_')
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = ''
    // A hook that never sees stdin must not hang the turn.
    const t = setTimeout(() => resolve(null), 2000)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (raw += c))
    process.stdin.on('end', () => {
      clearTimeout(t)
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
    process.stdin.on('error', () => {
      clearTimeout(t)
      resolve(null)
    })
  })
}
