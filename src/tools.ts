/**
 * MCP tool surface.
 *
 * Design rule: the model should never have to think about Telegram's quirks.
 * No manual escaping, no 4096-char arithmetic, no picking sendPhoto vs
 * sendDocument. Write text, name files, get a message.
 */

import type { Bot } from 'grammy'
import { assertAllowedChat } from './access.js'
import { prefs, loadAccess, LOCAL_API, API_ROOT } from './config.js'
import { type Format, render, chunkFor, collapse, markdownToHtml, codeBlock } from './format.js'
import { sendFiles, downloadAttachment, limitsSummary, humanSize } from './files.js'
import {
  startTyping,
  stopTyping,
  openStream,
  pushStream,
  setStream,
  closeStream,
  abortStream,
  draftSupport,
  activeStreams,
  typeOut,
} from './stream.js'
import type { TypeUnit } from './stream.js'
import { startHeartbeat, setHeartbeatText } from './status.js'
import { ask, sendPlan, pendingCounts } from './interactive.js'
import { record, read as readHistory, chats as historyChats, format as formatHistory } from './history.js'

type Api = Bot['api']

/** Log an outbound message so the agent can look up what it already said. */
function logOut(chat_id: string, text: string, id?: number): void {
  if (!text.trim()) return
  record(chat_id, {
    ts: new Date().toISOString(),
    dir: 'out',
    ...(id != null ? { id: String(id) } : {}),
    text,
  })
}

const str = (v: unknown): string => String(v ?? '')
const num = (v: unknown): number | undefined => (v == null ? undefined : Number(v))
const bool = (v: unknown): boolean => v === true || v === 'true'

