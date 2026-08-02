/**
 * The heartbeat message.
 *
 * A chat action ("typing…") is easy to miss and says nothing about which
 * message is being worked on. Worse, when a turn takes minutes the sender has
 * no way to distinguish a busy session from a bridge that stopped receiving —
 * the failure mode this plugin exists to avoid.
 *
 * So every inbound message gets an immediate message of its own: a status line
 * posted whole (never typed out — a status word that reveals itself letter by
 * letter defeats the point of being instant) with an emoji after it that cycles
 * while the turn runs. The animation lives in this process, so it keeps moving
 * regardless of what the agent is doing.
 *
 * When the answer goes out the line closes itself — but at the bottom of the
 * chat, not where it started. A turn puts an answer and a stack of activity
 * cards between the two, and a closing line settled in place is one nobody
 * scrolls back far enough to see.
 */

import type { Bot } from 'grammy'
import { readFileSync } from 'fs'
import { join } from 'path'
import { prefs, trace, STATE_DIR } from './config.js'
import { markdownToHtml } from './format.js'

type Api = Bot['api']

type Beat = {
  api: Api
  /** Where the line is posted — the turn's chat, or the owner's when redirected. */
  target: string
  /** Set when target is not the chat the turn came from. */
  origin?: string
  /** Fixed wording, if the caller set one. Otherwise words rotate. */
  text?: string
  words: string[]
  word: number
  frames: string[]
  frame: number
  startedAt: number
  /** Chosen once per turn — a tip that changes every frame is unreadable. */
  tip?: string
  /** The past-tense word the line settles on when the turn is done. */
  doneWord: string
  messageId?: number
  timer?: ReturnType<typeof setInterval>
  /** Set when the beat is cleared before its send resolved. */
  cancelled: boolean
}

/** Ticks between word changes — the emoji carries the fast rhythm. */
const WORD_EVERY = 4

const beats = new Map<string, Beat>()

/**
 * Post the status line for a chat and start cycling its emoji. Idempotent —
 * a second call while one is live leaves the existing message alone, so a
 * follow-up message mid-turn doesn't stack status lines.
 */
