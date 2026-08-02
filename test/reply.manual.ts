/**
 * Manual check that `reply` reveals by default. Not part of the automated
 * suite — it posts to a real chat.
 *
 *   bun run test/reply.manual.ts <chat_id> "text" [--instant]
 */

import { Bot } from 'grammy'
import { TOKEN, API_ROOT } from '../src/config.js'
import { callTool } from '../src/tools.js'

const chat = process.argv[2]
const text = process.argv[3]
const instant = process.argv.includes('--instant')
if (!chat || !text) throw new Error('usage: bun run test/reply.manual.ts <chat_id> "text" [--instant]')
if (!TOKEN) throw new Error('no TELEGRAM_BOT_TOKEN')

const bot = new Bot(TOKEN, { client: { apiRoot: API_ROOT } })

const t0 = Date.now()
const res = await callTool(bot.api, 'reply', { chat_id: chat, text, ...(instant ? { instant: true } : {}) })
console.log(`${res} — ${Date.now() - t0}ms`)
process.exit(0)
