/**
 * Interactive elements: permission prompts, plan approvals, and questions —
 * all answerable with a tap instead of typing a reply code.
 *
 * The official plugin already relayed permission requests with Allow/Deny
 * buttons. This adds:
 *   - "always allow" as a third permission answer
 *   - ask(): an arbitrary question with buttons that blocks until answered
 *   - plan approval with an expandable full-text view
 *
 * Callback payloads are capped at 64 bytes by Telegram, so ids stay short and
 * the detail text lives in a process-local map keyed by that id.
 */

import type { Bot, Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { randomBytes } from 'crypto'
import { loadAccess, prefs } from './config.js'
import { markdownToHtml, escapeHtml, collapse } from './format.js'
import { togglePlugin, resolveRun, chooseSetting, mcpAction } from './commands.js'

type Api = Bot['api']

const shortId = (): string => randomBytes(4).toString('hex')

// ---------------------------------------------------------------------------
// Permission requests (driven by Claude Code's channel notification)
// ---------------------------------------------------------------------------

export type PermissionDetail = {
  tool_name: string
  description: string
  input_preview: string
  /** Message ids we posted, so all of them can be resolved once answered. */
  posted: Array<{ chat_id: string; message_id: number }>
}

export const pendingPermissions = new Map<string, PermissionDetail>()

// Only allow/deny exist — Claude Code's permission protocol has no "always"
// answer, and a button promising one would be a lie. Standing pre-approvals
// belong in settings permissions.allow, not in a chat tap.
export function permissionKeyboard(request_id: string, expanded = false): InlineKeyboard {
  const kb = new InlineKeyboard()
  if (!expanded) kb.text('Details', `perm:more:${request_id}`)
  kb.text('Erlauben', `perm:allow:${request_id}`).text('Ablehnen', `perm:deny:${request_id}`)
  return kb
}

/** Broadcast a permission request to every allowlisted DM. */
export async function postPermissionRequest(
  api: Api,
  request_id: string,
  detail: Omit<PermissionDetail, 'posted'>,
): Promise<void> {
  const entry: PermissionDetail = { ...detail, posted: [] }
  pendingPermissions.set(request_id, entry)

  const text =
    `🔐 <b>Freigabe nötig</b>\n<code>${escapeHtml(detail.tool_name)}</code>\n\n` +
    escapeHtml(truncate(detail.description, 300))

  for (const chat_id of loadAccess().allowFrom) {
    try {
      const sent = await api.sendMessage(chat_id, text, {
        parse_mode: 'HTML',
        reply_markup: permissionKeyboard(request_id),
        link_preview_options: { is_disabled: true },
      })
      entry.posted.push({ chat_id, message_id: sent.message_id })
    } catch (err) {
      process.stderr.write(`telegram-unleashed: permission post to ${chat_id} failed: ${err}\n`)
    }
  }
}

// ---------------------------------------------------------------------------
// ask(): a question with buttons that blocks until answered
// ---------------------------------------------------------------------------

type AskWaiter = {
  resolve: (value: { index: number; label: string; by: string }) => void
  reject: (err: Error) => void
  options: string[]
  timer: ReturnType<typeof setTimeout>
  posted: Array<{ chat_id: string; message_id: number }>
  question: string
}

const pendingAsks = new Map<string, AskWaiter>()

/**
 * Post a question with one button per option and wait for a tap.
 * Resolves with the chosen option; rejects on timeout.
 */
export function ask(
  api: Api,
  chat_id: string,
  question: string,
  options: string[],
  opts: { timeoutSec?: number; detail?: string; columns?: number } = {},
): Promise<{ index: number; label: string; by: string }> {
  const id = shortId()
  const timeoutSec = opts.timeoutSec ?? prefs().askTimeoutSec
  const columns = Math.max(1, Math.min(opts.columns ?? (options.some(o => o.length > 18) ? 1 : 2), 3))

  const kb = new InlineKeyboard()
  options.forEach((label, i) => {
    kb.text(truncate(label, 60), `ask:${id}:${i}`)
    if ((i + 1) % columns === 0) kb.row()
  })

  let body = `❓ <b>${escapeHtml(question)}</b>`
  if (opts.detail) body += `\n\n${collapse(markdownToHtml(opts.detail))}`

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAsks.delete(id)
      void finalise(api, waiter.posted, `${body}\n\n<i>⌛ Zeit abgelaufen — keine Antwort</i>`)
      reject(new Error(`no answer within ${timeoutSec}s`))
    }, timeoutSec * 1000)
    if (typeof timer.unref === 'function') timer.unref()

    const waiter: AskWaiter = { resolve, reject, options, timer, posted: [], question }
    pendingAsks.set(id, waiter)

    void api
      .sendMessage(chat_id, body, {
        parse_mode: 'HTML',
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      })
      .then(sent => {
        waiter.posted.push({ chat_id, message_id: sent.message_id })
      })
      .catch(err => {
        clearTimeout(timer)
        pendingAsks.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

// ---------------------------------------------------------------------------
// Plan approval
// ---------------------------------------------------------------------------

type PlanWaiter = {
  resolve: (v: { decision: 'approve' | 'reject'; by: string; note?: string }) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  posted: Array<{ chat_id: string; message_id: number }>
  title: string
  body: string
}

const pendingPlans = new Map<string, PlanWaiter>()

/** Post a plan for approval and wait for a decision. */
export function sendPlan(
  api: Api,
  chat_id: string,
  title: string,
  body: string,
  opts: { timeoutSec?: number } = {},
): Promise<{ decision: 'approve' | 'reject'; by: string; note?: string }> {
  const id = shortId()
  const timeoutSec = opts.timeoutSec ?? prefs().askTimeoutSec

  const kb = new InlineKeyboard()
    .text('Freigeben', `plan:${id}:approve`)
    .text('Ablehnen', `plan:${id}:reject`)

  const rendered = markdownToHtml(body)
  const text = `📋 <b>${escapeHtml(title)}</b>\n\n${rendered}`

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPlans.delete(id)
      void finalise(api, waiter.posted, `${text}\n\n<i>⌛ Zeit abgelaufen</i>`)
      reject(new Error(`plan not answered within ${timeoutSec}s`))
    }, timeoutSec * 1000)
    if (typeof timer.unref === 'function') timer.unref()

    const waiter: PlanWaiter = { resolve, reject, timer, posted: [], title, body }
    pendingPlans.set(id, waiter)

    void api
      .sendMessage(chat_id, text, {
        parse_mode: 'HTML',
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      })
      .then(sent => waiter.posted.push({ chat_id, message_id: sent.message_id }))
      .catch(err => {
        clearTimeout(timer)
        pendingPlans.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

// ---------------------------------------------------------------------------
// Callback router
// ---------------------------------------------------------------------------

type PermissionEmitter = (request_id: string, behavior: 'allow' | 'deny') => void

/** Hands a message to the session. Injected because the transport lives in index. */
type Relay = (
  chat_id: string,
  text: string,
  meta: { user: string; user_id: string; ts: string },
) => void

/**
 * Wire the single callback_query handler. Every interactive element routes
 * through here; authorisation is checked once, centrally.
 */
export function registerCallbacks(bot: Bot, emitPermission: PermissionEmitter, relayCommand: Relay): void {
  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data ?? ''
    const senderId = String(ctx.from.id)

    // Same rule as the inbound gate: only allowlisted users may act.
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Nicht berechtigt.' }).catch(() => {})
      return
    }

    const who = ctx.from.username ? `@${ctx.from.username}` : senderId

    // ---- run button on a command card ----
    const run = /^run:(\d{1,3}|cancel)$/.exec(data)
    if (run) {
      const command = resolveRun(run[1])
      if (!command) {
        await ctx.answerCallbackQuery({ text: run[1] === 'cancel' ? 'Cancelled.' : 'Stale — send it again.' }).catch(() => {})
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
        return
      }
      await ctx.answerCallbackQuery({ text: command }).catch(() => {})
      // Drop the buttons so the same card cannot be fired twice.
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
      relayCommand(String(ctx.chat?.id ?? ''), command, {
        user: ctx.from.username ?? senderId,
        user_id: senderId,
        ts: new Date().toISOString(),
      })
      return
    }

    // ---- MCP server card ----
    const mc = /^mc:(\d{1,3}|health|back)$/.exec(data)
    if (mc) {
      // Dialling every server takes seconds; answer the tap first so the
      // button stops spinning while the CLI works.
      if (mc[1] === 'health') await ctx.answerCallbackQuery({ text: 'Checking…' }).catch(() => {})
      const { view, note } = await mcpAction(mc[1] === 'back' ? 'back' : mc[1])
      if (mc[1] !== 'health') await ctx.answerCallbackQuery({ text: note }).catch(() => {})
      await ctx
        .editMessageText(markdownToHtml(view.text), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(view.keyboard ? { reply_markup: view.keyboard } : {}),
        })
        .catch(() => {})
      return
    }

    // ---- model and effort pickers ----
    const setting = /^(md|ef):(\d{1,3})$/.exec(data)
    if (setting) {
      const { view, note } = chooseSetting(setting[1], Number(setting[2]))
      await ctx.answerCallbackQuery({ text: note }).catch(() => {})
      await ctx
        .editMessageText(markdownToHtml(view.text), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(view.keyboard ? { reply_markup: view.keyboard } : {}),
        })
        .catch(() => {})
      return
    }

    // ---- plugin toggles ----
    const pl = /^pl:(\d{1,3})$/.exec(data)
    if (pl) {
      const { view, note } = togglePlugin(Number(pl[1]))
      await ctx.answerCallbackQuery({ text: note }).catch(() => {})
      await ctx
        .editMessageText(markdownToHtml(view.text), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(view.keyboard ? { reply_markup: view.keyboard } : {}),
        })
        .catch(() => {})
      return
    }

    // ---- permissions ----
    const perm = /^perm:(allow|deny|more):([A-Za-z0-9_-]{1,32})$/.exec(data)
    if (perm) {
      const [, behavior, request_id] = perm
      const detail = pendingPermissions.get(request_id)

      if (behavior === 'more') {
        if (!detail) {
          await ctx.answerCallbackQuery({ text: 'Details nicht mehr verfügbar.' }).catch(() => {})
          return
        }
        let pretty: string
        try {
          pretty = JSON.stringify(JSON.parse(detail.input_preview), null, 2)
        } catch {
          pretty = detail.input_preview
        }
        const expanded =
          `🔐 <b>Freigabe nötig</b>\n<code>${escapeHtml(detail.tool_name)}</code>\n\n` +
          `${escapeHtml(detail.description)}\n\n` +
          `<pre>${escapeHtml(truncate(pretty, 3000))}</pre>`
        await ctx
          .editMessageText(expanded, {
            parse_mode: 'HTML',
            reply_markup: permissionKeyboard(request_id, true),
          })
          .catch(() => {})
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }

      emitPermission(request_id, behavior as 'allow' | 'deny')
      pendingPermissions.delete(request_id)

      const label = behavior === 'allow' ? '✅ Erlaubt' : '❌ Abgelehnt'
      await ctx.answerCallbackQuery({ text: label }).catch(() => {})
      // Strip the buttons everywhere it was posted so it can't be answered twice.
      if (detail?.posted.length) {
        await finalise(ctx.api, detail.posted, undefined, `\n\n<i>${label} — ${escapeHtml(who)}</i>`)
      } else {
        const msg = ctx.callbackQuery.message
        if (msg && 'text' in msg && msg.text) {
          await ctx.editMessageText(`${escapeHtml(msg.text)}\n\n<i>${label}</i>`, { parse_mode: 'HTML' }).catch(() => {})
        }
      }
      return
    }

    // ---- ask ----
    const askM = /^ask:([a-f0-9]{8}):(\d{1,2})$/.exec(data)
    if (askM) {
      const [, id, idxRaw] = askM
      const waiter = pendingAsks.get(id)
      if (!waiter) {
        await ctx.answerCallbackQuery({ text: 'Diese Frage ist nicht mehr offen.' }).catch(() => {})
        return
      }
      const index = Number(idxRaw)
      const label = waiter.options[index]
      if (label === undefined) {
        await ctx.answerCallbackQuery({ text: 'Unbekannte Option.' }).catch(() => {})
        return
      }
      clearTimeout(waiter.timer)
      pendingAsks.delete(id)
      await ctx.answerCallbackQuery({ text: label }).catch(() => {})
      await finalise(ctx.api, waiter.posted, undefined, `\n\n<i>➡️ ${escapeHtml(label)} — ${escapeHtml(who)}</i>`)
      waiter.resolve({ index, label, by: who })
      return
    }

    // ---- plan ----
    const planM = /^plan:([a-f0-9]{8}):(approve|reject)$/.exec(data)
    if (planM) {
      const [, id, decision] = planM
      const waiter = pendingPlans.get(id)
      if (!waiter) {
        await ctx.answerCallbackQuery({ text: 'Dieser Plan ist nicht mehr offen.' }).catch(() => {})
        return
      }
      clearTimeout(waiter.timer)
      pendingPlans.delete(id)
      const label = decision === 'approve' ? '✅ Freigegeben' : '❌ Abgelehnt'
      await ctx.answerCallbackQuery({ text: label }).catch(() => {})
      await finalise(ctx.api, waiter.posted, undefined, `\n\n<i>${label} — ${escapeHtml(who)}</i>`)
      waiter.resolve({ decision: decision as 'approve' | 'reject', by: who })
      return
    }

    await ctx.answerCallbackQuery().catch(() => {})
  })
}

