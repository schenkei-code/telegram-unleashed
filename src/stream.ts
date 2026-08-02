/**
 * Presence and live output.
 *
 * Two problems the original plugin left open:
 *
 * 1. sendChatAction('typing') expires after ~5 seconds. A turn that takes two
 *    minutes shows "typing…" for the first five and then nothing — the user
 *    can't tell a working agent from a dead one. TypingKeeper re-pokes on an
 *    interval until output actually goes out.
 *
 * 2. There was no way to show partial output. Bot API 10.2 added
 *    sendRichMessageDraft, which streams a message while it is being written —
 *    the user watches the answer appear. Where that isn't available we fall
 *    back to edit-based streaming, which looks nearly the same.
 */

import type { Bot } from 'grammy'
import { prefs } from './config.js'
import { markdownToHtml, chunkHtml } from './format.js'
import { stopHeartbeat } from './status.js'

type Api = Bot['api']

// ---------------------------------------------------------------------------
// Typing keepalive
// ---------------------------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setInterval>>()
const deadlines = new Map<string, number>()

/**
 * Start (or refresh) the typing indicator for a chat and keep it alive.
 * Idempotent — calling it again just extends the deadline.
 */
export function startTyping(api: Api, chat_id: string, action: 'typing' | 'upload_document' | 'upload_photo' = 'typing'): void {
  const p = prefs()
  if (!p.typingKeepalive) {
    void api.sendChatAction(chat_id, action).catch(() => {})
    return
  }

  deadlines.set(chat_id, Date.now() + p.typingMaxSec * 1000)
  void api.sendChatAction(chat_id, action).catch(() => {})
  if (timers.has(chat_id)) return

  const t = setInterval(() => {
    const until = deadlines.get(chat_id) ?? 0
    if (Date.now() > until) {
      // Only the indicator gives up here. A turn that outlives the keepalive
      // is still running, and settling the status line into "Done" would say
      // the opposite of the truth.
      clearTypingTimer(chat_id)
      return
    }
    void api.sendChatAction(chat_id, action).catch(() => {})
  }, p.typingIntervalSec * 1000)
  // Never hold the process open on account of an indicator.
  if (typeof t.unref === 'function') t.unref()
  timers.set(chat_id, t)
}

/**
 * Stop the indicator. Called as soon as real output goes out — which is also
 * the moment the status line has said what it was there to say, so it closes
 * with it.
 */
export function stopTyping(chat_id: string): void {
  stopHeartbeat(chat_id)
  clearTypingTimer(chat_id)
}

function clearTypingTimer(chat_id: string): void {
  const t = timers.get(chat_id)
  if (t) clearInterval(t)
  timers.delete(chat_id)
  deadlines.delete(chat_id)
}

export function stopAllTyping(): void {
  for (const id of [...timers.keys()]) stopTyping(id)
}

// ---------------------------------------------------------------------------
// Live streaming
// ---------------------------------------------------------------------------

/**
 * Whether the account can use rich-message drafts. Probed once on first use;
 * a rejection disables it for the process so we don't retry on every token.
 */
let draftsAvailable: boolean | null = null

export function draftSupport(): 'unknown' | 'yes' | 'no' {
  return draftsAvailable === null ? 'unknown' : draftsAvailable ? 'yes' : 'no'
}

/** Set when Telegram rate-limits draft updates; frames are skipped until then. */
let draftCooldownUntil = 0

/** Seconds Telegram asked us to wait, or null if this wasn't a rate limit. */
function retryAfter(err: unknown): number | null {
  const p = (err as any)?.parameters?.retry_after
  if (typeof p === 'number') return p
  const msg = err instanceof Error ? err.message : String(err)
  if (!/429|too many requests/i.test(msg)) return null
  const m = /retry after (\d+)/i.exec(msg)
  return m ? Number(m[1]) : 1
}

type StreamState = {
  chat_id: string
  draft_id: number
  /** Accumulated markdown source. */
  text: string
  /** message_id of the fallback message being edited, if any. */
  messageId?: number
  lastPush: number
  lastPushed: string
  mode: 'draft' | 'edit' | 'buffer'
  reply_to?: number
  silent?: boolean
  closed: boolean
}

