#!/usr/bin/env node
// client-render.test.mjs — focused verification of the Markdown/HTML render fix.
//
// Loads client.js with the same loader-stub approach the live bundle uses
// (fake window.__ModuleLoader__, fake require('react'), fake ctx), then exercises
// the plugin's exported pure renderer `__renderMarkdown(text, h)` with a stub
// h() that records an element tree. Static/grep checks cover the sandboxed HTML
// preview, the api/dsh-doc-panel/file?p= src helper, the md/html-only render/source
// toggle, locale parity, forbidden DOM/API patterns and slot registrations.
//
// Usage: node test/client-render.test.mjs
// Exit code 0 = every hard check passed.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.resolve(HERE, '..', 'client.js')

const results = []
let sectionName = 'init'
const section = (name) => { sectionName = name; console.log(`\n# ${name}`) }
function check(name, fn) {
  try {
    fn()
    results.push({ section: sectionName, name, ok: true })
    console.log(`PASS  [${sectionName}] ${name}`)
  } catch (err) {
    results.push({ section: sectionName, name, ok: false, detail: err?.message ?? String(err) })
    console.log(`FAIL  [${sectionName}] ${name} — ${err?.message ?? String(err)}`)
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const note = (msg) => console.log(`NOTE  ${msg}`)
const report = (msg) => console.log(`REPORT ${msg}`)

const src = fs.readFileSync(CLIENT_PATH, 'utf8')
const lineOf = (needle) => src.slice(0, src.indexOf(needle)).split('\n').length

// ---------------------------------------------------------------- load client
section('module load')
let plugin = null
let captured = null
let loadError = null
try {
  globalThis.window = { __ModuleLoader__: { load(opts) { captured = opts } } }
  await import(pathToFileURL(CLIENT_PATH).href)
} catch (err) {
  loadError = err
}
check('client.js loads under the plugin loader', () => {
  if (loadError) throw loadError
  assert(captured && typeof captured.factory === 'function', '__ModuleLoader__.load called with a factory')
  eq(captured.id, 'dsh-doc-panel', 'loader id')
})

const React = {
  createElement: (type, props, ...children) => ({ type: String(type), props: props ?? {}, children }),
  Fragment: 'Fragment',
  memo: (c) => c,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (v) => ({ current: v }),
  useReducer: (r, init) => [init, () => {}],
}
const stubRequire = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(id)})`)
}

// ------------------------------------------------------- fake ctx + apply()
const registrations = []
const injections = []
const dictionaries = {}
const effects = []
const ctx = {
  effect(fn, label) { effects.push({ label, fn }); const d = fn(); return d },
  slots: {
    inject(name, fn) { injections.push({ name, fn }); return () => {} },
    register(def, component) { registrations.push({ def, component }); return () => { registrations.pop(); return true } },
  },
  locale: {
    register(ns, dict) { dictionaries[ns] = dict; return () => { delete dictionaries[ns] } },
    bind(ns) { return (key) => key },
  },
}
try {
  plugin = captured.factory(stubRequire)
  plugin.apply(ctx)
  for (const { fn } of injections) fn()
} catch (err) {
  loadError = err
}
const renderMarkdown = plugin?.__renderMarkdown
check('apply(ctx) runs and exposes __renderMarkdown', () => {
  if (loadError) throw loadError
  eq(typeof renderMarkdown, 'function', 'plugin.__renderMarkdown')
})

// ------------------------------------------------------------------ tree utils
function record(text) {
  // Wraps h so the returned tree keeps keys/props but is JSON-serialisable.
  // Inline children arrive as arrays (React flattens them); flatten here too.
  const flatten = (values) => values.flatMap((v) => (Array.isArray(v) ? flatten(v) : [v]))
  const h = (type, props, ...children) => ({ type: String(type), props: sanitise(props), children: flatten(children).map(normalise) })
  const sanitise = (props) => {
    if (!props) return {}
    const out = {}
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === 'function') out[k] = '[fn]'
      else if (v === undefined || v === null) continue
      else out[k] = v
    }
    return out
  }
  const normalise = (v) => {
    if (typeof v === 'string' || typeof v === 'number') return String(v)
    if (v && typeof v === 'object') {
      if (typeof v.type === 'string') return { type: v.type, props: sanitise(v.props), children: flatten(v.children ?? []).map(normalise) }
      return '[object]'
    }
    return null
  }
  return normalise(renderMarkdown(text, h))
}
function allNodes(node, acc = []) {
  if (node && typeof node === 'object' && typeof node.type === 'string') acc.push(node)
  for (const child of (node && node.children) || []) allNodes(child, acc)
  return acc
}
function findAll(tree, type) { return allNodes(tree).filter((n) => n.type === type) }
function textOf(node) {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}
const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------- renderer tests
section('renderer: block constructs')
if (typeof renderMarkdown === 'function') {
  check('h1 and h2 headings render as h1/h2', () => {
    const tree = record('# Title\n\n## Subtitle')
    eq(findAll(tree, 'h1').length, 1, 'h1 count')
    eq(findAll(tree, 'h2').length, 1, 'h2 count')
    eq(norm(textOf(findAll(tree, 'h1')[0])), 'Title', 'h1 text')
    eq(norm(textOf(findAll(tree, 'h2')[0])), 'Subtitle', 'h2 text')
    report('heading mapping: "# Title" -> h1[Title]; "## Subtitle" -> h2[Subtitle]')
  })
  check('fenced code block becomes pre > code with a language class', () => {
    const tree = record('```js\nconst a = 1\n```')
    const pre = findAll(tree, 'pre')
    eq(pre.length, 1, 'pre count')
    const code = findAll(tree, 'code')
    eq(code.length, 1, 'code count')
    assert(code[0].props.className.includes('language-js'), `language class missing: ${JSON.stringify(code[0].props.className)}`)
    eq(norm(textOf(code[0])), 'const a = 1', 'code text')
    report(`fenced code mapping: pre>code className=${JSON.stringify(code[0].props.className)} text=${JSON.stringify(norm(textOf(code[0])))}`)
  })
  check('nested unordered list keeps ul > li > ul structure', () => {
    const tree = record('- a\n  - a1\n  - a2\n- b')
    const lists = findAll(tree, 'ul')
    eq(lists.length, 2, 'nested ul count')
    const outer = lists.find((n) => n.children.some((c) => c && c.type === 'li'))
    assert(outer, 'no outer ul')
    eq(outer.children.filter((c) => c && c.type === 'li').length, 2, 'outer li count')
    const inner = outer.children.find((c) => c && c.type === 'li' && (c.children || []).some((g) => g && g.type === 'ul'))
    assert(inner, 'no nested ul inside first li')
    eq(inner.children.find((g) => g && g.type === 'ul').children.length, 2, 'inner li count')
    report('nested list mapping: 2 x ul, outer li=2, inner li=2')
  })
  check('ordered list becomes ol > li', () => {
    const tree = record('1. one\n2. two')
    const ol = findAll(tree, 'ol')
    eq(ol.length, 1, 'ol count')
    eq(ol[0].children.filter((c) => c && c.type === 'li').length, 2, 'li count')
    report('ordered list mapping: ol > li x2')
  })
  check('blockquote wraps parsed block content', () => {
    const tree = record('> quoted text')
    const quote = findAll(tree, 'blockquote')
    eq(quote.length, 1, 'blockquote count')
    assert(norm(textOf(quote[0])).includes('quoted text'), 'blockquote text missing')
    report('blockquote mapping: blockquote > (p) "quoted text"')
  })
  check('horizontal rule renders as hr', () => {
    const tree = record('---')
    eq(findAll(tree, 'hr').length, 1, 'hr count')
  })
  check('GFM table renders thead/tbody with correct th/td counts', () => {
    const tree = record('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    const table = findAll(tree, 'table')
    eq(table.length, 1, 'table count')
    const thead = findAll(table[0], 'thead')
    const tbody = findAll(table[0], 'tbody')
    eq(thead.length, 1, 'thead count')
    eq(tbody.length, 1, 'tbody count')
    const ths = findAll(thead[0], 'th')
    const tds = findAll(tbody[0], 'td')
    eq(ths.length, 2, 'th count')
    eq(tds.length, 4, 'td count')
    eq(tbody[0].children.filter((c) => c && c.type === 'tr').length, 2, 'body row count')
    report('table mapping: table>thead(tr>th x2)+tbody(tr x2>td x4)')
  })
}

section('renderer: inline constructs')
if (typeof renderMarkdown === 'function') {
  check('strong / em / del / inline code render as elements', () => {
    const tree = record('**bold** *italic* ~~gone~~ `inline`')
    eq(findAll(tree, 'strong').length, 1, 'strong count')
    eq(findAll(tree, 'em').length, 1, 'em count')
    eq(findAll(tree, 'del').length, 1, 'del count')
    eq(findAll(tree, 'code').length, 1, 'inline code count')
    eq(norm(textOf(findAll(tree, 'strong')[0])), 'bold', 'strong text')
    eq(norm(textOf(findAll(tree, 'em')[0])), 'italic', 'em text')
    eq(norm(textOf(findAll(tree, 'del')[0])), 'gone', 'del text')
    eq(norm(textOf(findAll(tree, 'code')[0])), 'inline', 'code text')
    report('inline mapping: **x**->strong, *x*->em, ~~x~~->del, `x`->code')
  })
  check('link gets href + target=_blank + rel', () => {
    const tree = record('[docs](https://example.com/x)')
    const links = findAll(tree, 'a')
    eq(links.length, 1, 'a count')
    eq(links[0].props.href, 'https://example.com/x', 'href')
    eq(links[0].props.target, '_blank', 'target')
    assert(typeof links[0].props.rel === 'string' && /noreferrer|noopener/.test(links[0].props.rel), `rel=${JSON.stringify(links[0].props.rel)}`)
    eq(norm(textOf(links[0])), 'docs', 'link text')
    report(`link mapping: a href=${JSON.stringify(links[0].props.href)} target=${JSON.stringify(links[0].props.target)} rel=${JSON.stringify(links[0].props.rel)}`)
  })
  check('unsafe javascript: link is rendered without an href', () => {
    const tree = record('[x](javascript:alert(1))')
    eq(findAll(tree, 'a').length, 0, 'no anchor for javascript: URL')
  })
}

section('renderer: safety, images, robustness')
if (typeof renderMarkdown === 'function') {
  check('raw <script> in markdown stays text and no script element exists', () => {
    const tree = record('# X\n\n<script>alert(1)</script>')
    eq(findAll(tree, 'script').length, 0, 'script element count')
    const text = textOf(tree)
    assert(text.includes('<script>alert(1)</script>'), `raw HTML not preserved as text: ${JSON.stringify(text)}`)
    report('raw HTML mapping: "<script>alert(1)</script>" -> text child only')
  })
  check('absolute Windows image path resolves to the api raw-file route', () => {
    const abs = 'C:\\pics\\shot.png'
    const tree = record(`![shot](${abs})`)
    const imgs = findAll(tree, 'img')
    eq(imgs.length, 1, 'img count')
    const srcValue = imgs[0].props.src
    assert(typeof srcValue === 'string' && srcValue.startsWith('api/dsh-doc-panel/file?p='), `src=${JSON.stringify(srcValue)}`)
    assert(srcValue.includes(encodeURIComponent(abs)), 'src must encode the absolute document path')
    eq(imgs[0].props.alt, 'shot', 'alt')
    report(`image mapping: img src=${JSON.stringify(srcValue)}`)
  })
  check('relative image does not render an img with a relative src', () => {
    const tree = record('![alt](images/x.png)')
    eq(findAll(tree, 'img').length, 0, 'img count for relative src')
    const text = textOf(tree)
    assert(text.includes('alt'), `alt text fallback missing: ${JSON.stringify(text)}`)
    report('relative image mapping: no img, alt text fallback "alt"')
  })
  check('empty string / plain text do not throw and stay text', () => {
    const empty = record('')
    eq(empty.type, 'div', 'empty root type')
    eq(textOf(empty), '', 'empty text')
    const plain = record('just plain text')
    assert(textOf(plain).includes('just plain text'), 'plain text lost')
  })
  check('two runs produce identical recorded trees (determinism)', () => {
    const sample = '# H\n\n**b** [l](https://e.com) `c`\n\n- a\n  - b\n\n```js\nx\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'
    eq(JSON.stringify(record(sample)), JSON.stringify(record(sample)), 'renderer output')
  })
}

