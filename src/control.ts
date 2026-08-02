/**
 * Reading and flipping Claude Code's own configuration from the chat.
 *
 * Everything here works on the files Claude Code already keeps, because the
 * plugin runs as a separate process and cannot ask the CLI anything. Skills and
 * commands are discovered by walking the same directories the CLI walks;
 * plugins and MCP servers are read from their registries.
 *
 * Deliberately not here: anything touching access.json. Who may talk to the
 * bridge is decided at the machine, never by something that arrived over it —
 * a message asking to be allowed in is exactly what an attack looks like.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { spawn } from 'child_process'

const CLAUDE_DIR = join(homedir(), '.claude')
const SETTINGS = join(CLAUDE_DIR, 'settings.json')
const LOCAL_SETTINGS = join(CLAUDE_DIR, 'settings.local.json')
const INSTALLED = join(CLAUDE_DIR, 'plugins', 'installed_plugins.json')
const USER_CONFIG = join(homedir(), '.claude.json')

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

type Settings = { enabledPlugins?: Record<string, unknown> }

/**
 * What is actually in force. settings.local.json overrides settings.json, and
 * reading only the latter reports plugins as on that the local file has turned
 * off — a listing that lies is worse than none.
 */
function effectivePlugins(): Record<string, unknown> {
  return {
    ...(readJson<Settings>(SETTINGS)?.enabledPlugins ?? {}),
    ...(readJson<Settings>(LOCAL_SETTINGS)?.enabledPlugins ?? {}),
  }
}

// ---------------------------------------------------------------------------
// Skills and commands
// ---------------------------------------------------------------------------

export type Command = { name: string; description: string; source: string }

