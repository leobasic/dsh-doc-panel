/**
 * dsh-doc-panel — Host half.
 *
 * One sidebar entry in the Web client opens a conversation-scoped document browser.
 * This module derives the document index from the session corpus plus a filtered
 * workspace scan, and serves it to the browser half over three authenticated fetch
 * routes (plus a diagnostics route):
 *
 *   POST api/dsh-doc-panel/list   -> { ok, value: Index }  (or { ok:false, error })
 *   POST api/dsh-doc-panel/read   -> { ok, value: text|binary preview }
 *   GET  api/dsh-doc-panel/file?p=... -> raw bytes (allow-listed paths only)
 *   POST|GET api/dsh-doc-panel/diag   -> the scan diagnostics
 *
 * Design constraints honoured here:
 *  - Plain ESM, Node builtins only, no build step, no top-level side effects.
 *  - Every route handler is wrapped so it can never throw; optional Host services
 *    are probed and every miss degrades to an honest { ok:false, error }.
 *  - Session logs are read strictly one at a time and immediately reduced to compact
 *    signals; raw event arrays are never retained (a big log decompresses to >100 MB).
 *  - The only file this module ever writes is the persisted index cache.
 *  - Concurrent /list calls share a single in-flight scan (promise de-duplication).
 *
 * The pure functions at the bottom of each section are exported for offline tests:
 * normalizeDocKind, extractSessionSignals, collectWorkspaceFiles, buildIndex.
 */

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, win32 } from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bumped only when the on-disk cache layout changes. */
const INDEX_VERSION = 1

/** Favorites store schema version. */
const FAVORITES_VERSION = 1
/** Hard cap on stored favorites; the oldest addedAt entries are dropped first. */
const MAX_FAVORITES = 1000

/**
 * User-facing document types listed by default. Data/intermediate formats such as
 * .csv and .txt are deliberately opt-in: a workspace is full of intermediate text
 * extracts and data dumps, and listing them drowns the actual documents.
 * A user can add them back with `config.extensions`.
 */
const DEFAULT_EXTENSIONS = ['.md', '.markdown', '.html', '.htm', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt']

/**
 * Extension gate for the medium-confidence reference tier when extractSessionSignals
 * is called without an explicit extension list (offline tests). The runtime passes the
 * configured extension set, so this fallback only has to stay permissive: buildIndex
 * always re-filters references through the configured set.
 */
const FALLBACK_REFERENCE_EXTENSIONS = new Set([...DEFAULT_EXTENSIONS, '.csv', '.txt'])

const DEFAULT_CONFIG = Object.freeze({
  extensions: DEFAULT_EXTENSIONS,
  maxFiles: 5000,
  maxDepth: 6,
  cacheTtlMs: 60000,
  cachePath: null,
  favoritesPath: null,
  timeoutMs: 180000,
  warmOnStartup: true,
})

/** Text preview cap, in characters (contract: 300000). */
const MAX_TEXT_CHARS = 300000
/** Upper bound on how many bytes we read to obtain MAX_TEXT_CHARS (UTF-8 is <= 4 bytes/char). */
const MAX_TEXT_BYTES = MAX_TEXT_CHARS * 4

/** Kinds that are always previewed as text. */
const TEXT_KINDS = new Set(['md', 'html', 'csv', 'txt'])
/** `other` kinds that are still text (contract: "other with text mime: also json/xml/log"). */
const TEXT_EXTRA_EXTENSIONS = new Set(['.json', '.xml', '.log'])

/** Path segments that always mean "harness internals", never a user document. */
const IGNORED_PATH_SEGMENTS = new Set(['node_modules', '.agents', '.claude', '.git', '.venv', 'venv', '__pycache__', '.dsh-doc-panel', 'dist', 'build'])

/**
 * Tool calls that only read or enumerate information. They never author a document,
 * and harvesting their arguments produced false positives (README.md files that were
 * merely read from the harness installation), so they contribute no medium references.
 * Every other tool — bash/pwsh/run_code, terminal_*, workflow, unknown write-ish tools —
 * may still mention document paths.
 */
const READ_ONLY_TOOL_NAMES = new Set([
  'read',
  'read_image',
  'grep',
  'glob',
  'web_search',
  'web_fetch',
  'skill',
  'list_agents',
  'wait_agent',
  'job_list',
  'job_output',
  'job_kill',
  'ask_user_question',
  'todo_write',
  'session_search',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  'session_trace',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
])

/** Extension -> Content-Type used by the raw-file route. */
const MIME_BY_EXTENSION = new Map([
  ['.pdf', 'application/pdf'],
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.md', 'text/plain; charset=utf-8'],
  ['.markdown', 'text/plain; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.log', 'text/plain; charset=utf-8'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  // Legacy binary Office formats are part of the default scan set; serve them with their
  // real types instead of the octet-stream fallback.
  ['.doc', 'application/msword'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
])

/** Extensions served with `content-disposition: inline` (everything else downloads). */
const INLINE_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm', '.pdf', '.txt', '.csv', '.json', '.xml', '.log'])

/** Slack applied to turn windows when attributing files by mtime (contract: 60 s). */
const TURN_WINDOW_SLACK_MS = 60000

const MAX_PARENT_WALK = 64
const MAX_REFS_PER_SESSION = 4000
const MAX_TURNS_PER_SESSION = 2000
const MAX_FAILED_SESSIONS_IN_DIAG = 200
const MAX_ARGUMENTS_BYTES_FOR_SCAN = 4 * 1024 * 1024

const JSON_HEADERS = Object.freeze({ 'cache-control': 'no-store' })

/** Delay before the config-gated startup scan fires (warmOnStartup, default on). */
const WARM_STARTUP_DELAY_MS = 2500

const EMPTY_SIGNALS = Object.freeze({ title: '', firstTime: null, lastTime: null, turns: [], refs: [] })

// ---------------------------------------------------------------------------
// Small generic helpers (no side effects)
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function clampInt(value, fallback, min, max) {
  const parsed = toNumber(value)
  if (parsed === null) return fallback
  const integer = Math.round(parsed)
  if (integer < min) return min
  if (integer > max) return max
  return integer
}

function messageOf(error) {
  try {
    if (error instanceof Error) return error.message || String(error)
    return String(error)
  } catch {
    return 'unknown error'
  }
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx?.logger
    const write = logger?.[level]
    if (typeof write === 'function') write.call(logger, message)
  } catch {
    // Logging must never break a route.
  }
}

/** Read an optional Cordis service without throwing when it is not registered. */
function serviceOf(ctx, serviceName) {
  try {
    if (typeof ctx?.get !== 'function') return null
    const value = ctx.get(serviceName, false)
    return value === undefined || value === null ? null : value
  } catch {
    return null
  }
}

async function disposeOf(target) {
  if (target === null || target === undefined) return
  try {
    if (typeof target[Symbol.asyncDispose] === 'function') {
      await target[Symbol.asyncDispose]()
      return
    }
    if (typeof target[Symbol.dispose] === 'function') {
      target[Symbol.dispose]()
    }
  } catch {
    // Disposal is best effort — a failed dispose must not fail the scan.
  }
}

function jsonOk(value) {
  return Response.json({ ok: true, value }, { headers: JSON_HEADERS })
}

function jsonFail(code, message) {
  return Response.json({ ok: false, error: { code, message } }, { headers: JSON_HEADERS })
}

async function readJsonBody(request) {
  try {
    if (!request || typeof request.json !== 'function') return null
    const value = await request.json()
    return isPlainObject(value) ? value : null
  } catch {
    // Empty body, malformed JSON, or a non-object body all degrade to "no options".
    return null
  }
}

// ---------------------------------------------------------------------------
// Path helpers — every comparison is case-insensitive and forward-slash normalised
// ---------------------------------------------------------------------------

function isWindowsAbsolute(value) {
  return typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value))
}

/**
 * Canonicalise a host path. Windows drive/UNC paths are normalised with win32 rules
 * (so the same file given as `D:\x` and `D:/x` compares equal), and absolute POSIX
 * paths are resolved with the host resolver. Relative paths have no base here and
 * return null — callers decide whether they can resolve them.
 */
function toAbsolutePath(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (isWindowsAbsolute(trimmed)) {
    try {
      return win32.normalize(trimmed)
    } catch {
      return null
    }
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    try {
      return resolve(trimmed)
    } catch {
      return null
    }
  }
  return null
}

/** Case-insensitive comparison key: forward slashes, collapsed separators, no trailing slash. */
function normalizePathKey(value) {
  const absolute = toAbsolutePath(value)
  const base = absolute === null ? String(value ?? '') : absolute
  return base.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase()
}

function fileNameOf(value) {
  if (typeof value !== 'string') return ''
  const parts = value.split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

function extensionOf(value) {
  const name = fileNameOf(value)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

/**
 * Resolve a path reference found in a tool call.
 * - absolute Windows path -> normalised with win32 rules
 * - absolute POSIX path -> resolved with the host resolver
 * - relative path + session cwd (Windows or POSIX) -> resolved against that cwd
 * - anything else stays as-is (and will simply fail to match an indexed file)
 */
function resolveRefPath(value, cwd) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^"(.*)"$/s, '$1').trim()
  if (trimmed === '') return null
  if (isWindowsAbsolute(trimmed)) {
    try {
      return win32.normalize(trimmed)
    } catch {
      return null
    }
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    try {
      return resolve(trimmed)
    } catch {
      return null
    }
  }
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    const base = cwd.trim()
    try {
      // A relative reference means "relative to the conversation's working directory";
      // keep Windows and POSIX bases on their own separator conventions.
      if (isWindowsAbsolute(base)) return win32.resolve(base, trimmed)
      if (base.startsWith('/') || base.startsWith('\\')) return resolve(base, trimmed)
    } catch {
      return null
    }
  }
  return trimmed
}