export function startHeartbeat(api: Api, chat_id: string): void {
  const p = prefs()
  if (!p.heartbeat) return
  if (beats.has(chat_id)) return

  // A group never sees a status line — not a live one, not a closing one, not
  // one that is posted and deleted again. Everyone in the group would have to
  // read past it to reach the answer, and a message that appears and vanishes
  // is worse than one that was never sent. With statusChatId the line moves to
  // the operator's own chat; without it, a group turn simply has no status.
  const isGroup = chat_id.startsWith('-')
  const redirect = isGroup && p.statusChatId !== '' && p.statusChatId !== chat_id
  if (isGroup && !redirect) return

  const beat: Beat = {
    api,
    target: redirect ? p.statusChatId : chat_id,
    origin: redirect ? chat_id : undefined,
    words: p.heartbeatWords,
    word: 0,
    frames: p.heartbeatFrames,
    frame: 0,
    startedAt: Date.now(),
    tip: p.heartbeatTips.length
      ? p.heartbeatTips[Math.floor(Math.random() * p.heartbeatTips.length)]
      : undefined,
    doneWord: p.heartbeatDoneWords[Math.floor(Math.random() * p.heartbeatDoneWords.length)] ?? 'Done',
    cancelled: false,
  }
  beats.set(chat_id, beat)

  // Out of context the line would just say something is happening somewhere.
  if (beat.origin) void groupTitle(api, beat.origin)

  void api
    .sendMessage(beat.target, render(beat), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    .then((sent) => {
      // The turn may have finished while this was in flight.
      if (beat.cancelled) {
        beat.messageId = sent.message_id
        settle(beat)
        return
      }
      beat.messageId = sent.message_id
      const t = setInterval(() => tick(chat_id), p.heartbeatIntervalSec * 1000)
      if (typeof t.unref === 'function') t.unref()
      beat.timer = t
    })
    .catch((err) => {
      trace(`heartbeat post failed chat=${beat.target}: ${err?.description ?? err}`)
      beats.delete(chat_id)
    })
}

/**
 * Called wherever real output goes out, so the agent never has to think about
 * it. The line does not vanish — it settles into a past-tense word and the
 * final duration, which is what tells the sender the turn is actually over
 * rather than merely quiet. Set heartbeatKeep false to delete it instead.
 */
export function stopHeartbeat(chat_id: string): void {
  const beat = beats.get(chat_id)
  if (!beat) return
  beats.delete(chat_id)
  beat.cancelled = true
  if (beat.timer) clearInterval(beat.timer)
  settle(beat)
}

function settle(beat: Beat): void {
  // The line was never posted — either the send is still in flight, in which
  // case it settles itself on arrival, or it failed. Both are worth knowing.
  if (beat.messageId == null) {
    trace(`heartbeat settle skipped — no message yet (target=${beat.target})`)
    return
  }
  const id = beat.messageId
  if (!prefs().heartbeatKeep) {
    void beat.api.deleteMessage(beat.target, id).catch(() => {})
    return
  }

  // The line was posted before the turn started, so by now the answer and any
  // activity cards sit below it — edited in place it settles somewhere nobody
  // scrolls back to. So it moves: the old line goes, the closing one arrives at
  // the end of the chat where the turn actually finished. Silent, because it
  // marks the end of something the user has already been notified about.
  void (async () => {
    await beat.api.deleteMessage(beat.target, id).catch(() => {})
    await beat.api
      .sendMessage(beat.target, renderDone(beat), {
        parse_mode: 'HTML',
        disable_notification: true,
        link_preview_options: { is_disabled: true },
      })
      // Nobody awaits this, so a rejection here is what "the closing line never
      // appeared" looks like from the chat. Silence would leave it unexplained.
      .catch((err) => trace(`heartbeat settle failed msg=${id}: ${err?.description ?? err}`))
  })()
}

export function stopAllHeartbeats(): void {
  for (const id of [...beats.keys()]) stopHeartbeat(id)
}

/** Replace the wording of a live status line, keeping the same message. */
export function setHeartbeatText(chat_id: string, text: string): boolean {
  const beat = beats.get(chat_id)
  if (!beat) return false
  beat.text = text
  tick(chat_id)
  return true
}

export function heartbeatActive(chat_id: string): boolean {
  return beats.has(chat_id)
}

function tick(chat_id: string): void {
  const beat = beats.get(chat_id)
  if (!beat || beat.messageId == null) return
  beat.frame = (beat.frame + 1) % beat.frames.length
  if (beat.frame % WORD_EVERY === 0) beat.word = (beat.word + 1) % beat.words.length
  void beat.api
    .editMessageText(beat.target, beat.messageId, render(beat), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
    // "not modified" and rate limits are both harmless — the next frame catches up.
    .catch(() => {})
}

function render(beat: Beat): string {
  const emoji = beat.frames[beat.frame] ?? ''
  const word = beat.text ?? beat.words[beat.word] ?? 'Working'
  // Elapsed time is what turns a status line into a heartbeat: a frozen clock
  // reads as a hung turn even while the emoji keeps moving.
  const secs = Math.floor((Date.now() - beat.startedAt) / 1000)
  const line = `${emoji} ${markdownToHtml(`_${word}…_`)} (${elapsed(secs)}${tokens(beat)})${where(beat)}`
  return beat.tip ? `${line}\n  ⎿  ${markdownToHtml(`_Tip: ${beat.tip}_`)}` : line
}

/**
 * The turn's token count, as the terminal shows it beside the spinner. Written
 * by the activity hook, which is the only part of this plugin that gets to see
 * Claude Code's usage numbers. Absent or stale, the clock stands on its own.
 */
function tokens(beat: Beat): string {
  try {
    const file = join(STATE_DIR, 'turn', `${beat.origin ?? beat.target}.json`.replace(/[^\w.-]/g, '_'))
    const { tokens: n, at } = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof n !== 'number' || n <= 0) return ''
    // A count from a turn that is already over would be a lie about this one.
    if (typeof at === 'number' && at < beat.startedAt) return ''
    return ` · ↓ ${n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n} tokens`
  } catch {
    return ''
  }
}

/** Names the group a redirected line belongs to; empty when it is in place. */
function where(beat: Beat): string {
  if (!beat.origin) return ''
  return ` · ${markdownToHtml(`_in ${titles.get(beat.origin) ?? 'a group'}_`)}`
}

const titles = new Map<string, string>()

async function groupTitle(api: Api, chat_id: string): Promise<void> {
  if (titles.has(chat_id)) return
  try {
    const chat = await api.getChat(chat_id)
    const title = 'title' in chat && chat.title ? chat.title : chat_id
    titles.set(chat_id, title)
  } catch {
    titles.set(chat_id, chat_id)
  }
}

/**
 * The finished line. No tip and no ellipsis — the point of it is that nothing
 * is still in flight.
 */
function renderDone(beat: Beat): string {
  const secs = Math.floor((Date.now() - beat.startedAt) / 1000)
  return `${prefs().heartbeatDoneFrame} ${markdownToHtml(`_${beat.doneWord}_`)} (${elapsed(secs)}${tokens(beat)})${where(beat)}`
}

function elapsed(secs: number): string {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return s ? `${m}m ${s}s` : `${m}m`
}
