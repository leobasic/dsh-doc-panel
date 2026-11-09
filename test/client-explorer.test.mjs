#!/usr/bin/env node
// client-explorer.test.mjs — offline stub-render smoke for the dashboard UI.
//
// Mounts the captured `main` slot component with a synchronous React-hook stub and a
// fake same-origin fetch (no DOM, no browser, no network), then verifies the dashboard
// structure and the behavioural invariants: KPI values, left cards (favorites / type
// donut + legend / recent list), conversation card grid, folder table, star toggle,
// unavailable favorites, type filter, sort, search, md/html preview and degraded
// favorites. A final section audits styles/locale/classes statically.
//
// Usage: node test/client-explorer.test.mjs
// Exit code 0 = every hard check passed.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.resolve(HERE, '..', 'client.js')
const src = fs.readFileSync(CLIENT_PATH, 'utf8')

const results = []
let sectionName = 'init'
const section = (name) => { sectionName = name; console.log(`\n# ${name}`) }
function check(name, fn) {
  try { fn(); results.push({ section: sectionName, name, ok: true }); console.log(`PASS  [${sectionName}] ${name}`) }
  catch (err) { results.push({ section: sectionName, name, ok: false, detail: err?.message ?? String(err) }); console.log(`FAIL  [${sectionName}] ${name} — ${err?.message ?? String(err)}`) }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ section: sectionName, name, ok: true }); console.log(`PASS  [${sectionName}] ${name}`) }
  catch (err) { results.push({ section: sectionName, name, ok: false, detail: err?.message ?? String(err) }); console.log(`FAIL  [${sectionName}] ${name} — ${err?.message ?? String(err)}`) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const report = (msg) => console.log(`REPORT ${msg}`)
const note = (msg) => console.log(`NOTE  ${msg}`)

// ---------------------------------------------------------------- stub React
let hookIndex = 0
let dirty = false
const pendingEffects = []
let stateSlots = []
let refSlots = []
let memoSlots = []
let callbackSlots = []
let effectSlots = []
function resetHarness() {
  stateSlots = []; refSlots = []; memoSlots = []; callbackSlots = []; effectSlots = []
  pendingEffects.length = 0
  hookIndex = 0; dirty = false
}
function depsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}
const flatten = (values) => values.flatMap((v) => (Array.isArray(v) ? flatten(v) : [v]))
const React = {
  Fragment: 'Fragment',
  memo: (c) => c,
  createElement(type, props, ...children) {
    // Render function components inline so DonutChart/Sparkline/icon subtrees appear.
    if (typeof type === 'function') return type(props || {})
    return { type: String(type), props: props || {}, children: flatten(children) }
  },
  useState(init) {
    const i = hookIndex++
    if (!(i in stateSlots)) stateSlots[i] = typeof init === 'function' ? init() : init
    const set = (value) => {
      const next = typeof value === 'function' ? value(stateSlots[i]) : value
      if (!Object.is(next, stateSlots[i])) { stateSlots[i] = next; dirty = true }
    }
    return [stateSlots[i], set]
  },
  useRef(init) {
    const i = hookIndex++
    if (!(i in refSlots)) refSlots[i] = { current: typeof init === 'function' ? init() : init }
    return refSlots[i]
  },
  useMemo(fn, deps) {
    const i = hookIndex++
    const prev = memoSlots[i]
    if (!prev || !depsEqual(prev.deps, deps)) memoSlots[i] = { deps, value: fn() }
    return memoSlots[i].value
  },
  useCallback(fn, deps) {
    const i = hookIndex++
    const prev = callbackSlots[i]
    if (!prev || !depsEqual(prev.deps, deps)) callbackSlots[i] = { deps, value: fn }
    return callbackSlots[i].value
  },
  useEffect(fn, deps) {
    const i = hookIndex++
    const prev = effectSlots[i]
    if (!prev || !depsEqual(prev.deps, deps)) pendingEffects.push({ i, fn, deps })
  },
}
function runEffects() {
  const queued = pendingEffects.splice(0)
  for (const { i, fn, deps } of queued) {
    const prev = effectSlots[i]
    if (prev && typeof prev.cleanup === 'function') { try { prev.cleanup() } catch { /* ignore */ } }
    effectSlots[i] = { deps, cleanup: fn() }
  }
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)) }

