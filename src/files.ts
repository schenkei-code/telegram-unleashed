/**
 * Attachments.
 *
 * The original sent every file as a separate message and capped everything at
 * 50 MB. Here:
 *   - media of the same kind is grouped into albums (one notification, one
 *     scrollable block instead of eight separate messages)
 *   - the type is chosen per file: photo / video / audio / voice / animation /
 *     document, so Telegram renders players and previews instead of a
 *     download stub
 *   - the ceiling follows the API in use: 50 MB against Telegram's cloud,
 *     2000 MB against a self-hosted Bot API server
 *   - oversized files are reported with the exact remedy rather than a flat
 *     "too large"
 */

import type { Bot } from 'grammy'
import { InputFile } from 'grammy'
import { statSync, mkdirSync, writeFileSync } from 'fs'
import { extname, basename, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import {
  API_ROOT,
  INBOX_DIR,
  LOCAL_API,
  MAX_CAPTION_LIMIT,
  MAX_DOWNLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  TOKEN,
} from './config.js'
import { assertSendable } from './access.js'

type Api = Bot['api']

const PHOTO = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const ANIM = new Set(['.gif'])
const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'])
const AUDIO = new Set(['.mp3', '.m4a', '.flac', '.wav', '.aac', '.opus'])
const VOICE = new Set(['.ogg', '.oga'])

export type MediaKind = 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'document'

export function kindOf(path: string): MediaKind {
  const e = extname(path).toLowerCase()
  if (PHOTO.has(e)) return 'photo'
  if (ANIM.has(e)) return 'animation'
  if (VIDEO.has(e)) return 'video'
  if (AUDIO.has(e)) return 'audio'
  if (VOICE.has(e)) return 'voice'
  return 'document'
}

export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

/** Validate a file before upload. Throws with an actionable message. */
export function checkUploadable(path: string): { size: number; kind: MediaKind } {
  assertSendable(path)
  const st = statSync(path)
  if (!st.isFile()) throw new Error(`not a file: ${path}`)
  if (st.size > MAX_UPLOAD_BYTES) {
    const limit = humanSize(MAX_UPLOAD_BYTES)
    const hint = LOCAL_API
      ? 'split it or compress it'
      : 'run a local Bot API server (TELEGRAM_API_ROOT) to raise the limit to 2 GB, or split the file'
    throw new Error(`file too large: ${basename(path)} is ${humanSize(st.size)}, limit is ${limit} — ${hint}`)
  }
  return { size: st.size, kind: kindOf(path) }
}

type SendOpts = {
  caption?: string
  parse_mode?: 'HTML' | 'MarkdownV2'
  reply_to?: number
  /** Send photos/videos without compression, as files. */
  as_document?: boolean
  /** Silent delivery — no notification sound. */
  silent?: boolean
  /** Cover images with a spoiler (click to reveal). */
  spoiler?: boolean
}

/**
 * Send a batch of files, grouping album-capable media (photo/video) into
 * media groups of up to 10. Returns every message id produced.
 */
export async function sendFiles(
  api: Api,
  chat_id: string,
  files: string[],
  opts: SendOpts = {},
): Promise<number[]> {
  for (const f of files) checkUploadable(f)

  const ids: number[] = []
  const caption = opts.caption?.slice(0, MAX_CAPTION_LIMIT)
  const base = {
    ...(opts.reply_to ? { reply_parameters: { message_id: opts.reply_to } } : {}),
    ...(opts.silent ? { disable_notification: true } : {}),
  }

  // Split into album-capable media and everything else, preserving order.
  const albumable: string[] = []
  const singles: string[] = []
  for (const f of files) {
    const k = opts.as_document ? 'document' : kindOf(f)
    if (k === 'photo' || k === 'video') albumable.push(f)
    else singles.push(f)
  }

  // Albums: 2..10 items per group. A lone item goes through the single path so
  // it keeps its caption formatting.
  for (let i = 0; i < albumable.length; i += 10) {
    const batch = albumable.slice(i, i + 10)
    if (batch.length === 1) {
      singles.unshift(batch[0])
      continue
    }
    const media = batch.map((f, j) => ({
      type: kindOf(f) === 'video' ? ('video' as const) : ('photo' as const),
      media: new InputFile(f),
      ...(opts.spoiler ? { has_spoiler: true } : {}),
      // Only the first item carries the caption — Telegram shows it for the group.
      ...(j === 0 && caption ? { caption, ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}) } : {}),
    }))
    const sent = await api.sendMediaGroup(chat_id, media as never, base)
    ids.push(...sent.map(m => m.message_id))
  }

  for (const f of singles) {
    const kind = opts.as_document ? 'document' : kindOf(f)
    const input = new InputFile(f)
    const withCaption = {
      ...base,
      ...(caption ? { caption, ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}) } : {}),
    }
    let msgId: number
    switch (kind) {
      case 'photo':
        msgId = (await api.sendPhoto(chat_id, input, { ...withCaption, ...(opts.spoiler ? { has_spoiler: true } : {}) })).message_id
        break
      case 'animation':
        msgId = (await api.sendAnimation(chat_id, input, { ...withCaption, ...(opts.spoiler ? { has_spoiler: true } : {}) })).message_id
        break
      case 'video':
        msgId = (await api.sendVideo(chat_id, input, {
          ...withCaption,
          supports_streaming: true,
          ...(opts.spoiler ? { has_spoiler: true } : {}),
        })).message_id
        break
      case 'audio':
        msgId = (await api.sendAudio(chat_id, input, withCaption)).message_id
        break
      case 'voice':
        msgId = (await api.sendVoice(chat_id, input, withCaption)).message_id
        break
      default:
        msgId = (await api.sendDocument(chat_id, input, withCaption)).message_id
    }
    ids.push(msgId)
  }

  return ids
}