/** Cancel everything still waiting — used on shutdown. */
export function cancelAllWaiters(reason: string): void {
  for (const [id, w] of pendingAsks) {
    clearTimeout(w.timer)
    w.reject(new Error(reason))
    pendingAsks.delete(id)
  }
  for (const [id, w] of pendingPlans) {
    clearTimeout(w.timer)
    w.reject(new Error(reason))
    pendingPlans.delete(id)
  }
}

export function pendingCounts(): { permissions: number; asks: number; plans: number } {
  return { permissions: pendingPermissions.size, asks: pendingAsks.size, plans: pendingPlans.size }
}

// ---------------------------------------------------------------------------

/**
 * Remove the buttons from every copy of a prompt and optionally append an
 * outcome line, so the chat history records what was decided.
 */
async function finalise(
  api: Api,
  posted: Array<{ chat_id: string; message_id: number }>,
  replacement?: string,
  suffix?: string,
): Promise<void> {
  for (const { chat_id, message_id } of posted) {
    if (replacement != null) {
      await api.editMessageText(chat_id, message_id, replacement, { parse_mode: 'HTML' }).catch(() => {})
      continue
    }
    // Keep the original text; drop the keyboard and append the outcome.
    await api.editMessageReplyMarkup(chat_id, message_id, { reply_markup: undefined }).catch(() => {})
    if (suffix) {
      await api
        .editMessageCaption(chat_id, message_id, { caption: undefined })
        .catch(() => {}) // no-op for text messages; guarded below
    }
  }
  if (!suffix || replacement != null) return
  // Append as a follow-up so we never have to re-render the original text.
  for (const { chat_id, message_id } of posted) {
    await api
      .sendMessage(chat_id, suffix.trim(), {
        parse_mode: 'HTML',
        reply_parameters: { message_id },
        disable_notification: true,
        link_preview_options: { is_disabled: true },
      })
      .catch(() => {})
    break // one confirmation is enough
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