/**
 * Core ignore test: true when any path segment is one of IGNORED_PATH_SEGMENTS, is a
 * dot segment (this also covers `.agents`/`.claude`/`.git` and dot-directories in
 * general) or is an `.asar` file/directory. Used for directories and files alike.
 */
function hasIgnoredPathSegment(value) {
  if (typeof value !== 'string') return true
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (normalized === '') return true
  const segments = normalized.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return true
  for (const segment of segments) {
    const lower = segment.toLowerCase()
    if (IGNORED_PATH_SEGMENTS.has(lower)) return true
    if (segment.startsWith('.')) return true
    if (lower.endsWith('.asar')) return true
  }
  return false
}

/**
 * Shared predicate for every path source (workspace scan, strong/medium refs, the
 * out-of-workspace reference pass and buildIndex's acceptance test).
 *
 * A path is harness-internal — never a user document — when it has an ignored segment
 * (see hasIgnoredPathSegment) or when its basename starts with '.' or '_' (dotfiles,
 * scratch files). Directory names beginning with '_' are *not* skipped by the scan,
 * because the contract only excludes underscore *file* names from listing.
 */
function isIgnoredPath(value) {
  if (hasIgnoredPathSegment(value)) return true
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const segments = normalized.split('/').filter((segment) => segment !== '')
  const base = segments[segments.length - 1] ?? ''
  return base.startsWith('_')
}

/** True when `absolutePath` sits inside the given workspace directory. */
function workspaceContains(workspace, absolutePath) {
  if (typeof workspace !== 'string' || workspace.trim() === '') return false
  const workspaceKey = normalizePathKey(workspace)
  const pathKey = normalizePathKey(absolutePath)
  if (workspaceKey === '' || pathKey === '') return false
  return pathKey === workspaceKey || pathKey.startsWith(workspaceKey + '/')
}

/** Path of a file relative to the conversation workspace, forward slashes. */
function relativeToWorkspace(workspace, absolutePath) {
  const absolute = toAbsolutePath(absolutePath)
  if (absolute === null) return String(absolutePath ?? '').replace(/\\/g, '/')
  if (typeof workspace !== 'string' || workspace.trim() === '') return absolute.replace(/\\/g, '/')
  const workspaceParts = workspace.replace(/[\\/]+/g, '/').split('/').filter(Boolean)
  const pathParts = absolute.replace(/[\\/]+/g, '/').split('/').filter(Boolean)
  let common = 0
  while (common < workspaceParts.length && common < pathParts.length && workspaceParts[common].toLowerCase() === pathParts[common].toLowerCase()) {
    common += 1
  }
  if (common === workspaceParts.length && pathParts.length > common) {
    return pathParts.slice(common).join('/')
  }
  // Outside the workspace (a session may write anywhere on disk): show the absolute path.
  return absolute.replace(/\\/g, '/')
}

function cwdOfHeader(header) {
  if (!isPlainObject(header)) return ''
  const cwd = header.cwd
  return typeof cwd === 'string' ? cwd.trim() : ''
}

/** Session ids appear both bare (`<uuid>`) and prefixed (`session-<uuid>`); compare on the bare form. */
function normalizeSessionId(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/^session-/, '').toLowerCase()
}

// ---------------------------------------------------------------------------
// Configuration normalisation
// ---------------------------------------------------------------------------

function normalizeExtensions(value) {
  const source = Array.isArray(value) ? value : []
  const extensions = []
  for (const entry of source) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim().toLowerCase()
    if (trimmed === '') continue
    extensions.push(trimmed.startsWith('.') ? trimmed : '.' + trimmed)
  }
  return extensions.length > 0 ? [...new Set(extensions)] : [...DEFAULT_EXTENSIONS]
}

function normalizeConfig(raw) {
  const source = isPlainObject(raw) ? raw : {}
  const extensions = normalizeExtensions(source.extensions)
  const cachePath = typeof source.cachePath === 'string' && source.cachePath.trim() !== '' ? source.cachePath.trim() : null
  const favoritesPath = typeof source.favoritesPath === 'string' && source.favoritesPath.trim() !== '' ? source.favoritesPath.trim() : null
  return {
    extensions,
    allowedExtensions: new Set(extensions),
    maxFiles: clampInt(source.maxFiles, DEFAULT_CONFIG.maxFiles, 1, 200000),
    maxDepth: clampInt(source.maxDepth, DEFAULT_CONFIG.maxDepth, 0, 64),
    cacheTtlMs: clampInt(source.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs, 0, 24 * 60 * 60 * 1000),
    cachePath,
    favoritesPath,
    timeoutMs: clampInt(source.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 30 * 60 * 1000),
    warmOnStartup: source.warmOnStartup !== false,
  }
}

/**
 * The extension set that decides which absolute paths mentioned by a non-write tool
 * call become medium references. The runtime passes the configured extension list so
 * that adding `.csv` to the config also makes csv paths extractable from tool
 * arguments; offline callers that pass nothing get the permissive fallback.
 */
function extensionGateFrom(options) {
  const configured = Array.isArray(options?.extensions) ? options.extensions : null
  if (configured === null) return FALLBACK_REFERENCE_EXTENSIONS
  const gate = new Set()
  for (const entry of configured) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim().toLowerCase()
    if (trimmed === '') continue
    gate.add(trimmed.startsWith('.') ? trimmed : '.' + trimmed)
  }
  return gate.size > 0 ? gate : FALLBACK_REFERENCE_EXTENSIONS
}

// ---------------------------------------------------------------------------
// Pure function: normalizeDocKind
// ---------------------------------------------------------------------------

/**
 * Map a file extension (with or without the dot) to the UI document kind.
 * Unknown or empty extensions collapse to 'other'.
 */
export function normalizeDocKind(extension) {
  const raw = typeof extension === 'string' ? extension.trim().toLowerCase() : ''
  const withDot = raw === '' ? '' : raw.startsWith('.') ? raw : '.' + raw
  switch (withDot) {
    case '.md':
    case '.markdown':
      return 'md'
    case '.html':
    case '.htm':
      return 'html'
    case '.pdf':
      return 'pdf'
    case '.docx':
    case '.doc':
      return 'docx'
    case '.xlsx':
    case '.xls':
      return 'xlsx'
    case '.pptx':
    case '.ppt':
      return 'pptx'
    case '.csv':
      return 'csv'
    case '.txt':
      return 'txt'
    default:
      return 'other'
  }
}

// ---------------------------------------------------------------------------
// Pure functions: favorites store (no fs here — persistence lives in apply())
// ---------------------------------------------------------------------------

/**
 * Keep only the newest entry per normalized path, then drop the oldest entries beyond
 * the cap. Returns the surviving entries in their original order.
 */
function capFavorites(favorites) {
  if (!Array.isArray(favorites) || favorites.length <= MAX_FAVORITES) return Array.isArray(favorites) ? favorites : []
  const dropped = new Set([...favorites].sort((left, right) => left.addedAt - right.addedAt).slice(0, favorites.length - MAX_FAVORITES))
  return favorites.filter((favorite) => !dropped.has(favorite))
}

/**
 * Defensive read-side validation of the persisted favorites store.
 *
 * Accepts the store object `{ version, updatedAt, favorites }` (or a bare array of
 * entries) and returns only well-formed favorites: a non-empty absolute path that
 * win32-normalizes, plus name/conversation metadata and a finite addedAt. A store with
 * a different `version` is discarded entirely; malformed entries are dropped one by
 * one. Identity is the case-insensitive win32-normalized path, so duplicates collapse
 * to the newest addedAt while the original path casing is preserved.
 *
 * Pure: no fs, no clock.
 */
export function sanitizeFavorites(raw) {
  let entries = null
  if (Array.isArray(raw)) {
    entries = raw
  } else if (isPlainObject(raw)) {
    if (raw.version !== undefined && raw.version !== FAVORITES_VERSION) return []
    entries = Array.isArray(raw.favorites) ? raw.favorites : null
  }
  if (entries === null) return []

  const byPath = new Map()
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue
    const rawPath = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (rawPath === '') continue
    const absolute = toAbsolutePath(rawPath)
    if (absolute === null) continue
    const key = normalizePathKey(absolute)
    if (key === '') continue
    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : fileNameOf(absolute)
    if (name === '') continue
    const favorite = {
      path: rawPath,
      name,
      conversationId: typeof entry.conversationId === 'string' ? entry.conversationId : '',
      conversationTitle: typeof entry.conversationTitle === 'string' ? entry.conversationTitle : '',
      addedAt: toNumber(entry.addedAt) ?? 0,
    }
    const existing = byPath.get(key)
    // Same file saved twice (e.g. different casing): keep the more recent save.
    if (existing === undefined || favorite.addedAt > existing.addedAt) byPath.set(key, favorite)
  }
  return capFavorites([...byPath.values()])
}

/**
 * Toggle one document in the favorites list.
 *
 * Returns `{ favorites, favorited }` where `favorited` is true when the document was
 * added and false when it was removed. Invalid input (non-absolute path or empty name)
 * leaves the list untouched and reports favorited:false. Adding beyond the cap drops
 * the oldest entries. Pure: no fs — the caller persists the returned list.
 */
