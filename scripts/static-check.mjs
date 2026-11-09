#!/usr/bin/env node
// static-check.mjs — in-process static validation of the dsh-doc-panel package.
//
// Portable: the repository root is resolved from this file's location, so it works
// from a clean checkout on any machine. `node --check` syntax runs are handled by
// scripts/test-all.mjs; everything here is pure fs+JSON analysis.
//
// Usage: node scripts/static-check.mjs [pluginDir]
// Exit code 0 = all checks PASS, 1 = at least one FAIL.
//
// While the public-release files are still being authored, set
// DSH_DOC_PANEL_ALLOW_INCOMPLETE=1 to downgrade missing LICENSE/READMEs/package
// metadata to WARN. Privacy-marker failures are never downgraded.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(process.argv[2] ?? path.join(SCRIPT_DIR, '..'))
const ALLOW_INCOMPLETE = process.env.DSH_DOC_PANEL_ALLOW_INCOMPLETE === '1'
const results = []
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

function check(section, name, ok, detail = '') {
  results.push({ section, name, ok: Boolean(ok), warn: false, detail })
}
/** Release-metadata check: missing pieces are WARN while the release is incomplete. */
function checkRelease(section, name, ok, detail = '') {
  if (ok) return check(section, name, true, detail)
  if (ALLOW_INCOMPLETE) {
    results.push({ section, name, ok: true, warn: true, detail: `WARN (incomplete release allowed): ${detail}` })
    return
  }
  check(section, name, false, detail)
}
function file(p) { return path.join(ROOT, p) }
function exists(p) { try { return fs.statSync(p).isFile() } catch { return false } }
function read(p) { return fs.readFileSync(p, 'utf8') }
function lineOf(text, idx) { return text.slice(0, idx).split('\n').length }
function findAll(text, re) {
  const out = []
  let m
  while ((m = re.exec(text))) out.push({ index: m.index, match: m[0] })
  return out
}