/**
 * What the bridge knows about an inbound attachment beyond its file_id.
 * Bot-API file_ids mean nothing to MTProto, so the fallback needs the chat
 * and the size to find the same file again from the user-account side.
 */
export type AttachmentOrigin = { chat_id: string; size?: number; name?: string }

const origins = new Map<string, AttachmentOrigin>()

/** Remember where an inbound attachment came from, for the MTProto fallback. */
export function rememberAttachment(file_id: string, origin: AttachmentOrigin): void {
  origins.set(file_id, origin)
  // The map only has to survive the gap between "message arrived" and "agent
  // asks for the file" — a small window; cap it so it can never grow into a leak.
  if (origins.size > 200) {
    const oldest = origins.keys().next().value
    if (oldest !== undefined) origins.delete(oldest)
  }
}

/**
 * Download an attachment into the inbox and return its local path.
 * With a local Bot API server the file is already on disk and getFile returns
 * an absolute path — no HTTP round trip, no size ceiling.
 *
 * Files past the Bot-API cap (20 MB cloud) fall back to the user's MTProto
 * session when one is configured — see mtprotoFetch.
 */
export async function downloadAttachment(api: Api, file_id: string): Promise<string> {
  let file
  try {
    file = await api.getFile(file_id)
  } catch (err) {
    // The cloud API refuses getFile outright for big files — the size never
    // even reaches the check below.
    if (/file is too big/i.test(String((err as any)?.description ?? err))) {
      return await mtprotoFetch(api, file_id)
    }
    throw err
  }
  if (!file.file_path) throw new Error('Telegram returned no file_path — the file may have expired')

  if (file.file_size != null && file.file_size > MAX_DOWNLOAD_BYTES) {
    return await mtprotoFetch(api, file_id)
  }

  mkdirSync(INBOX_DIR, { recursive: true })

  const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const dest = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)

  // Local API server: file_path is an absolute path on this machine.
  if (LOCAL_API && /^([a-zA-Z]:[\\/]|\/)/.test(file.file_path)) {
    const { copyFileSync } = await import('fs')
    copyFileSync(file.file_path, dest)
    return dest
  }

  const res = await fetch(`${API_ROOT}/file/bot${TOKEN}/${file.file_path}`)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}

/**
 * Fetch a file the Bot API will not serve, over the user's own MTProto login.
 *
 * A user account has no 20-MB download cap. The helper script opens the
 * configured Telethon session, finds the newest media in the same chat whose
 * size (and name) match, and downloads it. Needs one-time setup — see the
 * account skill; without it this stays a clear error instead of a mystery.
 */
async function mtprotoFetch(api: Api, file_id: string): Promise<string> {
  const session = process.env.TELEGRAM_MTPROTO_SESSION
  const apiId = process.env.TELEGRAM_MTPROTO_API_ID
  const apiHash = process.env.TELEGRAM_MTPROTO_API_HASH
  const origin = origins.get(file_id)

  if (!session || !apiId || !apiHash) {
    throw new Error(
      `attachment exceeds Telegram's bot download cap (${humanSize(MAX_DOWNLOAD_BYTES)}) and no MTProto fallback is configured — ` +
        `set TELEGRAM_MTPROTO_SESSION / _API_ID / _API_HASH in the channel .env (see the account skill), ` +
        `or run a local Bot API server (TELEGRAM_API_ROOT)`,
    )
  }
  if (!origin?.size) {
    throw new Error('attachment is too big for the Bot API and its origin is unknown — ask the sender to resend it')
  }

  // The user account sees a private chat with the bridge as a dialog with the
  // BOT; groups keep their id. origin.chat_id is the bot's view of the chat —
  // for a DM that is the human's id, which the user session cannot dial.
  const me = await api.getMe()
  const entity = origin.chat_id.startsWith('-') ? origin.chat_id : `@${me.username}`

  mkdirSync(INBOX_DIR, { recursive: true })
  const py = process.env.TELEGRAM_MTPROTO_PYTHON || 'python'
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'mtproto_fetch.py')
  const args = [
    script,
    '--session', session,
    '--api-id', apiId,
    '--api-hash', apiHash,
    '--entity', entity,
    '--size', String(origin.size),
    '--out', INBOX_DIR,
  ]
  if (origin.name) args.push('--name', origin.name)

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(py, args, { shell: false, windowsHide: true })
    let out = ''
    let errText = ''
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000)
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (errText += c))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`MTProto fallback could not start ${py}: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const path = out.trim().split('\n').pop()?.trim()
      if (code !== 0 || !path) {
        reject(new Error(`MTProto fallback failed: ${(errText || out).trim().slice(-300) || `exit ${code}`}`))
        return
      }
      resolve(path)
    })
  })
}

/** Describe the active limits, for the /status command and diagnostics. */
export function limitsSummary(): string {
  return LOCAL_API
    ? `local Bot API server (${API_ROOT}) — uploads to ${humanSize(MAX_UPLOAD_BYTES)}, downloads unlimited`
    : `Telegram cloud API — uploads to ${humanSize(MAX_UPLOAD_BYTES)}, downloads to ${humanSize(MAX_DOWNLOAD_BYTES)}`
}