// ------------------------------------------------------- fake fetch + data
const now = Date.now()
const H = 3600000
const fakeDocs = {
  a: [
    { path: 'D:\\ws\\report.md', relPath: 'report.md', name: 'report.md', ext: '.md', kind: 'md', size: 2560, mtime: now - 2 * H, delivered: true },
    { path: 'D:\\ws\\board.html', relPath: 'board.html', name: 'board.html', ext: '.html', kind: 'html', size: 4096, mtime: now - 3 * H, delivered: false },
  ],
  b: [
    { path: 'D:\\ws\\危大报告.docx', relPath: '危大报告.docx', name: '危大报告.docx', ext: '.docx', kind: 'docx', size: 10240, mtime: now - 26 * H, delivered: false },
    { path: 'D:\\ws\\规范.pdf', relPath: '规范.pdf', name: '规范.pdf', ext: '.pdf', kind: 'pdf', size: 20480, mtime: now - 10 * 86400000, delivered: false },
  ],
  c: [
    { path: 'D:\\ws\\notes.md', relPath: 'notes.md', name: 'notes.md', ext: '.md', kind: 'md', size: 512, mtime: now - 60000, delivered: false },
  ],
}
const FAV_REPORT = { path: 'D:\\ws\\report.md', name: 'report.md', conversationId: 'conv-a', conversationTitle: 'A股复盘', addedAt: now - 1000, available: true, kind: 'md', size: 2560, mtime: now - 2 * H }
const FAV_MISSING = { path: 'D:\\ws\\missing.md', name: 'missing.md', conversationId: 'conv-x', conversationTitle: '旧会话', addedAt: now - 2000, available: false, kind: 'md', size: null, mtime: null }
const initialFavorites = [FAV_REPORT, FAV_MISSING]
let favoritesState = [...initialFavorites]
const fakeIndex = {
  generatedAt: now,
  conversations: [
    { id: 'conv-a', title: 'A股复盘', createdAt: now - 86400000, updatedAt: now - 1 * H, workspace: 'D:\\ws', sessionCount: 2, documents: fakeDocs.a },
    { id: 'conv-b', title: '危大工程审核', createdAt: now - 3 * 86400000, updatedAt: now - 26 * H, workspace: 'D:\\ws', sessionCount: 1, documents: fakeDocs.b },
    { id: 'conv-c', title: '其他会话', createdAt: now - 600000, updatedAt: now - 60000, workspace: 'D:\\ws', sessionCount: 1, documents: fakeDocs.c },
  ],
}
let fetchMode = 'normal'
let calls = []
const okResponse = (value) => Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, value }) })
const failResponse = (message) => Promise.resolve({ ok: false, status: 500, text: async () => JSON.stringify({ ok: false, error: { code: 'test/down', message } }) })
globalThis.fetch = (route, init = {}) => {
  let body = null
  try { body = JSON.parse(init.body || '{}') } catch { body = null }
  calls.push({ route, method: init.method, headers: init.headers, body })
  if (route === 'api/dsh-doc-panel/list') return okResponse(fakeIndex)
  if (route === 'api/dsh-doc-panel/favorites') return fetchMode === 'favorites-down' ? failResponse('favorites offline') : okResponse({ favorites: favoritesState })
  if (route === 'api/dsh-doc-panel/favorites/toggle') {
    const key = String(body && body.path).replace(/\\/g, '/').toLowerCase()
    const existing = favoritesState.findIndex((f) => f.path.replace(/\\/g, '/').toLowerCase() === key)
    let favorited
    if (existing >= 0) { favoritesState = favoritesState.filter((_, i) => i !== existing); favorited = false }
    else {
      favoritesState = [{ path: body.path, name: body.name, conversationId: body.conversationId, conversationTitle: body.conversationTitle, addedAt: Date.now(), available: true, kind: String(body.name).split('.').pop(), size: 100, mtime: now }, ...favoritesState]
      favorited = true
    }
    return okResponse({ favorites: [...favoritesState].sort((l, r) => r.addedAt - l.addedAt), favorited })
  }
  if (route === 'api/dsh-doc-panel/read') {
    const p = String(body && body.path)
    if (/\.md$/i.test(p)) return okResponse({ kind: 'text', text: '# Report heading\n\nBody text.', bytes: 30, truncated: false })
    return okResponse({ kind: 'text', text: '<html><body>raw</body></html>', bytes: 30, truncated: false })
  }
  return failResponse('unknown route')
}