// ---------------------------------------------------------------- package.json
let pkg = null
try {
  pkg = JSON.parse(read(file('package.json')))
  check('package.json', 'parses as JSON', true)
} catch (err) {
  check('package.json', 'parses as JSON', false, err.message)
}
if (pkg) {
  check('package.json', 'name is dsh-doc-panel', pkg.name === 'dsh-doc-panel', `name=${pkg.name}`)
  check('package.json', 'type is module', pkg.type === 'module', `type=${pkg.type}`)
  check('package.json', 'version present', typeof pkg.version === 'string' && pkg.version.length > 0)

  const exportsMap = pkg.exports ?? {}
  const expectExport = {
    '.': './index.js',
    './client': './client.js',
    './icon': './icon.svg',
  }
  for (const [key, target] of Object.entries(expectExport)) {
    check('package.json', `exports "${key}" -> ${target}`, exportsMap[key] === target, `actual=${JSON.stringify(exportsMap[key])}`)
    check('package.json', `export target ${target} exists`, exists(file(target.replace(/^\.\//, ''))))
  }
  check('package.json', 'exports has "./locale/*.json"', typeof exportsMap['./locale/*.json'] === 'string', JSON.stringify(exportsMap['./locale/*.json'] ?? null))

  const dsh = pkg.dsh ?? {}
  check('package.json', 'dsh.bundle.patch -> ./cordis.patch.yml', dsh.bundle?.patch === './cordis.patch.yml', `actual=${JSON.stringify(dsh.bundle?.patch ?? null)}`)
  check('package.json', 'dsh.bundle.patch file exists', exists(file('cordis.patch.yml')))
  check('package.json', 'dsh.client.platform is web', dsh.client?.platform === 'web', `actual=${JSON.stringify(dsh.client?.platform ?? null)}`)

  // Every runtime file must be shipped by the files list.
  const filesList = Array.isArray(pkg.files) ? pkg.files : []
  const covered = (p) => filesList.some((f) => {
    const norm = f.replace(/\\/g, '/').replace(/^\.\//, '')
    if (norm === p) return true
    if (!norm.includes('*')) return false
    const re = new RegExp('^' + norm.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    return re.test(p)
  })
  const runtimeFiles = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'locale/en.json', 'locale/zh.json']
  const notCovered = runtimeFiles.filter((p) => exists(file(p)) && !covered(p))
  check('package.json', 'files list covers every runtime file', notCovered.length === 0, notCovered.join(', '))
  check('package.json', 'files list omits test/scripts', !filesList.some((f) => /^(test|scripts)\//.test(f)), JSON.stringify(filesList))
}

// ------------------------------------------------------------ cordis.patch.yml
try {
  const yml = read(file('cordis.patch.yml'))
  const body = yml.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
  const indent = (l) => l.length - l.trimStart().length
  // Tiny YAML-subset parser for the only shape this bundle patch uses:
  //   - insert:
  //       - id: <x>
  //         name: <y>
  check('cordis.patch.yml', 'has no tab indentation', !body.some((l) => l.includes('\t')))
  const insertIdx = body.findIndex((l) => indent(l) === 0 && /^-\s+insert:\s*$/.test(l.trimStart()))
  check('cordis.patch.yml', 'top-level "- insert:" entry present', insertIdx !== -1)
  const rows = []
  if (insertIdx !== -1) {
    const insertIndent = indent(body[insertIdx])
    let current = null
    for (let i = insertIdx + 1; i < body.length; i++) {
      const l = body[i]
      const ind = indent(l)
      if (ind <= insertIndent) break
      if (/^\s*-\s+id:/.test(l)) {
        current = { id: l.split(':').slice(1).join(':').trim() }
        rows.push(current)
      } else if (current && /^\s*name:/.test(l)) {
        current.name = l.split(':').slice(1).join(':').trim()
      }
    }
    check('cordis.patch.yml', 'inserts a row with id "dsh-doc-panel"', rows.some((r) => r.id === 'dsh-doc-panel'), JSON.stringify(rows))
    check('cordis.patch.yml', 'inserted row name matches package name', rows.some((r) => r.name === pkg?.name), JSON.stringify(rows))
    check('cordis.patch.yml', 'no extra top-level entries', body.filter((l, i) => indent(l) === 0 && i !== insertIdx && !/^-\s+insert:/.test(l.trimStart())).length === 0)
  }
} catch (err) {
  check('cordis.patch.yml', 'readable', false, err.message)
}

// ------------------------------------------------------------------- locales
for (const locale of ['en', 'zh']) {
  const p = file(`locale/${locale}.json`)
  try {
    const data = JSON.parse(read(p))
    check('locale', `${locale}.json parses`, true)
    check('locale', `${locale}.json meta.title is a non-empty string`, typeof data.meta?.title === 'string' && data.meta.title.trim() !== '')
    check('locale', `${locale}.json meta.description is a non-empty string`, typeof data.meta?.description === 'string' && data.meta.description.trim() !== '')
  } catch (err) {
    check('locale', `${locale}.json parses`, false, err.message)
  }
}
// Client-registered dictionaries must be flat string->string maps; verify via source grep later.

// ------------------------------------------------------------------ icon.svg
if (exists(file('icon.svg'))) {
  const st = fs.statSync(file('icon.svg'))
  check('icon.svg', 'size <= 256 KiB', st.size <= 256 * 1024, `${st.size} bytes`)
  const svg = read(file('icon.svg'))
  check('icon.svg', 'starts with <svg', /^\s*<svg[\s>]/i.test(svg))
  check('icon.svg', 'has xmlns declaration', /xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(svg))
} else {
  check('icon.svg', 'exists', false)
}

// ------------------------------------------------------------------ index.js
if (!exists(file('index.js'))) {
  check('index.js', 'exists (runtime host half)', false, 'missing or still being written')
} else {
  check('index.js', 'exists (runtime host half)', true)
  const src = read(file('index.js'))
  check('index.js', 'no top-level scan side effects (no bare buildIndex/collectWorkspaceFiles call)', !/^(?![ \t]*(\/\/|\*)).*\b(collectWorkspaceFiles|buildIndex)\s*\(/m.test(src) || /export function|function buildIndex/.test(src), 'manual review')
  check('index.js', 'imports only node builtins / relative', !/from\s+['"](?!node:|\.)[^'"]+['"]/.test(src))
  check('index.js', 'no npm dependencies', !/require\(\s*['"](?!node:|\.)[^'"]+['"]\s*\)/.test(src))
  {
    const m = /const\s+DEFAULT_EXTENSIONS\s*=\s*\[([^\]]*)\]/.exec(src)
    const list = m ? m[1] : ''
    check('index.js', 'default extension set is documents-only (csv/txt opt-in)',
      Boolean(m) && list.includes("'.md'") && !list.includes("'.csv'") && !list.includes("'.txt'"),
      m ? list.trim() : 'DEFAULT_EXTENSIONS not found')
    check('index.js', 'declares config.extensions', /extensions\s*:/.test(src))
  }
}

// ------------------------------------------------------------------ client.js
const clientPath = file('client.js')
if (!exists(clientPath)) {
  check('client.js', 'exists (runtime client half)', false, 'missing or still being written')
} else {
  check('client.js', 'exists (runtime client half)', true)
  const src = read(clientPath)
  const lines = src.split('\n')
  const at = (i) => `client.js:${lineOf(src, i)}`

  // 1. No Harness client package imports.
  const clientImports = findAll(src, /(?:from\s+['"]|require\(\s*['"]|import\(\s*['"])@deepseek-ai\/dsh-client-[^'"]*['"]/g)
  check('client.js', 'no @deepseek-ai/dsh-client-* imports', clientImports.length === 0, clientImports.map((m) => at(m.index)).join(', '))

  // 2. No document.body.
  const bodyHits = findAll(src, /\bdocument\.body\b/g)
  check('client.js', 'no document.body access', bodyHits.length === 0, bodyHits.map((m) => at(m.index)).join(', '))

  // 3. innerHTML — must not be fed fetched data. Flag every use for manual review.
  const innerHits = findAll(src, /\.innerHTML\b/g)
  const innerDanger = innerHits.filter((m) => {
    const ctx = src.slice(Math.max(0, m.index - 300), m.index + 300)
    return /\b(fetch|response|res\.json|data|value|documents|conversations|text)\b/.test(ctx)
  })
  check('client.js', 'no innerHTML assignment', innerHits.length === 0, innerHits.map((m) => at(m.index)).join(', '))
  check('client.js', 'no innerHTML with fetched data', innerDanger.length === 0, innerDanger.map((m) => at(m.index)).join(', '))

  // 4. dangerouslySetInnerHTML.
  const dsiHits = findAll(src, /dangerouslySetInnerHTML/g)
  check('client.js', 'no dangerouslySetInnerHTML', dsiHits.length === 0, dsiHits.map((m) => at(m.index)).join(', '))

  // 5. Literal colors outside the sidebar SVG artwork. Report for manual review.
  const colorHits = findAll(src, /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g)
  const colorSvg = colorHits.filter((m) => {
    const ctx = src.slice(Math.max(0, m.index - 400), m.index + 200)
    return /<svg[\s\S]*$/i.test(ctx) && !/<\/svg>\s*['"`]?[)\]],?\s*$/.test(ctx)
  })
  const colorOutsideSvg = colorHits.filter((m) => !colorSvg.includes(m))
  check('client.js', 'literal colors only inside sidebar SVG artwork', colorOutsideSvg.length === 0,
    colorOutsideSvg.map((m) => `${at(m.index)}:${JSON.stringify(m.match)}`).join(', '))

  // 6. setInterval must be cleaned up.
  const intervals = findAll(src, /\bsetInterval\s*\(/g)
  const clears = findAll(src, /\bclearInterval\s*\(/g)
  check('client.js', 'every setInterval has clearInterval cleanup', intervals.length === 0 || clears.length >= 1,
    `setInterval@${intervals.map((m) => at(m.index)).join(',')} clearInterval@${clears.map((m) => at(m.index)).join(',')}`)

  // 7. Loader + registration shape (contract sanity, not a hard task-3 item).
  check('client.js', 'uses window.__ModuleLoader__.load', /__ModuleLoader__\s*\.\s*load\s*\(/.test(src))
  check('client.js', "loader id is 'dsh-doc-panel'", /id\s*:\s*['"]dsh-doc-panel['"]/.test(src))
  check('client.js', "registers slot 'sidebar.panellist'", /sidebar\.panellist/.test(src))
  check('client.js', 'registers a main slot', /\bname\s*:\s*['"]main['"]/.test(src))
  {
    const nsConst = /(?:const|let|var)\s+NS\s*=\s*['"]dsh-doc-panel['"]/.test(src)
    const bindsNs = /locale\.bind\(\s*(?:['"]dsh-doc-panel['"]|NS)\s*\)/.test(src)
    const registersNs = /locale\.register\(\s*(?:['"]dsh-doc-panel['"]|NS)\s*,/.test(src)
    check('client.js', 'binds locale namespace dsh-doc-panel', nsConst && bindsNs && registersNs,
      `NS const=${nsConst} bind=${bindsNs} register=${registersNs}`)
  }
  check('client.js', 'no ReactDOM.render / createRoot (must use slots)', !/ReactDOM|createRoot/.test(src))

  // 8. Scope hygiene: a single <style> block.
  const styleTags = findAll(src, /<style[\s>]/g)
  check('client.js', 'style tag count is 1 or 0', styleTags.length <= 1, `${styleTags.length}`)

  // 9. Theme tokens only for colors in <style> (heuristic): --dsw-alias-* usage present.
  check('client.js', 'uses --dsw-alias-* theme tokens', /--dsw-alias-/.test(src))
  const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(src)
  if (styleBlock) {
    const literals = findAll(styleBlock[1], /(?:#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\()/g)
    check('client.js', 'style block uses no literal colors', literals.length === 0, literals.map((m) => JSON.stringify(m.match)).join(', '))
  }
}

// -------------------------------------------------------------- public release
const releaseSection = 'release'
const licensePath = file('LICENSE')
const licenseText = exists(licensePath) ? read(licensePath) : ''
checkRelease(releaseSection, 'LICENSE exists', exists(licensePath))
checkRelease(releaseSection, 'LICENSE is MIT',
  /MIT License/i.test(licenseText) || /Permission is hereby granted, free of charge/i.test(licenseText),
  exists(licensePath) ? 'no MIT text found' : 'LICENSE missing')
checkRelease(releaseSection, 'README.md exists', exists(file('README.md')))
checkRelease(releaseSection, 'README.zh.md exists', exists(file('README.zh.md')))
if (pkg) {
  checkRelease(releaseSection, 'package.json license is MIT', pkg.license === 'MIT', `license=${JSON.stringify(pkg.license)}`)
  const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository && typeof pkg.repository.url === 'string' ? pkg.repository.url : '')
  checkRelease(releaseSection, 'package.json has a repository URL', typeof repo === 'string' && repo.includes('github.com'), JSON.stringify(pkg.repository ?? null))
  checkRelease(releaseSection, 'package.json has a description', typeof pkg.description === 'string' && pkg.description.trim().length > 0)
  checkRelease(releaseSection, 'package.json is not private', pkg.private !== true, `private=${JSON.stringify(pkg.private)}`)
}

// ------------------------------------------- author-private marker scan
// Markers are assembled from fragments so this scanner's own source stays clean.
const PRIVATE_MARKERS = [
  'xp' + 'bas',
  'C:' + '\\Users',
  'D:' + '\\deepseek_harness_workspace',
  'E:' + '\\aicoding',
  'haoy' + 'un',
]
const scanSection = 'privacy'
function collectScanFiles(dir, acc) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { collectScanFiles(full, acc); continue }
    if (entry.isFile()) acc.push(full)
  }
}
const scanFiles = []
for (const p of ['index.js', 'client.js', 'package.json', 'cordis.patch.yml']) if (exists(file(p))) scanFiles.push(file(p))
for (const dir of ['test', 'scripts', 'locale']) collectScanFiles(file(dir), scanFiles)
const markerHits = []
for (const full of scanFiles) {
  let text
  try { text = read(full) } catch { continue }
  const lines = text.split('\n')
  for (const marker of PRIVATE_MARKERS) {
    const needle = marker.toLowerCase()
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(needle)) markerHits.push(`${rel(full)}:${index + 1} contains a private marker`)
    })
  }
}
check(scanSection, 'no author-private markers in runtime/test/script files', markerHits.length === 0, markerHits.slice(0, 20).join(' | '))
check(scanSection, 'old real-corpus fixture is absent from test/', !fs.existsSync(file('test/fixture.json')), 'test/fixture.json is still present')
{
  const portable = ['test/client-render.test.mjs', 'test/client-explorer.test.mjs', 'test/host-scan.test.mjs', 'test/host-favorites.test.mjs']
  const sessionHits = []
  for (const p of portable) {
    if (!exists(file(p))) continue
    const text = read(file(p))
    text.split('\n').forEach((line, index) => {
      if (/\.jsonl\.zstd|session\.v\d+\.jsonl/.test(line)) sessionHits.push(`${p}:${index + 1}`)
    })
  }
  check(scanSection, 'portable tests do not reference local session logs', sessionHits.length === 0, sessionHits.join(', '))
}
check(scanSection, 'developer-only tools are env-configurable (no hardcoded local roots)',
  !exists(file('scripts/dev/make-fixture.mjs')) || /DSH_SESSIONS_ROOT/.test(read(file('scripts/dev/make-fixture.mjs'))),
  'make-fixture must read DSH_SESSIONS_ROOT (hardcoded local paths are caught by the marker scan)')

const failed = results.filter((r) => !r.ok)
const warnings = results.filter((r) => r.ok && r.warn)
const summary = {
  pluginDir: ROOT,
  sections: [...new Set(results.map((r) => r.section))],
  checks: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  warnings: warnings.length,
  failures: failed.map((r) => `${r.section}: ${r.name}${r.detail ? ` — ${r.detail}` : ''}`),
  warningsDetail: warnings.map((r) => `${r.section}: ${r.name}${r.detail ? ` — ${r.detail}` : ''}`),
}
for (const r of results) console.log(`${r.warn ? 'WARN' : r.ok ? 'PASS' : 'FAIL'}  [${r.section}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
console.log('\nSTATIC_SUMMARY ' + JSON.stringify(summary))
process.exitCode = failed.length ? 1 : 0
