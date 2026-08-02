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
  /** Fixed wording, if the caller set one. Otherwise words rotate. */
  text?: string
  words: string[]
  word: number
  frames: string[]
  frame: number
  startedAt: number
  /** Chosen once per turn — a tip that changes every frame is unreadable. */
  tip?: string
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

  const beat: Beat = {
    api,
    words: p.heartbeatWords,
    word: 0,
    frames: p.heartbeatFrames,
    frame: 0,
    startedAt: Date.now(),
    tip: p.heartbeatTips.length
      ? p.heartbeatTips[Math.floor(Math.random() * p.heartbeatTips.length)]
      : undefined,
    cancelled: false,
  }
  beats.set(chat_id, beat)

  void api
    .sendMessage(chat_id, render(beat), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    .then((sent) => {
      // The turn may have finished while this was in flight.
      if (beat.cancelled) {
        void api.deleteMessage(chat_id, sent.message_id).catch(() => {})
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
 * Remove the status line. Called wherever real output goes out, so the agent
 * never has to think about it.
 */
export function stopHeartbeat(chat_id: string): void {
  const beat = beats.get(chat_id)
  if (!beat) return
  beats.delete(chat_id)
  beat.cancelled = true
  if (beat.timer) clearInterval(beat.timer)
  if (beat.messageId != null) {
    void beat.api.deleteMessage(chat_id, beat.messageId).catch(() => {})
  }
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
    .editMessageText(chat_id, beat.messageId, render(beat), {
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
  const line = `${emoji} ${markdownToHtml(`_${word}…_`)} · ${elapsed(secs)}`.trim()
  return beat.tip ? `${line}\n\n${markdownToHtml(`_Tip: ${beat.tip}_`)}` : line
}

function elapsed(secs: number): string {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return s ? `${m}m ${s}s` : `${m}m`
}
