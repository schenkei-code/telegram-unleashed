/**
 * Access control — carried over from the official plugin unchanged in
 * substance. This is the part you do not get creative with.
 *
 * Inbound:  gate() decides deliver / drop / pair for every message.
 * Outbound: assertAllowedChat() ensures a tool can only target a chat the
 *           inbound gate would have accepted, so a prompt injection can't
 *           make the bot message a stranger.
 * Files:    assertSendable() keeps channel state (the bot token above all)
 *           out of the attachment path.
 */

import type { Context } from 'grammy'
import { readdirSync, rmSync, realpathSync } from 'fs'
import { join, sep } from 'path'
import { randomBytes } from 'crypto'
import {
  type Access,
  APPROVED_DIR,
  STATE_DIR,
  STATIC,
  loadAccess,
  saveAccess,
} from './config.js'

let botUsername = ''
export function setBotUsername(u: string): void {
  botUsername = u
}
export function getBotUsername(): string {
  return botUsername
}

export function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted — add via /telegram:access`)
}

/**
 * The reply tool takes arbitrary paths. Claude can already Read and paste file
 * contents, so this isn't a new exfiltration channel in general — but the
 * server's own state (the token in .env) is the one thing it should never be
 * able to attach. Downloaded inbox files are explicitly allowed back out.
 */
export function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    return // statSync will produce a proper error, or STATE_DIR is absent
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export function gate(ctx: Context): GateResult {
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        // Initial reply plus one reminder, then silence.
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const policy = access.groups[String(ctx.chat!.id)]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
    if (requireMention && !isMentioned(ctx, access.mentionPatterns)) return { action: 'drop' }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

/** Like gate() but for bot commands: no pairing side effects, just allow/drop. */
export function dmCommandGate(ctx: Context): { access: Access; senderId: string } | null {
  if (ctx.chat?.type !== 'private') return null
  if (!ctx.from) return null
  const senderId = String(ctx.from.id)
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)
  if (access.dmPolicy === 'disabled') return null
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
  return { access, senderId }
}

export function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {
      // invalid user-supplied regex — skip
    }
  }
  return false
}

/**
 * The access skill drops a file at approved/<senderId> when it pairs someone.
 * Poll for it, confirm, clean up. In DMs chatId == senderId.
 */
export function startApprovalWatcher(send: (chatId: string, text: string) => Promise<unknown>): void {
  if (STATIC) return
  const t = setInterval(() => {
    let files: string[]
    try {
      files = readdirSync(APPROVED_DIR)
    } catch {
      return
    }
    for (const senderId of files) {
      const file = join(APPROVED_DIR, senderId)
      void send(senderId, 'Paired. Say hi to Claude.').then(
        () => rmSync(file, { force: true }),
        err => {
          process.stderr.write(`telegram-unleashed: approval confirm failed: ${err}\n`)
          rmSync(file, { force: true }) // don't loop on a broken send
        },
      )
    }
  }, 5000)
  if (typeof t.unref === 'function') t.unref()
}
