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
 * regardless of what the agent is doing, and it clears itself the moment real
 * output goes out.
 */

import type { Bot } from 'grammy'
import { prefs } from './config.js'
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

  // A group is an audience. Unless told otherwise the line stays where the
  // turn happened; with statusChatId set it moves to the owner's chat, so the
  // group only ever sees the finished message.
  const redirect = chat_id.startsWith('-') && p.statusChatId && p.statusChatId !== chat_id

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
    .catch(() => {
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
  if (beat.messageId == null) return
  if (!prefs().heartbeatKeep) {
    void beat.api.deleteMessage(beat.target, beat.messageId).catch(() => {})
    return
  }
  void beat.api
    .editMessageText(beat.target, beat.messageId, renderDone(beat), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
    .catch(() => {})
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
  const line = `${emoji} ${markdownToHtml(`_${word}…_`)} · ${elapsed(secs)}${where(beat)}`.trim()
  return beat.tip ? `${line}\n\n${markdownToHtml(`_Tip: ${beat.tip}_`)}` : line
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
  return `${prefs().heartbeatDoneFrame} ${markdownToHtml(`_${beat.doneWord}_`)} · ${elapsed(secs)}${where(beat)}`.trim()
}

function elapsed(secs: number): string {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return s ? `${m}m ${s}s` : `${m}m`
}