// ------------------------------------------------------------ static / grep checks
section('static: sandboxed HTML preview + raw route')
check('sandbox attribute includes allow-scripts and excludes allow-same-origin', () => {
  const sandboxValues = [...src.matchAll(/sandbox\s*:\s*'([^']*)'/g)].map((m) => m[1])
  assert(sandboxValues.length > 0, 'no sandbox attribute literal found')
  for (const value of sandboxValues) {
    assert(value.split(/\s+/).includes('allow-scripts'), `sandbox missing allow-scripts: ${JSON.stringify(value)}`)
    assert(!value.includes('allow-same-origin'), `sandbox must not include allow-same-origin: ${JSON.stringify(value)}`)
  }
  assert(!/allow-same-origin/.test(src), 'source mentions allow-same-origin')
  report(`iframe sandbox value(s): ${JSON.stringify(sandboxValues)}`)
})
check('iframe src helper builds api/dsh-doc-panel/file?p= from the document path', () => {
  assert(/function fileUrlForPath\(filePath\)/.test(src), 'fileUrlForPath helper missing')
  assert(/'api\/dsh-doc-panel\/file\?p='\s*\+\s*encodeURIComponent\(path\)/.test(src), 'fileUrlForPath must build the encoded raw route')
  assert(/function htmlFrameSrc\(doc\)\s*\{\s*return rawFileUrl\(doc\)/.test(src) || /htmlFrameSrc\(doc\)/.test(src), 'htmlFrameSrc helper missing')
  assert(/src:\s*htmlFrameSrc\(doc\)/.test(src), 'HTML iframe must use htmlFrameSrc(doc)')
  assert(/src:\s*rawUrl/.test(src), 'PDF iframe must use the raw url')
})
check('md + html only get the render/source toggle; locale keys exist in zh+en', () => {
  assert(/const toggleable = kind === 'md' \|\| kind === 'html'/.test(src), 'toggle must be limited to md/html')
  assert(/switchPreviewMode\('render'\)/.test(src), 'render mode switch missing')
  assert(/switchPreviewMode\('source'\)/.test(src), 'source mode switch missing')
  const dict = dictionaries['dsh-doc-panel']
  assert(dict && dict.zh && dict.en, 'locale dictionaries not registered')
  for (const key of ['preview.render', 'preview.source', 'preview.modeAria']) {
    assert(typeof dict.zh[key] === 'string' && dict.zh[key] !== '', `zh missing ${key}`)
    assert(typeof dict.en[key] === 'string' && dict.en[key] !== '', `en missing ${key}`)
    report(`locale ${key}: zh=${JSON.stringify(dict.zh[key])} en=${JSON.stringify(dict.en[key])}`)
  }
  const zhKeys = new Set(Object.keys(dict.zh))
  const enKeys = new Set(Object.keys(dict.en))
  const missing = [...zhKeys].filter((k) => !enKeys.has(k)).concat([...enKeys].filter((k) => !zhKeys.has(k)))
  eq(missing.length, 0, `zh/en parity gaps: ${JSON.stringify(missing)}`)
  assert(zhKeys.size >= 50, `only ${zhKeys.size} locale keys`)
  report(`locale parity: ${zhKeys.size} keys in both zh/en`)
})
check('markdown preview path renders with renderMarkdown (no HTML string injection)', () => {
  assert(/renderMarkdown\(value\.text, h\)/.test(src), 'markdown preview must call renderMarkdown')
  assert(/kind === 'html' && mode === 'render'/.test(src), 'HTML render branch missing')
  assert(/kind === 'md' && mode === 'render'/.test(src), 'Markdown render branch missing')
})
check('forbidden DOM/API patterns absent', () => {
  for (const [name, re] of [
    ['document.body', /\bdocument\.body\b/],
    ['innerHTML', /\.innerHTML\b/],
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
    ['setInterval', /\bsetInterval\s*\(/],
  ]) assert(!re.test(src), `${name} found`)
})
check('no literal colors outside the sidebar SVG artwork', () => {
  const hits = [...src.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g)]
  const outside = hits.filter((m) => {
    const ctxText = src.slice(Math.max(0, m.index - 400), m.index + 200)
    return !/<svg[\s\S]*$/i.test(ctxText)
  })
  eq(outside.length, 0, `literal colors: ${JSON.stringify(outside.slice(0, 5).map((m) => m[0]))}`)
})

section('static: slot registrations unchanged')
check('apply() registers exactly one sidebar.panellist entry {id dsh-doc-panel, order 30} and one main key', () => {
  eq(registrations.length, 2, 'registration count')
  const sidebar = registrations.filter((r) => r.def?.name === 'sidebar.panellist')
  const main = registrations.filter((r) => r.def?.name === 'main')
  eq(sidebar.length, 1, 'sidebar.panellist registration count')
  eq(main.length, 1, 'main registration count')
  eq(sidebar[0].def.id, 'dsh-doc-panel', 'sidebar id')
  eq(sidebar[0].def.order, 30, 'sidebar order')
  eq(sidebar[0].def.locale, 'dsh-doc-panel', 'sidebar locale')
  eq(main[0].def.key, 'dsh-doc-panel', 'main key')
  eq(typeof sidebar[0].component, 'function', 'sidebar icon component')
  eq(typeof main[0].component, 'function', 'main panel component')
  eq(effects.length, 1, 'ctx.effect count (locale)')
  report('registrations: sidebar.panellist{id dsh-doc-panel, order 30, locale dsh-doc-panel}, main{key dsh-doc-panel}')
})

// ------------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok)
const summary = {
  clientPath: CLIENT_PATH,
  bytes: src.length,
  lines: src.split('\n').length,
  checks: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed.map((r) => `${r.section}: ${r.name} — ${r.detail}`),
}
console.log('\nCLIENT_RENDER_SUMMARY ' + JSON.stringify(summary))
process.exitCode = failed.length ? 1 : 0
