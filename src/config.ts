/**
 * telegram-unleashed — configuration and access state.
 *
 * State lives outside the plugin so upgrades never lose credentials:
 *   ~/.claude/channels/<channel>/
 *     .env          TELEGRAM_BOT_TOKEN
 *     access.json   policy, allowlists, delivery prefs
 *     inbox/        downloaded attachments
 *     approved/     pairing handoff from the access skill
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Channel name — set TELEGRAM_CHANNEL=telegram-dev to run against a second bot. */
export const CHANNEL = process.env.TELEGRAM_CHANNEL ?? 'telegram'

export const STATE_DIR =
  process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', CHANNEL)
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const PID_FILE = join(STATE_DIR, 'bot.pid')
export const TRACE_FILE = join(STATE_DIR, 'trace.log')

/**
 * One line in the bridge's own log. Lives here rather than in the server so
 * background work — the status line, the typing indicator — can record why it
 * gave up. A caught-and-dropped failure in something nobody is awaiting is
 * invisible from the outside and looks exactly like a feature that was never
 * built.
 */
export function trace(line: string): void {
  try {
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} [${process.pid}] ${line}\n`)
  } catch {
    // Diagnostics must never break the bridge.
  }
}

// Plugin-spawned MCP servers get no env block — the token is loaded from disk.
// Real environment wins so CI/overrides still work.
try {
  chmodSync(ENV_FILE, 0o600) // no-op on Windows (would need ACLs)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

export const TOKEN = process.env.TELEGRAM_BOT_TOKEN
export const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

/**
 * A self-hosted Bot API server lifts Telegram's cloud limits:
 *   uploads   50 MB  ->  2000 MB
 *   downloads 20 MB  ->  unlimited (and files are served from local disk)
 * Set TELEGRAM_API_ROOT=http://localhost:8081 after starting telegram-bot-api.
 */
export const API_ROOT = (process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org').replace(/\/+$/, '')
export const LOCAL_API = !/^https:\/\/api\.telegram\.org$/i.test(API_ROOT)

/** Upload ceiling. Local API server raises it 40x. */
export const MAX_UPLOAD_BYTES = LOCAL_API ? 2000 * 1024 * 1024 : 50 * 1024 * 1024
/** Download ceiling for getFile. Unlimited on a local server. */
export const MAX_DOWNLOAD_BYTES = LOCAL_API ? Number.POSITIVE_INFINITY : 20 * 1024 * 1024

/** Telegram's hard per-message text cap. */
export const MAX_CHUNK_LIMIT = 4096
/** Caption cap for media messages — much lower than the text cap. */
export const MAX_CAPTION_LIMIT = 1024

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]

  // ---- delivery / UX ----
  /** Emoji to react with on receipt. Empty string disables. */
  ackReaction?: string
  /** Which chunks carry Telegram's reply reference. Default 'first'. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default 4096. */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of a hard char count. */
  chunkMode?: 'length' | 'newline'

  // ---- unleashed additions ----
  /**
   * Keep the "typing…" indicator alive while a turn is in flight.
   * Telegram expires chat actions after ~5s, so we re-send on an interval.
   * Default true.
   */
  typingKeepalive?: boolean
  /** Seconds between keepalive pokes. Default 4. */
  typingIntervalSec?: number
  /** Hard stop for the keepalive so a hung turn can't poke forever. Default 600. */
  typingMaxSec?: number
  /**
   * Post a status message of its own the moment a message arrives, with a
   * cycling emoji and a running clock, and delete it when the answer goes out.
   * A chat action alone leaves the sender unable to tell a working session from
   * a bridge that stopped receiving. Default true.
   */
  heartbeat?: boolean
  /** Words the status line rotates through. */
  heartbeatWords?: string[]
  /** Emoji frames the status line cycles. */
  heartbeatFrames?: string[]
  /**
   * Optional one-liners shown under the status line, one picked per turn.
   * Empty by default — fill it locally with whatever is worth reading while
   * waiting, rather than shipping someone else's copy in the package.
   */
  heartbeatTips?: string[]
  /** Seconds between frames. Floor 1, but Telegram drops edits below ~3. Default 3. */
  heartbeatIntervalSec?: number
  /**
   * Leave the status line in the chat when the turn ends, rewritten to a
   * past-tense word and the final duration. That closing line is how the
   * sender knows the turn is over rather than merely quiet. Default true;
   * set false to delete the line instead. */
  heartbeatKeep?: boolean
  /** Past-tense words for the closing line. */
  heartbeatDoneWords?: string[]
  /** Marker in front of the closing line. Default '✳'. */
  heartbeatDoneFrame?: string
  /**
   * Where the status line goes when the turn happens in a group. A group is
   * an audience: the other members want the answer, not a running commentary
   * on how it was produced, so a group never gets a status line either way.
   * Set this to your own chat id to have it (and the activity feed) delivered
   * there instead; leave it empty and a group turn simply runs without one.
   */
  statusChatId?: string
  /**
   * Default rendering mode for reply/edit when the caller omits `format`.
   * 'auto' converts common Markdown to Telegram HTML and escapes everything
   * else — the safe default, no caller-side escaping needed.
   */
  defaultFormat?: 'auto' | 'html' | 'markdownv2' | 'text'
  /**
   * Stream long answers as a live-updating message instead of one bulk send.
   * Requires Bot API 10.2; falls back to edit-based streaming automatically.
   */
  streaming?: boolean
  /** Minimum ms between stream edits — Telegram rate-limits edits. Default 1200. */
  streamIntervalMs?: number
  /**
   * Type ordinary replies out in front of the user instead of posting them
   * whole. Only applies where it is free of side effects: a private chat with
   * rich drafts, plain text, single message, no attachments. Default true.
   */
  reveal?: boolean
  /** Reveal granularity: natural | char | word | line | paragraph. Default 'natural'. */
  revealUnit?: 'natural' | 'char' | 'word' | 'line' | 'paragraph'
  /** Ms between reveal frames. Default 180. */
  revealTickMs?: number
  /** Wall-clock budget for a reveal; longer text takes bigger steps. Default 3500. */
  revealMaxMs?: number
  /** Send link previews. Default false (agent output is usually code, not links). */
  linkPreview?: boolean
  /** Seconds an interactive question waits for a button press. Default 900. */
  askTimeoutSec?: number
  /** Collapse outbound text longer than this into an expandable quote. 0 = off. Default 0. */
  collapseOver?: number
  /**
   * Keep a local log of every message in and out, so the agent can look up what
   * was already said. Telegram itself exposes no history. Default true.
   */
  history?: boolean
  /**
   * Shape of the activity feed (`hooks/activity.mjs`).
   *
   * 'live' treats it as a view: a new paragraph replaces the card before it and
   * the whole feed leaves the chat when the turn ends, so what stands
   * afterwards is the answer alone. 'mirror' treats it as scrollback: nothing
   * is deleted and thinking is shown, for when the chat *is* the terminal
   * rather than a window onto one. Default 'live'.
   *
   * Read by the hook, which is a separate process per event — a change here
   * takes effect on the next event, with no restart.
   */
  feedMode?: 'live' | 'mirror'
}

const HEARTBEAT_WORDS = ['Pondering', 'Twisting', 'Musing', 'Digging', 'Untangling', 'Brewing']
/**
 * Claude Code's own spinner, one glyph per frame and back again. Emoji would
 * be louder, but the point of this line is that it looks like the terminal the
 * work is actually happening in.
 */
const HEARTBEAT_FRAMES = ['·', '✢', '✳', '∗', '✻', '✽', '✻', '∗', '✳', '✢']
const HEARTBEAT_DONE_WORDS = ['Done', 'Finished', 'Wrapped up']

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return { ...defaultAccess(), ...parsed } as Access
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write('telegram-unleashed: access.json is corrupt, moved aside. Starting fresh.\n')
    return defaultAccess()
  }
}

// Static mode snapshots access at boot and never writes. Pairing needs runtime
// mutation, so it degrades to allowlist rather than handing out dead codes.
const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('telegram-unleashed: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

export function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

export function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

/** Resolved delivery settings with defaults applied. */
export function prefs(a: Access = loadAccess()) {
  return {
    ackReaction: a.ackReaction ?? '',
    replyToMode: a.replyToMode ?? 'first',
    textChunkLimit: Math.max(1, Math.min(a.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT)),
    chunkMode: a.chunkMode ?? 'length',
    typingKeepalive: a.typingKeepalive ?? true,
    typingIntervalSec: Math.max(1, a.typingIntervalSec ?? 4),
    typingMaxSec: Math.max(10, a.typingMaxSec ?? 600),
    heartbeat: a.heartbeat ?? true,
    heartbeatWords: a.heartbeatWords?.length ? a.heartbeatWords : HEARTBEAT_WORDS,
    heartbeatFrames: a.heartbeatFrames?.length ? a.heartbeatFrames : HEARTBEAT_FRAMES,
    heartbeatTips: a.heartbeatTips ?? [],
    // Telegram throttles a chat to roughly one message a second and edits
    // count, so the terminal's eight frames a second is not reachable here.
    // One second is the floor rather than the recommendation: the activity
    // card edits on the same budget, and past that ceiling Telegram simply
    // drops frames — the animation gets choppier, not faster. Three is the
    // fastest that reliably lands.
    heartbeatIntervalSec: Math.max(1, a.heartbeatIntervalSec ?? 3),
    heartbeatKeep: a.heartbeatKeep ?? true,
    heartbeatDoneWords: a.heartbeatDoneWords?.length ? a.heartbeatDoneWords : HEARTBEAT_DONE_WORDS,
    heartbeatDoneFrame: a.heartbeatDoneFrame ?? '✳',
    statusChatId: a.statusChatId ?? '',
    defaultFormat: a.defaultFormat ?? 'auto',
    streaming: a.streaming ?? true,
    streamIntervalMs: Math.max(400, a.streamIntervalMs ?? 1200),
    reveal: a.reveal ?? true,
    revealUnit: a.revealUnit ?? 'natural',
    revealTickMs: Math.max(60, a.revealTickMs ?? 180),
    revealMaxMs: Math.max(500, a.revealMaxMs ?? 3500),
    linkPreview: a.linkPreview ?? false,
    askTimeoutSec: Math.max(10, a.askTimeoutSec ?? 900),
    collapseOver: Math.max(0, a.collapseOver ?? 0),
  }
}
