import { markdownToHtml, chunkHtml, escapeHtml, codeBlock } from '../src/format.js'

let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++
  } else {
    fail++
    console.log(`FAIL: ${name}${detail ? '\n      ' + detail : ''}`)
  }
}

function eq(name: string, got: string, want: string): void {
  check(name, got === want, `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`)
}

// ---- escaping ----
eq('escape angle brackets', escapeHtml('<script>'), '&lt;script&gt;')
eq('escape ampersand', escapeHtml('a & b'), 'a &amp; b')
eq('escape order (no double-encode)', escapeHtml('&lt;'), '&amp;lt;')

// ---- inline markup ----
eq('bold', markdownToHtml('**fett**'), '<b>fett</b>')
eq('italic star', markdownToHtml('ein *kursiv* wort'), 'ein <i>kursiv</i> wort')
eq('italic underscore', markdownToHtml('ein _kursiv_ wort'), 'ein <i>kursiv</i> wort')
eq('bold italic', markdownToHtml('***beides***'), '<b><i>beides</i></b>')
eq('strikethrough', markdownToHtml('~~weg~~'), '<s>weg</s>')
eq('spoiler', markdownToHtml('||geheim||'), '<tg-spoiler>geheim</tg-spoiler>')
eq('inline code', markdownToHtml('`x = 1`'), '<code>x = 1</code>')
eq('heading becomes bold', markdownToHtml('## Titel'), '<b>Titel</b>')

// ---- the escaping trap the old plugin left to the caller ----
eq('raw html is escaped, not injected', markdownToHtml('<b>nope</b>'), '&lt;b&gt;nope&lt;/b&gt;')
eq('ampersand in prose', markdownToHtml('Tom & Jerry'), 'Tom &amp; Jerry')
eq(
  'code content is escaped',
  markdownToHtml('`if (a < b && c > d)`'),
  '<code>if (a &lt; b &amp;&amp; c &gt; d)</code>',
)

// ---- fenced code ----
eq(
  'fenced code with language',
  markdownToHtml('```ts\nconst a = 1\n```'),
  '<pre><code class="language-ts">const a = 1</code></pre>',
)
eq('fenced code without language', markdownToHtml('```\nplain\n```'), '<pre>plain</pre>')
check(
  'markdown inside code is left alone',
  markdownToHtml('```\n**not bold** <tag>\n```') === '<pre>**not bold** &lt;tag&gt;</pre>',
  markdownToHtml('```\n**not bold** <tag>\n```'),
)

// ---- links ----
eq(
  'link',
  markdownToHtml('[Anthropic](https://anthropic.com)'),
  '<a href="https://anthropic.com">Anthropic</a>',
)
check(
  'non-http scheme is defused',
  !markdownToHtml('[x](javascript:alert(1))').includes('<a '),
  markdownToHtml('[x](javascript:alert(1))'),
)

// ---- blockquotes ----
eq('short quote', markdownToHtml('> zitat').trim(), '<blockquote>zitat</blockquote>')
check(
  'long quote becomes expandable',
  markdownToHtml('> ' + 'x'.repeat(600)).includes('<blockquote expandable>'),
)

// ---- sentinel cannot be forged ----
check(
  'PUA sentinel in input cannot inject markup',
  !markdownToHtml('0 plain').includes('<pre>'),
  markdownToHtml('0 plain'),
)

// ---- chunking ----
{
  const html = markdownToHtml('```js\n' + 'console.log(1)\n'.repeat(400) + '```')
  const parts = chunkHtml(html, 4096, 'newline')
  check('long code block is split', parts.length > 1, `parts=${parts.length}`)
  check(
    'every chunk is within the limit',
    parts.every(p => p.length <= 4096),
    `max=${Math.max(...parts.map(p => p.length))}`,
  )
  check(
    'every chunk opens and closes <pre>',
    parts.every(p => (p.match(/<pre>/g)?.length ?? 0) === (p.match(/<\/pre>/g)?.length ?? 0)),
  )
  check(
    'every chunk balances <code>',
    parts.every(p => (p.match(/<code[ >]/g)?.length ?? 0) === (p.match(/<\/code>/g)?.length ?? 0)),
  )
  const rejoined = parts.join('').replace(/<\/pre><pre>/g, '').replace(/<\/code><code class="language-js">/g, '')
  check('content survives the round trip', rejoined.includes('console.log(1)'))
}

{
  const parts = chunkHtml('<b>' + 'a'.repeat(9000) + '</b>', 4096, 'length')
  check('bold across chunks stays balanced', parts.every(p => (p.match(/<b>/g)?.length ?? 0) === (p.match(/<\/b>/g)?.length ?? 0)), parts.map(p => p.length).join(','))
  check('all chunks within limit', parts.every(p => p.length <= 4096))
}

{
  // An entity must never be cut in half — "&am|p;" would render as literal text.
  const html = 'x'.repeat(4090) + '&amp;' + 'y'.repeat(100)
  const parts = chunkHtml(html, 4096, 'length')
  check(
    'html entity is never split',
    parts.every(p => !/&[a-z]{1,6}$/i.test(p) && !/^[a-z]{1,6};/i.test(p)),
    parts.map(p => p.slice(-8)).join(' | '),
  )
}

// ---- codeBlock helper ----
eq('codeBlock escapes', codeBlock('a < b', 'py'), '<pre><code class="language-py">a &lt; b</code></pre>')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