// ---------------------------------------------------------------- load client
let plugin = null
let captured = null
const registrations = []
const injections = []
const dictionaries = {}
try {
  globalThis.window = { __ModuleLoader__: { load(opts) { captured = opts } } }
  await import(pathToFileURL(CLIENT_PATH).href)
  plugin = captured.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require(${id})`) })
  plugin.apply({
    effect(fn) { return fn() },
    slots: {
      inject(name, fn) { injections.push({ name, fn }); return () => {} },
      register(def, component) { registrations.push({ def, component }); return () => true },
    },
    locale: {
      register(ns, dict) { dictionaries[ns] = dict; return () => {} },
      bind(ns) { return (key) => (dictionaries[ns] && dictionaries[ns].zh && dictionaries[ns].zh[key]) || key },
    },
  })
  for (const { fn } of injections) fn()
} catch (err) {
  console.log(`FATAL: could not load/apply client.js: ${err.message}`)
  process.exit(1)
}
const zh = dictionaries['dsh-doc-panel']?.zh ?? {}
const en = dictionaries['dsh-doc-panel']?.en ?? {}
const Main = registrations.find((r) => r.def?.name === 'main')?.component

// ------------------------------------------------------------- tree helpers
const allNodes = (node, acc = []) => {
  if (node && typeof node === 'object' && typeof node.type === 'string') {
    acc.push(node)
    for (const child of node.children) allNodes(child, acc)
  }
  return acc
}
const classTokens = (node) => (node && typeof node.props?.className === 'string' ? node.props.className.split(/\s+/).filter(Boolean) : [])
const hasClass = (node, token) => classTokens(node).includes(token)
const findClass = (tree, token) => allNodes(tree).filter((n) => hasClass(n, token))
const findWithin = (node, token) => findClass(node, token)
const textOf = (node) => (typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.map(textOf).join('') : '')
const norm = (s) => String(s).replace(/\s+/g, ' ').trim()
const click = (node) => {
  assert(node, 'click target missing')
  assert(typeof node.props.onClick === 'function', `click target has no onClick (class=${classTokens(node).join('.') || node.type})`)
  node.props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} })
}
const change = (node, value) => {
  assert(node, 'change target missing')
  assert(typeof node.props.onChange === 'function', 'change target has no onChange')
  node.props.onChange({ target: { value } })
}
async function renderStable() {
  let last = null
  for (let pass = 0; pass < 40; pass += 1) {
    dirty = false
    hookIndex = 0
    pendingEffects.length = 0
    last = Main({})
    runEffects()
    await flush()
    if (!dirty && pendingEffects.length === 0) return last
  }
  throw new Error('component did not settle after 40 passes')
}
async function mountFresh(mode) {
  resetHarness()
  fetchMode = mode
  calls = []
  favoritesState = [...initialFavorites]
  return renderStable()
}

// ================================================================== assertions
section('dashboard: top bar + KPI row')
const tree = await mountFresh('normal')
check('dashboard renders without throwing', () => {
  assert(tree && tree.type === 'div', 'root element missing')
  assert(allNodes(tree).some((n) => hasClass(n, 'dsh-doc-panel__page')), 'page wrapper missing')
  const listCalls = calls.filter((c) => c.route === 'api/dsh-doc-panel/list')
  assert(listCalls.length >= 1 && listCalls[0].method === 'POST', 'list route not called')
  assert(calls.some((c) => c.route === 'api/dsh-doc-panel/favorites'), 'favorites route not called')
})
check('top bar has title, subtitle, search and 全部/收藏 segmented control', () => {
  const bar = findClass(tree, 'dsh-doc-panel__topbar')[0]
  assert(bar, 'topbar missing')
  const title = findWithin(bar, 'dsh-doc-panel__title')[0]
  eq(norm(textOf(title)), zh['nav.label'], 'topbar title')
  const subtitle = findWithin(bar, 'dsh-doc-panel__subtitle')[0]
  assert(subtitle && norm(textOf(subtitle)).includes('3') && norm(textOf(subtitle)).includes('5'), `subtitle: ${JSON.stringify(norm(textOf(subtitle)))}`)
  assert(findWithin(bar, 'dsh-doc-panel__search')[0], 'search input missing')
  const seg = findWithin(bar, 'dsh-doc-panel__segmented-btn')
  eq(seg.length, 2, 'segmented button count')
  eq(norm(textOf(seg[0])), zh['topbar.all'], 'segmented all label')
  eq(norm(textOf(seg[1])), zh['topbar.favorites'], 'segmented favorites label')
})
check('KPI row shows the four tiles with computed values and a 7-bar sparkline', () => {
  const tiles = findClass(tree, 'dsh-doc-panel__kpi')
  eq(tiles.length, 4, 'KPI tile count')
  const labels = tiles.map((t) => norm(textOf(findWithin(t, 'dsh-doc-panel__kpi-label')[0])))
  eq(JSON.stringify(labels), JSON.stringify([zh['kpi.conversations'], zh['kpi.documents'], zh['kpi.favorites'], zh['kpi.weekly']]), 'KPI labels')
  const values = tiles.map((t) => norm(textOf(findWithin(t, 'dsh-doc-panel__kpi-value')[0])))
  eq(JSON.stringify(values), JSON.stringify(['3', '5', '2', '4']), 'KPI values')
  const bars = findClass(tree, 'dsh-doc-panel__spark__bar')
  eq(bars.length, 7, 'sparkline bar count')
  assert(bars.every((b) => typeof b.props.style?.height === 'string' && !/NaN/.test(b.props.style.height)), 'sparkline bar height broken')
  report(`KPI labels=${JSON.stringify(labels)} values=${JSON.stringify(values)} sparkBars=${bars.length}`)
})
check('no NaN / undefined leaks into the rendered tree', () => {
  const bad = []
  const walk = (value) => {
    if (typeof value === 'string') { if (value.includes('NaN') || value.includes('undefined')) bad.push(value.slice(0, 60)); return }
    if (typeof value === 'number') { if (Number.isNaN(value)) bad.push('NaN number'); return }
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (value && typeof value === 'object') { Object.values(value).forEach(walk) }
  }
  walk(tree)
  eq(bad.length, 0, `suspicious values: ${JSON.stringify(bad.slice(0, 5))}`)
})

section('left column: favorites / document types / recently updated')
check('left column holds exactly the three expected cards', () => {
  const left = findClass(tree, 'dsh-doc-panel__left')[0]
  assert(left, 'left column missing')
  const cards = left.children.filter((c) => c && typeof c === 'object' && hasClass(c, 'dsh-doc-panel__card'))
  eq(cards.length, 3, 'left card count')
  eq(norm(textOf(findWithin(cards[0], 'dsh-doc-panel__card-title')[0])), zh['fav.title'], 'favorites card title')
  eq(norm(textOf(findWithin(cards[1], 'dsh-doc-panel__card-title')[0])), zh['left.types'], 'types card title')
  eq(norm(textOf(findWithin(cards[2], 'dsh-doc-panel__card-title')[0])), zh['left.recent'], 'recent card title')
})
check('favorites card lists its rows and a count pill', () => {
  const left = findClass(tree, 'dsh-doc-panel__left')[0]
  const favCard = left.children.find((c) => c && norm(textOf(findWithin(c, 'dsh-doc-panel__card-title')[0] || { children: [] })) === zh['fav.title'])
  const rows = findWithin(favCard, 'dsh-doc-panel__mini-row')
  eq(rows.length, 2, 'favorites mini row count')
  eq(norm(textOf(findWithin(favCard, 'dsh-doc-panel__pillcount')[0])), '2', 'favorites count pill')
  assert(norm(textOf(favCard)).includes('report.md'), 'favorite document name missing')
  assert(findWithin(favCard, 'dsh-doc-panel__card-link')[0], 'view-all link missing')
})
check('document-types card renders a donut with one segment per kind + legend rows', () => {
  const left = findClass(tree, 'dsh-doc-panel__left')[0]
  const typesCard = left.children.filter((c) => c && hasClass(c, 'dsh-doc-panel__card'))[1]
  const donut = findWithin(typesCard, 'dsh-doc-panel__donut')[0]
  assert(donut, 'donut missing')
  const svg = allNodes(donut).find((n) => n.type === 'svg')
  assert(svg, 'donut svg missing')
  const circles = allNodes(svg).filter((n) => n.type === 'circle')
  const segments = circles.filter((c) => typeof c.props.strokeDasharray === 'string')
  eq(segments.length, 4, 'donut segment count (md/html/docx/pdf)')
  eq(norm(textOf(findWithin(donut, 'dsh-doc-panel__donut__value')[0])), '5', 'donut center total')
  const legend = findClass(typesCard, 'dsh-doc-panel__legend-row')
  eq(legend.length, 4, 'legend row count')
  const legendNames = legend.map((r) => norm(textOf(findWithin(r, 'dsh-doc-panel__legend-name')[0])))
  eq(JSON.stringify(legendNames.slice().sort()), JSON.stringify([zh['type.docx'], zh['type.html'], zh['type.md'], zh['type.pdf']].sort()), 'legend names')
  const pcts = legend.map((r) => norm(textOf(findWithin(r, 'dsh-doc-panel__legend-pct')[0])))
  assert(pcts.every((p) => /^\d+%$/.test(p)), `legend percentages: ${JSON.stringify(pcts)}`)
  report(`donut segments=${segments.length} legend=${JSON.stringify(legendNames)} pct=${JSON.stringify(pcts)}`)
})
check('recently-updated card lists up to 5 documents newest first', () => {
  const left = findClass(tree, 'dsh-doc-panel__left')[0]
  const recentCard = left.children.filter((c) => c && hasClass(c, 'dsh-doc-panel__card'))[2]
  const rows = findWithin(recentCard, 'dsh-doc-panel__mini-row')
  eq(rows.length, 5, 'recent row count')
  assert(norm(textOf(rows[0])).includes('notes.md'), `newest recent row: ${JSON.stringify(norm(textOf(rows[0])))}`)
  assert(/(分钟前|小时前|天前|刚刚)/.test(norm(textOf(rows[0]))), 'recent row lacks relative time')
})

section('right column: conversation card grid')
check('conversation grid renders cards (not table rows) with title, time, workspace, stats, chips, footer', () => {
  const grid = findClass(tree, 'dsh-doc-panel__convgrid')[0]
  assert(grid, 'conversation grid missing')
  const cards = findClass(grid, 'dsh-doc-panel__convcard')
  eq(cards.length, 3, 'conversation card count')
  eq(findClass(grid, 'dsh-doc-panel__row--folder').length, 0, 'grid must not contain table rows')
  const cardA = cards.find((c) => norm(textOf(findWithin(c, 'dsh-doc-panel__convcard-title')[0] || { children: [] })) === 'A股复盘')
  assert(cardA, 'A股复盘 card missing')
  const time = findWithin(cardA, 'dsh-doc-panel__convcard-time')[0]
  assert(time && /(分钟前|小时前|天前|刚刚)/.test(norm(textOf(time))), `card relative time: ${JSON.stringify(norm(textOf(time || { children: [] })))}`)
  const pill = findWithin(cardA, 'dsh-doc-panel__workspace')[0]
  eq(norm(textOf(pill)), 'ws', 'workspace pill text')
  const stats = findWithin(cardA, 'dsh-doc-panel__statline').map((n) => norm(textOf(n)))
  eq(stats.length, 4, 'statline count')
  eq(stats[0], zh['conv.statDocs'] + '2', 'docs stat')
  eq(stats[1], zh['conv.statSize'] + '6.5 KB', 'size stat')
  eq(stats[2], zh['conv.statDelivered'] + '1', 'delivered stat')
  eq(stats[3], zh['conv.statTypes'] + '2', 'types stat')
  const chips = findWithin(cardA, 'dsh-doc-panel__chip')
  eq(chips.length, 2, 'type chip count for A')
  assert(norm(textOf(chips[0])).match(/^(HTML|MD) \d$/), 'chip text shape')
  const foot = norm(textOf(findWithin(cardA, 'dsh-doc-panel__convcard-foot')[0]))
  eq(foot, '最近 · report.md', 'card footer recent line')
  report(`card A stats=${JSON.stringify(stats)} chips=${JSON.stringify(chips.map((c) => norm(textOf(c))))} foot=${JSON.stringify(foot)}`)
})
check('default ordering is updatedAt desc', () => {
  const titles = findClass(tree, 'dsh-doc-panel__convcard').map((c) => norm(textOf(findWithin(c, 'dsh-doc-panel__convcard-title')[0])))
  eq(JSON.stringify(titles), JSON.stringify(['其他会话', 'A股复盘', '危大工程审核']), 'card order')
})

section('type filter chips + sort control')
await checkAsync('type filter chip narrows the grid and 全部 restores it', async () => {
  const chips = findClass(tree, 'dsh-doc-panel__filterchips')[0]
  assert(chips, 'filter chips row missing')
  const pdfChip = findWithin(chips, 'dsh-doc-panel__chip').find((c) => norm(textOf(c)).startsWith(zh['type.pdf']))
  assert(pdfChip, 'PDF filter chip missing')
  click(pdfChip)
  const filtered = await renderStable()
  const filteredCards = findClass(filtered, 'dsh-doc-panel__convcard')
  eq(filteredCards.length, 1, 'filtered card count')
  eq(norm(textOf(findWithin(filteredCards[0], 'dsh-doc-panel__convcard-title')[0])), '危大工程审核', 'filtered card title')
  const allChip = findWithin(findClass(filtered, 'dsh-doc-panel__filterchips')[0], 'dsh-doc-panel__chip').find((c) => norm(textOf(c)) === zh['topbar.all'])
  assert(allChip, 'all filter chip missing')
  click(allChip)
  const restored = await renderStable()
  eq(findClass(restored, 'dsh-doc-panel__convcard').length, 3, 'restored card count')
})
await checkAsync('sort control changes the card order', async () => {
  const base = await renderStable()
  const select = findClass(base, 'dsh-doc-panel__sort')[0]
  assert(select, 'sort select missing')
  change(select, 'count')
  const byCount = await renderStable()
  const titles = findClass(byCount, 'dsh-doc-panel__convcard').map((c) => norm(textOf(findWithin(c, 'dsh-doc-panel__convcard-title')[0])))
  eq(JSON.stringify(titles), JSON.stringify(['A股复盘', '危大工程审核', '其他会话']), 'count sort order')
  change(findClass(byCount, 'dsh-doc-panel__sort')[0], 'updated')
  const byUpdated = await renderStable()
  const restored = findClass(byUpdated, 'dsh-doc-panel__convcard').map((c) => norm(textOf(findWithin(c, 'dsh-doc-panel__convcard-title')[0])))
  eq(JSON.stringify(restored), JSON.stringify(['其他会话', 'A股复盘', '危大工程审核']), 'updated sort order')
  report(`sort count -> ${JSON.stringify(titles)}; updated -> ${JSON.stringify(restored)}`)
})

section('folder view: table, rows, star toggle')
let treeFolder = null
await checkAsync('clicking a conversation card opens the folder view with header and rows', async () => {
  const card = findClass(await renderStable(), 'dsh-doc-panel__convcard').find((c) => norm(textOf(findWithin(c, 'dsh-doc-panel__convcard-title')[0])) === 'A股复盘')
  click(card)
  treeFolder = await renderStable()
  const head = findClass(treeFolder, 'dsh-doc-panel__thead')[0]
  assert(head, 'folder table header missing')
  const labels = head.children.map((c) => norm(textOf(c)))
  for (const key of ['explorer.name', 'explorer.location', 'explorer.size', 'explorer.modified']) {
    assert(labels.includes(zh[key]), `header label ${key} (${zh[key]}) missing from ${JSON.stringify(labels)}`)
  }
  const rows = findClass(treeFolder, 'dsh-doc-panel__row--folder')
  eq(rows.length, 2, 'folder row count')
  const rowStars = rows.reduce((count, row) => count + findWithin(row, 'dsh-doc-panel__star').length, 0)
  eq(rowStars, 2, 'star button count in folder rows')
  report(`folder header=${JSON.stringify(labels)} rows=${rows.length}`)
})
check('existing favorite star is active; new one toggles via the exact route body', () => {
  const rows = findClass(treeFolder, 'dsh-doc-panel__row--folder')
  const reportRow = rows.find((r) => norm(textOf(r)).includes('report.md'))
  const boardRow = rows.find((r) => norm(textOf(r)).includes('board.html'))
  eq(findWithin(reportRow, 'dsh-doc-panel__star')[0].props['aria-pressed'], 'true', 'report.md favorited')
  eq(findWithin(boardRow, 'dsh-doc-panel__star')[0].props['aria-pressed'], 'false', 'board.html not favorited')
})
await checkAsync('star click POSTs the toggle route with the exact body and flips state', async () => {
  const boardRow = findClass(treeFolder, 'dsh-doc-panel__row--folder').find((r) => norm(textOf(r)).includes('board.html'))
  click(findWithin(boardRow, 'dsh-doc-panel__star')[0])
  const after = await renderStable()
  const toggleCalls = calls.filter((c) => c.route === 'api/dsh-doc-panel/favorites/toggle')
  eq(toggleCalls.length, 1, 'toggle call count')
  eq(toggleCalls[0].method, 'POST', 'toggle method')
  eq(toggleCalls[0].headers['content-type'], 'application/json', 'toggle content-type')
  eq(JSON.stringify(toggleCalls[0].body), JSON.stringify({ path: 'D:\\ws\\board.html', name: 'board.html', conversationId: 'conv-a', conversationTitle: 'A股复盘' }), 'toggle body')
  const updatedRow = findClass(after, 'dsh-doc-panel__row--folder').find((r) => norm(textOf(r)).includes('board.html'))
  eq(findWithin(updatedRow, 'dsh-doc-panel__star')[0].props['aria-pressed'], 'true', 'aria-pressed after add')
  report(`toggle POST body: ${JSON.stringify(toggleCalls[0].body)}`)
})

section('preview: markdown tree + HTML sandboxed iframe')
await checkAsync('md row renders a heading tree; html row renders the sandboxed iframe', async () => {
  const folder = await renderStable()
  const reportRow = findClass(folder, 'dsh-doc-panel__row--folder').find((r) => norm(textOf(r)).includes('report.md'))
  click(reportRow)
  const mdTree = await renderStable()
  const mdwrap = findClass(mdTree, 'dsh-doc-panel__mdwrap')[0]
  assert(mdwrap, 'md preview wrapper missing')
  const h1s = allNodes(mdwrap).filter((n) => n.type === 'h1')
  assert(h1s.length >= 1, 'no h1 in md preview')
  eq(norm(textOf(h1s[0])), 'Report heading', 'h1 text')
  const readCalls = calls.filter((c) => c.route === 'api/dsh-doc-panel/read')
  assert(readCalls.length >= 1 && readCalls[readCalls.length - 1].body.path === 'D:\\ws\\report.md', 'read route/body for md preview')
  const back = findClass(mdTree, 'dsh-doc-panel__back')[0]
  assert(back, 'preview back button missing')
  click(back)
  const backTree = await renderStable()
  const boardRow = findClass(backTree, 'dsh-doc-panel__row--folder').find((r) => norm(textOf(r)).includes('board.html'))
  click(boardRow)
  const htmlTree = await renderStable()
  const frames = allNodes(htmlTree).filter((n) => n.type === 'iframe')
  eq(frames.length, 1, 'iframe count')
  const sandbox = frames[0].props.sandbox
  assert(typeof sandbox === 'string' && sandbox.split(/\s+/).includes('allow-scripts'), `sandbox missing allow-scripts: ${JSON.stringify(sandbox)}`)
  assert(!String(sandbox).includes('allow-same-origin'), `sandbox must not include allow-same-origin: ${JSON.stringify(sandbox)}`)
  assert(String(frames[0].props.src).startsWith('api/dsh-doc-panel/file?p='), `iframe src=${JSON.stringify(frames[0].props.src)}`)
  report(`md h1=${JSON.stringify(norm(textOf(h1s[0])))}; iframe sandbox=${JSON.stringify(sandbox)}`)
})

section('favorites view + segmented tabs')
await checkAsync('收藏 tab shows available cards clickable and unavailable cards dimmed/not openable', async () => {
  const current = await renderStable()
  const back = findClass(current, 'dsh-doc-panel__back')[0]
  if (back) { click(back); await renderStable() }
  const folderBack = findClass(await renderStable(), 'dsh-doc-panel__back')[0]
  if (folderBack) { click(folderBack); await renderStable() }
  const seg = findClass(await renderStable(), 'dsh-doc-panel__segmented-btn')
  const favTab = seg.find((b) => norm(textOf(b)) === zh['topbar.favorites'])
  assert(favTab, '收藏 segmented tab missing')
  click(favTab)
  const favTree = await renderStable()
  const cards = findClass(favTree, 'dsh-doc-panel__doccard')
  eq(cards.length, 3, 'favorite doc card count (2 initial + board.html added by the star toggle)')
  const unavailable = cards.find((c) => hasClass(c, 'is-unavailable'))
  assert(unavailable, 'unavailable favorite card missing')
  eq(unavailable.props.onClick, undefined, 'unavailable favorite must not be openable')
  eq(unavailable.props.role, undefined, 'unavailable favorite must not be a button')
  assert(norm(textOf(unavailable)).includes(zh['fav.itemUnavailable']), 'unavailable note missing')
  const available = cards.find((c) => !hasClass(c, 'is-unavailable'))
  eq(typeof available.props.onClick, 'function', 'available favorite must be openable')
  const cardStars = cards.reduce((count, card) => count + findWithin(card, 'dsh-doc-panel__star').length, 0)
  eq(cardStars, 3, 'favorite card star count')
  report(`favorites cards=${cards.length} unavailable=${JSON.stringify(norm(textOf(unavailable)).slice(0, 60))}`)
  click(findClass(favTree, 'dsh-doc-panel__segmented-btn').find((b) => norm(textOf(b)) === zh['topbar.all']))
  eq(findClass(await renderStable(), 'dsh-doc-panel__convcard').length, 3, '全部 tab restores the grid')
})

section('search: cross-conversation results + restore')
await checkAsync('search renders rows with 所属对话 and clearing restores the grid', async () => {
  const input = findClass(await renderStable(), 'dsh-doc-panel__search')[0]
  assert(input, 'search input missing')
  change(input, 'md')
  const searchTree = await renderStable()
  const head = findClass(searchTree, 'dsh-doc-panel__thead')[0]
  assert(head, 'search table header missing')
  const labels = head.children.map((c) => norm(textOf(c)))
  assert(labels.includes(zh['explorer.conversation']), `所属对话 header missing from ${JSON.stringify(labels)}`)
  const rows = findClass(searchTree, 'dsh-doc-panel__row--fav')
  eq(rows.length, 2, 'search row count')
  const text = rows.map((r) => norm(textOf(r))).join(' | ')
  assert(text.includes('A股复盘') && text.includes('其他会话'), `search rows must span conversations: ${JSON.stringify(text.slice(0, 160))}`)
  change(findClass(searchTree, 'dsh-doc-panel__search')[0], '')
  const restored = await renderStable()
  eq(findClass(restored, 'dsh-doc-panel__convcard').length, 3, 'grid restored after clearing search')
  report(`search "md": ${rows.length} rows; header=${JSON.stringify(labels)}`)
})

section('degraded favorites: stars disabled, rest of the dashboard renders')
await checkAsync('favorites route failure disables stars and still renders the dashboard', async () => {
  const treeDown = await mountFresh('favorites-down')
  eq(findClass(treeDown, 'dsh-doc-panel__kpi').length, 4, 'KPI tiles render when favorites are down')
  const favKpi = findClass(treeDown, 'dsh-doc-panel__kpi')[2]
  eq(norm(textOf(findWithin(favKpi, 'dsh-doc-panel__kpi-value')[0])), '0', 'favorites KPI value')
  assert(norm(textOf(favKpi)).includes(zh['fav.unavailable']), 'favorites KPI sub should say unavailable')
  const left = findClass(treeDown, 'dsh-doc-panel__left')[0]
  const favCard = left.children.filter((c) => c && hasClass(c, 'dsh-doc-panel__card'))[0]
  assert(norm(textOf(favCard)).includes(zh['fav.unavailable']), 'favorites card should say unavailable')
  eq(findClass(treeDown, 'dsh-doc-panel__convcard').length, 3, 'conversation cards still render')
  const card = findClass(treeDown, 'dsh-doc-panel__convcard').find((c) => norm(textOf(findWithin(c, 'dsh-doc-panel__convcard-title')[0])) === 'A股复盘')
  click(card)
  const folder = await renderStable()
  const star = findClass(folder, 'dsh-doc-panel__star')[0]
  assert(star, 'row star missing in degraded mode')
  eq(star.props.disabled, true, 'star must be disabled when favorites are unavailable')
  eq(star.props.title, zh['fav.unavailable'], 'star title should say unavailable')
  report(`degraded favorites: KPI=0, stars disabled title=${JSON.stringify(star.props.title)}`)
})

section('static: style tokens, classes, locale, registrations')
{
  const cssStart = src.indexOf('const CSS = `')
  assert(cssStart !== -1, 'CSS template literal not found')
  const cssBodyStart = src.indexOf('`', cssStart) + 1
  const cssEnd = src.indexOf('`;', cssBodyStart)
  assert(cssEnd !== -1, 'CSS template literal end not found')
  const css = src.slice(cssBodyStart, cssEnd)

  check('CSS braces are balanced', () => {
    const open = (css.match(/\{/g) || []).length
    const close = (css.match(/\}/g) || []).length
    eq(open, close, `CSS braces ${open} open vs ${close} close`)
  })
  check('no literal hex/rgb/hsl colors outside artwork (tokens/color-mix only)', () => {
    const hits = [...src.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g)]
    eq(hits.length, 0, `literal colors: ${JSON.stringify(hits.slice(0, 5).map((m) => m[0]))}`)
  })
  check('forbidden DOM/API patterns absent', () => {
    for (const [name, re] of [['innerHTML', /\.innerHTML\b/], ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/], ['document.body', /\bdocument\.body\b/], ['setInterval', /\bsetInterval\s*\(/], ['allow-same-origin', /allow-same-origin/]]) {
      assert(!re.test(src), `${name} found`)
    }
  })
  check('every JSX class exists in the style block', () => {
    const referenced = new Map()
    for (const m of src.matchAll(/'([^']*dsh-doc-panel__[^']*)'/g)) {
      for (const token of m[1].split(/\s+/)) {
        if (token.startsWith('dsh-doc-panel__') && !token.endsWith('-')) referenced.set(token, true)
      }
    }
    const defined = new Set([...css.matchAll(/\.(dsh-doc-panel__[A-Za-z0-9_-]+)/g)].map((m) => m[1]))
    const allowedUnstyled = new Set(['dsh-doc-panel__cell--name']) // generic .__cell already covers it
    const missing = [...referenced.keys()].filter((token) => !defined.has(token) && !allowedUnstyled.has(token))
    eq(missing.length, 0, `JSX classes without CSS: ${JSON.stringify(missing.slice(0, 12))}`)
    const unstyled = [...referenced.keys()].filter((token) => !defined.has(token))
    report(`JSX class audit: ${referenced.size} referenced, ${defined.size} defined, ${missing.length} missing; intentionally unstyled: ${JSON.stringify(unstyled)}`)
  })
  check('modifier classes used by JSX are styled', () => {
    const modifiers = new Set()
    for (const m of src.matchAll(/'([^']*)'/g)) {
      for (const token of m[1].split(/\s+/)) if (/^is-[a-z-]+$/.test(token)) modifiers.add(token)
    }
    const missing = [...modifiers].filter((token) => !new RegExp('\\.' + token + '(?![a-z-])').test(css))
    eq(missing.length, 0, `modifier classes without CSS: ${JSON.stringify(missing)}`)
  })
  check('locale dictionary parity and every literal t()/tt() key resolves', () => {
    const zhKeys = new Set(Object.keys(zh))
    const enKeys = new Set(Object.keys(en))
    eq(zhKeys.size, enKeys.size, 'zh/en key count')
    const parityGaps = [...zhKeys].filter((k) => !enKeys.has(k)).concat([...enKeys].filter((k) => !zhKeys.has(k)))
    eq(parityGaps.length, 0, `parity gaps: ${JSON.stringify(parityGaps)}`)
    const used = new Set()
    for (const m of src.matchAll(/(?<![A-Za-z0-9_$])(?:t|tt)\(\s*'([A-Za-z0-9_.-]+)'\s*[,)]/g)) used.add(m[1])
    const unresolved = [...used].filter((k) => !zhKeys.has(k))
    eq(unresolved.length, 0, `unresolved locale keys: ${JSON.stringify(unresolved)}`)
    report(`locale: ${zhKeys.size} keys zh+en; ${used.size} literal keys referenced; no unresolved keys`)
  })
  check('registrations unchanged: one sidebar entry + one main panel', () => {
    eq(registrations.length, 2, 'registration count')
    const sidebar = registrations.filter((r) => r.def?.name === 'sidebar.panellist')
    const main = registrations.filter((r) => r.def?.name === 'main')
    eq(sidebar.length, 1, 'sidebar registration count')
    eq(main.length, 1, 'main registration count')
    eq(sidebar[0].def.id, 'dsh-doc-panel', 'sidebar id')
    eq(sidebar[0].def.order, 30, 'sidebar order')
    eq(main[0].def.key, 'dsh-doc-panel', 'main key')
  })
}

const failed = results.filter((r) => !r.ok)
const summary = {
  clientBytes: src.length,
  checks: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed.map((r) => `${r.section}: ${r.name} — ${r.detail}`),
}
console.log('\nCLIENT_EXPLORER_SUMMARY ' + JSON.stringify(summary))
process.exitCode = failed.length ? 1 : 0