const streams = new Map<string, StreamState>()

let draftSeq = Date.now() % 2_000_000_000

/** Open a live stream in a chat. Returns its handle. */
export async function openStream(
  api: Api,
  chat_id: string,
  opts: { reply_to?: number; initial?: string; silent?: boolean } = {},
): Promise<{ stream_id: string; mode: 'draft' | 'edit' | 'buffer'; message_id?: number }> {
  const stream_id = `s${++draftSeq}`
  const st: StreamState = {
    chat_id,
    draft_id: draftSeq,
    text: opts.initial ?? '',
    lastPush: 0,
    lastPushed: '',
    mode: 'draft',
    reply_to: opts.reply_to,
    silent: opts.silent,
    closed: false,
  }

  // Drafts are private-chat only. A negative id is a group/channel — and a
  // group has no business watching an answer being written: half-formed text,
  // edited a dozen times, notifies and re-notifies everyone in the room. There
  // the stream buffers silently and lands as one finished message.
  const isPrivate = !chat_id.startsWith('-')
  if (!isPrivate) st.mode = 'buffer'
  else if (draftsAvailable === false) st.mode = 'edit'

  streams.set(stream_id, st)

  if (st.mode === 'edit' && st.text) {
    const sent = await sendEditable(api, st)
    st.messageId = sent
  } else if (st.mode === 'draft' && st.text) {
    await pushDraft(api, st)
  }

  return { stream_id, mode: st.mode, message_id: st.messageId }
}

/** Append to a stream. Rate-limited internally; safe to call per token. */
export async function pushStream(api: Api, stream_id: string, delta: string): Promise<void> {
  const st = streams.get(stream_id)
  if (!st || st.closed) throw new Error(`unknown or closed stream: ${stream_id}`)
  st.text += delta

  // Nothing to show mid-flight in a group; the text is kept and sent at the end.
  if (st.mode === 'buffer') return

  const p = prefs()
  const now = Date.now()
  if (now - st.lastPush < p.streamIntervalMs) return
  st.lastPush = now

  if (st.mode === 'draft') await pushDraft(api, st)
  else await pushEdit(api, st)
}

/** Replace a stream's whole content (rather than appending). */
export async function setStream(api: Api, stream_id: string, text: string): Promise<void> {
  const st = streams.get(stream_id)
  if (!st || st.closed) throw new Error(`unknown or closed stream: ${stream_id}`)
  st.text = text
  st.lastPush = 0
  await pushStream(api, stream_id, '')
}

/**
 * Finish a stream, committing the final text as a real message.
 * Returns the message ids that were sent.
 */
export async function closeStream(
  api: Api,
  stream_id: string,
  finalText?: string,
): Promise<number[]> {
  const st = streams.get(stream_id)
  if (!st) throw new Error(`unknown stream: ${stream_id}`)
  if (finalText != null) st.text = finalText
  st.closed = true
  streams.delete(stream_id)

  // Closing the turn is deferred to the finally below: the status line settles
  // to the *end* of the chat now, and settling it before the answer is sent
  // would put the closing line above the thing it is closing.
  try {
    return await commit(api, st)
  } finally {
    stopTyping(st.chat_id)
  }
}

