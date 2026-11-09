#!/usr/bin/env node
// live-verify.mjs — DEVELOPER-ONLY validation of a local Host runtime cache.
//
// PRIVACY WARNING: this tool reads local runtime state (the persisted index cache and
// optionally a decoded fixture) that contains real conversation titles, document paths
// and workspace locations. Never commit its output; the default result path is an OS
// temp file for that reason.
//
// Every machine-specific path is supplied through the environment (or CLI flags):
//   DSH_DOC_CACHE        required — path to the Host's persisted index.json
//   DSH_DOC_WORKSPACE    required — the workspace to scan for offline expectations
//   DSH_DOC_FIXTURE      optional — decoded fixture (skips the fixture diff when unset)
//   DSH_LIVE_VERIFY_OUT  optional — result JSON path (default: OS temp file)
//
// Usage:
//   DSH_DOC_CACHE=<...>/index.json DSH_DOC_WORKSPACE=<...> \
//     node scripts/dev/live-verify.mjs [--cache <index.json>] [--workspace <dir>] [--fixture <file>] [--out <file>]
//
// The runtime index intentionally differs from the offline fixture index: legacy
// session logs that fail readSession are skipped, and the runtime scanner adds
// externally-referenced documents outside the scanned workspace. So hard assertions
// cover invariants and known-truth spot checks; the fixture diff is reported with
// explicit classification instead of a blanket equality assert.
//
// Exit code 0 = hard checks pass; 1 = a hard check failed; 2 = missing configuration.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..', '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const WORKSPACE = arg('--workspace', process.env.DSH_DOC_WORKSPACE ?? '')
const CACHE_ENV = arg('--cache', process.env.DSH_DOC_CACHE ?? '')
const FIXTURE_PATH = arg('--fixture', process.env.DSH_DOC_FIXTURE ?? '')
const RESULT_PATH = arg('--out', process.env.DSH_LIVE_VERIFY_OUT ?? path.join(os.tmpdir(), 'dsh-doc-panel-live-verify-result.json'))
const NOW = Date.now()
if (!WORKSPACE) {
  console.error('live-verify (developer-only): DSH_DOC_WORKSPACE is not set (or pass --workspace <dir>).')
  process.exit(2)
}
if (!CACHE_ENV) {
  console.error('live-verify (developer-only): DSH_DOC_CACHE is not set (or pass --cache <index.json>).')
  console.error('Example: DSH_DOC_CACHE=<profile>/.dsh-doc-panel/index.json DSH_DOC_WORKSPACE=<workspace> node scripts/dev/live-verify.mjs')
  process.exit(2)
}
console.error('PRIVACY WARNING: live-verify reads local runtime cache data with real paths; do not commit its output.')