export function toggleFavorite(current, input, now) {
  const favorites = sanitizeFavorites(Array.isArray(current) ? current : [])
  const value = isPlainObject(input) ? input : {}
  const rawPath = typeof value.path === 'string' ? value.path.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const absolute = toAbsolutePath(rawPath)
  if (absolute === null || name === '') return { favorites, favorited: false }

  const key = normalizePathKey(absolute)
  const existingIndex = favorites.findIndex((favorite) => normalizePathKey(favorite.path) === key)
  if (existingIndex >= 0) {
    favorites.splice(existingIndex, 1)
    return { favorites, favorited: false }
  }

  favorites.push({
    path: rawPath,
    name,
    conversationId: typeof value.conversationId === 'string' ? value.conversationId : '',
    conversationTitle: typeof value.conversationTitle === 'string' ? value.conversationTitle : '',
    addedAt: toNumber(now) ?? Date.now(),
  })
  return { favorites: capFavorites(favorites), favorited: true }
}

// ---------------------------------------------------------------------------
// Pure function: extractSessionSignals
// ---------------------------------------------------------------------------

function parseToolArguments(value, maxBytes) {
  if (value === null || value === undefined) return null
  if (isPlainObject(value)) return value
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.length > maxBytes) return null
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Collect every JSON string value that is an absolute Windows path with an allowed
 * document extension. Used for the medium-confidence tier ("the tool mentioned this
 * file, but we cannot prove it wrote it").
 */
function collectAbsolutePathStrings(value, out, depth, allowedExtensions) {
  if (depth > 8 || out.length >= MAX_REFS_PER_SESSION) return
  if (typeof value === 'string') {
    if (isWindowsAbsolute(value) && allowedExtensions.has(extensionOf(value))) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAbsolutePathStrings(item, out, depth + 1, allowedExtensions)
    return
  }
  if (!isPlainObject(value)) return
  for (const item of Object.values(value)) collectAbsolutePathStrings(item, out, depth + 1, allowedExtensions)
}

function messageTextFromContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let text = ''
    for (const block of content) {
      if (typeof block === 'string') text += block
      else if (isPlainObject(block) && typeof block.text === 'string') text += block.text
    }
    return text
  }
  if (isPlainObject(content)) {
    if (typeof content.text === 'string') return content.text
    if (Array.isArray(content.content)) return messageTextFromContent(content.content)
  }
  return ''
}

/**
 * First human-authored user message text — used only as a conversation-title fallback.
 * Team/agent relayed messages are skipped so a conversation is not named after a
 * teammate's message.
 */
function firstUserMessageText(data) {
  if (!isPlainObject(data)) return ''
  const source = isPlainObject(data.source) ? data.source : null
  const sourceKind = typeof source?.kind === 'string' ? source.kind : ''
  if (sourceKind === 'agent-message' || sourceKind === 'team-message' || sourceKind === 'subagent-settled') return ''
  const raw = messageTextFromContent(data.content ?? (isPlainObject(data.message) ? data.message.content : data.message))
  if (raw.trim() === '') return ''
  return raw.replace(/^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '').replace(/\s+/g, ' ').trim()
}

/**
 * Reduce one session log to compact, cacheable signals.
 *
 * `events` is the decoded session-log array ({ type, seq, time, data }). The caller
 * drops the array right after this call: a large log decompresses to >100 MB, and
 * only the summary below is ever kept.
 *
 * Relative `write`/`edit` file paths are resolved against, in order: the optional
 * second argument `{ cwd }`, the in-band `session` record's cwd (legacy logs), or —
 * when neither is available — left relative for buildIndex to resolve against the
 * session header cwd.
 *
 * Returns { title, firstTime, lastTime, turns:[{turn,start,end}],
 *           refs:[{path,strong,delivered,authored,time}] }.
 *   - strong  = write/edit target or a `present` deliverable
 *   - authored= produced by write/edit
 *   - delivered = produced by `present`
 *   - other tool calls contribute strong:false / "medium" references
 */
export function extractSessionSignals(events, options) {
  const optionCwd = typeof options?.cwd === 'string' ? options.cwd : ''
  const referenceExtensions = extensionGateFrom(options)
  const signals = { title: '', firstTime: null, lastTime: null, turns: [], refs: [] }
  if (!Array.isArray(events)) return signals

  let titleFromEvent = ''
  let firstUserText = ''
  // Legacy logs carry the session cwd on their first decoded record. It is only a
  // fallback: the API header cwd (options.cwd, or buildIndex's header) wins.
  let inBandCwd = ''
  let firstTime = Number.POSITIVE_INFINITY
  let lastTime = Number.NEGATIVE_INFINITY
  const turnByNumber = new Map()
  const refKeys = new Set()
  const refs = []

  const ensureTurn = (turnNumber) => {
    if (turnNumber === null) return null
    let turn = turnByNumber.get(turnNumber)
    if (turn === undefined) {
      if (turnByNumber.size >= MAX_TURNS_PER_SESSION) return null
      turn = { turn: turnNumber, start: null, end: null }
      turnByNumber.set(turnNumber, turn)
    }
    return turn
  }

  const pushRef = (path, refOptions, time) => {
    if (typeof path !== 'string' || path.trim() === '') return
    // Harness-internal paths (node_modules, .asar, dot-directories, scratch files) are
    // never documents, so they are dropped at the source for every tier.
    if (isIgnoredPath(path)) return
    if (refs.length >= MAX_REFS_PER_SESSION) return
    const dedupeKey = path.toLowerCase() + '|' + (refOptions.strong ? '1' : '0') + (refOptions.delivered ? '1' : '0') + (refOptions.authored ? '1' : '0') + '|' + time
    if (refKeys.has(dedupeKey)) return
    refKeys.add(dedupeKey)
    refs.push({
      path,
      strong: refOptions.strong === true,
      delivered: refOptions.delivered === true,
      authored: refOptions.authored === true,
      // 0 means "time unknown"; it only matters for ordering two refs to the same path.
      time: time === null ? 0 : time,
    })
  }

  for (const event of events) {
    if (!isPlainObject(event)) continue
    const type = typeof event.type === 'string' ? event.type : ''
    const eventTime = toNumber(event.time)
    if (eventTime !== null) {
      if (eventTime < firstTime) firstTime = eventTime
      if (eventTime > lastTime) lastTime = eventTime
    }
    const data = isPlainObject(event.data) ? event.data : isPlainObject(event) ? event : null
    if (data === null) continue

    switch (type) {
      case 'session': {
        if (inBandCwd === '' && typeof data.cwd === 'string' && data.cwd.trim() !== '') {
          inBandCwd = data.cwd.trim()
        }
        break
      }
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim() !== '') {
          titleFromEvent = data.title.trim().slice(0, 200)
        }
        break
      }
      case 'turn/start': {
        const turn = ensureTurn(toNumber(data.turn))
        if (turn !== null && eventTime !== null) turn.start = eventTime
        break
      }
      case 'turn/end': {
        const turn = ensureTurn(toNumber(data.turn))
        if (turn !== null && eventTime !== null) turn.end = eventTime
        break
      }
      case 'user/message': {
        if (firstUserText === '') {
          const text = firstUserMessageText(data)
          if (text !== '') firstUserText = text.slice(0, 160)
        }
        break
      }
      case 'tool/call': {
        const toolName = typeof data.name === 'string' ? data.name : ''
        const rawArguments = data.arguments
        const eventTurn = ensureTurn(toNumber(data.turn))
        if (eventTurn !== null && eventTurn.start === null && eventTime !== null) eventTurn.start = eventTime

        if (toolName === 'write' || toolName === 'edit') {
          // Arguments are always parsed: malformed JSON must not produce a reference.
          // Oversized payloads are skipped rather than parsed (memory bound).
          const args = parseToolArguments(rawArguments, MAX_ARGUMENTS_BYTES_FOR_SCAN)
          if (args === null) break
          const candidate = args.file_path ?? args.path ?? args.filePath
          if (typeof candidate === 'string') {
            const resolvedPath = resolveRefPath(candidate, optionCwd || inBandCwd)
            if (resolvedPath !== null) pushRef(resolvedPath, { strong: true, authored: true, delivered: false }, eventTime)
          }
          break
        }

        if (toolName === 'present') {
          const args = parseToolArguments(rawArguments, MAX_ARGUMENTS_BYTES_FOR_SCAN)
          if (args === null) break
          const files = Array.isArray(args.files) ? args.files : isPlainObject(args.files) ? [args.files] : []
          for (const entry of files) {
            const candidate = typeof entry === 'string' ? entry : isPlainObject(entry) && typeof entry.path === 'string' ? entry.path : null
            if (candidate === null) continue
            const resolvedPath = resolveRefPath(candidate, optionCwd || inBandCwd)
            if (resolvedPath !== null) pushRef(resolvedPath, { strong: true, authored: false, delivered: true }, eventTime)
          }
          break
        }

        // Read-only tools never author a document: harvesting their arguments only
        // produced noise (README.md files that were merely read from the installation).
        if (READ_ONLY_TOOL_NAMES.has(toolName.toLowerCase())) break

        // Every other tool: absolute document paths mentioned anywhere in the arguments.
        const args = parseToolArguments(rawArguments, MAX_ARGUMENTS_BYTES_FOR_SCAN)
        if (args === null) break
        const paths = []
        collectAbsolutePathStrings(args, paths, 0, referenceExtensions)
        for (const candidate of paths) {
          const resolvedPath = resolveRefPath(candidate, optionCwd || inBandCwd)
          if (resolvedPath !== null) pushRef(resolvedPath, { strong: false, authored: false, delivered: false }, eventTime)
        }
        break
      }
      default:
        break
    }
  }

  signals.title = titleFromEvent !== '' ? titleFromEvent : firstUserText
  signals.firstTime = firstTime === Number.POSITIVE_INFINITY ? null : firstTime
  signals.lastTime = lastTime === Number.NEGATIVE_INFINITY ? null : lastTime

  // "a turn without end uses lastTime"
  const turns = [...turnByNumber.values()]
  for (const turn of turns) {
    if (turn.start === null) turn.start = signals.firstTime ?? signals.lastTime ?? 0
    if (turn.end === null) turn.end = signals.lastTime ?? turn.start
  }
  turns.sort((left, right) => left.turn - right.turn)
  signals.turns = turns
  refs.sort((left, right) => left.time - right.time)
  signals.refs = refs
  return signals
}

