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
 * Two modes, set as `feedMode` in access.json:
 *
 *   live   (default) — the card is a view, not a log: every new assistant
 *          paragraph deletes the previous card and opens a fresh one, and the
 *          whole feed is taken out of the chat when the turn ends. What stands
 *          afterwards is the answer alone.
 *
 *   mirror — the card is scrollback, the way a terminal is scrollback. Nothing
 *          is ever deleted, thinking is shown, and a full card is left standing
 *          while the next one opens beneath it. For driving a session from the
 *          phone, where the chat has to be the terminal rather than a preview
 *          of it.
 *
 * Note what mirror does NOT do: print tool output in full. The terminal does
 * not either — it collapses a long result behind ctrl+o and shows the first
 * few lines. Mirroring that collapse is what makes the two views match; a
 * `Read` of a thousand-line file printed whole is something the terminal never
 * showed in the first place.
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
 * Minimum ms between edits. Telegram rate-limits a chat to roughly one message
 * a second and the status line is editing from the same budget — the clock on
 * it should tick smoothly, and a tool call showing up half a second later does
 * not. So the card yields: it spends less of the allowance than the line does.
 * A rejected edit is harmless either way, the next event carries the same text
 * plus whatever arrived since.
 */
const EDIT_INTERVAL_MS = 1800
/** Telegram's cap is 4096; leave room for the block markup around the body. */
const MAX_CHARS = 3600
/**
 * Steps a card holds before it is retired and a fresh one takes over. Each
 * step is a bullet, its result and a blank line, so this is roughly three
 * times as many lines on screen.
 */
const MAX_LINES = 6
/**
 * Result lines printed under a call. The terminal shows about five before it
 * collapses the rest behind ctrl+o; four plus the "+N lines" tail is the same
 * shape in a message that also has to fit on a phone.
 */
const RESULT_LINES = 4
/** How long a finished card stays editable before the next turn opens a new one. */
const CARD_IDLE_MS = 90_000

/**
 * Mirror mode: the feed is scrollback rather than a live view.
 *
 * Read once per process — every hook event is its own process, so this is a
 * single stat per event and always reflects the file as it stands.
 */
const MIRROR = readAccess().feedMode === 'mirror'
/**
 * A mirrored card may stand a little taller: nothing above it will be deleted,
 * so the cost of a card is one message rather than a message that replaces
 * what came before. Still bounded — a card past this reads as a wall.
 */
const MIRROR_MAX_LINES = 12
/** Thinking, clipped to what a phone will scroll through without complaint. */
const THINKING_CHARS = 700

function readAccess() {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8'))
  } catch {
    return {}
  }
}

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

  // The result belongs to the call above it, the way the terminal prints it.
  if (event === 'PostToolUse' && payload.tool_name) {
    attachResult(st, resultText(payload))
  }

  if (event === 'UserPromptSubmit') {
    // New turn — retire the previous card so the next line opens a fresh one.
    st.messageId = null
    st.lines = []
    st.tokens = 0
    // Claude Code's own clock starts here, not when Telegram received the
    // message: between the two sit the relay and the queue. Handing the moment
    // over is what makes the two clocks read the same.
    st.turnStart = Date.now()
  }

  // Hand the running count to the bridge process, which puts it on the status
  // line the way the terminal puts it next to the spinner.
  if (st.chatId) publishTurn(st.chatId, st.tokens ?? 0, st.turnStart)

  const finished = event === 'Stop'

  // The card was a view of work in progress, and the work is no longer in
  // progress. What should stand afterwards is the answer and the closing
  // status line — a stack of tool calls between them is scrollback nobody
  // reads twice.
  if (finished && st.chatId && !MIRROR) {
    await retire(token, st)
    st.messageId = null
    st.lines = []
    st.lastBody = null
    saveState(stateFile, st)
    return
  }

  // Mirror mode ends the turn the other way round: whatever the rate limit held
  // back gets one last publish, unthrottled, so the scrollback is complete
  // rather than missing its final steps. Then the card is closed — the next
  // turn opens its own instead of editing this one.
  if (finished && st.chatId) {
    if (st.lines?.length) {
      const body = render(st)
      if (body !== st.lastBody) {
        const sent = await publish(token, st, body)
        if (sent) st.messageId = sent
      }
    }
    st.messageId = null
    st.lines = []
    st.lastBody = null
    saveState(stateFile, st)
    return
  }

  if (!st.chatId || !st.lines.length) {
    saveState(stateFile, st)
    return
  }

  const now = Date.now()
  const due = now - (st.lastEdit ?? 0) >= EDIT_INTERVAL_MS
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
      st.tokens = 0
    }
    return
  }

  const msg = entry?.message
  if (!msg) return
  if (entry.type !== 'assistant') return

  // What the terminal counts next to the spinner: tokens the model has
  // produced this turn. The plugin's own process never sees these — Claude Code
  // reports usage to the transcript, not to an MCP server — so the count is
  // handed over on disk.
  const out = msg.usage?.output_tokens
  if (typeof out === 'number') st.tokens = (st.tokens ?? 0) + out

  if (!Array.isArray(msg.content)) return
  for (const block of msg.content) {
    // Thinking is on screen in the terminal, so a mirror shows it too. In live
    // mode it stays out: that feed exists to say what is happening, and
    // reasoning is not that. tool_use is already covered by PreToolUse.
    if (MIRROR && block?.type === 'thinking' && block.thinking?.trim()) {
      rollCard(st)
      pushLine(st, { kind: 'thinking', text: clip(block.thinking.trim(), THINKING_CHARS) })
      continue
    }
    if (block?.type === 'text' && block.text?.trim()) {
      // A new paragraph closes the card that came before it. Without this the
      // card grows for the whole turn and ends up a wall of tool lines nobody
      // scrolls back through.
      rollCard(st)
      pushLine(st, { kind: 'text', text: block.text.trim() })
    }
  }
}

