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

const CLAUDE_DIR = join(homedir(), '.claude')
const SETTINGS = join(CLAUDE_DIR, 'settings.json')
const INSTALLED = join(CLAUDE_DIR, 'plugins', 'installed_plugins.json')
const USER_CONFIG = join(homedir(), '.claude.json')

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
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
    Object.entries(readJson<Record<string, unknown>>(SETTINGS)?.enabledPlugins ?? {})
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
  const settings = readJson<{ enabledPlugins?: Record<string, unknown> }>(SETTINGS)
  const installed = readJson<{ plugins?: Record<string, unknown> }>(INSTALLED)

  const ids = new Set([
    ...Object.keys(settings?.enabledPlugins ?? {}),
    ...Object.keys(installed?.plugins ?? {}),
  ])

  return [...ids]
    .map((id) => ({
      id,
      enabled: (settings?.enabledPlugins ?? {})[id] !== false && id in (settings?.enabledPlugins ?? {}),
      installed: id in (installed?.plugins ?? {}),
    }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id))
}

/**
 * Turn a plugin on or off. Returns what it resolved the name to, since a bare
 * plugin name is far easier to type on a phone than `name@marketplace`.
 */
export function setPlugin(name: string, on: boolean): { id: string; changed: boolean } {
  const settings = readJson<Record<string, any>>(SETTINGS)
  if (!settings) throw new Error('cannot read settings.json')

  const known = Object.keys(settings.enabledPlugins ?? {})
  const id =
    known.find((k) => k === name) ??
    known.find((k) => k.split('@')[0] === name) ??
    (() => {
      throw new Error(`unknown plugin: ${name}`)
    })()

  const before = settings.enabledPlugins[id]
  if (before === on) return { id, changed: false }

  settings.enabledPlugins[id] = on

  // Written through a temp file: a half-written settings.json disables every
  // setting in it, which is a much worse outcome than a failed toggle.
  const tmp = `${SETTINGS}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  renameSync(tmp, SETTINGS)
  return { id, changed: true }
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
  const settings = readJson<{ enabledPlugins?: Record<string, unknown> }>(SETTINGS)
  const cache = join(CLAUDE_DIR, 'plugins', 'cache')
  const seen = new Set(out.map((s) => s.name))
  for (const marketplace of dirs(cache)) {
    for (const plugin of dirs(join(cache, marketplace))) {
      if ((settings?.enabledPlugins ?? {})[`${plugin}@${marketplace}`] === false) continue
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
