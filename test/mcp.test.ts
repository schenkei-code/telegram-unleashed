/**
 * End-to-end: spawn the server exactly the way Claude Code does (stdio MCP),
 * then drive real tool calls against the dev bot.
 *
 * Run: TELEGRAM_CHANNEL=telegram-dev bun run test/mcp.test.ts <chat_id>
 */

const CHAT = process.argv[2] ?? process.env.TELEGRAM_TEST_CHAT
if (!CHAT) {
  console.error(
    'Usage: TELEGRAM_CHANNEL=<channel> bun run test/mcp.test.ts <chat_id>\n' +
      'The chat must be allowlisted in that channel\'s access.json.',
  )
  process.exit(2)
}

const proc = Bun.spawn(['bun', 'run', 'src/index.ts'], {
  cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, TELEGRAM_CHANNEL: 'telegram-dev' },
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
})

// Surface server logs so a failure is diagnosable.
void (async () => {
  const dec = new TextDecoder()
  for await (const c of proc.stderr) process.stderr.write('  [server] ' + dec.decode(c))
})()

let buf = ''
const pending = new Map<number, (v: any) => void>()
let nextId = 1

void (async () => {
  const dec = new TextDecoder()
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk)
    let i: number
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)!(msg)
          pending.delete(msg.id)
        }
      } catch {}
    }
  }
})()

function rpc(method: string, params?: unknown, timeoutMs = 30000): Promise<any> {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)
    pending.set(id, v => {
      clearTimeout(t)
      resolve(v)
    })
  })
}

function notify(method: string, params?: unknown): void {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

let pass = 0,
  fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const call = async (name: string, args: Record<string, unknown>) => {
  const r = await rpc('tools/call', { name, arguments: args })
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r)
  return { ok: !r.result?.isError && !r.error, text }
}

console.log('handshake')
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'telegram-unleashed-test', version: '1.0.0' },
})
check('initialize', init.result?.serverInfo?.name === 'telegram-unleashed', JSON.stringify(init.result?.serverInfo))
check('declares channel capability', !!init.result?.capabilities?.experimental?.['claude/channel'])
check(
  'declares permission capability',
  !!init.result?.capabilities?.experimental?.['claude/channel/permission'],
)
notify('notifications/initialized')

console.log('\ntools')
const tools = await rpc('tools/list')
const names: string[] = (tools.result?.tools ?? []).map((t: any) => t.name)
check('tools listed', names.length >= 15, `n=${names.length}`)
for (const expected of ['reply', 'ask', 'send_plan', 'stream_start', 'send_code', 'channel_info']) {
  check(`has ${expected}`, names.includes(expected))
}

console.log('\ndiagnostics')
{
  const r = await call('channel_info', {})
  check('channel_info succeeds', r.ok, r.text)
  console.log('    ' + r.text.split('\n').join('\n    '))
}

console.log('\nguard rails')
{
  const r = await call('reply', { chat_id: '999999999', text: 'should not arrive' })
  check('rejects non-allowlisted chat', !r.ok && /not allowlisted/.test(r.text), r.text)
}
{
  const r = await call('reply', {
    chat_id: CHAT,
    text: 'x',
    files: [process.env.USERPROFILE + '/.claude/channels/telegram-dev/.env'],
  })
  check('refuses to attach channel state', !r.ok && /refusing to send channel state/.test(r.text), r.text)
}
{
  const r = await call('ask', { chat_id: CHAT, question: 'zu wenig Optionen', options: ['nur eine'] })
  check('ask rejects a single option', !r.ok && /at least 2/.test(r.text), r.text)
}

console.log('\nsending')
{
  const r = await call('reply', {
    chat_id: CHAT,
    text:
      '*telegram-unleashed* — Selbsttest\n\n' +
      'Kein manuelles Escaping mehr: `a < b && c > d`, Tom & Jerry, <nicht-injiziert>\n\n' +
      '```ts\nconst limit: number = 4096 // wird nicht zerrissen\n```\n\n' +
      '> Ein Zitat, das eingerückt bleibt.\n\n' +
      '~~durchgestrichen~~ und ||Spoiler||',
  })
  check('reply with mixed markup', r.ok, r.text)
}
{
  const r = await call('send_code', {
    chat_id: CHAT,
    language: 'typescript',
    caption: 'Syntax-Highlighting:',
    code: 'export function chunkHtml(html: string, limit: number) {\n  // Tags werden über Grenzen hinweg geschlossen und neu geöffnet\n  return html.length <= limit ? [html] : split(html)\n}',
  })
  check('send_code', r.ok, r.text)
}
{
  const long = Array.from({ length: 60 }, (_, i) => `Zeile ${i + 1}: ${'Inhalt '.repeat(12)}`).join('\n')
  const r = await call('reply', { chat_id: CHAT, text: '```\n' + long + '\n```' })
  check('long code block splits cleanly', r.ok, r.text)
}

console.log('\nstreaming')
{
  const s = await call('stream_start', { chat_id: CHAT, initial: 'Streaming-Test' })
  check('stream_start', s.ok, s.text)
  const id = /stream_id: (\S+)/.exec(s.text)?.[1]
  check('returns a stream id', !!id, s.text)
  if (id) {
    for (const part of [
      '\n\nDer Text wächst',
      ' Stück',
      ' für Stück,',
      '\nwährend die Antwort entsteht.',
    ]) {
      await call('stream_push', { stream_id: id, text: part })
      await Bun.sleep(700)
    }
    const e = await call('stream_end', {
      stream_id: id,
      text:
        'Streaming-Test abgeschlossen.\n\nDer Text wuchs Stück für Stück, statt am Ende als Block zu erscheinen.',
    })
    check('stream_end', e.ok, e.text)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
proc.stdin.end()
proc.kill()
await Bun.sleep(300)
process.exit(fail > 0 ? 1 : 0)