const ALLOWED_EXT = new Set(['.md', '.markdown', '.html', '.htm', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.csv', '.txt'])
const DOC_EXT = new Set(['.md', '.markdown', '.html', '.htm', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'])
const KIND_BY_EXT = {
  '.md': 'md', '.markdown': 'md', '.html': 'html', '.htm': 'html', '.pdf': 'pdf',
  '.docx': 'docx', '.doc': 'docx', '.xlsx': 'xlsx', '.xls': 'xlsx',
  '.pptx': 'pptx', '.ppt': 'pptx', '.csv': 'csv', '.txt': 'txt',
}
const ALLOWED_KINDS = new Set(['md', 'html', 'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'other'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.agents', '.claude', '.venv', 'venv', '__pycache__', 'dist', 'build', '.dsh-doc-panel'])

const results = []
let sectionName = 'init'
const section = (name) => { sectionName = name; console.log(`\n# ${name}`) }
function check(name, fn, { soft = false } = {}) {
  try {
    fn()
    results.push({ section: sectionName, name, ok: true, soft })
    console.log(`PASS  [${sectionName}] ${name}`)
  } catch (err) {
    results.push({ section: sectionName, name, ok: false, soft, detail: err?.message ?? String(err) })
    console.log(`${soft ? 'WARN' : 'FAIL'}  [${sectionName}] ${name} — ${err?.message ?? String(err)}`)
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const posix = (p) => String(p).replace(/\\/g, '/')
const norm = (p) => posix(p).replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase()
const isAbsWin = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)
const isAsar = (p) => posix(p).toLowerCase().split('/').some((s) => s === 'app.asar' || s.endsWith('.asar'))
const underWorkspace = (p) => { const k = norm(p); const w = norm(WORKSPACE); return k === w || k.startsWith(w + '/') }
const report = (msg) => console.log(`REPORT ${msg}`)
const note = (msg) => console.log(`NOTE ${msg}`)

// ------------------------------------------------------------ cache discovery
section('runtime cache file')
const candidates = [CACHE_ENV]
const existing = candidates.filter((p) => fs.existsSync(p))
for (const p of candidates) console.log(`CHECK_CACHE ${fs.existsSync(p) ? 'EXISTS' : 'ABSENT'} ${p}`)
check('the configured runtime cache file exists', () => {
  assert(existing.length > 0, `ABSENT: ${candidates.join(' | ')} — run the plugin's first list/scan or point DSH_DOC_CACHE at the cache`)
})
const CACHE_PATH = existing[0] ?? candidates[0]
let cache = null
if (fs.existsSync(CACHE_PATH)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
    check('cache parses as JSON object', () => assert(cache && typeof cache === 'object' && !Array.isArray(cache), 'not an object'))
    check('cache looks like the Host index (version 1 + conversations + diag)', () => {
      eq(cache.version, 1, 'version')
      assert(Array.isArray(cache.conversations), 'conversations not an array')
      assert(cache.diag && typeof cache.diag === 'object', 'diag missing from persisted cache')
    })
  } catch (err) {
    check('cache parses as JSON object', () => { throw err })
  }
}
const convs = Array.isArray(cache?.conversations) ? cache.conversations : []
const cacheDocs = []
for (const c of convs) for (const d of Array.isArray(c?.documents) ? c.documents : []) cacheDocs.push({ c, d })
const docsUnderWorkspace = cacheDocs.filter(({ d }) => underWorkspace(d.path))
const docsExternal = cacheDocs.filter(({ d }) => !underWorkspace(d.path))

// ---------------------------------------------------------- structural checks
if (cache) {
  section('runtime cache structure')
  check('conversations expose id/title/workspace/sessionCount/counts; no empty conversations', () => {
    const ids = new Set()
    for (const c of convs) {
      assert(typeof c.id === 'string' && c.id, 'conversation without id')
      assert(!ids.has(c.id), `duplicate conversation id ${c.id}`)
      ids.add(c.id)
      assert(typeof c.title === 'string' && c.title.trim() !== '', `${c.id}: empty title`)
      assert(typeof c.workspace === 'string' && isAbsWin(c.workspace), `${c.id}: bad workspace ${JSON.stringify(c.workspace)}`)
      assert(Number.isInteger(c.sessionCount) && c.sessionCount >= 1, `${c.id}: sessionCount=${c.sessionCount}`)
      assert(Array.isArray(c.documents) && c.documents.length > 0, `${c.id}: no documents (zero-doc conversations must be absent)`)
      assert(c.counts && typeof c.counts.byKind === 'object', `${c.id}: counts.byKind missing`)
      assert(typeof c.updatedAt === 'number' && typeof c.createdAt === 'number', `${c.id}: createdAt/updatedAt not numbers`)
    }
  })
  check('conversations sorted by updatedAt desc', () => {
    for (let i = 1; i < convs.length; i++) {
      assert(convs[i - 1].updatedAt >= convs[i].updatedAt, `out of order at ${i}: ${convs[i - 1].updatedAt} < ${convs[i].updatedAt}`)
    }
  })
  check('document fields: path/ext/kind/flags/sessionId and extension allow-list', () => {
    const seen = new Set()
    for (const { c, d } of cacheDocs) {
      assert(typeof d.path === 'string' && isAbsWin(d.path), `bad path ${JSON.stringify(d.path)} (conversation ${c.id})`)
      assert(typeof d.relPath === 'string' && !d.relPath.includes('\\'), `bad relPath ${JSON.stringify(d.relPath)}`)
      assert(typeof d.name === 'string' && d.name.length > 0, `bad name for ${d.path}`)
      eq(d.ext, path.extname(d.name).toLowerCase(), `ext for ${d.path}`)
      eq(d.kind, KIND_BY_EXT[d.ext] ?? 'other', `kind for ${d.path}`)
      assert(ALLOWED_KINDS.has(d.kind), `unknown kind ${d.kind}`)
      assert(ALLOWED_EXT.has(d.ext), `disallowed extension in index: ${d.path}`)
      assert(typeof d.delivered === 'boolean', `delivered not boolean: ${d.path}`)
      assert(typeof d.authored === 'boolean', `authored not boolean: ${d.path}`)
      assert(typeof d.sessionId === 'string' && d.sessionId, `sessionId missing: ${d.path}`)
      assert(Number.isFinite(d.size) && d.size >= 0, `bad size ${d.path}`)
      assert(Number.isFinite(d.mtime) && d.mtime > Date.UTC(2000, 0, 1), `bad mtime ${d.path}`)
      const k = norm(d.path)
      assert(!seen.has(k), `document listed twice: ${d.path}`)
      seen.add(k)
    }
  })
  check('documents sorted by mtime desc per conversation', () => {
    for (const c of convs) for (let i = 1; i < c.documents.length; i++) {
      assert(c.documents[i - 1].mtime >= c.documents[i].mtime, `documents of ${c.id} not sorted at ${i}`)
    }
  })
  check('counts.byKind sums to documents.length and is accurate', () => {
    for (const c of convs) {
      const expected = {}
      for (const d of c.documents) expected[d.kind] = (expected[d.kind] ?? 0) + 1
      eq(JSON.stringify(c.counts.byKind), JSON.stringify(expected), `counts.byKind for ${c.id}`)
    }
  })
  check('every non-asar document exists on disk with a matching size', () => {
    const skippedAsar = []
    for (const { d } of cacheDocs) {
      if (isAsar(d.path)) { skippedAsar.push(d.path); continue }
      const st = fs.statSync(d.path)
      assert(st.isFile(), `not a file: ${d.path}`)
      eq(d.size, st.size, `size mismatch ${d.path}`)
    }
    if (skippedAsar.length) note(`skipped existence/size check for ${skippedAsar.length} asar-internal path(s) (not visible to a standalone node process): ${skippedAsar.slice(0, 3).join(' | ')}`)
  })
  check('no skipped-tree documents in the index (.agents/node_modules/.git/__pycache__ etc.)', () => {
    const bad = []
    for (const { d } of cacheDocs) {
      const segs = posix(d.path).toLowerCase().split('/')
      for (const seg of segs.slice(0, -1)) if (SKIP_DIRS.has(seg)) bad.push(`${d.path} (segment ${seg})`)
      const base = segs[segs.length - 1]
      if (base.startsWith('.') || base.startsWith('_')) bad.push(`${d.path} (basename)`)
    }
    assert(bad.length === 0, `${bad.length} noisy path(s): ${JSON.stringify(bad.slice(0, 8))}`)
  })
  check('no harness-internal (asar / DSH install dir) documents', () => {
    const bad = cacheDocs.filter(({ d }) => isAsar(d.path) || /[\\/]resources[\\/]app\.asar/i.test(d.path))
    assert(bad.length === 0, `${bad.length} harness-internal path(s): ${JSON.stringify(bad.slice(0, 5).map(({ d }) => d.path))}`)
  })
  check('no dot-directory documents under the workspace', () => {
    const bad = docsUnderWorkspace.filter(({ d }) => {
      const rel = posix(d.path).slice(posix(WORKSPACE).length + 1)
      return rel.split('/').slice(0, -1).some((s) => s.startsWith('.'))
    })
    assert(bad.length === 0, `${bad.length}: ${JSON.stringify(bad.slice(0, 5).map(({ d }) => d.path))}`)
  })
  check('default runtime index is documents-only (csv/txt are opt-in config)', () => {
    const bad = cacheDocs.filter(({ d }) => !DOC_EXT.has(d.ext))
    assert(bad.length === 0, `${bad.length} opt-in extension doc(s): ${JSON.stringify(bad.slice(0, 5).map(({ d }) => d.path))}`)
  })
  check('diagnostics present and complete (or only known legacy-descriptor failures)', () => {
    const diag = cache.diag
    assert(diag && typeof diag === 'object', 'diag missing')
    const knownFailure = (entry) => typeof entry?.error === 'string' && /descriptor|migration|unsupported/i.test(entry.error)
    const failed = Array.isArray(diag.failedSessions) ? diag.failedSessions : []
    const completeOk = diag.complete === true
    const legacyOk = failed.length >= 1 && failed.every(knownFailure)
    assert(completeOk || legacyOk, `complete=${diag.complete} failedSessions=${JSON.stringify(failed).slice(0, 400)}`)
    assert(Number.isFinite(diag.sessionCount) && diag.sessionCount > 0, `diag.sessionCount=${diag.sessionCount}`)
    assert(Number.isFinite(diag.fileCount) && diag.fileCount >= cacheDocs.length, `diag.fileCount ${diag.fileCount} < documents ${cacheDocs.length}`)
    report(`diag: ${JSON.stringify({ complete: diag.complete, sessionCount: diag.sessionCount, fileCount: diag.fileCount, attributed: diag.attributed, unattributed: diag.unattributed, failedSessions: failed.length, phaseMs: diag.phaseMs })}`)
    if (!completeOk) note(`complete=false is expected for legacy session(s): ${failed.map((f) => f.id).join(', ')}`)
  })
  report(`runtime index: ${convs.length} conversations, ${cacheDocs.length} documents (${docsUnderWorkspace.length} under workspace, ${docsExternal.length} external), generatedAt=${new Date(cache.generatedAt).toISOString()}, cache=${CACHE_PATH}`)

  // --------------------------------------- optional, env-driven spot checks
  // Author-specific expectations are intentionally NOT hardcoded in this public repo.
  section('runtime spot checks (optional, env-driven)')
  const spotTitle = process.env.DSH_LIVE_SPOT_TITLE ?? ''
  const spotDoc = process.env.DSH_LIVE_SPOT_DOC ?? ''
  const spotExpectDelivered = process.env.DSH_LIVE_SPOT_DELIVERED === '1'
  if (!spotTitle || !spotDoc) {
    note('skipping author-specific spot checks (set DSH_LIVE_SPOT_TITLE and DSH_LIVE_SPOT_DOC to enable)')
  } else {
    check('spot: configured conversation contains the configured document', () => {
      const conv = convs.find((c) => typeof c.title === 'string' && c.title.includes(spotTitle))
      assert(conv, `conversation containing ${JSON.stringify(spotTitle)} not found in the runtime index`)
      const wanted = norm(path.join(WORKSPACE, spotDoc))
      const hit = conv.documents.find((d) => norm(d.path) === wanted || d.name === spotDoc)
      assert(hit, `document ${JSON.stringify(spotDoc)} not found under ${JSON.stringify(spotTitle)}`)
      if (spotExpectDelivered) eq(hit.delivered, true, 'delivered flag')
      report(`spot: conv=${conv.id} doc=${hit.name} delivered=${hit.delivered}`)
    })
  }

  // ------------------------------------------------------- diff vs offline fixture
  if (!FIXTURE_PATH) {
    note('DSH_DOC_FIXTURE is not set — skipping the fixture-vs-runtime diff (optional developer input)')
  } else {
  section('fixture-vs-runtime diff (informational, classified)')
  let host = null
  let fixture = null
  try {
    host = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href)
    fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
  } catch (err) {
    check('fixture + index.js available for the diff', () => { throw new Error(err.message) })
  }
  if (host && fixture && typeof host.buildIndex === 'function' && typeof host.collectWorkspaceFiles === 'function') {
    const fixtureTime = Date.parse(fixture.generatedAt) || 0
    const fixtureSessions = fixture.sessions.map((s) => ({
      id: s.id,
      header: { ...s.header },
      signals: { title: s.title, firstTime: s.firstTime, lastTime: s.lastTime, turns: s.turns, refs: s.refs },
    }))
    let expected = null
    try {
      const files = host.collectWorkspaceFiles(WORKSPACE, { maxDepth: 6, maxFiles: 5000 })
      expected = host.buildIndex({ sessions: fixtureSessions, files, config: { maxDepth: 6, maxFiles: 5000, cacheTtlMs: 60000 }, now: NOW })
    } catch (err) {
      check('fixture-derived index builds', () => { throw new Error(err.message) })
    }
    if (expected) {
      const expectedDocs = new Map()
      for (const c of expected.conversations) for (const d of c.documents) expectedDocs.set(norm(d.path), { c, d })
      const runtimeWorkspaceDocs = new Map(docsUnderWorkspace.map(({ c, d }) => [norm(d.path), { c, d }]))
      const missing = [...expectedDocs.keys()].filter((k) => !runtimeWorkspaceDocs.has(k))
      const extra = [...runtimeWorkspaceDocs.keys()].filter((k) => !expectedDocs.has(k))
      const missingConvs = expected.conversations.map((c) => c.id).filter((id) => !convs.some((c) => c.id === id))
      const runtimeNewAfterFixture = extra.filter((k) => {
        try { return fs.statSync(runtimeWorkspaceDocs.get(k).d.path).mtimeMs > fixtureTime } catch { return false }
      })
      const externalByRoot = {}
      for (const { d } of docsExternal) {
        const root = /^([A-Za-z]:)/.exec(d.path)?.[1] ?? 'other'
        externalByRoot[root] = (externalByRoot[root] ?? 0) + 1
      }
      const attributionDiffs = []
      for (const [k, { c, d }] of runtimeWorkspaceDocs) {
        const want = expectedDocs.get(k)
        if (!want) continue
        if (d.sessionId !== want.d.sessionId || c.id !== want.c.id) {
          attributionDiffs.push(`${d.name}: runtime ${c.id}/${d.sessionId} vs offline ${want.c.id}/${want.d.sessionId}`)
        }
      }
      const describe = (keys) => keys.slice(0, 12).map((k) => path.basename(k)).join(', ') + (keys.length > 12 ? ` …(+${keys.length - 12})` : '')
      check('offline fixture-era workspace documents are all present at runtime', () => {
        eq(missing.length, 0, `missing ${missing.length}: ${describe(missing)}`)
      }, { soft: true })
      check('runtime workspace documents all appear in the offline expectation', () => {
        eq(extra.length, runtimeNewAfterFixture.length, `unexpected ${extra.length - runtimeNewAfterFixture.length} of ${extra.length}: ${describe(extra)}`)
      }, { soft: true })
      check('offline fixture conversations are present at runtime', () => {
        eq(missingConvs.length, 0, `missing conversations: ${missingConvs.join(', ')}`)
      }, { soft: true })
      report(`diff vs offline: offline=${expected.conversations.length} conv/${expectedDocs.size} docs; runtime=${convs.length} conv/${cacheDocs.length} docs (workspace=${docsUnderWorkspace.length}, external=${docsExternal.length} ${JSON.stringify(externalByRoot)}); missingWorkspaceDocs=${missing.length}; extraWorkspaceDocs=${extra.length} (newAfterFixture=${runtimeNewAfterFixture.length}); attributionDiffs=${attributionDiffs.length}`)
      if (missing.length) note(`missing fixture-era workspace docs (likely legacy readSession failures): ${describe(missing)}`)
      if (attributionDiffs.length) note(`attribution diffs (runtime vs offline, sample): ${attributionDiffs.slice(0, 6).join(' | ')}`)
    }
  }
  }
}

const hard = results.filter((r) => !r.ok && !r.soft)
const soft = results.filter((r) => !r.ok && r.soft)
const summary = {
  cachePath: CACHE_PATH,
  cacheCandidates: candidates.map((p) => ({ path: p, exists: fs.existsSync(p) })),
  present: existing.length > 0,
  sections: [...new Set(results.map((r) => r.section))],
  checks: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: hard.length,
  warnings: soft.length,
  failures: hard.map((r) => `${r.section}: ${r.name} — ${r.detail}`),
  warningsDetail: soft.map((r) => `${r.section}: ${r.name} — ${r.detail}`),
}
console.log('\nLIVE_VERIFY_SUMMARY ' + JSON.stringify(summary))
try {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true })
  fs.writeFileSync(RESULT_PATH, JSON.stringify({ ...summary, results }, null, 2), 'utf8')
  note(`result written to ${RESULT_PATH} (local only — do not commit)`)
} catch (err) { /* best effort */ }
process.exitCode = hard.length ? 1 : 0
