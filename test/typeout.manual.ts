/**
 * Manual check for the `say` reveal. Not part of the automated suite — it
 * posts to a real chat.
 *
 *   bun run test/typeout.manual.ts <chat_id> [unit]
 *
 * Set SAY_TEXT to send your own text instead of the built-in sample.
 */

import { Bot } from 'grammy'
import { TOKEN, API_ROOT } from '../src/config.js'
import { typeOut, type TypeUnit } from '../src/stream.js'

const chat = process.argv[2]
const unit = (process.argv[3] as TypeUnit) ?? 'word'
if (!chat) throw new Error('usage: bun run test/typeout.manual.ts <chat_id> [unit]')
if (!TOKEN) throw new Error('no TELEGRAM_BOT_TOKEN')

const bot = new Bot(TOKEN, { client: { apiRoot: API_ROOT } })

const text =
  process.env.SAY_TEXT ??
  `Reveal-Test mit unit=${unit}. Der Text steht schon fest, das Plugin gibt ihn nur nach und nach frei — ein Tool-Aufruf, keine Rückfrage ans Modell zwischendurch. So schaut flüssiges Streaming aus.`

const t0 = Date.now()
const ids = await typeOut(bot.api, chat, text, {
  unit,
  tickMs: process.env.SAY_TICK ? Number(process.env.SAY_TICK) : undefined,
  maxMs: process.env.SAY_MS ? Number(process.env.SAY_MS) : undefined,
})
console.log(`ok in ${Date.now() - t0}ms, ids: ${ids.join(', ')}`)
process.exit(0)
