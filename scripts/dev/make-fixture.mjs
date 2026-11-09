#!/usr/bin/env node
// make-fixture.mjs — DEVELOPER-ONLY real-session-log decoder.
//
// PRIVACY WARNING: this tool reads your local DSH session logs, which contain real
// conversation titles, prompts and absolute file paths. The generated fixture is
// machine-specific and MUST NOT be committed or published. The default output path is
// an OS temp file for that reason.
//
// Usage (both paths are env-configurable; nothing is hardcoded to a machine):
//   DSH_SESSIONS_ROOT=<dir> [DSH_FIXTURE_OUT=<file>] \
//     node --max-old-space-size=4096 scripts/dev/make-fixture.mjs [--sessions-root <dir>] [--out <file>]
//
// Session logs are a concatenation of independent zstd frames, one JSON line per
// frame. We split on the zstd magic (28 B5 2F FD), decompress each
// [position, nextPosition) slice and skip slices that throw (the magic can occur
// by chance inside a compressed payload).
//
// The fixture mirrors the Host contract's extractSessionSignals output:
//   { generatedAt, stats, sessions:[{id, header:{id,cwd,parentSession,createdAt,
//     delegationDepth}, title, firstTime, lastTime, turns:[{turn,start,end}],
//     refs:[{path,strong,delivered,authored,time}]}] }
// No raw events and no tool result bodies are kept.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ALLOWED_DOC_EXT = new Set([
  '.md', '.markdown', '.html', '.htm', '.pdf',
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.csv', '.txt',
])
const MAX_REF_PATH = 1024
// Mirrors the final Host semantics: read-only tool calls never produce medium
// references, and harness-internal paths are never documents. Keeping the fixture
// aligned with those rules makes the offline index comparable with the runtime one.
const READ_ONLY_TOOL_NAMES = new Set([
  'read', 'read_image', 'grep', 'glob', 'web_search', 'web_fetch', 'skill',
  'list_agents', 'wait_agent', 'job_list', 'job_output', 'job_kill',
  'ask_user_question', 'todo_write', 'session_search', 'session_event_read',
  'session_event_search', 'session_event_trace', 'session_trace',
  'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
])
const IGNORED_PATH_SEGMENTS = new Set([
  'node_modules', '.agents', '.claude', '.git', '.venv', 'venv', '__pycache__',
  '.dsh-doc-panel', 'dist', 'build',
])

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const sessionsRoot = arg('--sessions-root', process.env.DSH_SESSIONS_ROOT ?? '')
const outFile = arg('--out', process.env.DSH_FIXTURE_OUT ?? path.join(os.tmpdir(), 'dsh-doc-panel-fixture.local.json'))
if (!sessionsRoot) {
  console.error('make-fixture (developer-only): DSH_SESSIONS_ROOT is not set.')
  console.error('Set DSH_SESSIONS_ROOT to your local DSH sessions directory (e.g. <home>/.dsh/sessions/<workspace-slug>) or pass --sessions-root <dir>.')
  console.error('PRIVACY: the decoded fixture contains real conversation data and must never be committed.')
  process.exit(2)
}
console.error('PRIVACY WARNING: make-fixture decodes real local session logs. The generated fixture is machine-specific; do not commit or publish it.')
console.error(`Using sessions root: ${sessionsRoot}`)
console.error(`Writing fixture to: ${outFile}`)

function listSessionLogs(root) {
  const out = []
  let dirs
  try { dirs = fs.readdirSync(root, { withFileTypes: true }) } catch (err) {
    throw new Error(`cannot read sessions root ${root}: ${err.message}`)
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(root, d.name)
    let files
    try { files = fs.readdirSync(dir) } catch { continue }
    // The session store has two generations: current `session.v<N>.jsonl.zstd`
    // and legacy `session.jsonl.zstd`. Prefer the highest numbered generation;
    // fall back to the legacy log. One log per session dir.
    const candidates = files.filter((f) => f.endsWith('.jsonl.zstd'))
    if (!candidates.length) continue
    const versioned = candidates
      .map((name) => ({ name, version: Number(/^session\.v(\d+)\.jsonl\.zstd$/.exec(name)?.[1] ?? -1) }))
      .filter((c) => c.version >= 0)
      .sort((a, b) => b.version - a.version)
    const chosen = versioned.length
      ? versioned[0]
      : { name: candidates.includes('session.jsonl.zstd') ? 'session.jsonl.zstd' : candidates.sort()[0], version: -1 }
    out.push({ sessionDir: d.name, file: path.join(dir, chosen.name), format: chosen.version >= 0 ? `v${chosen.version}` : 'legacy' })
  }
  out.sort((a, b) => a.sessionDir.localeCompare(b.sessionDir))
  return out
}