/**
 * Retire the current card and start an empty one. The old message is queued for
 * deletion rather than left behind — the feed is a live view of the work, not a
 * log, and a chat full of superseded cards defeats the point.
 */
function rollCard(st) {
  if (!st.lines?.length) return
  // In mirror mode the finished card is left standing and the next one opens
  // below it. That is the whole difference between a view and scrollback:
  // dropping `messageId` without queueing it for deletion means the next
  // publish sends rather than edits, and nothing that was on screen is taken
  // back off it.
  if (st.messageId && !MIRROR) {
    st.stale = st.stale ?? []
    st.stale.push(st.messageId)
  }
  st.messageId = null
  st.lines = []
  st.lastBody = null
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
  // Consecutive identical entries are noise (retries, repeated reads). Compare
  // every field that identifies one: a tool call carries name and argument, not
  // text, and comparing an absent field collapses every call into the first.
  if (prev && prev.kind === line.kind && prev.text === line.text && prev.name === line.name && prev.arg === line.arg) return
  // A long stretch of tool calls with no prose between them would otherwise
  // grow one card past what anyone reads on a phone. Paragraphs alone are not
  // a reliable break: a turn can run twenty tools without saying a word.
  if (st.lines.length >= (MIRROR ? MIRROR_MAX_LINES : MAX_LINES)) rollCard(st)
  st.lines.push(line)
}

/**
 * One tool call, written the way the terminal writes it: `Tool(argument)`.
 * The argument is whatever identifies the call at a glance — the command, the
 * file, the pattern — because that is what the terminal shows and this feed
 * exists to be the same view from a phone.
 */
function toolLine(name, input) {
  // Sending to Telegram is what produces this feed; echoing it is a loop.
  if (/telegram-unleashed/.test(name)) return null

  const short = toolName(name)
  // The whole path, as the terminal prints it. A monospace block scrolls
  // sideways instead of wrapping, so a long line costs a swipe, not the layout.
  const file = (p) => (typeof p === 'string' ? p : '')
  // Name and argument stay apart so the card can set them differently — the
  // terminal leans on colour for that, a Telegram message on weight and font.
  const call = (arg, as = short) => ({ kind: 'tool', name: as, arg })

  switch (short) {
    case 'Read':
      return call(file(input.file_path))
    case 'Write':
      return call(file(input.file_path), 'Create')
    // The terminal calls an edit an Update, and the wording is the point of
    // matching it: this card exists to read like the one on the machine.
    case 'Edit':
      return call(file(input.file_path), 'Update')
    case 'NotebookEdit':
      return call(file(input.notebook_path), 'Update')
    case 'Bash':
    case 'PowerShell':
      // The command itself, not the description — a paraphrase of a shell
      // command is strictly less information than the command. Its line breaks
      // survive too: the terminal shows a heredoc shaped like a heredoc.
      return call(keep(input.command || input.description || '', 600))
    case 'Grep':
      return call(clip(input.pattern ?? '', 50))
    case 'Glob':
      return call(clip(input.pattern ?? '', 50))
    case 'Agent':
    case 'Task':
      return call(clip(input.description ?? '', 70))
    case 'WebFetch':
      return call(clip(input.url ?? '', 70))
    case 'WebSearch':
      return call(clip(input.query ?? '', 60))
    case 'Skill':
      return call(input.skill ?? '')
    case 'ToolSearch':
      // In live mode this is plumbing — the agent fetching a schema is not the
      // work. A mirror shows it, because the terminal does.
      return MIRROR ? call(clip(input.query ?? '', 60)) : null
    default:
      // Everything else: an MCP tool, a plugin's own tool, something newer than
      // this switch. `call('')` would print a bare name with empty brackets and
      // throw away the one field that says what it was for, so guess the
      // argument the way the cases above pick theirs.
      return call(guessArg(input))
  }
}

