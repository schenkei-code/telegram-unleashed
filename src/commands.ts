/**
 * Telegram's command menu, backed by what Claude Code actually has installed.
 *
 * Two kinds of command end up in the same blue menu. A handful are answered by
 * the plugin itself — listing plugins, reading history — because they are
 * questions about the bridge and need no session. The rest are the user's own
 * skills and slash commands, which are only *listed* here; tapping one sends
 * its name as an ordinary message and the session runs it.
 *
 * Telegram will not accept a command name with a dash or a colon in it, so
 * `claude-mem:mem-search` is registered as `claude_mem_mem_search` and
 * translated back on the way in. Without that the menu would offer commands
 * that silently do nothing.
 */

import type { Bot } from 'grammy'
import { InlineKeyboard } from 'grammy'
import {
  listCommands,
  listPlugins,
  listMcp,
  setPlugin,
  runCli,
  getSetting,
  setSetting,
  MODELS,
  EFFORTS,
  CLI_COMMANDS,
  type Plugin,
  type Command,
  type Choice,
} from './control.js'
import { read as readHistory, format as formatHistory } from './history.js'
import { draftSupport } from './stream.js'
import { CHANNEL } from './config.js'

/** Telegram's rule: 1-32 chars, lowercase letters, digits and underscores. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
}

/** Commands the plugin answers itself, in menu order. */
const NATIVE: { name: string; description: string }[] = [
  { name: 'commands', description: 'List every skill and command available' },
  { name: 'model', description: 'Model — tap to switch' },
  { name: 'effort', description: 'Reasoning effort — tap to switch' },
  { name: 'plugins', description: 'Plugins — tap to turn on or off' },
  { name: 'mcp', description: 'MCP servers currently configured' },
  { name: 'history', description: 'Recent messages in this chat' },
  { name: 'status', description: 'Bridge status' },
  { name: 'help', description: 'What this bridge can do' },
]

const nativeNames = new Set([...NATIVE.map((c) => c.name), ...Object.keys(CLI_COMMANDS)])

/**
 * Publish the menu. Telegram caps it at 100 entries, so the native commands go
 * first and the discovered ones fill whatever is left.
 */
export async function publishMenu(bot: Bot, scope: { type: 'all_private_chats' } | undefined = { type: 'all_private_chats' }): Promise<number> {
  const seen = new Set(nativeNames)
  const entries = [
    ...NATIVE.map((c) => ({ command: c.name, description: c.description })),
    ...Object.entries(CLI_COMMANDS).map(([name, c]) => ({ command: name, description: c.description })),
  ]

  for (const c of listCommands()) {
    if (entries.length >= 100) break
    const s = slug(c.name)
    if (!s || seen.has(s)) continue
    seen.add(s)
    // Telegram rejects an empty description and allows 256 per entry — but
    // the *total* payload has its own undocumented ceiling, which sixty full
    // ones already exceed. Skill descriptions are paragraphs, so clip hard.
    entries.push({ command: s, description: clipDescription(c.description || c.name) })
  }

  // The ceiling is not published anywhere, so back off rather than guess it:
  // shorten first, and only start dropping entries once that stops helping.
  for (let attempt = 0; ; attempt++) {
    try {
      await bot.api.setMyCommands(entries, scope ? { scope } : undefined)
      return entries.length
    } catch (err) {
      if (!/BOT_COMMANDS_TOO_MUCH/i.test(String((err as any)?.description ?? err)) || attempt >= 6) throw err
      if (attempt < 3) {
        const max = [60, 40, 24][attempt]
        for (const e of entries) e.description = e.description.slice(0, max)
      } else {
        entries.length = Math.max(NATIVE.length + Object.keys(CLI_COMMANDS).length, Math.floor(entries.length / 2))
      }
    }
  }
}

/** One useful line, not the first paragraph of a skill's frontmatter. */
function clipDescription(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= 80) return one
  // Prefer a sentence boundary if there is one early enough to be worth it.
  const dot = one.slice(0, 80).lastIndexOf('. ')
  return dot > 30 ? one.slice(0, dot + 1) : one.slice(0, 79) + '…'
}

/**
 * Undo the slugging for an inbound message, so a tapped menu entry reaches the
 * session under the name the session knows.
 */