function decodeLog(file) {
  const buf = fs.readFileSync(file)
  const positions = []
  let i = buf.indexOf(MAGIC, 0)
  while (i !== -1) { positions.push(i); i = buf.indexOf(MAGIC, i + 1) }
  const events = []
  let decodedFrames = 0
  let skippedFrames = 0
  for (let k = 0; k < positions.length; k++) {
    const start = positions[k]
    const end = k + 1 < positions.length ? positions[k + 1] : buf.length
    try {
      const text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
      decodedFrames++
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { events.push(JSON.parse(line)) } catch { /* truncated tail line */ }
      }
    } catch {
      skippedFrames++
    }
  }
  return { events, frames: positions.length, decodedFrames, skippedFrames, bytes: buf.length }
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

function resolvePath(cwd, p) {
  if (typeof p !== 'string' || p.trim() === '') return null
  try {
    return toPosix(path.resolve(cwd || '.', p))
  } catch {
    return null
  }
}

function isAbsoluteWindowsPath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)
}

/** Walk every string value inside a parsed JSON value. */
function collectStrings(value, acc = []) {
  if (typeof value === 'string') acc.push(value)
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, acc)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, acc)
  return acc
}

/** True when a string is, on its own, an absolute Windows path to an allowed document. */
function asDocumentPath(s) {
  if (typeof s !== 'string') return null
  const p = s.trim()
  if (!isAbsoluteWindowsPath(p)) return null
  if (p.length > MAX_REF_PATH) return null
  if (/[\r\n]/.test(p)) return null
  const ext = path.extname(p).toLowerCase()
  if (!ALLOWED_DOC_EXT.has(ext)) return null
  return p
}

function normalizeRefPath(p) {
  // Case-insensitive, forward-slash normalized, as the Host compares paths.
  return toPosix(p).replace(/\/+/g, '/').toLowerCase()
}

/** True for harness-internal paths (ignored segment, dot segment, .asar, _basename). */
function isIgnoredPath(value) {
  if (typeof value !== 'string') return true
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const segments = normalized.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return true
  for (const segment of segments) {
    const lower = segment.toLowerCase()
    if (IGNORED_PATH_SEGMENTS.has(lower)) return true
    if (segment.startsWith('.')) return true
    if (lower.endsWith('.asar')) return true
  }
  const base = segments[segments.length - 1] ?? ''
  return base.startsWith('_')
}

function extractSignals(events) {
  let title
  let header
  let firstTime
  let lastTime
  const turnStarts = new Map()
  const turnEnds = new Map()
  const refsByPath = new Map()
  let toolCalls = 0

  const touch = (t) => {
    if (typeof t !== 'number' || !Number.isFinite(t)) return
    if (firstTime === undefined || t < firstTime) firstTime = t
    if (lastTime === undefined || t > lastTime) lastTime = t
  }

  const addRef = (cwd, rawPath, flags) => {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') return
    let full = isAbsoluteWindowsPath(rawPath) ? toPosix(rawPath) : resolvePath(cwd, rawPath)
    if (!full) return
    if (isIgnoredPath(full)) return
    // Normalize the textual form of absolute drive paths only; keep case for display.
    const key = normalizeRefPath(full)
    const prev = refsByPath.get(key)
    if (prev) {
      prev.strong = prev.strong || flags.strong === true
      prev.delivered = prev.delivered || flags.delivered === true
      prev.authored = prev.authored || flags.authored === true
      if (typeof flags.time === 'number' && flags.time > prev.time) prev.time = flags.time
    } else {
      refsByPath.set(key, {
        path: full,
        strong: flags.strong === true,
        delivered: flags.delivered === true,
        authored: flags.authored === true,
        time: typeof flags.time === 'number' ? flags.time : 0,
      })
    }
  }

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'session') {
      if (!header) header = ev
      if (typeof ev.createdAt === 'number') touch(ev.createdAt)
    }
    if (typeof ev.time === 'number') {
      touch(ev.time)
      if (ev.type === 'turn/start') turnStarts.set(ev.data?.turn, ev.time)
      else if (ev.type === 'turn/end') turnEnds.set(ev.data?.turn, ev.time)
    }
    if (ev.type === 'session/title' && typeof ev.data?.title === 'string') title = ev.data.title
    if (ev.type === 'tool/call') {
      toolCalls++
      const name = ev.data?.name
      const cwd = header?.cwd
      let args
      try { args = typeof ev.data?.arguments === 'string' ? JSON.parse(ev.data.arguments) : ev.data?.arguments } catch { args = undefined }
      if (args !== undefined) {
        if (name === 'write' || name === 'edit') {
          if (typeof args?.file_path === 'string') addRef(cwd, args.file_path, { strong: true, authored: true, time: ev.time })
        } else if (name === 'present') {
          for (const f of Array.isArray(args?.files) ? args.files : []) {
            if (typeof f?.path === 'string') addRef(cwd, f.path, { strong: true, delivered: true, time: ev.time })
          }
        } else if (!READ_ONLY_TOOL_NAMES.has(name)) {
          // Medium tier: a write-capable tool's argument string that is itself an
          // absolute Windows document path (read-only tools contribute nothing).
          for (const s of collectStrings(args)) {
            const p = asDocumentPath(s)
            if (p) addRef(cwd, p, { time: ev.time })
          }
        }
      }
    }
  }

  // Turn windows: turn/end closes a turn; an open turn ends at lastTime.
  const turnIds = [...new Set([...turnStarts.keys(), ...turnEnds.keys()])].filter((t) => typeof t === 'number')
  turnIds.sort((a, b) => a - b)
  const turns = turnIds.map((turn) => ({
    turn,
    start: turnStarts.get(turn) ?? lastTime ?? 0,
    end: turnEnds.get(turn) ?? lastTime ?? 0,
  }))

  const refs = [...refsByPath.values()].sort((a, b) => {
    const ka = normalizeRefPath(a.path)
    const kb = normalizeRefPath(b.path)
    if (ka !== kb) return ka < kb ? -1 : 1
    return a.time - b.time
  })

  return {
    id: header?.id,
    header: {
      id: header?.id ?? null,
      cwd: header?.cwd ?? null,
      parentSession: header?.parentSession ?? null,
      createdAt: header?.createdAt ?? null,
      delegationDepth: header?.delegationDepth ?? null,
    },
    title: title ?? null,
    firstTime: firstTime ?? null,
    lastTime: lastTime ?? null,
    turns,
    refs,
    _toolCalls: toolCalls,
  }
}