// ---------------------------------------------------------------------------
// Pure function: collectWorkspaceFiles
// ---------------------------------------------------------------------------

/**
 * Recursively list document files under one workspace directory.
 *
 * Skips dot-directories and the build/vendor directories in SKIP_DIRECTORY_NAMES,
 * skips file names starting with '.' or '_', never follows symlinks, and stops at
 * config.maxDepth / config.maxFiles. `config.deadline` (optional, internal) is an
 * absolute epoch-ms time after which the walk returns what it has.
 *
 * Returns [{ path, size, mtime }].
 */
export function collectWorkspaceFiles(cwd, config) {
  return walkWorkspace(cwd, normalizeConfig(config)).files
}

function walkWorkspace(cwd, cfg) {
  const files = []
  const completion = { truncated: false, timedOut: false }
  if (typeof cwd !== 'string' || cwd.trim() === '') return { files, ...completion }
  let rootStat
  try {
    rootStat = statSync(cwd)
  } catch {
    return { files, ...completion }
  }
  if (!rootStat.isDirectory()) return { files, ...completion }

  const extensions = cfg.allowedExtensions ?? new Set(cfg.extensions)
  const maxFiles = cfg.maxFiles
  const maxDepth = cfg.maxDepth
  const deadline = typeof cfg.deadline === 'number' ? cfg.deadline : Number.POSITIVE_INFINITY
  const stack = [{ dir: cwd, depth: 0 }]
  let visited = 0

  while (stack.length > 0) {
    if (files.length >= maxFiles) {
      completion.truncated = true
      break
    }
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        completion.truncated = true
        break
      }
      visited += 1
      if ((visited & 63) === 0 && Date.now() > deadline) {
        completion.timedOut = true
        return { files, ...completion }
      }
      const name = entry.name
      let kind = 'other'
      try {
        if (entry.isSymbolicLink()) kind = 'symlink'
        else if (entry.isDirectory()) kind = 'directory'
        else if (entry.isFile()) kind = 'file'
      } catch {
        kind = 'other'
      }
      if (kind === 'other') {
        // Some filesystems report DT_UNKNOWN; fall back to lstat for those entries only.
        try {
          const entryStat = lstatSync(join(current.dir, name))
          if (entryStat.isSymbolicLink()) kind = 'symlink'
          else if (entryStat.isDirectory()) kind = 'directory'
          else if (entryStat.isFile()) kind = 'file'
        } catch {
          continue
        }
      }
      if (kind === 'symlink') continue
      if (kind === 'directory') {
        if (current.depth + 1 > maxDepth) continue
        const childDirectory = join(current.dir, name)
        // Vendor/build/asar/dot directories are harness internals. A leading '_' only
        // excludes files (contract), so an underscore-named directory is still walked.
        if (hasIgnoredPathSegment(childDirectory)) continue
        stack.push({ dir: childDirectory, depth: current.depth + 1 })
        continue
      }
      if (kind !== 'file') continue
      const filePath = join(current.dir, name)
      if (isIgnoredPath(filePath)) continue
      if (!extensions.has(extensionOf(name))) continue
      let entryStat
      try {
        entryStat = statSync(filePath)
      } catch {
        continue
      }
      if (!entryStat.isFile()) continue
      files.push({ path: filePath, size: entryStat.size, mtime: entryStat.mtimeMs })
    }
  }

  return { files, ...completion }
}

// ---------------------------------------------------------------------------
// Pure function: buildIndex
// ---------------------------------------------------------------------------

function emptySignals() {
  return { title: '', firstTime: null, lastTime: null, turns: [], refs: [] }
}

/**
 * Accept the flat session shape used by callers that already speak
 * extractSessionSignals output: { id, header, title, firstTime, lastTime, turns, refs }.
 * A nested `signals` object still wins when present.
 */
function signalsOfSession(session) {
  if (isPlainObject(session.signals)) return session.signals
  const hasFlatShape =
    Object.hasOwn(session, 'title') ||
    Object.hasOwn(session, 'firstTime') ||
    Object.hasOwn(session, 'lastTime') ||
    Object.hasOwn(session, 'turns') ||
    Object.hasOwn(session, 'refs')
  if (!hasFlatShape) return emptySignals()
  return {
    title: typeof session.title === 'string' ? session.title : '',
    firstTime: toNumber(session.firstTime),
    lastTime: toNumber(session.lastTime),
    turns: Array.isArray(session.turns) ? session.turns : [],
    refs: Array.isArray(session.refs) ? session.refs : [],
  }
}

function sessionViewsOf(sessions) {
  const views = []
  if (!Array.isArray(sessions)) return views
  for (const session of sessions) {
    if (!isPlainObject(session)) continue
    const header = isPlainObject(session.header) ? session.header : {}
    const id = typeof session.id === 'string' && session.id !== '' ? session.id : typeof header.id === 'string' ? header.id : ''
    if (id === '') continue
    const signals = signalsOfSession(session)
    views.push({ id, header, signals, key: normalizeSessionId(id), root: null })
  }
  // Deterministic order: scans and ties must not depend on the service's list order.
  views.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  return views
}

function rootViewOf(view, byKey) {
  let current = view
  const seen = new Set()
  for (let depth = 0; depth < MAX_PARENT_WALK; depth += 1) {
    seen.add(current.key)
    const parentRaw = typeof current.header.parentSession === 'string' ? current.header.parentSession : ''
    if (parentRaw === '') return current
    const parentKey = normalizeSessionId(parentRaw)
    if (parentKey === '' || seen.has(parentKey)) return current
    const parent = byKey.get(parentKey)
    if (parent === undefined) {
      // Parent log is gone (deleted/archived): this session is the topmost known root.
      return current
    }
    current = parent
  }
  return current
}

function turnWindowsOf(signals) {
  const turns = Array.isArray(signals?.turns) ? signals.turns : []
  const windows = []
  for (const turn of turns) {
    if (!isPlainObject(turn)) continue
    const start = toNumber(turn.start)
    const end = toNumber(turn.end) ?? start
    if (start === null || end === null) continue
    windows.push({ start, end })
  }
  return windows
}

function sessionTitleOf(view) {
  const title = typeof view.signals?.title === 'string' ? view.signals.title.trim() : ''
  if (title !== '') return title.slice(0, 200)
  return 'Session ' + view.id.slice(-6)
}

/**
 * Build the client-facing index from already-collected data. Pure: no fs, no Host
 * services, no clock reads beyond the supplied `now`.
 *
 * @param {{ sessions?: Array<{id:string, header:object, signals:object}>,
 *           files?: Array<{path:string,size?:number,mtime?:number}>,
 *           config?: object, now?: number }} input
 * @returns the Index object described in the plugin contract.
 */
export function buildIndex(input) {
  return buildIndexCore(input).index
}