/** First non-empty description from YAML frontmatter, if there is any. */
function frontmatterDescription(file: string): string {
  try {
    const text = readFileSync(file, 'utf8').slice(0, 4000)
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!fm) return ''
    const m = /^description:\s*(.+)$/m.exec(fm[1])
    return m ? m[1].replace(/^["']|["']$/g, '').trim() : ''
  } catch {
    return ''
  }
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

function files(path: string, ext: string): string[] {
  try {
    return readdirSync(path).filter((f) => f.endsWith(ext))
  } catch {
    return []
  }
}

/**
 * Every slash command and skill the CLI would offer: the user's own, plus the
 * ones each enabled plugin ships.
 */
export function listCommands(): Command[] {
  const out: Command[] = []

  for (const f of files(join(CLAUDE_DIR, 'commands'), '.md')) {
    const name = basename(f, '.md')
    out.push({
      name,
      description: frontmatterDescription(join(CLAUDE_DIR, 'commands', f)),
      source: 'user',
    })
  }

  for (const d of dirs(join(CLAUDE_DIR, 'skills'))) {
    const skill = join(CLAUDE_DIR, 'skills', d, 'SKILL.md')
    if (!existsSync(skill)) continue
    out.push({ name: d, description: frontmatterDescription(skill), source: 'skill' })
  }

  // Plugin-provided skills, but only from plugins that are actually on.
  const enabled = new Set(
    Object.entries(effectivePlugins())
      .filter(([, v]) => v !== false)
      .map(([k]) => k),
  )
  const cache = join(CLAUDE_DIR, 'plugins', 'cache')
  for (const marketplace of dirs(cache)) {
    for (const plugin of dirs(join(cache, marketplace))) {
      if (!enabled.has(`${plugin}@${marketplace}`)) continue
      for (const version of dirs(join(cache, marketplace, plugin))) {
        for (const d of dirs(join(cache, marketplace, plugin, version, 'skills'))) {
          const skill = join(cache, marketplace, plugin, version, 'skills', d, 'SKILL.md')
          if (!existsSync(skill)) continue
          out.push({ name: `${plugin}:${d}`, description: frontmatterDescription(skill), source: plugin })
        }
      }
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export type Plugin = { id: string; enabled: boolean; installed: boolean }

export function listPlugins(): Plugin[] {
  const enabled = effectivePlugins()
  const installed = readJson<{ plugins?: Record<string, unknown> }>(INSTALLED)

  const ids = new Set([...Object.keys(enabled), ...Object.keys(installed?.plugins ?? {})])

  return [...ids]
    .map((id) => ({
      id,
      enabled: id in enabled && enabled[id] !== false,
      installed: id in (installed?.plugins ?? {}),
    }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id))
}

/**
 * Turn a plugin on or off. Returns what it resolved the name to, since a bare
 * plugin name is far easier to type on a phone than `name@marketplace`.
 */
export function setPlugin(name: string, on: boolean): { id: string; changed: boolean } {
  const effective = effectivePlugins()
  const known = Object.keys(effective)
  const id =
    known.find((k) => k === name) ??
    known.find((k) => k.split('@')[0] === name) ??
    (() => {
      throw new Error(`unknown plugin: ${name}`)
    })()

  if ((effective[id] !== false) === on) return { id, changed: false }

  // Write to whichever file currently decides it. Setting the global file for
  // a plugin the local one overrides would change nothing and look like the
  // toggle was ignored.
  const local = readJson<Record<string, any>>(LOCAL_SETTINGS)
  const target = local?.enabledPlugins && id in local.enabledPlugins ? LOCAL_SETTINGS : SETTINGS

  const settings = readJson<Record<string, any>>(target)
  if (!settings) throw new Error(`cannot read ${basename(target)}`)
  settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [id]: on }

  // Written through a temp file: a half-written settings file disables every
  // setting in it, which is a much worse outcome than a failed toggle.
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  renameSync(tmp, target)
  return { id, changed: true }
}

// ---------------------------------------------------------------------------
// CLI diagnostics
// ---------------------------------------------------------------------------

/**
 * Claude Code's built-in slash commands are not files, and most of them drive
 * the terminal UI — there is nothing to run headless. A few exist as CLI
 * subcommands too, and those we can shell out to.
 *
 * A fixed allowlist, never anything the user typed: this runs a real process,
 * and the arguments must not be reachable from a chat message.
 */
export const CLI_COMMANDS: Record<string, { args: string[]; description: string }> = {
  doctor: { args: ['doctor'], description: 'Installation health check' },
  version: { args: ['--version'], description: 'Claude Code version' },
  mcp_health: { args: ['mcp', 'list'], description: 'MCP servers with a live health check' },
  plugin_list: { args: ['plugin', 'list'], description: 'Installed plugins as the CLI sees them' },
}

export function runCli(name: string, timeoutMs = 60_000): Promise<string> {
  const entry = CLI_COMMANDS[name]
  if (!entry) return Promise.resolve(`unknown: ${name}`)

  return new Promise((resolve) => {
    // No shell — the argument list is fixed, and spawning through one would
    // hand a parser something it has no business seeing.
    const child = spawn('claude', entry.args, { shell: false, windowsHide: true })
    let out = ''
    const done = (text: string) => {
      clearTimeout(timer)
      try {
        child.kill()
      } catch {}
      resolve(text.trim() || '(no output)')
    }
    const timer = setTimeout(() => done(`${out}\n\n(timed out after ${timeoutMs / 1000}s)`), timeoutMs)

    child.stdout?.on('data', (c) => (out += c))
    child.stderr?.on('data', (c) => (out += c))
    child.on('error', (err) => done(`could not run claude: ${err.message}`))
    child.on('close', () => done(out))
  })
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export type McpServer = { name: string; scope: string; transport: string }

export function listMcp(): McpServer[] {
  const out: McpServer[] = []

  const user = readJson<{ mcpServers?: Record<string, any> }>(USER_CONFIG)?.mcpServers ?? {}
  for (const [name, cfg] of Object.entries(user)) {
    out.push({ name, scope: 'user', transport: cfg?.url ? 'http' : (cfg?.command ?? 'stdio') })
  }

  // Plugins bring their own servers along; those are on exactly when the
  // plugin is. Several versions of a plugin can sit in the cache side by side
  // and declare the same server, so collapse them by name.
  const enabled = effectivePlugins()
  const cache = join(CLAUDE_DIR, 'plugins', 'cache')
  const seen = new Set(out.map((s) => s.name))
  for (const marketplace of dirs(cache)) {
    for (const plugin of dirs(join(cache, marketplace))) {
      if (enabled[`${plugin}@${marketplace}`] === false) continue
      for (const version of dirs(join(cache, marketplace, plugin))) {
        const mcp = readJson<{ mcpServers?: Record<string, any> }>(
          join(cache, marketplace, plugin, version, '.mcp.json'),
        )
        for (const name of Object.keys(mcp?.mcpServers ?? {})) {
          if (seen.has(name)) continue
          seen.add(name)
          out.push({ name, scope: plugin, transport: 'plugin' })
        }
      }
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}