export function resolveSlug(text: string): string {
  const m = /^\/([a-z0-9_]{1,32})(\s[\s\S]*)?$/.exec(text.trim())
  if (!m) return text
  const [, name, rest = ''] = m
  if (nativeNames.has(name)) return text

  const match = listCommands().find((c) => slug(c.name) === name)
  return match ? `/${match.name}${rest}` : text
}

// ---------------------------------------------------------------------------
// Native handlers
// ---------------------------------------------------------------------------

export type Handled = { text: string; keyboard?: InlineKeyboard }

/**
 * Answer a native command, or return null to let the message through to the
 * session unchanged.
 */
export async function handleCommand(text: string, chat_id: string): Promise<Handled | null> {
  const m = /^\/([a-z0-9_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  const [, name, arg = ''] = m

  // Built-ins that also exist as CLI subcommands run for real.
  if (name in CLI_COMMANDS) {
    return { text: `*/${name}*\n\n\`\`\`\n${await runCli(name)}\n\`\`\`` }
  }

  // A tapped menu entry is a bare word with no context — the blurb Telegram
  // shows is clipped to a line, and there is no way to pass an argument. So a
  // bare command opens a card with the full description and a run button;
  // typing one with arguments still goes straight through.
  if (!nativeNames.has(name) && !arg.trim()) {
    const card = commandCard(name)
    if (card) return card
  }

  if (!nativeNames.has(name)) return null

  switch (name) {
    case 'commands': {
      const all = listCommands()
      if (!all.length) return { text: 'No skills or commands found.' }
      const lines = all.map((c) => `/${c.name}${c.description ? ` — ${c.description.slice(0, 90)}` : ''}`)
      return { text: `*${all.length} commands*\n\n${lines.join('\n')}` }
    }

    case 'model':
    case 'effort': {
      const field = name === 'model' ? MODEL_FIELD : EFFORT_FIELD
      // Typed with a value it is a direct set; tapped from the menu it opens
      // the picker, since a menu entry carries no argument.
      if (arg.trim()) {
        const wanted = arg.trim().toLowerCase()
        const choice = field.choices.find((c) => c.value === wanted || c.label.toLowerCase() === wanted)
        if (!choice) {
          return { text: `Unknown ${field.noun}: \`${arg.trim()}\`\n\n${field.choices.map((c) => c.value).join(', ')}` }
        }
        setSetting(field.key, choice.value)
      }
      return choiceView(field)
    }

    case 'plugins':
      return pluginsView()

    case 'mcp': {
      const servers = listMcp()
      if (!servers.length) return { text: 'No MCP servers configured.' }
      return {
        text: `*MCP servers*\n\n${servers.map((s) => `${s.name} — ${s.scope} (${s.transport})`).join('\n')}`,
      }
    }

    case 'history': {
      const n = Number(arg) || 20
      return { text: formatHistory(readHistory(chat_id, { limit: n })) }
    }

    case 'status': {
      const plugins = listPlugins()
      return {
        text: [
          `*Bridge status*`,
          `channel: ${CHANNEL}`,
          `model: ${getSetting('model') ?? 'unset'}`,
          `effort: ${getSetting('effortLevel') ?? 'unset'}`,
          `streaming: ${draftSupport() === 'no' ? 'edit fallback' : 'rich drafts'}`,
          `plugins: ${plugins.filter((p) => p.enabled).length} on / ${plugins.length} known`,
          `mcp servers: ${listMcp().length}`,
          `commands: ${listCommands().length}`,
        ].join('\n'),
      }
    }

    case 'help':
    default:
      return {
        text: [
          '*telegram-unleashed*',
          '',
          'Write normally and the session answers. Tap the menu button for the',
          'full list of skills and commands — those run in the session.',
          '',
          'Answered here without a session:',
          ...NATIVE.map((c) => `/${c.name} — ${c.description}`),
          '',
          'Plugin changes take effect when Claude Code restarts.',
        ].join('\n'),
      }
  }
}

// ---------------------------------------------------------------------------
// Command cards
// ---------------------------------------------------------------------------

/** Commands offered by a card, so a button can carry a position, not a name. */
let cardOrder: Command[] = []

function commandCard(sluggedName: string): Handled | null {
  const all = listCommands()
  const cmd = all.find((c) => slug(c.name) === sluggedName)
  if (!cmd) return null

  cardOrder = all
  const index = all.indexOf(cmd)

  const body = [`*/${cmd.name}*`, '', cmd.description || '_no description_', '', `_from: ${cmd.source}_`]
  return {
    text: body.join('\n'),
    keyboard: new InlineKeyboard().text('▶ Run', `run:${index}`).text('✕', 'run:cancel'),
  }
}

/**
 * Resolve a run button back to the command it stands for. Returns null for the
 * cancel button, or when the list has moved on since the card was drawn.
 */
export function resolveRun(payload: string): string | null {
  if (payload === 'cancel') return null
  const cmd = cardOrder[Number(payload)]
  return cmd ? `/${cmd.name}` : null
}

// ---------------------------------------------------------------------------
// Model and effort pickers
// ---------------------------------------------------------------------------

type Field = { key: string; noun: string; title: string; prefix: string; choices: Choice[] }

const MODEL_FIELD: Field = { key: 'model', noun: 'model', title: 'Model', prefix: 'md', choices: MODELS }
const EFFORT_FIELD: Field = { key: 'effortLevel', noun: 'effort level', title: 'Reasoning effort', prefix: 'ef', choices: EFFORTS }

const FIELDS: Record<string, Field> = { md: MODEL_FIELD, ef: EFFORT_FIELD }

function choiceView(field: Field): Handled {
  const current = getSetting(field.key)
  const keyboard = new InlineKeyboard()
  field.choices.forEach((c, i) => {
    if (i > 0 && i % 2 === 0) keyboard.row()
    keyboard.text(`${c.value === current ? '●' : '○'} ${c.label}`, `${field.prefix}:${i}`)
  })

  // A value someone set by hand — a full model id, say — is worth showing even
  // though no button matches it, or the card would claim nothing is set.
  const known = field.choices.some((c) => c.value === current)
  const shown = current ?? 'unset'
  return {
    text: [
      `*${field.title}* — \`${shown}\`${current && !known ? ' _(not in this list)_' : ''}`,
      '',
      'Tap to switch. Takes effect after a restart.',
    ].join('\n'),
    keyboard,
  }
}

/** Handle a tap on a model or effort button. */
export function chooseSetting(prefix: string, index: number): { view: Handled; note: string } {
  const field = FIELDS[prefix]
  if (!field) return { view: { text: 'Unknown setting.' }, note: 'Unknown setting.' }

  const choice = field.choices[index]
  if (!choice) return { view: choiceView(field), note: 'Stale — reopened.' }

  try {
    const changed = setSetting(field.key, choice.value)
    return { view: choiceView(field), note: changed ? `${field.noun}: ${choice.value}` : 'Already set.' }
  } catch (err) {
    return { view: choiceView(field), note: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Plugin toggles
// ---------------------------------------------------------------------------

/**
 * Callback payloads are capped at 64 bytes and plugin ids are long, so the
 * buttons carry a position in this list rather than a name.
 */
let pluginOrder: Plugin[] = []

function pluginsView(): Handled {
  pluginOrder = listPlugins().filter((p) => p.installed)
  if (!pluginOrder.length) return { text: 'No plugins installed.' }

  const keyboard = new InlineKeyboard()
  pluginOrder.slice(0, 60).forEach((p, i) => {
    if (i > 0) keyboard.row() // between rows only — a trailing .row() adds an empty one
    keyboard.text(`${p.enabled ? '✅' : '⬜'} ${p.id.split('@')[0]}`, `pl:${i}`)
  })

  const on = pluginOrder.filter((p) => p.enabled).length
  return {
    text: `*Plugins* — ${on} on, ${pluginOrder.length} installed\n\nTap to toggle. Takes effect after a restart.`,
    keyboard,
  }
}

/**
 * Handle a tap on a plugin button. Returns the refreshed view, or a short
 * message if the tap could not be applied.
 */
export function togglePlugin(index: number): { view: Handled; note: string } {
  const target = pluginOrder[index]
  if (!target) return { view: pluginsView(), note: 'Stale list — reopened.' }

  try {
    const { id, changed } = setPlugin(target.id, !target.enabled)
    return {
      view: pluginsView(),
      note: changed ? `${id.split('@')[0]} ${target.enabled ? 'off' : 'on'}` : 'Already in that state.',
    }
  } catch (err) {
    return { view: pluginsView(), note: err instanceof Error ? err.message : String(err) }
  }
}