function buildIndexCore(input) {
  const source = isPlainObject(input) ? input : {}
  const cfg = normalizeConfig(source.config)
  const generatedAt = toNumber(source.now) ?? Date.now()
  const views = sessionViewsOf(source.sessions)
  const fileInputs = Array.isArray(source.files) ? source.files : []

  const byKey = new Map()
  for (const view of views) byKey.set(view.key, view)

  // --- fold child / subagent sessions into their root conversation -------------
  const conversationByRootKey = new Map()
  for (const view of views) {
    view.root = rootViewOf(view, byKey)
    let conversation = conversationByRootKey.get(view.root.key)
    if (conversation === undefined) {
      conversation = { root: view.root, members: [], documents: [] }
      conversationByRootKey.set(view.root.key, conversation)
      const workspace = cwdOfHeader(view.root.header)
      conversation.workspace = workspace
      if (workspace === '') {
        // Root has no cwd (older log): fall back to the first member that has one.
        for (const member of views) {
          if (member.root.key !== view.root.key) continue
          const memberCwd = cwdOfHeader(member.header)
          if (memberCwd !== '') {
            conversation.workspace = memberCwd
            break
          }
        }
      }
    }
    conversation.members.push(view)
  }

  // --- reference towers (strong beats medium; newest wins; deterministic) ------
  const strongRefs = new Map()
  const mediumRefs = new Map()
  for (const view of views) {
    const cwd = cwdOfHeader(view.header)
    const refs = Array.isArray(view.signals?.refs) ? view.signals.refs : []
    for (const ref of refs) {
      if (!isPlainObject(ref)) continue
      const absolute = resolveRefPath(ref.path, cwd)
      if (absolute === null) continue
      // External callers may hand us raw refs, so re-apply the ignore predicate here:
      // harness-internal paths (node_modules, .asar, dot-directories) are never documents.
      if (isIgnoredPath(absolute)) continue
      const extension = extensionOf(absolute)
      if (!cfg.allowedExtensions.has(extension)) continue
      const key = normalizePathKey(absolute)
      const candidate = {
        view,
        time: toNumber(ref.time) ?? 0,
        delivered: ref.delivered === true,
        authored: ref.authored === true,
      }
      const target = ref.strong === true ? strongRefs : mediumRefs
      const current = target.get(key)
      // `>` keeps the first-inserted ref on a time tie; views are sorted by id, so ties
      // resolve deterministically instead of depending on the log encoding order.
      if (current === undefined || candidate.time > current.time) target.set(key, candidate)
    }
  }

  // --- per-session attribution candidates -------------------------------------
  const candidates = views.map((view) => ({
    view,
    workspace: cwdOfHeader(view.header),
    turns: turnWindowsOf(view.signals),
    firstTime: toNumber(view.signals?.firstTime),
    lastTime: toNumber(view.signals?.lastTime),
  }))

  const documentCountByKind = new Map()
  const seenFileKeys = new Set()
  let unattributed = 0
  let consideredFiles = 0

  for (const file of fileInputs) {
    if (!isPlainObject(file)) continue
    const absolute = toAbsolutePath(file.path)
    if (absolute === null) continue
    // Same shared predicate for scanned files: no vendor/build/asar/dot/scratch paths.
    if (isIgnoredPath(absolute)) continue
    const extension = extensionOf(absolute)
    if (!cfg.allowedExtensions.has(extension)) continue
    const key = normalizePathKey(absolute)
    if (seenFileKeys.has(key)) continue
    seenFileKeys.add(key)
    consideredFiles += 1

    const mtime = toNumber(file.mtime) ?? 0
    let attribution = null

    // Tier 1 + 2: an explicit tool-call reference decides attribution outright.
    const strong = strongRefs.get(key)
    if (strong !== undefined) {
      attribution = { view: strong.view, delivered: strong.delivered, authored: strong.authored }
    } else {
      const medium = mediumRefs.get(key)
      if (medium !== undefined) {
        attribution = { view: medium.view, delivered: medium.delivered, authored: medium.authored }
      }
    }

    // Tier 3: the file's mtime falls inside one of a session's turn windows (±60 s).
    // Pick the session whose turn boundary is closest to the mtime.
    if (attribution === null) {
      let best = null
      for (const candidate of candidates) {
        if (!workspaceContains(candidate.workspace, absolute)) continue
        let bestScore = null
        let bestEnd = null
        for (const window of candidate.turns) {
          if (mtime >= window.start - TURN_WINDOW_SLACK_MS && mtime <= window.end + TURN_WINDOW_SLACK_MS) {
            const score = Math.abs(mtime - window.end)
            if (bestScore === null || score < bestScore) {
              bestScore = score
              bestEnd = window.end
            }
          }
        }
        if (bestScore === null) continue
        if (
          best === null ||
          bestScore < best.score ||
          (bestScore === best.score && (bestEnd > best.turnEnd || (bestEnd === best.turnEnd && candidate.view.key < best.view.key)))
        ) {
          best = { view: candidate.view, score: bestScore, turnEnd: bestEnd, delivered: false, authored: false }
        }
      }
      attribution = best
    }

    // Tier 4: the mtime falls anywhere inside the session's [firstTime, lastTime]
    // lifetime; pick the session that ended closest to the mtime.
    if (attribution === null) {
      let best = null
      for (const candidate of candidates) {
        if (!workspaceContains(candidate.workspace, absolute)) continue
        if (candidate.firstTime === null || candidate.lastTime === null) continue
        if (mtime < candidate.firstTime || mtime > candidate.lastTime) continue
        const score = Math.abs(mtime - candidate.lastTime)
        if (
          best === null ||
          score < best.score ||
          (score === best.score && (candidate.lastTime > best.lastTime || (candidate.lastTime === best.lastTime && candidate.view.key < best.view.key)))
        ) {
          best = { view: candidate.view, score, lastTime: candidate.lastTime, delivered: false, authored: false }
        }
      }
      attribution = best
    }

    if (attribution === null) {
      // Tier 5: unattributed — the file exists in a scanned workspace but no session
      // can claim it; it is not listed.
      unattributed += 1
      continue
    }

    const conversation = conversationByRootKey.get(attribution.view.root.key)
    if (conversation === undefined) {
      unattributed += 1
      continue
    }

    const kind = normalizeDocKind(extension)
    const document = {
      path: absolute,
      relPath: relativeToWorkspace(conversation.workspace, absolute),
      name: fileNameOf(absolute),
      ext: extension,
      kind,
      size: toNumber(file.size) ?? 0,
      mtime,
      delivered: attribution.delivered === true,
      authored: attribution.authored === true,
      sessionId: attribution.view.id,
    }
    conversation.documents.push(document)
    documentCountByKind.set(kind, (documentCountByKind.get(kind) ?? 0) + 1)
  }

  // --- conversation summaries --------------------------------------------------
  const conversations = []
  for (const conversation of conversationByRootKey.values()) {
    if (conversation.documents.length === 0) continue
    const documents = conversation.documents.sort((left, right) => {
      if (right.mtime !== left.mtime) return right.mtime - left.mtime
      return left.path.toLowerCase() < right.path.toLowerCase() ? -1 : left.path.toLowerCase() > right.path.toLowerCase() ? 1 : 0
    })

    const byKind = {}
    for (const document of documents) byKind[document.kind] = (byKind[document.kind] ?? 0) + 1

    let createdAt = toNumber(conversation.root.header.createdAt)
    if (createdAt === null) {
      for (const member of conversation.members) {
        const firstTime = toNumber(member.signals?.firstTime)
        if (firstTime !== null && (createdAt === null || firstTime < createdAt)) createdAt = firstTime
      }
    }
    if (createdAt === null) createdAt = generatedAt

    conversations.push({
      id: conversation.root.id,
      title: sessionTitleOf(conversation.root),
      createdAt,
      updatedAt: documents[0].mtime,
      workspace: conversation.workspace,
      sessionCount: conversation.members.length,
      documents,
      counts: { byKind },
    })
  }

  conversations.sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
    return left.id.toLowerCase() < right.id.toLowerCase() ? -1 : left.id.toLowerCase() > right.id.toLowerCase() ? 1 : 0
  })

  let totalDocuments = 0
  for (const conversation of conversations) totalDocuments += conversation.documents.length

  return {
    index: {
      generatedAt,
      version: INDEX_VERSION,
      totalConversations: conversations.length,
      totalDocuments,
      conversations,
    },
    stats: {
      sessionCount: views.length,
      fileCount: consideredFiles,
      attributed: totalDocuments,
      unattributed,
    },
  }
}

// ---------------------------------------------------------------------------
// Raw-file response helpers
// ---------------------------------------------------------------------------

function mimeForExtension(extension) {
  return MIME_BY_EXTENSION.get(extension) ?? 'application/octet-stream'
}

function isTextDocument(document) {
  if (TEXT_KINDS.has(document.kind)) return true
  return document.kind === 'other' && TEXT_EXTRA_EXTENSIONS.has(document.ext)
}

function contentDispositionFor(document) {
  if (INLINE_EXTENSIONS.has(document.ext)) return 'inline'
  return "attachment; filename*=UTF-8''" + encodeRfc5987(document.name)
}