async function commit(api: Api, st: StreamState): Promise<number[]> {
  const p = prefs()
  const html = markdownToHtml(st.text)

  if (st.mode === 'edit' && st.messageId != null) {
    // The live message already exists — finalise it, then send any overflow.
    const parts = chunkHtml(html, p.textChunkLimit, p.chunkMode)
    const ids: number[] = [st.messageId]
    await api
      .editMessageText(st.chat_id, st.messageId, parts[0], {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: !p.linkPreview },
      })
      .catch(() => {})
    for (const part of parts.slice(1)) {
      const sent = await api.sendMessage(st.chat_id, part, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: !p.linkPreview },
      })
      ids.push(sent.message_id)
    }
    return ids
  }

  // Draft mode: the draft was only a preview. Commit the real message.
  if (st.mode === 'draft' && draftsAvailable !== false) {
    try {
      const sent = await (api.raw as any).sendRichMessage({
        chat_id: Number(st.chat_id),
        rich_message: { markdown: st.text },
        ...(st.silent ? { disable_notification: true } : {}),
        ...(st.reply_to ? { reply_parameters: { message_id: st.reply_to } } : {}),
      })
      const id = typeof sent === 'object' && sent && 'message_id' in sent ? (sent as any).message_id : 0
      return id ? [id] : []
    } catch (err) {
      // Rich message rejected — fall through to plain HTML so the user still
      // gets the answer.
      process.stderr.write(`telegram-unleashed: sendRichMessage failed, falling back: ${err}\n`)
      draftsAvailable = false
    }
  }

  const parts = chunkHtml(html, p.textChunkLimit, p.chunkMode)
  const ids: number[] = []
  for (let i = 0; i < parts.length; i++) {
    const sent = await api.sendMessage(st.chat_id, parts[i], {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: !p.linkPreview },
      ...(st.silent ? { disable_notification: true } : {}),
      ...(i === 0 && st.reply_to ? { reply_parameters: { message_id: st.reply_to } } : {}),
    })
    ids.push(sent.message_id)
  }
  return ids
}

/**
 * Reveal a finished text word by word, pacing the reveal here rather than
 * across tool calls.
 *
 * stream_push is one MCP round-trip per chunk, so a caller-driven stream moves
 * at the caller's thinking speed — seconds between chunks. When the text is
 * already written, the pacing has no reason to leave this process: one call in,
 * a smooth reveal out.
 *
 * Drafts are cheap enough to update several times a second. Edit-based
 * streaming is not, so it gets a slower tick and correspondingly bigger steps —
 * the reveal still finishes in the same wall-clock time either way.
 */
export async function typeOut(
  api: Api,
  chat_id: string,
  text: string,
  opts: { reply_to?: number; tickMs?: number; maxMs?: number; unit?: TypeUnit; silent?: boolean } = {},
): Promise<number[]> {
  const { stream_id } = await openStream(api, chat_id, { reply_to: opts.reply_to, silent: opts.silent })
  const st = streams.get(stream_id)
  if (!st) return []

  // In a group the reveal is skipped outright rather than played out slowly:
  // the point of typing something out is that one person is watching it happen.
  if (st.mode === 'buffer') return closeStream(api, stream_id, text)

  const words = tokenize(text, opts.unit ?? 'natural')
  // Drafts tolerate this comfortably — the 429s seen while tuning came from
  // bursts across several streams, not from the tick itself. The edit fallback
  // is charged per message edit and has to go much slower.
  const tick = Math.max(60, opts.tickMs ?? (st.mode === 'draft' ? 180 : 1100))
  // A few seconds is about as long as a reveal stays charming; past that the
  // step size grows rather than the wait.
  const budget = Math.max(tick, opts.maxMs ?? 3_500)

  // Long text speeds up instead of dragging on — a reveal nobody waits out is
  // worse than no reveal at all.
  const ticks = Math.max(1, Math.floor(budget / tick))
  const step = Math.max(1, Math.ceil(words.length / ticks))

  for (let i = 0; i < words.length; i += step) {
    st.text += words.slice(i, i + step).join('')
    if (i + step >= words.length) break // the final frame is closeStream's job
    if (st.mode === 'draft') await pushDraft(api, st)
    else await pushEdit(api, st)
    await sleep(tick)
  }

  return closeStream(api, stream_id, text)
}

export type TypeUnit = 'natural' | 'char' | 'word' | 'line' | 'paragraph'

/** Words up to this length spell themselves out; longer ones land whole. */
const SPELL_OUT_MAX = 3

/**
 * Split text into reveal units. Every token carries its own trailing
 * whitespace, so concatenating any prefix reproduces the original exactly —
 * no separator to re-insert and no drift between the preview and the commit.
 */
function tokenize(text: string, unit: TypeUnit): string[] {
  switch (unit) {
    case 'char':
      return [...text]
    case 'line':
      return text.match(/[^\n]*\n?/g)?.filter((s) => s !== '') ?? [text]
    case 'paragraph':
      return text.match(/[\s\S]*?(?:\n{2,}|$)/g)?.filter((s) => s !== '') ?? [text]
    case 'word':
      return text.match(/\S+\s*/g) ?? [text]
    case 'natural':
    default:
      return natural(text)
  }
}