/**
 * Tool identifiers with the MCP scaffolding taken off.
 *
 * `mcp__<server>__<tool>` is the documented shape, but a server name may itself
 * carry underscores — `mcp__claude_ai_Gmail__search_threads` — and a pattern
 * anchored on single underscores leaves the whole prefix behind. Splitting on
 * the double underscore is what actually holds: the last field is the tool, the
 * one before it the server, and the server is worth keeping because `Gmail ·
 * search_threads` says where the call went and `search_threads` alone does not.
 */
function toolName(name) {
  if (!name.startsWith('mcp__')) return name
  const parts = name.slice(5).split('__').filter(Boolean)
  if (parts.length < 2) return parts[0] ?? name
  const tool = parts[parts.length - 1]
  // Server names arrive prefixed by their origin (`claude_ai_Gmail`,
  // `plugin_claude-mem_mcp-search`); the tail is the part anyone recognises.
  const server = parts[parts.length - 2].split('_').filter(Boolean).pop()
  return server ? `${server} · ${tool}` : tool
}

/**
 * The field of an unknown tool's input most likely to identify the call.
 *
 * Ordered by how specific each name usually is, then falling back to the first
 * short string in the object — for a tool this hook has never heard of, some
 * argument beats none.
 */
function guessArg(input) {
  if (!input || typeof input !== 'object') return ''
  const named = ['query', 'prompt', 'description', 'path', 'file_path', 'url', 'name', 'id', 'text', 'message']
  for (const key of named) {
    if (typeof input[key] === 'string' && input[key].trim()) return clip(input[key], 70)
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim() && value.length <= 200) return clip(value, 70)
  }
  return ''
}

/**
 * The result the terminal prints under a call, or '' when there is nothing.
 *
 * An edit's raw response is the whole patch, which is useless at this size —
 * the terminal summarises it as a line count and so does this. Same for a read:
 * the file's contents are not news, the fact that it was read is.
 */
