#!/usr/bin/env node
// host-scan.test.mjs — portable, deterministic tests for the dsh-doc-panel Host half.
//
// This test owns everything it needs: an inline synthetic session corpus (no real
// session logs, no test/fixture.json) and a temporary workspace created under
// os.tmpdir() with files written and mtimes pinned by the test. It therefore runs on a
// clean checkout, on any machine, and never reads or writes the author's data.
//
// Coverage:
//   * extractSessionSignals unit cases (titles, turn windows, write/present/medium
//     refs, relative paths, ignore rules, malformed JSON)
//   * normalizeDocKind extension mapping
//   * collectWorkspaceFiles (skip dirs, dot/underscore files, depth, maxFiles,
//     config.extensions)
//   * buildIndex attribution tiers (strong / medium / turn-window / session-window /
//     unattributed), dedupe by normalized path, child-session folding, conversation
//     and document counts, sorting, counts.byKind, determinism
//
// Usage: node test/host-scan.test.mjs
// Exit code 0 = every hard check passed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = path.resolve(HERE, '..', 'index.js')

// Fixed clock base: deterministic mtimes and turn windows, independent of "now".
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)
const NOW = T0 + 2000000
const IS_WIN = process.platform === 'win32'
const DOC_EXT = new Set(['.md', '.markdown', '.html', '.htm', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'])
const OPTIONAL_EXT = ['.csv', '.txt']
const ALLOWED_EXT = new Set([...DOC_EXT, ...OPTIONAL_EXT])
const SKIP_DIRS = new Set(['node_modules', '.git', '.agents', '.claude', '.venv', 'venv', '__pycache__', 'dist', 'build', '.dsh-doc-panel'])
const KIND_BY_EXT = {
  '.md': 'md', '.markdown': 'md', '.html': 'html', '.htm': 'html', '.pdf': 'pdf',
  '.docx': 'docx', '.doc': 'docx', '.xlsx': 'xlsx', '.xls': 'xlsx',
  '.pptx': 'pptx', '.ppt': 'pptx', '.csv': 'csv', '.txt': 'txt',
}

const results = []
let sectionName = 'init'
const section = (name) => { sectionName = name; console.log(`\n# ${name}`) }
function check(name, fn) {
  try { fn(); results.push({ section: sectionName, name, ok: true }); console.log(`PASS  [${sectionName}] ${name}`) }
  catch (err) { results.push({ section: sectionName, name, ok: false, detail: err?.message ?? String(err) }); console.log(`FAIL  [${sectionName}] ${name} — ${err?.message ?? String(err)}`) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const deepEq = (a, b, msg) => {
  const sa = JSON.stringify(a); const sb = JSON.stringify(b)
  if (sa !== sb) throw new Error(`${msg}: expected ${sb}, got ${sa}`)
}
const note = (msg) => console.log(`NOTE  ${msg}`)
const report = (msg) => console.log(`REPORT ${msg}`)
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase()

// ---------------------------------------------------------------- load host
let host = null
let hostError = null
try { host = await import(pathToFileURL(INDEX_PATH).href) } catch (err) { hostError = err }
section('host module')
check('index.js is importable', () => { if (!host) throw new Error(`import failed: ${hostError?.message ?? 'missing index.js'}`) })
for (const name of ['extractSessionSignals', 'collectWorkspaceFiles', 'buildIndex', 'normalizeDocKind']) {
  check(`export ${name} is a function`, () => {
    assert(host, 'index.js not importable')
    eq(typeof host[name], 'function', `typeof ${name}`)
  })
}
check('export name is "dsh-doc-panel"', () => { assert(host); eq(host.name, 'dsh-doc-panel', 'name') })
check('export apply is a function', () => { assert(host); eq(typeof host.apply, 'function', 'apply') })

// Fixed constant "now" is not used by the pure functions but is accepted by buildIndex.
const CONFIG = { maxDepth: 6, maxFiles: 1000, cacheTtlMs: 60000 }
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doc-panel-hostscan-'))
const WS = path.join(BASE, 'ws')
const COLLECT_TREE = path.join(BASE, 'collect-tree')

try {
  // =================================================================== synthetic corpus
  function writeDoc(relPath, mtimeMs, content = 'x') {
    const full = path.join(WS, relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
    fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs))
    return full
  }
  const files = {
    report: writeDoc('report.md', T0 + 1500, '# report'),
    delivered: writeDoc('delivered.html', T0 + 1600, '<html></html>'),
    pwshRef: writeDoc('pwsh-ref.md', T0 + 1800, '# pwsh ref'),
    childDoc: writeDoc('child-doc.md', T0 + 3500, '# child'),
    turnWindow: writeDoc('turn-window.md', T0 + 15000, '# turn window'),
    sessionWindow: writeDoc('session-window.md', T0 + 300000, '# session window'),
    unattributed: writeDoc('unattributed.md', T0 + 900000, '# unattributed'),
    ignoredExtension: writeDoc('notes.json', T0 + 1500, '{"a":1}'),
  }
  // Harness-internal paths: must never be scanned or turned into refs.
  const internalFiles = [
    writeDoc('node_modules/pkg/hidden.md', T0 + 1500),
    writeDoc('.agents/skill/hidden.md', T0 + 1500),
    writeDoc('.hidden-dir/hidden.md', T0 + 1500),
    writeDoc('_scratch.md', T0 + 1500),
    writeDoc('app.asar/inside.md', T0 + 1500),
    writeDoc('dist/out.md', T0 + 1500),
    writeDoc('build/out.md', T0 + 1500),
    writeDoc('.git/hidden.md', T0 + 1500),
    writeDoc('__pycache__/hidden.md', T0 + 1500),
    writeDoc('.dsh-doc-panel/cache.md', T0 + 1500),
  ]

  const ev = (type, time, data) => ({ type, time, data })
  const toolCall = (time, name, args) => ev('tool/call', time, { name, arguments: JSON.stringify(args) })

  const rootEvents = [
    { type: 'session', id: 'session-root', cwd: WS, createdAt: T0 + 500, delegationDepth: 0 },
    ev('session/title', T0 + 600, { title: 'QA Root Title' }),
    ev('turn/start', T0 + 1000, { turn: 1 }),
    toolCall(T0 + 1500, 'write', { file_path: files.report }),
    toolCall(T0 + 1550, 'write', { file_path: path.join(WS, 'REPORT.md') }), // duplicate normalized path
    toolCall(T0 + 1600, 'present', { files: [{ path: files.delivered }] }),
    toolCall(T0 + 1700, 'pwsh', { command: files.pwshRef }), // medium tier (windows-absolute on win32)
    toolCall(T0 + 1750, 'write', { file_path: internalFiles[0] }), // ignored segment
    toolCall(T0 + 1760, 'write', { file_path: internalFiles[3] }), // underscore basename
    toolCall(T0 + 1770, 'write', { file_path: internalFiles[4] }), // app.asar
    ev('turn/end', T0 + 2000, { turn: 1 }),
    ev('assistant/message', T0 + 2100, { turn: 1 }),
  ]
  const childEvents = [
    { type: 'session', id: 'session-child', cwd: WS, createdAt: T0 + 3000, parentSession: 'session-root', delegationDepth: 1 },
    ev('session/title', T0 + 3100, { title: 'QA Child Title' }),
    ev('turn/start', T0 + 3200, { turn: 1 }),
    toolCall(T0 + 3500, 'edit', { file_path: files.childDoc }),
    ev('turn/end', T0 + 3600, { turn: 1 }),
  ]
  const windowEvents = [
    { type: 'session', id: 'session-window', cwd: WS, createdAt: T0 + 9000, delegationDepth: 0 },
    ev('session/title', T0 + 9100, { title: 'QA Window Title' }),
    ev('turn/start', T0 + 10000, { turn: 1 }),
    ev('turn/end', T0 + 20000, { turn: 1 }),
  ]
  const sessionWindowEvents = [
    { type: 'session', id: 'session-sessionwin', cwd: WS, createdAt: T0 + 29000, delegationDepth: 0 },
    ev('session/title', T0 + 29100, { title: 'QA Session Window Title' }),
    ev('turn/start', T0 + 30000, { turn: 1 }),
    ev('turn/end', T0 + 31000, { turn: 1 }),
    ev('session/end-seed', T0 + 600000, {}), // extends lastTime to T0+600000
  ]

  // =============================================================== unit: signals
  section('extractSessionSignals (synthetic events)')
  check('title last-wins', () => {
    const sig = host.extractSessionSignals([
      { type: 'session', id: 's', cwd: WS, createdAt: T0 },
      ev('session/title', T0 + 1, { title: 'first' }),
      ev('session/title', T0 + 2, { title: 'second' }),
    ])
    eq(sig.title, 'second', 'title')
  })
  check('turn windows: closed and open (open ends at lastTime)', () => {
    const sig = host.extractSessionSignals([
      { type: 'session', id: 's', cwd: WS, createdAt: T0 },
      ev('turn/start', T0 + 1000, { turn: 1 }), ev('turn/end', T0 + 2000, { turn: 1 }),
      ev('turn/start', T0 + 3000, { turn: 2 }), ev('assistant/message', T0 + 4000, { turn: 2 }),
    ])
    const t1 = sig.turns.find((t) => t.turn === 1)
    const t2 = sig.turns.find((t) => t.turn === 2)
    eq(t1.start, T0 + 1000, 'turn1.start'); eq(t1.end, T0 + 2000, 'turn1.end')
    eq(t2.start, T0 + 3000, 'turn2.start'); eq(t2.end, T0 + 4000, 'turn2.end (open turn uses lastTime)')
  })
  check('write/edit strong+authored, present strong+delivered, relative resolved against cwd option', () => {
    const cwd = path.join(BASE, 'signals')
    fs.mkdirSync(cwd, { recursive: true })
    const abs = path.join(cwd, 'abs.md')
    const sig = host.extractSessionSignals([
      { type: 'session', id: 's', cwd, createdAt: T0 },
      toolCall(T0 + 1, 'write', { file_path: abs }),
      toolCall(T0 + 2, 'edit', { file_path: path.join('sub', 'rel.txt') }),
      toolCall(T0 + 3, 'present', { files: [{ path: path.join(cwd, 'out.pdf') }] }),
    ], { cwd })
    const get = (target) => sig.refs.find((r) => norm(r.path) === norm(target))
    const writeRef = get(abs); assert(writeRef, 'write ref missing'); eq(writeRef.strong, true, 'write.strong'); eq(writeRef.authored, true, 'write.authored')
    const relRef = get(path.join(cwd, 'sub', 'rel.txt')); assert(relRef, 'relative edit ref missing'); eq(relRef.strong, true, 'edit.strong'); eq(relRef.authored, true, 'edit.authored')
    const presentRef = get(path.join(cwd, 'out.pdf')); assert(presentRef, 'present ref missing'); eq(presentRef.strong, true, 'present.strong'); eq(presentRef.delivered, true, 'present.delivered'); eq(presentRef.authored, false, 'present.authored')
  })
  check('write-capable medium refs vs read-only tools and ignored paths', () => {
    const sharedSig = host.extractSessionSignals([
      { type: 'session', id: 's', cwd: WS, createdAt: T0 },
      toolCall(T0 + 1, 'pwsh', { command: 'C:\\docs\\medium.md' }),
      toolCall(T0 + 2, 'read', { file_path: 'C:\\docs\\read-only.md' }),
      toolCall(T0 + 3, 'write', { file_path: path.join(WS, 'node_modules', 'pkg', 'hidden.md') }),
      toolCall(T0 + 4, 'write', { file_path: path.join(WS, '_scratch.md') }),
      toolCall(T0 + 5, 'write', { file_path: path.join(WS, 'app.asar', 'inside.md') }),
    ])
    const medium = sharedSig.refs.find((r) => norm(r.path).endsWith('/medium.md'))
    assert(medium, 'medium ref from a write-capable tool missing')
    eq(medium.strong, false, 'medium.strong')
    eq(medium.authored, false, 'medium.authored')
    assert(!sharedSig.refs.some((r) => norm(r.path).endsWith('/read-only.md')), 'read-only tool must not produce a medium ref')
    assert(!sharedSig.refs.some((r) => /node_modules|\/_scratch\.md|\/app\.asar\//.test(norm(r.path))), 'harness-internal paths must be dropped at the source')
  })
  check('malformed JSON arguments are ignored without throwing', () => {
    const sig = host.extractSessionSignals([
      { type: 'session', id: 's', cwd: WS, createdAt: T0 },
      { type: 'tool/call', time: T0 + 1, data: { name: 'write', arguments: '{"file_path": "broken"' } },
      { type: 'tool/call', time: T0 + 2, data: { name: 'read', arguments: 'not json' } },
    ])
    assert(Array.isArray(sig.refs), 'refs must be an array')
    eq(sig.refs.length, 0, 'malformed JSON must not produce refs')
  })
  check('empty / malformed event lists do not throw', () => {
    for (const events of [[], [null], [{}], [{ type: 'tool/call' }]]) {
      const sig = host.extractSessionSignals(events)
      assert(sig && Array.isArray(sig.refs) && Array.isArray(sig.turns), 'signals shape')
    }
  })

  // ============================================================ unit: doc kinds
  section('normalizeDocKind')
  check('maps every allowed extension to its kind', () => {
    for (const [ext, kind] of Object.entries(KIND_BY_EXT)) eq(host.normalizeDocKind(ext), kind, `normalizeDocKind(${ext})`)
  })
  check('unknown extensions map to "other"', () => {
    for (const ext of ['.json', '.svg', '.mjs', '.png', '.zip', '']) eq(host.normalizeDocKind(ext), 'other', `normalizeDocKind(${JSON.stringify(ext)})`)
  })

  // ================================================== collectWorkspaceFiles trees
  section('collectWorkspaceFiles')
  fs.mkdirSync(COLLECT_TREE, { recursive: true })
  const treeWrite = (rel, mtimeMs = T0) => {
    const full = path.join(COLLECT_TREE, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'x', 'utf8')
    fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs))
  }
  for (const rel of [
    'ok.md', 'upper.MD', 'note.txt', 'data.csv', '_underscore.md', '.dot.md', 'code.mjs',
    'sub/nested.md',
    'deep/a/b/c/d/e/f/g/h/deep.md',
    'node_modules/pkg/a.md', '.agents/skill/a.md', '.git/a.md', '__pycache__/a.md',
    'dist/a.md', 'build/a.md', '.claude/a.md', '.venv/a.md', 'venv/a.md',
    '.dsh-doc-panel/a.md', '.hidden-dir/a.md', 'app.asar/a.md',
  ]) treeWrite(rel)

  const treeScan = (config) => host.collectWorkspaceFiles(COLLECT_TREE, config).map((f) => norm(path.relative(COLLECT_TREE, f.path))).sort()
  check('default scan applies skip dirs, dot/underscore files and the documents-only extension set', () => {
    const got = treeScan({ maxDepth: 6, maxFiles: 1000 })
    deepEq(got, ['ok.md', 'sub/nested.md', 'upper.md'], 'default tree scan')
  })
  check('explicit config.extensions widens the scan (csv/txt opt-in)', () => {
    deepEq(treeScan({ maxDepth: 6, maxFiles: 1000, extensions: ['.md', '.csv'] }), ['data.csv', 'ok.md', 'sub/nested.md', 'upper.md'], 'extensions [.md,.csv]')
    deepEq(treeScan({ maxDepth: 6, maxFiles: 1000, extensions: ['.txt'] }), ['note.txt'], 'extensions [.txt]')
  })
  check('maxDepth excludes very deep files; maxFiles caps the result', () => {
    const got = treeScan({ maxDepth: 6, maxFiles: 1000 })
    assert(!got.some((p) => p.includes('deep/a/b/c')), 'file beyond maxDepth was returned')
    const capped = host.collectWorkspaceFiles(COLLECT_TREE, { maxDepth: 6, maxFiles: 1 })
    assert(capped.length <= 1, `maxFiles=1 returned ${capped.length}`)
  })
  check('entries are absolute, existing files with sane size/mtime', () => {
    for (const entry of host.collectWorkspaceFiles(COLLECT_TREE, { maxDepth: 6, maxFiles: 1000 })) {
      assert(path.isAbsolute(entry.path), `not absolute: ${entry.path}`)
      const st = fs.statSync(entry.path)
      assert(st.isFile(), `not a file: ${entry.path}`)
      eq(entry.size, st.size, 'size')
      assert(Number.isFinite(entry.mtime) && entry.mtime > 0, 'mtime')
    }
  })

  // ================================================================== buildIndex
  section('buildIndex (synthetic corpus)')
  const sessionsOf = (eventsList) => eventsList.map((events) => {
    const meta = events[0] // synthetic `session` record
    const signals = host.extractSessionSignals(events)
    const header = {
      id: meta.id,
      cwd: meta.cwd,
      parentSession: meta.parentSession ?? null,
      createdAt: meta.createdAt,
      delegationDepth: meta.delegationDepth ?? 0,
    }
    return { id: header.id, header, signals }
  })
  const sessions = [
    ...sessionsOf([rootEvents]),
    ...sessionsOf([childEvents]),
    ...sessionsOf([windowEvents]),
    ...sessionsOf([sessionWindowEvents]),
  ]
  const rootSession = sessions.find((s) => s.id === 'session-root')
  const rootSignals = rootSession.signals
  check('synthetic extraction produced the expected refs and dropped internal ones', () => {
    eq(rootSession.header.parentSession, null, 'root parentSession')
    eq(rootSignals.title, 'QA Root Title', 'root title')
    assert(rootSignals.refs.some((r) => norm(r.path) === norm(files.report)), 'write ref missing')
    assert(rootSignals.refs.some((r) => norm(r.path) === norm(files.delivered) && r.delivered === true), 'present ref missing')
    assert(!rootSignals.refs.some((r) => /node_modules|_scratch\.md|app\.asar/.test(norm(r.path))), 'ignored refs leaked')
    if (IS_WIN) {
      const medium = rootSignals.refs.find((r) => norm(r.path) === norm(files.pwshRef))
      assert(medium, 'windows: medium ref missing for pwsh absolute path')
      eq(medium.strong, false, 'medium.strong')
    } else {
      note('non-win32: medium tier end-to-end is windows-path specific; the windows-absolute extraction case is covered in the unit test above')
    }
  })

  const scanned = host.collectWorkspaceFiles(WS, CONFIG)
  const idx = host.buildIndex({ sessions, files: scanned, config: CONFIG, now: NOW })
  const convs = Array.isArray(idx?.conversations) ? idx.conversations : []
  const allDocs = []
  for (const c of convs) for (const d of Array.isArray(c?.documents) ? c.documents : []) allDocs.push({ c, d })
  const byName = (name) => allDocs.filter(({ d }) => norm(d.name) === norm(name))
  const convByTitle = (title) => convs.find((c) => c.title === title)

  check('scan ignores harness-internal trees and non-document extensions', () => {
    const names = scanned.map((f) => norm(path.basename(f.path))).sort()
    deepEq(names, ['child-doc.md', 'delivered.html', 'pwsh-ref.md', 'report.md', 'session-window.md', 'turn-window.md', 'unattributed.md'], 'scanned basenames')
    for (const { d } of allDocs) {
      const segs = norm(d.path).split('/')
      for (const seg of segs.slice(0, -1)) assert(!SKIP_DIRS.has(seg) && !seg.startsWith('.') && !seg.endsWith('.asar'), `ignored path in index: ${d.path}`)
      assert(!path.basename(d.path).startsWith('_'), `underscore file in index: ${d.path}`)
      assert(ALLOWED_EXT.has(path.extname(d.path).toLowerCase()), `ignored extension in index: ${d.path}`)
    }
  })
  check('conversations: counts, titles, sorting by updatedAt desc', () => {
    eq(convs.length, 3, 'conversation count')
    deepEq(convs.map((c) => c.title), ['QA Session Window Title', 'QA Window Title', 'QA Root Title'], 'conversation order/titles')
    eq(idx.version, 1, 'version')
    eq(idx.generatedAt, NOW, 'generatedAt')
    eq(idx.totalConversations, convs.length, 'totalConversations')
    eq(idx.totalDocuments, allDocs.length, 'totalDocuments')
  })
  check('documents: total count, sorted by mtime desc, counts.byKind sums', () => {
    eq(allDocs.length, 6, 'document count')
    for (const c of convs) {
      for (let i = 1; i < c.documents.length; i++) assert(c.documents[i - 1].mtime >= c.documents[i].mtime, `documents of ${c.id} unsorted`)
      const expectedKinds = {}
      for (const d of c.documents) expectedKinds[d.kind] = (expectedKinds[d.kind] ?? 0) + 1
      deepEq(c.counts.byKind, expectedKinds, `counts.byKind for ${c.id}`)
      eq(Object.values(c.counts.byKind).reduce((a, b) => a + b, 0), c.documents.length, `counts sum for ${c.id}`)
      const maxMtime = Math.max(...c.documents.map((d) => d.mtime))
      eq(c.updatedAt, maxMtime, `updatedAt for ${c.id}`)
    }
    deepEq(convByTitle('QA Root Title').counts.byKind, { md: 3, html: 1 }, 'root counts')
    deepEq(convByTitle('QA Window Title').counts.byKind, { md: 1 }, 'window counts')
  })
  check('document fields: relPath/name/ext/kind and existing paths', () => {
    for (const { c, d } of allDocs) {
      eq(norm(d.relPath), norm(path.relative(c.workspace, d.path)), `relPath for ${d.path}`)
      eq(d.name, path.basename(d.path), `name for ${d.path}`)
      eq(d.ext, path.extname(d.path).toLowerCase(), `ext for ${d.path}`)
      eq(d.kind, KIND_BY_EXT[d.ext] ?? 'other', `kind for ${d.path}`)
      assert(fs.statSync(d.path).isFile(), `missing file ${d.path}`)
    }
  })
  check('attribution tiers: strong, present, turn-window, session-window, unattributed', () => {
    const rootConv = convByTitle('QA Root Title')
    const reportDoc = byName('report.md')
    eq(reportDoc.length, 1, 'exactly one report.md document')
    eq(reportDoc[0].d.sessionId, 'session-root', 'report.md producing session')
    eq(reportDoc[0].d.authored, true, 'report.md authored')
    eq(reportDoc[0].d.delivered, false, 'report.md delivered')
    const deliveredDoc = byName('delivered.html')[0]
    eq(deliveredDoc.d.sessionId, 'session-root', 'delivered.html producing session')
    eq(deliveredDoc.d.delivered, true, 'delivered.html delivered')
    eq(deliveredDoc.d.authored, false, 'delivered.html authored')
    const pwshDocs = byName('pwsh-ref.md')
    eq(pwshDocs.length, 1, 'pwsh-ref.md once')
    eq(pwshDocs[0].c.id, rootConv.id, 'pwsh-ref.md conversation')
    const turnDoc = byName('turn-window.md')[0]
    eq(turnDoc.d.sessionId, 'session-window', 'turn-window.md via turn window')
    eq(turnDoc.c.title, 'QA Window Title', 'turn-window.md conversation')
    const sessionDoc = byName('session-window.md')[0]
    eq(sessionDoc.d.sessionId, 'session-sessionwin', 'session-window.md via session window')
    eq(byName('unattributed.md').length, 0, 'unattributable file must not be listed')
    eq(byName('notes.json').length, 0, 'ignored extension must not be listed')
    report(`tiers: strong=report.md/delivered.html/child-doc.md; medium=${IS_WIN ? 'pwsh-ref.md' : 'n/a (non-win32)'}; turn-window=turn-window.md; session-window=session-window.md; unattributed=1 file excluded`)
  })
  check('child sessions fold into their root conversation', () => {
    const rootConv = convByTitle('QA Root Title')
    const childDoc = byName('child-doc.md')[0]
    eq(childDoc.d.sessionId, 'session-child', 'producing session stays the child')
    eq(childDoc.c.id, 'session-root', 'child doc folded into the root conversation')
    eq(rootConv.sessionCount, 2, 'root conversation sessionCount (root + child)')
    eq(convByTitle('QA Window Title').sessionCount, 1, 'window conversation sessionCount')
  })
  check('determinism: identical JSON across runs and input orders', () => {
    const again = host.buildIndex({ sessions, files: scanned, config: CONFIG, now: NOW })
    eq(JSON.stringify(again), JSON.stringify(idx), 'repeat run')
    const reversed = host.buildIndex({ sessions: [...sessions].reverse(), files: [...scanned].reverse(), config: CONFIG, now: NOW })
    eq(JSON.stringify(reversed), JSON.stringify(idx), 'reversed input order')
  })
  check('no ignored internal files appear anywhere in the index', () => {
    const internalNames = new Set(internalFiles.map((p) => path.basename(p)))
    for (const { d } of allDocs) assert(!internalNames.has(path.basename(d.path)), `internal file in index: ${d.path}`)
    assert(!allDocs.some(({ d }) => norm(d.path).includes('/node_modules/')), 'node_modules leaked')
  })
  check('buildIndex accepts flat fixture sessions and empty inputs', () => {
    const flat = sessions.map((s) => ({ id: s.id, header: s.header, title: s.signals.title, firstTime: s.signals.firstTime, lastTime: s.signals.lastTime, turns: s.signals.turns, refs: s.signals.refs }))
    const flatIdx = host.buildIndex({ sessions: flat, files: scanned, config: CONFIG, now: NOW })
    eq(JSON.stringify(flatIdx), JSON.stringify(idx), 'flat session shape')
    const empty = host.buildIndex({ sessions: [], files: [], config: CONFIG, now: NOW })
    eq(empty.totalConversations, 0, 'empty totalConversations')
    eq(empty.totalDocuments, 0, 'empty totalDocuments')
    deepEq(empty.conversations, [], 'empty conversations')
  })
} finally {
  try { fs.rmSync(BASE, { recursive: true, force: true }) } catch { /* best effort */ }
}

const failed = results.filter((r) => !r.ok)
const summary = {
  workspace: 'synthetic (os.tmpdir, cleaned up)',
  checks: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed.map((r) => `${r.section}: ${r.name} — ${r.detail}`),
}
console.log('\nHOST_SCAN_SUMMARY ' + JSON.stringify(summary))
process.exitCode = failed.length ? 1 : 0
