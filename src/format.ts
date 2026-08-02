/**
 * Formatting for Telegram.
 *
 * The original plugin exposed 'text' and 'markdownv2' and made the caller
 * escape MarkdownV2's 18 reserved characters by hand — which is exactly the
 * kind of thing a model gets wrong on the one message that matters.
 *
 * Here the default is 'auto': write ordinary Markdown, get valid Telegram
 * HTML. Everything that isn't recognised markup is escaped, so a stray '<'
 * or '&' can never break a message or smuggle a tag.
 *
 * Telegram's HTML subset (everything else is rejected by the API):
 *   b/strong  i/em  u/ins  s/strike/del  code  pre  a[href]
 *   tg-spoiler  span.tg-spoiler  tg-emoji[emoji-id]  blockquote[expandable]
 */

export type Format = 'auto' | 'html' | 'markdownv2' | 'text'

/** Escape text for Telegram HTML. Only these three chars are special. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape text for MarkdownV2 (kept for callers that explicitly ask for it). */
export function escapeMarkdownV2(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, m => '\\' + m)
}

// Private Use Area sentinels. These never occur in real text, so a stashed
// span can't be forged by message content nor mangled by the escaper.
const P_OPEN = ''
const P_CLOSE = ''
const RESTORE_RE = new RegExp(`${P_OPEN}(\\d+)${P_CLOSE}`, 'g')

/**
 * Convert a practical subset of Markdown to Telegram HTML.
 *
 * Handled: fenced code (with language), inline code, bold, italic,
 * strikethrough, spoilers, links, blockquotes (expandable when long), and
 * headings (rendered bold — Telegram has no heading tag).
 */