function resultText(payload) {
  const r = payload.tool_response ?? payload.tool_result ?? payload.result
  if (r == null) return ''
  if (typeof r === 'string') return r
  if (typeof r !== 'object') return ''

  if (Array.isArray(r.structuredPatch)) {
    let added = 0
    let removed = 0
    for (const hunk of r.structuredPatch) {
      for (const l of hunk?.lines ?? []) {
        if (l.startsWith('+')) added++
        else if (l.startsWith('-')) removed++
      }
    }
    if (added || removed) return `Added ${plural(added, 'line')}, removed ${plural(removed, 'line')}`
    if (r.type === 'create') return 'Created'
  }

  const numLines = r.file?.numLines
  if (typeof numLines === 'number') return `Read ${plural(numLines, 'line')}`

  // Otherwise take the first field that reads as text.
  const candidate = r.stdout ?? r.output ?? r.content ?? r.text ?? r.message
  if (typeof candidate === 'string') return candidate
  if (Array.isArray(candidate)) {
    return candidate.map((c) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('\n')
  }
  return ''
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Hang a result off the call it belongs to, rather than pushing a new line. */
function attachResult(st, text) {
  const last = st.lines?.[st.lines.length - 1]
  if (!last || last.kind !== 'tool' || last.result) return
  const body = String(text).replace(/\r/g, '').trim()
  if (!body) return

  const all = body.split('\n').filter((l) => l.trim())
  const shown = all.slice(0, RESULT_LINES).map((l) => clip(l, 200))
  const hidden = all.length - shown.length
  if (hidden > 0) shown.push(`… +${hidden} line${hidden === 1 ? '' : 's'}`)
  last.result = shown
}

function clip(s, n) {
  const one = String(s).replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

/** Like clip, but keeps the line breaks — a command is shaped how it was typed. */
function keep(s, n) {
  const text = String(s)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim()
  return text.length > n ? text.slice(0, n - 1) + '…' : text
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The card, in the terminal's own shape: a bullet per step, the call as
 * `Tool(argument)`, its result indented beneath it under the corner marker.
 *
 * One monospace block, because that is what a terminal is: the indentation of
 * a result under its call only survives in a fixed-width font, and it is the
 * indentation that makes the shape readable at a glance.
 *
 * No trailing "working…" marker: the status line the plugin posts alongside
 * carries the clock and the closing word, and saying it twice is noise.
 */
function render(st) {
  const parts = []
  for (const line of st.lines ?? []) {
    // A blank line between every step, as the terminal does it. Packed tight
    // the bullets read as one paragraph and the eye finds no step boundaries.
    if (parts.length) parts.push('')
    if (line.kind === 'text') {
      parts.push(`● ${line.text}`)
      continue
    }
    // The terminal's own marker for reasoning, so the eye sorts it from prose
    // without reading a word of it.
    if (line.kind === 'thinking') {
      parts.push(`✻ ${line.text}`)
      continue
    }
    // A multi-line command keeps its shape, its continuation lines indented
    // under the call the way the terminal lays them out.
    const arg = line.arg ? `(${line.arg.split('\n').join('\n  ')})` : ''
    parts.push(`● ${line.name}${arg}`)
    if (line.result?.length) {
      parts.push(`  ⎿  ${line.result[0]}`)
      for (const extra of line.result.slice(1)) parts.push(`     ${extra}`)
    }
  }
  let body = parts.join('\n')
  if (body.length > MAX_CHARS) body = '…\n' + body.slice(-(MAX_CHARS - 2))
  return `<pre>${esc(body)}</pre>`
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

/**
 * Take the card out of the chat: the live one and anything a paragraph or a
 * full card queued for deletion along the way. Best effort — a message the API
 * will not remove is simply left behind rather than retried forever.
 */
async function retire(token, st) {
  const root = (process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org').replace(/\/+$/, '')
  const base = `${root}/bot${token}`
  const target = feedChatId(st.chatId)
  if (!target) return

  const ids = [...(st.stale ?? []), ...(st.messageId ? [st.messageId] : [])]
  st.stale = []
  for (const id of ids) await call(`${base}/deleteMessage`, { chat_id: target, message_id: id })
}

async function publish(token, st, body) {
  const root = (process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org').replace(/\/+$/, '')
  const base = `${root}/bot${token}`
  const target = feedChatId(st.chatId)
  if (!target) return null

  // Cards superseded by a new paragraph. Deletion is best effort: a message the
  // API refuses to remove is dropped from the queue anyway, or every later
  // event would retry it forever.
  if (st.stale?.length) {
    const queued = st.stale
    st.stale = []
    for (const id of queued) await call(`${base}/deleteMessage`, { chat_id: target, message_id: id })
  }

  if (st.messageId) {
    const res = await call(`${base}/editMessageText`, {
      chat_id: target,
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
    chat_id: target,
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

/**
 * Where the feed is posted, or null to post nothing. A group turn's commentary
 * belongs to the operator, not to the group — statusChatId sends it there
 * instead. Without that setting a group turn gets no feed at all, rather than
 * one the whole group has to scroll past. Same rule as the status line.
 */
function feedChatId(chatId) {
  if (!chatId?.startsWith('-')) return chatId
  return readAccess().statusChatId || null
}

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

/**
 * The turn's token count and start time, in a file the bridge process reads.
 * Two processes, no channel between them: the hook is spawned per event and
 * the server is long-lived, so disk is the only thing they share.
 */
function publishTurn(chatId, tokens, startedAt) {
  try {
    const dir = join(STATE_DIR, 'turn')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${sanitize(chatId)}.json`),
      JSON.stringify({ tokens, startedAt: startedAt ?? null, at: Date.now() }),
    )
  } catch {}
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
