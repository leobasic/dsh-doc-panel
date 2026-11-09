#!/usr/bin/env node
// host-favorites.test.mjs — verification of the favorites store pure helpers,
// route registration table and diag field in index.js.
//
// Usage: node test/host-favorites.test.mjs
// Exit code 0 = every hard check passed.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = path.resolve(HERE, '..', 'index.js')
const src = fs.readFileSync(INDEX_PATH, 'utf8')

const results = []
let sectionName = 'init'
const section = (name) => { sectionName = name; console.log(`\n# ${name}`) }
function check(name, fn) {
  try { fn(); results.push({ section: sectionName, name, ok: true }); console.log(`PASS  [${sectionName}] ${name}`) }
  catch (err) { results.push({ section: sectionName, name, ok: false, detail: err?.message ?? String(err) }); console.log(`FAIL  [${sectionName}] ${name} — ${err?.message ?? String(err)}`) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const report = (msg) => console.log(`REPORT ${msg}`)
const note = (msg) => console.log(`NOTE  ${msg}`)

const host = await import(pathToFileURL(INDEX_PATH).href)
const sanitizeFavorites = host.sanitizeFavorites
const toggleFavorite = host.toggleFavorite

const P = (p) => p.replace(/\//g, '\\') // pretend win32 path in fixture data
const fav = (p, name, addedAt, extra = {}) => ({ path: P(p), name, conversationId: 'c1', conversationTitle: 'Chat', addedAt, ...extra })

section('module exports')
check('sanitizeFavorites is a function', () => eq(typeof sanitizeFavorites, 'function', 'type'))
check('toggleFavorite is a function', () => eq(typeof toggleFavorite, 'function', 'type'))

section('sanitizeFavorites: defensive read side')
if (typeof sanitizeFavorites === 'function') {
  check('corrupted / partial stores sanitize to an empty list', () => {
    for (const raw of [null, undefined, 'garbage', 42, {}, { favorites: 'nope' }, { version: 2, favorites: [fav('D:/ws/a.md', 'a.md', 1)] }]) {
      const out = sanitizeFavorites(raw)
      assert(Array.isArray(out) && out.length === 0, `expected [] for ${JSON.stringify(raw)?.slice(0, 80)}, got ${JSON.stringify(out)}`)
    }
  })
  check('malformed entries are dropped one by one, valid entries survive', () => {
    const out = sanitizeFavorites({ version: 1, favorites: [null, 1, { name: 'no path' }, { path: 'relative.md', name: 'r' }, { path: P('D:/ws/ok.md'), name: 'ok.md', addedAt: 5 }] })
    eq(out.length, 1, 'survivor count')
    eq(out[0].name, 'ok.md', 'survivor name')
  })
  check('dedupe by case-insensitive slash-normalized path keeps the newest addedAt', () => {
    const out = sanitizeFavorites([
      fav('D:/ws/Doc.md', 'Doc.md', 10),
      fav('d:\\ws\\doc.md', 'doc.md', 20),
      fav('D:/ws/other.md', 'other.md', 15),
    ])
    eq(out.length, 2, 'deduped count')
    const doc = out.find((f) => /doc\.md/i.test(f.name))
    eq(doc.addedAt, 20, 'kept newest addedAt for the duplicate path')
  })
  check('bare array and {version:1,favorites} are both accepted', () => {
    eq(sanitizeFavorites([fav('D:/ws/a.md', 'a.md', 1)]).length, 1, 'bare array')
    eq(sanitizeFavorites({ version: 1, favorites: [fav('D:/ws/a.md', 'a.md', 1)] }).length, 1, 'store object')
  })
  check('1000-entry cap drops the oldest entries (sanitize path)', () => {
    const many = []
    for (let i = 0; i < 1005; i += 1) many.push(fav(`D:/ws/f${i}.md`, `f${i}.md`, 1000 + i))
    const out = sanitizeFavorites(many)
    eq(out.length, 1000, 'capped length')
    const keptAdded = new Set(out.map((f) => f.addedAt))
    for (const oldest of [1000, 1001, 1002, 1003, 1004]) assert(!keptAdded.has(oldest), `oldest entry addedAt=${oldest} should have been dropped`)
    report(`cap: 1005 entries -> ${out.length}; oldest 5 dropped`)
  })
}

section('toggleFavorite: add / remove / validation / cap')
if (typeof toggleFavorite === 'function') {
  check('empty path or empty name leaves the list untouched', () => {
    const current = [fav('D:/ws/a.md', 'a.md', 1)]
    for (const input of [{}, { path: '', name: 'x' }, { path: P('D:/ws/a.md'), name: '' }, { path: 'relative.md', name: 'r' }]) {
      const out = toggleFavorite(current, input, 100)
      eq(out.favorited, false, `favorited for ${JSON.stringify(input)}`)
      eq(out.favorites.length, 1, `length for ${JSON.stringify(input)}`)
    }
  })
  check('adds a new path with addedAt=now and favorited=true', () => {
    const out = toggleFavorite([], { path: P('D:/ws/new.md'), name: 'new.md', conversationId: 'c9', conversationTitle: 'Chat 9' }, 12345)
    eq(out.favorited, true, 'favorited')
    eq(out.favorites.length, 1, 'length')
    eq(out.favorites[0].addedAt, 12345, 'addedAt')
    eq(out.favorites[0].path, P('D:/ws/new.md'), 'path')
    eq(out.favorites[0].conversationId, 'c9', 'conversationId')
    report(`add: {path,name} -> favorited=true addedAt=${out.favorites[0].addedAt}`)
  })
  check('second toggle on the same path removes it (favorited=false)', () => {
    const added = toggleFavorite([], { path: P('D:/ws/x.md'), name: 'x.md' }, 1)
    const removed = toggleFavorite(added.favorites, { path: P('D:/ws/x.md'), name: 'x.md' }, 2)
    eq(removed.favorited, false, 'favorited')
    eq(removed.favorites.length, 0, 'length after second toggle')
    report('toggle twice: add favorited=true -> remove favorited=false')
  })
  check('removes an existing path matched case-insensitively', () => {
    const out = toggleFavorite([fav('D:/ws/Doc.md', 'Doc.md', 5)], { path: 'd:\\ws\\doc.md', name: 'doc.md' }, 6)
    eq(out.favorited, false, 'favorited')
    eq(out.favorites.length, 0, 'length')
  })
  check('adding beyond the 1000 cap drops the oldest entry and keeps the new one', () => {
    const current = []
    for (let i = 0; i < 1000; i += 1) current.push(fav(`D:/ws/f${i}.md`, `f${i}.md`, 1000 + i))
    const out = toggleFavorite(current, { path: P('D:/ws/brand-new.md'), name: 'brand-new.md' }, 5000)
    eq(out.favorited, true, 'favorited')
    eq(out.favorites.length, 1000, 'capped length')
    const paths = out.favorites.map((f) => f.path.toLowerCase())
    assert(paths.some((p) => p.endsWith('brand-new.md')), 'new entry must be kept')
    assert(!paths.some((p) => p.endsWith('f0.md')), 'oldest entry (addedAt=1000) must be dropped')
  })
  check('pure helper preserves store order; the route enrichment supplies newest-first ordering', () => {
    const out = toggleFavorite([], { path: P('D:/ws/n.md'), name: 'n.md' }, 1)
    eq(out.favorites.length, 1, 'order sanity')
    // enrichFavorites is the route-side ordering owner: addedAt desc.
    assert(/function enrichFavorites\(cache, favorites\)/.test(src), 'enrichFavorites missing')
    assert(/list\.sort\(\(left, right\) => \{\s*if \(right\.addedAt !== left\.addedAt\) return right\.addedAt - left\.addedAt/.test(src),
      'enrichFavorites must sort newest-first by addedAt')
    note('sanitizeFavorites/toggleFavorite keep store order (documented); enrichFavorites sorts responses newest-first')
  })
}

section('routes + diag registration (static)')
check('favorites list route registered as POST with buffered body', () => {
  assert(/path: '\/api\/dsh-doc-panel\/favorites',\s*methods: \['POST'\],\s*requestBody: 'buffered'/.test(src),
    'favorites route entry not found in the registration table')
  assert(/fetch: guarded\(handleFavorites\)/.test(src), 'favorites route not guarded')
})
check('favorites toggle route registered as POST with buffered body', () => {
  assert(/path: '\/api\/dsh-doc-panel\/favorites\/toggle',\s*methods: \['POST'\],\s*requestBody: 'buffered'/.test(src),
    'favorites/toggle route entry not found in the registration table')
  assert(/fetch: guarded\(handleFavoritesToggle\)/.test(src), 'toggle route not guarded')
})
check('diag carries a favorites field', () => {
  assert(/function favoritesDiag\(/.test(src), 'favoritesDiag helper missing')
  assert(/diag: \{ \.\.\.cache\.diag, favorites: favoritesDiag\(\) \}/.test(src), 'list response diag must include favorites')
  assert(/return jsonOk\(\{ \.\.\.diag, favorites: favoritesDiag\(\) \}\)/.test(src), '/diag route must include favorites')
  assert(/version: FAVORITES_VERSION/.test(src) && /favorites: list/.test(src), 'favorites store persistence shape missing')
})
check('favorites store path is independent of the index cache path', () => {
  assert(/function resolveFavoritesPath\(/.test(src), 'resolveFavoritesPath missing')
  assert(/favorites\.json/.test(src), 'favorites file name missing')
})

const failed = results.filter((r) => !r.ok)
const summary = {
  indexBytes: src.length,
  checks: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed.map((r) => `${r.section}: ${r.name} — ${r.detail}`),
}
console.log('\nHOST_FAVORITES_SUMMARY ' + JSON.stringify(summary))
process.exitCode = failed.length ? 1 : 0