export function markdownToHtml(src: string, opts: { expandableQuoteOver?: number } = {}): string {
  const stash: string[] = []
  const keep = (html: string): string => {
    stash.push(html)
    return `${P_OPEN}${stash.length - 1}${P_CLOSE}`
  }

  // Strip any sentinel the input happens to contain — belt and braces.
  let s = src.split(P_OPEN).join('').split(P_CLOSE).join('')

  // 1. Fenced code blocks first — their contents must survive untouched.
  s = s.replace(/```([\w+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const code = escapeHtml(body.replace(/\r?\n$/, ''))
    return keep(
      lang
        ? `<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>`
        : `<pre>${code}</pre>`,
    )
  })
  // Fence with no newline after the opening marker.
  s = s.replace(/```([\s\S]*?)```/g, (_m, body: string) => keep(`<pre>${escapeHtml(body)}</pre>`))

  // 2. Inline code.
  s = s.replace(/`([^`\n]+)`/g, (_m, body: string) => keep(`<code>${escapeHtml(body)}</code>`))

  // 3. Links — captured before escaping so the URL keeps its characters.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    if (!/^(https?:|tg:\/\/|mailto:)/i.test(href)) return `${label} (${href})`
    return keep(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`)
  })

  // 4. Everything left is plain text -> escape it.
  s = escapeHtml(s)

  // 5. Inline emphasis, applied to the escaped text.
  s = s.replace(/\*\*\*([^\n*]+)\*\*\*/g, '<b><i>$1</i></b>')
  s = s.replace(/\*\*([^\n*]+)\*\*/g, '<b>$1</b>')
  s = s.replace(/(^|[\s(])\*([^\n*]+)\*(?=[\s).,!?;:]|$)/g, '$1<i>$2</i>')
  s = s.replace(/(^|[\s(])_([^\n_]+)_(?=[\s).,!?;:]|$)/g, '$1<i>$2</i>')
  s = s.replace(/~~([^\n~]+)~~/g, '<s>$1</s>')
  s = s.replace(/\|\|([^\n|]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>')

  // 6. Headings -> bold line (Telegram has no heading tag).
  s = s.replace(/^#{1,6}[ \t]+(.+)$/gm, '<b>$1</b>')

  // 7. Blockquotes: fold consecutive "> " lines into one block. Long quotes
  //    become expandable so they don't flood the chat.
  const overflow = opts.expandableQuoteOver ?? 500
  s = s.replace(/(?:^&gt;[ \t]?.*(?:\r?\n|$))+/gm, block => {
    const body = block
      .replace(/\r?\n$/, '')
      .split(/\r?\n/)
      .map(l => l.replace(/^&gt;[ \t]?/, ''))
      .join('\n')
    const tag = body.length > overflow ? '<blockquote expandable>' : '<blockquote>'
    return `${tag}${body}</blockquote>\n`
  })

  // 8. Horizontal rules have no Telegram equivalent.
  s = s.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '—————')

  // 9. Restore stashed markup.
  s = s.replace(RESTORE_RE, (_m, i: string) => stash[Number(i)] ?? '')

  return s
}

/** Wrap text in an expandable quote so long output stays collapsed. */
export function collapse(html: string): string {
  return `<blockquote expandable>${html}</blockquote>`
}

/** Render a code block, ready to send as HTML. */
export function codeBlock(code: string, lang?: string): string {
  const body = escapeHtml(code)
  return lang
    ? `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>`
    : `<pre>${body}</pre>`
}

/** Resolve a caller-supplied format into { text, parse_mode } for the Bot API. */
export function render(
  text: string,
  format: Format,
): { text: string; parse_mode?: 'HTML' | 'MarkdownV2' } {
  switch (format) {
    case 'text':
      return { text }
    case 'html':
      return { text, parse_mode: 'HTML' }
    case 'markdownv2':
      return { text, parse_mode: 'MarkdownV2' }
    case 'auto':
    default:
      return { text: markdownToHtml(text), parse_mode: 'HTML' }
  }
}

// ---------------------------------------------------------------------------
// HTML-aware chunking
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['br', 'hr', 'img'])

type OpenTag = { name: string; raw: string }

/**
 * Split HTML into Telegram-sized pieces without ever emitting an unbalanced
 * tag. A naive character split lands mid-<pre> and the API rejects the entire
 * message; here any tags still open at the cut are closed and reopened.
 */
export function chunkHtml(html: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (html.length <= limit) return [html]

  const out: string[] = []
  const open: OpenTag[] = []
  let buf = ''

  const closing = (): string => open.map(t => `</${t.name}>`).reverse().join('')
  const opening = (): string => open.map(t => t.raw).join('')

  const flush = (): void => {
    const body = buf + closing()
    if (body.trim()) out.push(body)
    buf = opening()
  }

  const pushText = (text: string): void => {
    let rest = text
    while (rest.length > 0) {
      const room = limit - buf.length - closing().length
      if (room <= 0) {
        // Nothing fits — flush and retry. Guard against a pathological stack
        // that leaves no room even when empty.
        if (buf === opening()) return
        flush()
        continue
      }
      if (rest.length <= room) {
        buf += rest
        return
      }
      let cut = room
      if (mode === 'newline') {
        const para = rest.lastIndexOf('\n\n', room)
        const line = rest.lastIndexOf('\n', room)
        const space = rest.lastIndexOf(' ', room)
        cut = para > room / 2 ? para : line > room / 2 ? line : space > room / 3 ? space : room
      }
      // Never split an HTML entity in half.
      const tail = rest.slice(Math.max(0, cut - 12), cut)
      const amp = tail.lastIndexOf('&')
      if (amp !== -1 && !tail.slice(amp).includes(';')) cut = Math.max(1, cut - (tail.length - amp))

      buf += rest.slice(0, cut)
      rest = rest.slice(cut).replace(/^\n+/, '')
      flush()
    }
  }

  const re = /<\/?([a-zA-Z][\w-]*)((?:\s[^>]*)?)>/g
  let last = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(html)) !== null) {
    pushText(html.slice(last, m.index))
    last = m.index + m[0].length

    const raw = m[0]
    const name = m[1].toLowerCase()
    const isClose = raw.startsWith('</')
    const selfClosing = raw.endsWith('/>') || VOID_TAGS.has(name)

    if (buf.length + raw.length + closing().length > limit) flush()
    buf += raw

    if (selfClosing) continue
    if (isClose) {
      const i = open.map(t => t.name).lastIndexOf(name)
      if (i !== -1) open.splice(i, 1)
    } else {
      open.push({ name, raw })
    }
  }
  pushText(html.slice(last))

  const finalBody = buf + closing()
  if (finalBody.trim() && finalBody !== opening() + closing()) out.push(finalBody)
  return out
}

/** Plain-text chunking (no tags to balance). */
export function chunkText(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/** Chunk according to the resolved parse mode. */
export function chunkFor(
  text: string,
  parseMode: 'HTML' | 'MarkdownV2' | undefined,
  limit: number,
  mode: 'length' | 'newline',
): string[] {
  return parseMode === 'HTML' ? chunkHtml(text, limit, mode) : chunkText(text, limit, mode)
}