export const TOOL_DEFS = [
  {
    name: 'reply',
    description:
      'Send a message to Telegram. Write plain Markdown — it is converted to Telegram formatting and escaped for you, so no manual escaping is ever needed. Long text is split automatically without breaking code blocks. Attach files with `files` (absolute paths); images, video, audio and documents are each sent in their proper form and multiple images become an album.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        reply_to: { type: 'string', description: 'message_id to thread under. Omit for a normal reply.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to attach.' },
        format: {
          type: 'string',
          enum: ['auto', 'html', 'markdownv2', 'text'],
          description:
            "'auto' (default) converts Markdown to Telegram HTML and escapes the rest. 'text' sends verbatim with no formatting. Use 'html'/'markdownv2' only to pass pre-formatted markup.",
        },
        collapse: { type: 'boolean', description: 'Wrap the text in an expandable quote so a long message stays folded.' },
        silent: { type: 'boolean', description: 'Deliver without a notification sound.' },
        spoiler: { type: 'boolean', description: 'Hide attached images behind a tap-to-reveal spoiler.' },
        as_document: { type: 'boolean', description: 'Send images/video uncompressed as files.' },
        instant: {
          type: 'boolean',
          description: 'Post the message whole instead of typing it out. Use for anything the user is waiting on.',
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'send_files',
    description:
      'Send files without a text message. Same media handling as reply: albums for multiple images, players for audio and video. Use when the files are the message.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        caption: { type: 'string', description: 'Optional caption, Markdown. Max ~1024 chars.' },
        reply_to: { type: 'string' },
        silent: { type: 'boolean' },
        spoiler: { type: 'boolean' },
        as_document: { type: 'boolean' },
      },
      required: ['chat_id', 'files'],
    },
  },
  {
    name: 'ask',
    description:
      'Ask the user a question with tappable buttons and WAIT for the answer. Returns the chosen option. Use this instead of sending a question as text when you need a decision before continuing — the user taps rather than types.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: '2-10 short labels.' },
        detail: { type: 'string', description: 'Optional longer context, shown as an expandable quote.' },
        timeout_sec: { type: 'number', description: 'Default 900.' },
      },
      required: ['chat_id', 'question', 'options'],
    },
  },
  {
    name: 'send_plan',
    description:
      'Send a plan or proposal for approval with Freigeben/Ablehnen buttons and WAIT for the decision. Returns approve or reject. Use before starting work the user should sign off on.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string', description: 'The plan itself, in Markdown.' },
        timeout_sec: { type: 'number', description: 'Default 900.' },
      },
      required: ['chat_id', 'title', 'body'],
    },
  },
  {
    name: 'status',
    description:
      'Reword the status line the plugin already posted for this turn — "Reading the repo", "Running the tests". The emoji keeps cycling and the clock keeps running; the line is deleted for you when your answer goes out. Use it when a turn takes long enough that the sender would wonder what you are doing.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string', description: 'Short present-tense phrase, no trailing ellipsis.' },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'stream_start',
    description:
      'Begin a live message that updates as you write. The user watches the answer appear instead of waiting on a typing indicator. Returns a stream_id — feed it with stream_push and finish with stream_end. Use for answers that take a while to produce. In a group the stream buffers instead and arrives as one finished message on stream_end, so the same code works in both places.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        initial: { type: 'string', description: 'Optional opening text.' },
        reply_to: { type: 'string' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'history',
    description:
      'Read what was said in this chat before. Telegram exposes no history to a bot, so the plugin keeps its own log of every message in and out — use this instead of asking the user to paste earlier context. Omit chat_id to list the chats that have a history.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Omit to list chats instead of reading one.' },
        limit: { type: 'number', description: 'How many messages, newest last. Default 50, 0 for all.' },
        search: {
          type: 'string',
          description: 'Only messages containing this text, case-insensitive. Applied before limit, so it reaches past the tail.',
        },
      },
    },
  },
  {
    name: 'say',
    description:
      'Send a message that types itself out in front of the user. Unlike stream_push, the pacing happens inside the plugin — one call reveals the whole text smoothly instead of one round-trip per chunk. Use when the text is already written and you want it to arrive alive rather than all at once. In a group it posts whole instead: a reveal is for one person watching, not an audience.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string', description: 'The full message, in Markdown.' },
        unit: {
          type: 'string',
          enum: ['natural', 'char', 'word', 'line', 'paragraph'],
          description:
            "Reveal granularity. Default 'natural' — short words spell out, long ones land whole, which reads like typing without stuttering.",
        },
        tick_ms: { type: 'number', description: 'Ms between frames. Default 180 (drafts) or 1100 (edit fallback).' },
        max_ms: {
          type: 'number',
          description: 'Wall-clock budget for the whole reveal. Default 3500 — longer text reveals in bigger steps rather than taking longer.',
        },
        reply_to: { type: 'string' },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'stream_push',
    description: 'Append to a live message. Rate-limited internally, so call it as often as you like.',
    inputSchema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string' },
        text: { type: 'string', description: 'Text to append.' },
        replace: { type: 'boolean', description: 'Replace the whole content instead of appending.' },
      },
      required: ['stream_id', 'text'],
    },
  },
  {
    name: 'stream_end',
    description: 'Finish a live message and commit the final text. Always call this — an open stream leaves a half-written message.',
    inputSchema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string' },
        text: { type: 'string', description: 'Optional final text, replacing what was streamed.' },
        cancel: { type: 'boolean', description: 'Discard instead of committing.' },
      },
      required: ['stream_id'],
    },
  },
  {
    name: 'react',
    description:
      'Add an emoji reaction to a message. Telegram accepts only a fixed set (👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷 😡).',
    inputSchema: {
      type: 'object',
      properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, emoji: { type: 'string' } },
      required: ['chat_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description:
      "Edit a message the bot sent. Edits don't push-notify, so send a fresh reply when a long task finishes.",
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
        format: { type: 'string', enum: ['auto', 'html', 'markdownv2', 'text'] },
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete a message the bot sent (within 48 hours).',
    inputSchema: {
      type: 'object',
      properties: { chat_id: { type: 'string' }, message_id: { type: 'string' } },
      required: ['chat_id', 'message_id'],
    },
  },
  {
    name: 'pin_message',
    description: 'Pin or unpin a message in the chat.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        unpin: { type: 'boolean', description: 'Unpin instead of pin.' },
      },
      required: ['chat_id', 'message_id'],
    },
  },
  {
    name: 'send_poll',
    description: 'Send a poll. Use for quick multi-way input where you do not need to block on the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        multiple: { type: 'boolean', description: 'Allow multiple answers.' },
        anonymous: { type: 'boolean', description: 'Default true.' },
      },
      required: ['chat_id', 'question', 'options'],
    },
  },
  {
    name: 'send_code',
    description:
      'Send a syntax-highlighted code block. Splits across messages if needed without breaking the block. Prefer this over pasting code into reply.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        code: { type: 'string' },
        language: { type: 'string', description: 'e.g. typescript, python, bash' },
        caption: { type: 'string', description: 'Optional line above the block.' },
      },
      required: ['chat_id', 'code'],
    },
  },
  {
    name: 'typing',
    description:
      'Show or hide the activity indicator. It is started automatically on every inbound message and kept alive until you reply, so you rarely need this — use it for a long stretch of work with no message in between.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        action: {
          type: 'string',
          enum: ['typing', 'upload_photo', 'upload_document', 'upload_video', 'record_voice'],
        },
        stop: { type: 'boolean' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'download_attachment',
    description:
      'Download an inbound attachment to the local inbox and return its path. Use when the <channel> meta carries attachment_file_id.',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
    },
  },
  {
    name: 'channel_info',
    description:
      'Report the channel state: active limits, whether live streaming is available, and what is currently waiting on an answer. Use when something is not behaving as expected.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

export async function callTool(
  api: Api,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const p = prefs()

  switch (name) {
    case 'reply': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      const files = (args.files as string[] | undefined) ?? []
      const reply_to = num(args.reply_to)
      const format = (args.format as Format | undefined) ?? p.defaultFormat

      let { text, parse_mode } = render(str(args.text), format)
      if (bool(args.collapse) && parse_mode === 'HTML') text = collapse(text)

      // Type the answer out where that is purely cosmetic. Everything below
      // either can't be revealed (media, pre-formatted markup) or would be
      // revealed badly (multi-part text, group chats without rich drafts), so
      // those keep the plain send.
      const raw = str(args.text)
      const revealable =
        p.reveal &&
        !bool(args.instant) &&
        !files.length &&
        !bool(args.collapse) &&
        format === 'auto' &&
        raw.trim().length > 0 &&
        text.length <= p.textChunkLimit &&
        !chat_id.startsWith('-') &&
        draftSupport() !== 'no'

      if (revealable) {
        const ids = await typeOut(api, chat_id, raw, {
          reply_to: p.replyToMode === 'off' ? undefined : reply_to,
          unit: p.revealUnit,
          tickMs: p.revealTickMs,
          maxMs: p.revealMaxMs,
          silent: bool(args.silent),
        })
        stopTyping(chat_id)
        if (ids.length) {
          logOut(chat_id, raw, ids[0])
          return `sent (id: ${ids[0]})`
        }
        // The reveal committed nothing — fall through to the plain send rather
        // than losing the message.
      }

      const ids: number[] = []
      if (text.trim()) {
        const parts = chunkFor(text, parse_mode, p.textChunkLimit, p.chunkMode)
        for (let i = 0; i < parts.length; i++) {
          const useReplyTo =
            reply_to != null && p.replyToMode !== 'off' && (p.replyToMode === 'all' || i === 0)
          const sent = await api.sendMessage(chat_id, parts[i], {
            ...(parse_mode ? { parse_mode } : {}),
            ...(useReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
            ...(bool(args.silent) ? { disable_notification: true } : {}),
            link_preview_options: { is_disabled: !p.linkPreview },
          })
          ids.push(sent.message_id)
        }
      }

      if (files.length) {
        ids.push(
          ...(await sendFiles(api, chat_id, files, {
            reply_to: p.replyToMode === 'off' ? undefined : reply_to,
            silent: bool(args.silent),
            spoiler: bool(args.spoiler),
            as_document: bool(args.as_document),
          })),
        )
      }

      stopTyping(chat_id)
      if (!ids.length) throw new Error('nothing to send — text was empty and no files were given')
      logOut(chat_id, files.length ? `${raw} [${files.length} file(s)]`.trim() : raw, ids[0])
      return ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(', ')})`
    }

    case 'send_files': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      const files = (args.files as string[] | undefined) ?? []
      if (!files.length) throw new Error('files is empty')
      startTyping(api, chat_id, 'upload_document')
      try {
        const caption = args.caption ? markdownToHtml(str(args.caption)) : undefined
        const ids = await sendFiles(api, chat_id, files, {
          caption,
          parse_mode: caption ? 'HTML' : undefined,
          reply_to: num(args.reply_to),
          silent: bool(args.silent),
          spoiler: bool(args.spoiler),
          as_document: bool(args.as_document),
        })
        return `sent ${ids.length} file(s) (ids: ${ids.join(', ')})`
      } finally {
        stopTyping(chat_id)
      }
    }

    case 'ask': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      const options = (args.options as string[] | undefined) ?? []
      if (options.length < 2) throw new Error('ask needs at least 2 options')
      if (options.length > 10) throw new Error('ask supports at most 10 options')
      stopTyping(chat_id)
      const answer = await ask(api, chat_id, str(args.question), options, {
        detail: args.detail ? str(args.detail) : undefined,
        timeoutSec: num(args.timeout_sec),
      })
      return `answered: ${answer.label} (option ${answer.index}, by ${answer.by})`
    }

    case 'send_plan': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      stopTyping(chat_id)
      const decision = await sendPlan(api, chat_id, str(args.title), str(args.body), {
        timeoutSec: num(args.timeout_sec),
      })
      return `${decision.decision} (by ${decision.by})`
    }

    case 'stream_start': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      const s = await openStream(api, chat_id, {
        reply_to: num(args.reply_to),
        initial: args.initial ? str(args.initial) : undefined,
      })
      return `stream_id: ${s.stream_id} (mode: ${s.mode})`
    }

    case 'history': {
      if (args.chat_id == null) {
        const list = historyChats()
        if (!list.length) return 'no history yet'
        return list
          .map((c) => `${c.chat_id} — ${c.messages} messages${c.last ? `, last ${c.last.slice(0, 19).replace('T', ' ')}` : ''}`)
          .join('\n')
      }
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      const entries = readHistory(chat_id, {
        limit: args.limit == null ? undefined : Number(args.limit),
        search: args.search ? str(args.search) : undefined,
      })
      return formatHistory(entries)
    }

    case 'say': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      stopTyping(chat_id)
      const ids = await typeOut(api, chat_id, str(args.text), {
        reply_to: num(args.reply_to),
        unit: args.unit ? (str(args.unit) as TypeUnit) : undefined,
        tickMs: num(args.tick_ms),
        maxMs: num(args.max_ms),
      })
      logOut(chat_id, str(args.text), ids[0])
      return ids.length ? `sent (ids: ${ids.join(', ')})` : 'sent'
    }

    case 'stream_push': {
      const id = str(args.stream_id)
      if (bool(args.replace)) await setStream(api, id, str(args.text))
      else await pushStream(api, id, str(args.text))
      return 'ok'
    }

    case 'stream_end': {
      const id = str(args.stream_id)
      if (bool(args.cancel)) {
        abortStream(id)
        return 'cancelled'
      }
      const ids = await closeStream(api, id, args.text != null ? str(args.text) : undefined)
      return ids.length ? `sent (ids: ${ids.join(', ')})` : 'sent'
    }

    case 'react': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      await api.setMessageReaction(chat_id, Number(args.message_id), [
        { type: 'emoji', emoji: str(args.emoji) as never },
      ])
      return 'reacted'
    }

    case 'edit_message': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      const format = (args.format as Format | undefined) ?? p.defaultFormat
      const { text, parse_mode } = render(str(args.text), format)
      const edited = await api.editMessageText(chat_id, Number(args.message_id), text, {
        ...(parse_mode ? { parse_mode } : {}),
        link_preview_options: { is_disabled: !p.linkPreview },
      })
      const id = typeof edited === 'object' ? edited.message_id : args.message_id
      return `edited (id: ${id})`
    }

    case 'delete_message': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      await api.deleteMessage(chat_id, Number(args.message_id))
      return 'deleted'
    }

    case 'pin_message': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      const mid = Number(args.message_id)
      if (bool(args.unpin)) {
        await api.unpinChatMessage(chat_id, mid)
        return 'unpinned'
      }
      await api.pinChatMessage(chat_id, mid, { disable_notification: true })
      return 'pinned'
    }

    case 'send_poll': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      const options = (args.options as string[] | undefined) ?? []
      if (options.length < 1) throw new Error('send_poll needs at least one option')
      const sent = await api.sendPoll(
        chat_id,
        str(args.question),
        options.map(o => ({ text: o })),
        {
          is_anonymous: args.anonymous == null ? true : bool(args.anonymous),
          allows_multiple_answers: bool(args.multiple),
        },
      )
      return `poll sent (id: ${sent.message_id})`
    }

    case 'send_code': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      const lang = args.language ? str(args.language) : undefined
      const head = args.caption ? markdownToHtml(str(args.caption)) + '\n' : ''
      const html = head + codeBlock(str(args.code), lang)
      const parts = chunkFor(html, 'HTML', p.textChunkLimit, 'length')
      const ids: number[] = []
      for (const part of parts) {
        const sent = await api.sendMessage(chat_id, part, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        })
        ids.push(sent.message_id)
      }
      stopTyping(chat_id)
      return `sent (ids: ${ids.join(', ')})`
    }

    case 'typing': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      if (bool(args.stop)) {
        stopTyping(chat_id)
        return 'stopped'
      }
      startTyping(api, chat_id, (args.action as never) ?? 'typing')
      return 'started'
    }

    case 'status': {
      const chat_id = str(args.chat_id)
      assertAllowedChat(chat_id)
      const text = str(args.text)
      if (setHeartbeatText(chat_id, text)) return 'updated'
      // No live status line — usually because the turn already produced output.
      startHeartbeat(api, chat_id)
      setHeartbeatText(chat_id, text)
      return 'started'
    }

    case 'download_attachment':
      return await downloadAttachment(api, str(args.file_id))

    case 'channel_info': {
      const a = loadAccess()
      const c = pendingCounts()
      const draft = draftSupport()
      return [
        `api: ${LOCAL_API ? 'local' : 'cloud'} (${API_ROOT})`,
        `limits: ${limitsSummary()}`,
        `live streaming: ${draft === 'yes' ? 'rich drafts' : draft === 'no' ? 'edit-based fallback' : 'not probed yet'}`,
        `default format: ${p.defaultFormat}`,
        `chunk limit: ${p.textChunkLimit} (${p.chunkMode})`,
        `typing keepalive: ${p.typingKeepalive ? `every ${p.typingIntervalSec}s, max ${p.typingMaxSec}s` : 'off'}`,
        `allowlisted chats: ${a.allowFrom.length} DM, ${Object.keys(a.groups).length} group(s)`,
        `waiting: ${c.permissions} permission(s), ${c.asks} question(s), ${c.plans} plan(s)`,
        `open streams: ${activeStreams().length}`,
      ].join('\n')
    }

    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

export { humanSize }