function main() {
  const started = Date.now()
  const logs = listSessionLogs(sessionsRoot)
  const sessions = []
  const perFile = []
  let totalBytes = 0
  let totalFrames = 0
  let totalDecodedFrames = 0
  let totalSkippedFrames = 0
  let totalEvents = 0
  let totalToolCalls = 0

  for (const { sessionDir, file } of logs) {
    const t0 = Date.now()
    let decoded
    try {
      decoded = decodeLog(file)
    } catch (err) {
      perFile.push({ sessionDir, file, error: String(err?.message ?? err) })
      continue
    }
    const signals = extractSignals(decoded.events)
    const ms = Date.now() - t0
    totalBytes += decoded.bytes
    totalFrames += decoded.frames
    totalDecodedFrames += decoded.decodedFrames
    totalSkippedFrames += decoded.skippedFrames
    totalEvents += decoded.events.length
    totalToolCalls += signals._toolCalls
    sessions.push(signals)
    perFile.push({
      sessionDir,
      bytes: decoded.bytes,
      frames: decoded.frames,
      decodedFrames: decoded.decodedFrames,
      skippedFrames: decoded.skippedFrames,
      events: decoded.events.length,
      refs: signals.refs.length,
      turns: signals.turns.length,
      ms,
    })
  }

  sessions.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  for (const s of sessions) delete s._toolCalls
  const dupIds = sessions.map((s) => s.id).filter((id, i, arr) => arr.indexOf(id) !== i)

  const fixture = {
    generatedAt: new Date().toISOString(),
    stats: {
      decodeMs: Date.now() - started,
      sessionsRoot,
      sessionLogs: logs.length,
      logsByFormat: logs.reduce((acc, l) => { acc[l.format] = (acc[l.format] ?? 0) + 1; return acc }, {}),
      sessions: sessions.length,
      bytes: totalBytes,
      frames: totalFrames,
      decodedFrames: totalDecodedFrames,
      skippedFrames: totalSkippedFrames,
      events: totalEvents,
      toolCalls: totalToolCalls,
      refs: sessions.reduce((n, s) => n + s.refs.length, 0),
      turns: sessions.reduce((n, s) => n + s.turns.length, 0),
      duplicateSessionIds: dupIds,
      assumptions: {
        mediumRefs: 'write-capable tools only; read-only tool calls contribute no medium refs (final Host semantics)',
        ignoredPaths: 'harness-internal paths dropped for every tier (ignored segments, dot segments, .asar, _basename)',
        relativePaths: 'resolved against the session header cwd when present',
      },
      node: process.version,
    },
    sessions,
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(fixture, null, 0) + '\n', 'utf8')
  const size = fs.statSync(outFile).size
  console.log(JSON.stringify({ outFile, bytes: size, ...fixture.stats, perFile }, null, 0))
  if (dupIds.length) {
    console.error(`duplicate session ids: ${dupIds.join(', ')}`)
    process.exitCode = 1
  }
}

main()