/**
 * Character-by-character everywhere reads as a stutter on long words, and
 * word-by-word skips the part that looks like typing. Split the difference:
 * short words spell themselves out, long ones arrive whole. The rhythm stays
 * even because both take roughly the same number of frames.
 */
function natural(text: string): string[] {
  const out: string[] = []
  for (const token of text.match(/\S+\s*/g) ?? []) {
    const word = token.replace(/\s+$/, '')
    const gap = token.slice(word.length)
    if ([...word].length > SPELL_OUT_MAX) {
      out.push(token)
      continue
    }
    // The trailing space rides on the last letter, so no frame shows a word
    // that has visibly ended but not yet spaced.
    const chars = [...word]
    chars.forEach((c, i) => out.push(i === chars.length - 1 ? c + gap : c))
  }
  return out.length ? out : [text]
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Drop a stream without committing anything. */
export function abortStream(stream_id: string): void {
  const st = streams.get(stream_id)
  if (st) {
    stopTyping(st.chat_id)
    streams.delete(stream_id)
  }
}

export function activeStreams(): string[] {
  return [...streams.keys()]
}

// ---------------------------------------------------------------------------

async function pushDraft(api: Api, st: StreamState): Promise<void> {
  if (st.text === st.lastPushed) return
  // Skipping a frame is invisible — the next one carries the same text plus
  // whatever arrived meanwhile, and closeStream commits the whole thing.
  if (Date.now() < draftCooldownUntil) return
  try {
    await (api.raw as any).sendRichMessageDraft({
      chat_id: Number(st.chat_id),
      draft_id: st.draft_id,
      rich_message: { markdown: st.text },
    })
    st.lastPushed = st.text
    draftsAvailable = true
  } catch (err) {
    // A rate limit says "slower", not "unsupported". Treating it as the latter
    // would cost the account rich drafts for the rest of the process over one
    // burst, so back off and keep the mode.
    const retry = retryAfter(err)
    if (retry != null) {
      draftCooldownUntil = Date.now() + retry * 1000
      return
    }
    // Anything else decides it for the process — switch this stream (and all
    // future ones) to edit-based streaming.
    draftsAvailable = false
    st.mode = 'edit'
    process.stderr.write(`telegram-unleashed: rich drafts unavailable, using edit streaming: ${err}\n`)
    st.messageId = await sendEditable(api, st)
  }
}

async function sendEditable(api: Api, st: StreamState): Promise<number> {
  const p = prefs()
  const html = trimToLimit(markdownToHtml(st.text || '…'), p.textChunkLimit)
  const sent = await api.sendMessage(st.chat_id, html, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(st.reply_to ? { reply_parameters: { message_id: st.reply_to } } : {}),
  })
  st.lastPushed = st.text
  return sent.message_id
}

async function pushEdit(api: Api, st: StreamState): Promise<void> {
  if (st.text === st.lastPushed) return
  const p = prefs()
  if (st.messageId == null) {
    st.messageId = await sendEditable(api, st)
    return
  }
  const html = trimToLimit(markdownToHtml(st.text), p.textChunkLimit)
  try {
    await api.editMessageText(st.chat_id, st.messageId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
    st.lastPushed = st.text
  } catch (err) {
    // "message is not modified" and rate limits are both non-fatal here —
    // the next push will catch up, and closeStream() writes the final text.
    const msg = err instanceof Error ? err.message : String(err)
    if (!/not modified|Too Many Requests/i.test(msg)) {
      process.stderr.write(`telegram-unleashed: stream edit failed: ${msg}\n`)
    }
  }
}

/**
 * While streaming we can only show one message's worth. Keep the tail (the
 * part being written) and mark the truncation; closeStream sends everything.
 */
function trimToLimit(html: string, limit: number): string {
  if (html.length <= limit) return html
  const parts = chunkHtml(html, limit - 8, 'newline')
  const tail = parts[parts.length - 1] ?? html.slice(-(limit - 8))
  return '…\n' + tail
}