function encodeRfc5987(value) {
  return encodeURIComponent(String(value ?? '')).replace(/['()!*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * Read at most MAX_TEXT_CHARS characters. `bytes` reports the real file size, and
 * `truncated` is true when the preview is shorter than the file.
 */
function readTextPreview(filePath) {
  const fileStat = statSync(filePath)
  if (!fileStat.isFile()) throw new Error('not a regular file')
  const bytesToRead = Math.min(fileStat.size, MAX_TEXT_BYTES)
  const buffer = Buffer.alloc(bytesToRead)
  let bytesRead = 0
  if (bytesToRead > 0) {
    const descriptor = openSync(filePath, 'r')
    try {
      bytesRead = readSync(descriptor, buffer, 0, bytesToRead, 0)
    } finally {
      closeSync(descriptor)
    }
  }
  const decoded = buffer.subarray(0, bytesRead).toString('utf8')
  const truncated = bytesRead < fileStat.size || decoded.length > MAX_TEXT_CHARS
  return {
    text: decoded.length > MAX_TEXT_CHARS ? decoded.slice(0, MAX_TEXT_CHARS) : decoded,
    bytes: fileStat.size,
    truncated,
  }
}

function parseByteRange(request, size) {
  try {
    const header = request?.headers?.get?.('range')
    if (typeof header !== 'string') return null
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
    if (match === null) return null
    const startRaw = match[1]
    const endRaw = match[2]
    if (startRaw === '' && endRaw === '') return null
    if (size <= 0) return null
    let start
    let end
    if (startRaw === '') {
      const suffix = Number(endRaw)
      if (!Number.isFinite(suffix) || suffix <= 0) return null
      start = Math.max(0, size - suffix)
      end = size - 1
    } else {
      start = Number(startRaw)
      end = endRaw === '' ? size - 1 : Number(endRaw)
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null
      if (start > end) return null
      if (start >= size) return null
      if (end >= size) end = size - 1
    }
    return { start, end }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Host plugin
// ---------------------------------------------------------------------------

export const name = 'dsh-doc-panel'

/**
 * Host entry. Registers the routes through the connection fetch service and keeps
 * the in-memory index cache. Everything stateful lives in this closure so importing
 * the module (for example from a client bundle or an offline test harness) has no
 * side effects.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const state = {
    cache: null, // { at, index, signals:Map, seqById:object, diag, docByKey:Map }
    inflight: null, // Promise<typeof state.cache>
    cachePath: null, // resolved absolute path of the persisted index
    favorites: null, // Favorite[] once loaded; null = not loaded yet (lazy)
    favoritesPath: null, // resolved absolute path of the favorites store
  }

  // ----- index cache ---------------------------------------------------------

  /** Resolve <default dir> for cache placement and workspace defaults. */
  function resolveDefaultDirectory() {
    const service = serviceOf(ctx, 'workingDirectory')
    let dir = ''
    try {
      let value = service?.defaultDirectory
      if (typeof value === 'function') value = value.call(service)
      if (typeof value === 'string' && value.trim() !== '') dir = value.trim()
    } catch {
      dir = ''
    }
    if (dir === '') dir = join(homedir(), '.dsh')
    return dir
  }

  function resolveCachePath() {
    const defaultDirectory = resolveDefaultDirectory()
    if (cfg.cachePath !== null) {
      const absolute = toAbsolutePath(cfg.cachePath)
      return absolute ?? join(defaultDirectory, cfg.cachePath)
    }
    return join(defaultDirectory, '.dsh-doc-panel', 'index.json')
  }

  /**
   * Favorites live next to the index cache but in their own file (never cachePath).
   * The same defaultDirectory resolution is used, so a cachePath override alone does
   * not move the favorites store.
   */
  function resolveFavoritesPath() {
    const defaultDirectory = resolveDefaultDirectory()
    if (cfg.favoritesPath !== null) {
      const absolute = toAbsolutePath(cfg.favoritesPath)
      return absolute ?? join(defaultDirectory, cfg.favoritesPath)
    }
    return join(defaultDirectory, '.dsh-doc-panel', 'favorites.json')
  }

  function loadPersistedIndex() {
    const cachePath = state.cachePath ?? resolveCachePath()
    state.cachePath = cachePath
    try {
      const raw = readFileSync(cachePath, 'utf8')
      if (raw.length > 64 * 1024 * 1024) return null
      const parsed = JSON.parse(raw)
      if (!isPlainObject(parsed) || parsed.version !== INDEX_VERSION) return null
      if (!Array.isArray(parsed.conversations)) return null
      const generatedAt = toNumber(parsed.generatedAt)
      if (generatedAt === null) return null
      const conversations = []
      for (const conversation of parsed.conversations) {
        if (!isPlainObject(conversation) || !Array.isArray(conversation.documents)) continue
        conversations.push(conversation)
      }
      const index = {
        generatedAt,
        version: INDEX_VERSION,
        totalConversations: conversations.length,
        totalDocuments: conversations.reduce((sum, conversation) => sum + conversation.documents.length, 0),
        conversations,
      }
      return { index, diag: isPlainObject(parsed.diag) ? parsed.diag : null }
    } catch {
      return null
    }
  }

  function persistIndex(cache) {
    if (cache === null || cache.persistable === false) return
    const cachePath = state.cachePath ?? resolveCachePath()
    state.cachePath = cachePath
    try {
      mkdirSync(join(cachePath, '..'), { recursive: true })
      const payload = {
        version: INDEX_VERSION,
        generatedAt: cache.index.generatedAt,
        // The persisted diag carries a favorites snapshot; the /diag route recomputes it
        // live so toggles are reflected without waiting for the next index refresh.
        diag: { ...cache.diag, favorites: favoritesDiag() },
        conversations: cache.index.conversations,
      }
      const temporaryPath = cachePath + '.tmp-' + process.pid + '-' + Date.now().toString(36)
      writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8')
      // Rename is atomic on the same volume: readers never see a half-written cache.
      renameSync(temporaryPath, cachePath)
    } catch (error) {
      safeLog(ctx, 'debug', 'dsh-doc-panel: could not persist index cache: ' + messageOf(error))
    }
  }

  function buildDocumentMap(index) {
    const map = new Map()
    if (!isPlainObject(index) || !Array.isArray(index.conversations)) return map
    for (const conversation of index.conversations) {
      if (!Array.isArray(conversation.documents)) continue
      for (const document of conversation.documents) {
        if (!isPlainObject(document) || typeof document.path !== 'string') continue
        map.set(normalizePathKey(document.path), document)
      }
    }
    return map
  }

  // ----- favorites store -----------------------------------------------------

  /**
   * Lazily load the persisted favorites store. A missing file or broken JSON is a
   * normal empty list, and the file is left untouched until the next write. Never throws.
   */
  function getFavorites() {
    if (state.favorites !== null) return state.favorites
    const favoritesPath = state.favoritesPath ?? resolveFavoritesPath()
    state.favoritesPath = favoritesPath
    let favorites = []
    try {
      const raw = readFileSync(favoritesPath, 'utf8')
      if (raw.length <= 8 * 1024 * 1024) favorites = sanitizeFavorites(JSON.parse(raw))
    } catch {
      favorites = []
    }
    state.favorites = favorites
    return favorites
  }

  /**
   * Persist the favorites store atomically (tmp + rename, same pattern as the index
   * cache). The in-memory list is authoritative even if the write fails, so the panel
   * keeps working on a read-only profile.
   */
  function saveFavorites(favorites) {
    const list = Array.isArray(favorites) ? favorites : []
    state.favorites = list
    const favoritesPath = state.favoritesPath ?? resolveFavoritesPath()
    state.favoritesPath = favoritesPath
    try {
      mkdirSync(join(favoritesPath, '..'), { recursive: true })
      const payload = {
        version: FAVORITES_VERSION,
        updatedAt: Date.now(),
        favorites: list,
      }
      const temporaryPath = favoritesPath + '.tmp-' + process.pid + '-' + Date.now().toString(36)
      writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8')
      renameSync(temporaryPath, favoritesPath)
    } catch (error) {
      safeLog(ctx, 'debug', 'dsh-doc-panel: could not persist favorites: ' + messageOf(error))
    }
    return list
  }

  /** Count + file path for diagnostics (loading lazily when needed). */
  function favoritesDiag() {
    const favoritesPath = state.favoritesPath ?? resolveFavoritesPath()
    state.favoritesPath = favoritesPath
    return { count: getFavorites().length, path: favoritesPath }
  }

  /**
   * Enrich persisted favorites with the CURRENT index: available/kind/size/mtime.
   * Unavailable favorites report nulls but stay listed; they never widen the read/file
   * allow-list (that stays index-only).
   */
  function enrichFavorites(cache, favorites) {
    const list = sanitizeFavorites(Array.isArray(favorites) ? favorites : [])
    list.sort((left, right) => {
      if (right.addedAt !== left.addedAt) return right.addedAt - left.addedAt
      const leftPath = left.path.toLowerCase()
      const rightPath = right.path.toLowerCase()
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
    })
    const docByKey = cache?.docByKey ?? new Map()
    return list.map((favorite) => {
      const document = docByKey.get(normalizePathKey(favorite.path))
      const available = isPlainObject(document)
      return {
        ...favorite,
        available,
        kind: available ? document.kind : null,
        size: available ? document.size : null,
        mtime: available ? document.mtime : null,
      }
    })
  }

  // ----- session reading -----------------------------------------------------

  function readLiveSessionSeqs() {
    const sessionsService = serviceOf(ctx, 'sessions')
    if (sessionsService === null || typeof sessionsService.list !== 'function') return null
    let list
    try {
      list = sessionsService.list()
    } catch {
      return null
    }
    if (!Array.isArray(list)) return null
    const seqById = new Map()
    for (const item of list) {
      if (!isPlainObject(item)) continue
      const id = typeof item.id === 'string' ? item.id : ''
      const seq = toNumber(item.seq)
      if (id === '' || seq === null) continue
      seqById.set(normalizeSessionId(id), seq)
    }
    return seqById
  }

  /**
   * Read one session log through sessionQuery.
   *
   * The profile can hold two log generations side by side; the service migrates them,
   * but a legacy log may still surface `formatStatus === 'migration-required'` or make
   * `readSession` throw. So: try readSession, then observeSession (disposed in finally),
   * and only then report the session as failed. One bad session must never fail the
   * whole index.
   */
  async function readSessionEvents(sessionQuery, record) {
    const sessionId = record.id
    const needsMigration = record.formatStatus === 'migration-required'
    const failures = []
    let emptyReadResult = null
    if (typeof sessionQuery.readSession === 'function') {
      try {
        const result = await sessionQuery.readSession(sessionId)
        const events = Array.isArray(result?.events) ? result.events : []
        const header = isPlainObject(result?.session?.header) ? result.session.header : isPlainObject(result?.header) ? result.header : null
        if (events.length === 0 && needsMigration && typeof sessionQuery.observeSession === 'function') {
          // The service flagged the log as needing migration and readSession came back
          // empty: give the observer a chance before treating the session as empty.
          emptyReadResult = { header, events }
        } else {
          return { header, events }
        }
      } catch (error) {
        failures.push('readSession: ' + messageOf(error))
      }
    }
    if (typeof sessionQuery.observeSession === 'function') {
      try {
        const observer = await sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
        try {
          const events = Array.isArray(observer?.events) ? observer.events : []
          const header = isPlainObject(observer?.header) ? observer.header : null
          return { header, events }
        } finally {
          await disposeOf(observer)
        }
      } catch (error) {
        failures.push('observeSession: ' + messageOf(error))
      }
    }
    if (emptyReadResult !== null) return emptyReadResult
    if (failures.length === 0) throw new Error('sessionQuery exposes neither readSession nor observeSession')
    throw new Error(failures.join('; '))
  }

  /**
   * Full + incremental scan. Returns a cache object. Throws only when the session
   * corpus itself is unavailable; all per-session failures are recorded in diag.
   */
  async function refreshIndex() {
    const startedAt = Date.now()
    const deadline = startedAt + cfg.timeoutMs
    const phaseMs = { list: 0, readSessions: 0, scan: 0, attribute: 0 }
    const failedSessions = []
    // Timeout truncation and per-session failures both make the index partial; the
    // index is still returned, with diag.complete = false.
    let timedOut = false

    const sessionQuery = serviceOf(ctx, 'sessionQuery')
    if (sessionQuery === null || typeof sessionQuery.listSessions !== 'function') {
      throw new Error('sessionQuery service is unavailable')
    }

    // 1. Authoritative session list (headers only — cheap).
    let listStart = Date.now()
    let records
    try {
      records = await sessionQuery.listSessions()
    } catch (error) {
      throw new Error('sessionQuery.listSessions failed: ' + messageOf(error))
    }
    phaseMs.list = Date.now() - listStart
    if (!Array.isArray(records)) throw new Error('sessionQuery.listSessions returned a non-array value')

    const sessionRecords = []
    for (const record of records) {
      const header = isPlainObject(record?.header) ? record.header : isPlainObject(record) && typeof record.id === 'string' ? record : null
      if (header === null) continue
      const id = typeof header.id === 'string' ? header.id : typeof record?.id === 'string' ? record.id : ''
      if (id === '') continue
      // SessionRecord.formatStatus can flag a legacy log that needs migration; keep it
      // so readSessionEvents can fall back to observeSession instead of trusting an
      // empty readSession result.
      const formatStatus = typeof record?.formatStatus === 'string' ? record.formatStatus : ''
      sessionRecords.push({ id, header, formatStatus })
    }

    const liveSeqs = readLiveSessionSeqs()
    const previousCache = state.cache
    const signalsByKey = new Map()
    const seqByKey = {}

    // 2. Read the changed sessions — strictly sequential, one log in memory at a time.
    const readStart = Date.now()
    for (const record of sessionRecords) {
      const key = normalizeSessionId(record.id)
      const cachedSignals = previousCache?.signals?.get(key)
      const cachedSeq = previousCache?.seqById?.[key]
      const liveSeq = liveSeqs === null ? undefined : liveSeqs.get(key)
      let signals = null

      if (cachedSignals !== undefined) {
        if (liveSeqs === null) {
          // No live-seq service: we cannot detect changes, so keep the cached signals.
          signals = cachedSignals
          if (cachedSeq !== undefined) seqByKey[key] = cachedSeq
        } else if (liveSeq === undefined) {
          // Session is not live any more; its log is immutable.
          signals = cachedSignals
          if (cachedSeq !== undefined) seqByKey[key] = cachedSeq
        } else if (cachedSeq !== undefined && cachedSeq === liveSeq) {
          signals = cachedSignals
          seqByKey[key] = cachedSeq
        }
        // Otherwise the live session advanced: fall through and re-read it.
      }

      if (signals !== null) {
        signalsByKey.set(key, signals)
        continue
      }

      if (Date.now() > deadline) {
        timedOut = true
        // Fall back to whatever we cached before; a time-boxed partial index beats
        // an empty one. Sessions first seen after the timeout keep zero signals.
        if (cachedSignals !== undefined) {
          signalsByKey.set(key, cachedSignals)
        }
        continue
      }

      try {
        const read = await readSessionEvents(sessionQuery, record)
        const header = isPlainObject(read.header) ? { ...record.header, ...read.header } : record.header
        const events = read.events
        const signalsForRecord = extractSessionSignals(events, { cwd: cwdOfHeader(header), extensions: cfg.extensions })
        // Drop the decoded events immediately: only the compact signals survive.
        read.events = null
        record.header = header
        signals = signalsForRecord
        if (liveSeq !== undefined) seqByKey[key] = liveSeq
      } catch (error) {
        if (failedSessions.length < MAX_FAILED_SESSIONS_IN_DIAG) {
          failedSessions.push({ id: record.id, error: messageOf(error) })
        }
        // A failed re-read keeps serving the previously cached signals when possible.
        if (cachedSignals !== undefined) {
          signals = cachedSignals
          if (cachedSeq !== undefined) seqByKey[key] = cachedSeq
        }
      }

      if (signals !== null) signalsByKey.set(key, signals)
    }
    phaseMs.readSessions = Date.now() - readStart

    // 3. Workspace scan. The walk is cheap compared with the log reads (~20 ms for a
    // few hundred documents), so it also runs on the warm path: that is what turns
    // externally produced files (scripts, downloads) into fresh index entries.
    const scanStart = Date.now()
    const workspaceRoots = []
    const seenWorkspaceKeys = new Set()
    for (const record of sessionRecords) {
      const cwd = cwdOfHeader(record.header)
      if (cwd === '') continue
      const key = normalizePathKey(cwd)
      if (key === '' || seenWorkspaceKeys.has(key)) continue
      seenWorkspaceKeys.add(key)
      workspaceRoots.push(cwd)
    }

    const files = []
    const seenFileKeys = new Set()
    for (const root of workspaceRoots) {
      if (Date.now() > deadline) {
        timedOut = true
        break
      }
      const remaining = cfg.maxFiles - files.length
      if (remaining <= 0) break
      const walk = walkWorkspace(root, { ...cfg, maxFiles: remaining, deadline })
      // Hitting maxFiles is a designed cap, not an incomplete scan; a walk cut short
      // by the timeout is.
      if (walk.timedOut) timedOut = true
      for (const file of walk.files) {
        const key = normalizePathKey(file.path)
        if (seenFileKeys.has(key)) continue
        seenFileKeys.add(key)
        files.push(file)
      }
    }

    // 3b. Explicitly referenced documents that live outside every scanned workspace
    // (or would be skipped by the workspace filters) still count if they exist now.
    for (const record of sessionRecords) {
      if (Date.now() > deadline) {
        timedOut = true
        break
      }
      if (files.length >= cfg.maxFiles * 2) break
      const key = normalizeSessionId(record.id)
      const signals = signalsByKey.get(key)
      if (signals === undefined || !Array.isArray(signals.refs)) continue
      const cwd = cwdOfHeader(record.header)
      for (const ref of signals.refs) {
        if (!isPlainObject(ref) || typeof ref.path !== 'string') continue
        const absolute = resolveRefPath(ref.path, cwd)
        if (absolute === null) continue
        // Harness-internal references (installation .asar trees, node_modules, dot dirs)
        // are never documents, even when the file happens to exist.
        if (isIgnoredPath(absolute)) continue
        const extension = extensionOf(absolute)
        if (!cfg.allowedExtensions.has(extension)) continue
        const fileKey = normalizePathKey(absolute)
        if (seenFileKeys.has(fileKey)) continue
        seenFileKeys.add(fileKey)
        try {
          const fileStat = statSync(absolute)
          if (!fileStat.isFile()) continue
          files.push({ path: absolute, size: fileStat.size, mtime: fileStat.mtimeMs })
        } catch {
          // The referenced file no longer exists: only current files may be listed.
        }
      }
    }
    phaseMs.scan = Date.now() - scanStart

    // 4. Attribution + index assembly.
    const attributeStart = Date.now()
    const built = buildIndexCore({
      sessions: sessionRecords.map((record) => ({
        id: record.id,
        header: record.header,
        signals: signalsByKey.get(normalizeSessionId(record.id)) ?? null,
      })),
      files,
      config: cfg,
      now: Date.now(),
    })
    phaseMs.attribute = Date.now() - attributeStart

    const cachePath = state.cachePath ?? resolveCachePath()
    state.cachePath = cachePath
    const complete = timedOut === false && failedSessions.length === 0
    const diag = {
      phaseMs,
      sessionCount: sessionRecords.length,
      failedSessions,
      fileCount: built.stats.fileCount,
      attributed: built.stats.attributed,
      unattributed: built.stats.unattributed,
      cachedAt: Date.now(),
      complete,
      cachePath,
    }

    const cache = {
      at: Date.now(),
      index: built.index,
      signals: signalsByKey,
      seqById: seqByKey,
      diag,
      docByKey: buildDocumentMap(built.index),
      // A timeout-truncated scan is not worth persisting; an index that is only
      // missing a few unreadable sessions still is.
      persistable: timedOut === false,
    }
    state.cache = cache
    persistIndex(cache)
    return cache
  }

  /**
   * Return the current index cache, refreshing it when stale or when forced.
   * Concurrent callers share one in-flight refresh; a failed refresh falls back to
   * the previously cached index when there is one.
   */
  async function ensureIndex(force) {
    if (state.cache === null) {
      const loaded = loadPersistedIndex()
      if (loaded !== null) {
        state.cache = {
          at: loaded.index.generatedAt,
          index: loaded.index,
          signals: new Map(),
          seqById: {},
          diag: loaded.diag,
          docByKey: buildDocumentMap(loaded.index),
        }
      }
    }

    if (force !== true && state.cache !== null && Date.now() - state.cache.at <= cfg.cacheTtlMs) {
      return state.cache
    }

    if (state.inflight !== null) return state.inflight

    const promise = refreshIndex()
    state.inflight = promise
    const clear = () => {
      if (state.inflight === promise) state.inflight = null
    }
    promise.then(clear, clear)

    try {
      return await promise
    } catch (error) {
      if (state.cache !== null) {
        // Keep serving the last good index instead of failing the panel outright.
        safeLog(ctx, 'warn', 'dsh-doc-panel: index refresh failed, serving cached index: ' + messageOf(error))
        return state.cache
      }
      throw error
    }
  }

  function findDocument(cache, requestedPath) {
    if (cache === null || typeof requestedPath !== 'string' || requestedPath.trim() === '') return null
    const direct = cache.docByKey.get(normalizePathKey(requestedPath))
    if (direct !== undefined) return direct
    const absolute = toAbsolutePath(requestedPath)
    if (absolute !== null) {
      const viaAbsolute = cache.docByKey.get(normalizePathKey(absolute))
      if (viaAbsolute !== undefined) return viaAbsolute
    }
    return null
  }

  // ----- route handlers ------------------------------------------------------

  async function handleList(request) {
    const body = await readJsonBody(request)
    const refresh = body !== null && body.refresh === true
    let cache
    try {
      cache = await ensureIndex(refresh)
    } catch (error) {
      return jsonFail('dsh-doc-panel/unavailable', messageOf(error))
    }
    return jsonOk(cache.index)
  }

  async function handleRead(request) {
    const body = await readJsonBody(request)
    const requestedPath = typeof body?.path === 'string' ? body.path : ''
    if (requestedPath.trim() === '') {
      return jsonFail('dsh-doc-panel/bad-request', 'body must be {"path":"<absolute path>"}')
    }
    let cache
    try {
      cache = await ensureIndex(false)
    } catch (error) {
      return jsonFail('dsh-doc-panel/unavailable', messageOf(error))
    }
    const document = findDocument(cache, requestedPath)
    if (document === null) {
      // The allow-list is the index: paths that are not currently indexed are refused.
      return jsonFail('dsh-doc-panel/not-found', 'document is not in the current index: ' + requestedPath)
    }
    if (isTextDocument(document)) {
      let preview
      try {
        preview = readTextPreview(document.path)
      } catch (error) {
        return jsonFail('dsh-doc-panel/read-failed', messageOf(error))
      }
      return jsonOk({ kind: 'text', text: preview.text, bytes: preview.bytes, truncated: preview.truncated })
    }
    return jsonOk({
      kind: 'binary',
      url: 'api/dsh-doc-panel/file?p=' + encodeURIComponent(document.path),
      mime: mimeForExtension(document.ext),
    })
  }

  async function handleFile(request) {
    let requestedPath = ''
    try {
      const url = new URL(typeof request?.url === 'string' ? request.url : '', 'http://dsh.local')
      requestedPath = url.searchParams.get('p') ?? ''
    } catch {
      return jsonFail('dsh-doc-panel/bad-request', 'request URL could not be parsed')
    }
    if (requestedPath.trim() === '') {
      return jsonFail('dsh-doc-panel/bad-request', 'missing p query parameter')
    }
    let cache
    try {
      cache = await ensureIndex(false)
    } catch (error) {
      return jsonFail('dsh-doc-panel/unavailable', messageOf(error))
    }
    const document = findDocument(cache, requestedPath)
    if (document === null) {
      return jsonFail('dsh-doc-panel/not-found', 'document is not in the current index: ' + requestedPath)
    }
    let fileStat
    try {
      // lstat (not stat): refuse symlinks so an indexed path cannot be swapped for a
      // link that escapes the workspace between scans.
      fileStat = lstatSync(document.path)
      if (!fileStat.isFile()) throw new Error('not a regular file')
    } catch (error) {
      return jsonFail('dsh-doc-panel/file-failed', messageOf(error))
    }

    const headers = {
      'cache-control': 'no-store',
      'content-type': mimeForExtension(document.ext),
      'content-disposition': contentDispositionFor(document),
      'accept-ranges': 'bytes',
    }
    const fileSize = fileStat.size
    const range = parseByteRange(request, fileSize)
    if (range !== null) {
      // Read only the requested slice: PDF viewers issue range requests for big files,
      // and there is no reason to pull the whole document into memory for them.
      const length = range.end - range.start + 1
      const chunk = Buffer.alloc(length)
      let bytesRead = 0
      try {
        const descriptor = openSync(document.path, 'r')
        try {
          bytesRead = readSync(descriptor, chunk, 0, length, range.start)
        } finally {
          closeSync(descriptor)
        }
      } catch (error) {
        return jsonFail('dsh-doc-panel/file-failed', messageOf(error))
      }
      const body = bytesRead === length ? chunk : chunk.subarray(0, bytesRead)
      const end = range.start + Math.max(0, bytesRead - 1)
      return new Response(body, {
        status: 206,
        headers: {
          ...headers,
          'content-range': 'bytes ' + range.start + '-' + end + '/' + fileSize,
          'content-length': String(body.byteLength),
        },
      })
    }

    let data
    try {
      data = readFileSync(document.path)
    } catch (error) {
      return jsonFail('dsh-doc-panel/file-failed', messageOf(error))
    }
    return new Response(data, {
      status: 200,
      headers: { ...headers, 'content-length': String(data.byteLength) },
    })
  }

  /**
   * Favorites list, enriched against the current index. Uses the same ensureIndex path
   * as /list without forcing a refresh; if the index cannot be resolved right now the
   * favorites are still returned (everything simply reports available:false).
   */
  async function handleFavorites() {
    let cache = null
    try {
      cache = await ensureIndex(false)
    } catch (error) {
      safeLog(ctx, 'debug', 'dsh-doc-panel: favorites listed without index: ' + messageOf(error))
    }
    return jsonOk({ favorites: enrichFavorites(cache, getFavorites()) })
  }

  /** Add or remove one favorite, persist atomically, then return the enriched list. */
  async function handleFavoritesToggle(request) {
    const body = await readJsonBody(request)
    const rawPath = typeof body?.path === 'string' ? body.path.trim() : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (rawPath === '' || name === '' || toAbsolutePath(rawPath) === null) {
      return jsonFail('dsh-doc-panel/bad-request', 'body must be {"path":"<absolute path>","name":"<file name>", ...}')
    }
    const result = toggleFavorite(
      getFavorites(),
      {
        path: rawPath,
        name,
        conversationId: typeof body?.conversationId === 'string' ? body.conversationId : '',
        conversationTitle: typeof body?.conversationTitle === 'string' ? body.conversationTitle : '',
      },
      Date.now(),
    )
    saveFavorites(result.favorites)
    let cache = null
    try {
      cache = await ensureIndex(false)
    } catch (error) {
      safeLog(ctx, 'debug', 'dsh-doc-panel: favorites toggled without index: ' + messageOf(error))
    }
    return jsonOk({ favorites: enrichFavorites(cache, result.favorites), favorited: result.favorited })
  }

  async function handleDiag() {
    let cache
    try {
      cache = await ensureIndex(false)
    } catch (error) {
      return jsonFail('dsh-doc-panel/unavailable', messageOf(error))
    }
    const diag = cache.diag ?? { complete: false }
    // Live favorites count: toggles must show up without waiting for an index refresh.
    return jsonOk({ ...diag, favorites: favoritesDiag() })
  }

  /** Wrap a handler so a bug can never reject the route promise. */
  function guarded(handler) {
    return async (request) => {
      try {
        return await handler(request)
      } catch (error) {
        safeLog(ctx, 'warn', 'dsh-doc-panel: route handler failed: ' + messageOf(error))
        return jsonFail('dsh-doc-panel/internal', messageOf(error))
      }
    }
  }

  // ----- registration --------------------------------------------------------

  try {
    if (typeof ctx?.inject !== 'function') return
    ctx.inject(['connection'], (injection) => {
      let connection = null
      try {
        connection = injection.get('connection')
      } catch {
        connection = null
      }
      const register = typeof connection?.fetch?.register === 'function' ? connection.fetch.register.bind(connection.fetch) : undefined
      if (register === undefined) {
        safeLog(ctx, 'warn', 'dsh-doc-panel: connection.fetch.register is unavailable; routes not registered')
        return
      }

      // Every route carries requestBody: the connection fetch route type requires it
      // for all methods, GET included (the GET handlers simply never read the body).
      // register() returns the disposer, which the effect uses as its cleanup callback.
      const routes = [
        {
          label: 'dsh-doc-panel: list route',
          options: {
            path: '/api/dsh-doc-panel/list',
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: guarded(handleList),
          },
        },
        {
          label: 'dsh-doc-panel: read route',
          options: {
            path: '/api/dsh-doc-panel/read',
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: guarded(handleRead),
          },
        },
        {
          label: 'dsh-doc-panel: file route',
          options: {
            path: '/api/dsh-doc-panel/file',
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: guarded(handleFile),
          },
        },
        {
          label: 'dsh-doc-panel: favorites route',
          options: {
            path: '/api/dsh-doc-panel/favorites',
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: guarded(handleFavorites),
          },
        },
        {
          label: 'dsh-doc-panel: favorites toggle route',
          options: {
            path: '/api/dsh-doc-panel/favorites/toggle',
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: guarded(handleFavoritesToggle),
          },
        },
        {
          // Diagnostics, also mirrored on GET so the persisted cache can be checked from
          // a plain URL as well as from POST.
          label: 'dsh-doc-panel: diag route',
          options: {
            path: '/api/dsh-doc-panel/diag',
            methods: ['POST', 'GET'],
            requestBody: 'buffered',
            fetch: guarded(handleDiag),
          },
        },
      ]

      for (const route of routes) {
        try {
          injection.effect(() => register(route.options), route.label)
        } catch (error) {
          safeLog(ctx, 'warn', 'dsh-doc-panel: could not register ' + route.options.path + ': ' + messageOf(error))
        }
      }
    })
  } catch (error) {
    safeLog(ctx, 'warn', 'dsh-doc-panel: plugin setup failed: ' + messageOf(error))
  }

  // ----- warm index on startup ----------------------------------------------
  // The panel is the only /list caller and it may not be opened for a while, so kick
  // one scan shortly after activation. This is the same ensureIndex path /list uses
  // (in-flight de-duplication, TTL, persistence); the timer is created inside an
  // effect, so unloading the plugin cancels it. No second scanner.
  if (cfg.warmOnStartup) {
    const scheduleWarmScan = () => {
      const timer = setTimeout(() => {
        try {
          // A /list (or a previous warm pass) already populated the cache: nothing to do.
          if (state.cache !== null) return
          ensureIndex(false).catch((error) => {
            safeLog(ctx, 'debug', 'dsh-doc-panel: startup scan skipped: ' + messageOf(error))
          })
        } catch (error) {
          safeLog(ctx, 'debug', 'dsh-doc-panel: startup scan skipped: ' + messageOf(error))
        }
      }, WARM_STARTUP_DELAY_MS)
      // Never keep the Host process alive just for the warm scan.
      if (typeof timer?.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    }
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => scheduleWarmScan(), 'dsh-doc-panel: startup index scan')
      } else {
        scheduleWarmScan()
      }
    } catch (error) {
      safeLog(ctx, 'debug', 'dsh-doc-panel: startup scan could not be scheduled: ' + messageOf(error))
    }
  }
}
