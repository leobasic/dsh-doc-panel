# Configuration

The Host half reads its options from the plugin row's `config` object (the row
`cordis.patch.yml` inserts). Every key is optional; unknown keys are ignored. The client
half has no configuration — it renders whatever the Host returns.

## Example

```yaml
- id: dsh-doc-panel
  name: dsh-doc-panel
  config:
    extensions: ['.md', '.markdown', '.html', '.htm', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt']
    maxFiles: 5000            # total workspace files per refresh
    maxDepth: 6               # directory depth below each conversation workspace
    cacheTtlMs: 60000         # index freshness window
    cachePath: null           # null = <defaultDirectory>/.dsh-doc-panel/index.json
    favoritesPath: null       # null = <defaultDirectory>/.dsh-doc-panel/favorites.json
    timeoutMs: 180000         # hard scan deadline (partial index on expiry)
    warmOnStartup: true       # background scan shortly after activation
```

## Key reference

| Key | Type | Default | Effect |
|---|---|---|---|
| `extensions` | `string[]` | `.md .markdown .html .htm .pdf .docx .doc .xlsx .xls .pptx .ppt` | Types listed, scanned and previewed; entries may omit the dot, are lower-cased and deduped. Empty/invalid values fall back to the default. The same list gates medium-tier path extraction, so adding `.csv`/`.txt` works end-to-end. |
| `maxFiles` | integer | `5000` | Cap on workspace files collected per refresh (clamped 1–200 000). Hitting it is a design limit, not an incomplete scan. |
| `maxDepth` | integer | `6` | Maximum directory depth below each workspace (clamped 0–64). |
| `cacheTtlMs` | integer | `60000` | Index freshness window (0–86 400 000 ms). Within it `/list` returns immediately; after it the Host refreshes incrementally. |
| `cachePath` | `string \| null` | `null` | Persisted index location. Absolute, or relative to `<defaultDirectory>`. Never reused for favorites. |
| `favoritesPath` | `string \| null` | `null` | Favorites store location. Absolute, or relative to `<defaultDirectory>`. |
| `timeoutMs` | integer | `180000` | Hard scan deadline (1 s–30 min). On expiry the partial index is returned and `diag.complete` is `false`. |
| `warmOnStartup` | boolean | `true` | Schedules one background scan ~2.5 s after activation; skipped if `/list` already built the cache. `false` scans on first open only. |

`<defaultDirectory>` is `ctx.get('workingDirectory').defaultDirectory` (the DSH profile
directory on a normal install); if unavailable the Host falls back to `~/.dsh`.

## Files on disk

| File | Shape | Notes |
|---|---|---|
| `<defaultDirectory>/.dsh-doc-panel/index.json` | `{ version: 1, generatedAt, diag, conversations }` | Persisted index, written atomically (temp file + rename). Contains no events or per-session signals; safe to delete — the next `/list` rebuilds it. |
| `<defaultDirectory>/.dsh-doc-panel/favorites.json` | `{ version: 1, updatedAt, favorites: [{ path, name, conversationId, conversationTitle, addedAt }] }` | Written atomically on each toggle. Identity is the case-insensitive normalized absolute path (original casing kept); capped at 1000, oldest `addedAt` dropped first. |

Missing files/directories are normal (empty index rebuild / empty favorites). Malformed
JSON, a wrong `version` or malformed entries are discarded defensively; for favorites
the file is left untouched until the next write. Nothing else is written.

## HTTP API

Routes are mounted under `/api/dsh-doc-panel/` on the Harness Host connection service,
same-origin and authenticated by the Web session. Every response is HTTP 200 with:

```json
{ "ok": true,  "value": { } }
{ "ok": false, "error": { "code": "dsh-doc-panel/<kind>", "message": "…" } }
```

Codes: `dsh-doc-panel/unavailable`, `bad-request`, `not-found`, `read-failed`,
`file-failed`, `internal`.

### `POST /api/dsh-doc-panel/list`

Body `{}`, or `{ "refresh": true }` to bypass the TTL.

```json
{ "ok": true, "value": {
  "generatedAt": 1760000000000, "version": 1,
  "totalConversations": 3, "totalDocuments": 12,
  "conversations": [{
    "id": "<root session id>", "title": "<conversation title>",
    "createdAt": 1760000000000, "updatedAt": 1760000500000,
    "workspace": "<workspace path>", "sessionCount": 2,
    "counts": { "byKind": { "md": 3, "pdf": 1 } },
    "documents": [{ "path": "<workspace>/notes/report.md", "relPath": "notes/report.md",
      "name": "report.md", "ext": ".md", "kind": "md", "size": 12034,
      "mtime": 1760000500000, "delivered": true, "authored": true,
      "sessionId": "<producing session id>" }]
  }]
} }
```

### `POST /api/dsh-doc-panel/read`

Body `{ "path": "<absolute path>" }`; only indexed paths are accepted. Text previews are
capped at 300 000 characters and report the real file size:

```json
{ "ok": true, "value": { "kind": "text", "text": "# Title\n…", "bytes": 12034, "truncated": false } }
{ "ok": true, "value": { "kind": "binary", "url": "api/dsh-doc-panel/file?p=<encoded path>", "mime": "application/pdf" } }
```

Text kinds are `md`, `html`, `csv`, `txt`, and `other` with a text extension
(`.json`, `.xml`, `.log`); everything else returns the binary form.

### `GET /api/dsh-doc-panel/file?p=<encoded absolute path>`

Raw bytes for an indexed path. `content-type` follows the extension (`application/pdf`,
`text/plain; charset=utf-8` for `.md`/`.txt`, `text/csv`, `text/html`, OpenXML/legacy
Office types, otherwise `application/octet-stream`). PDF/HTML/text-like extensions use
`content-disposition: inline`, others an RFC 5987 attachment. `Range: bytes=a-b` yields
`206`; non-indexed or non-regular paths return the JSON error envelope.

### `POST /api/dsh-doc-panel/favorites`

Body `{}`; newest `addedAt` first. `available` is true only when the path is in the
current index.

```json
{ "ok": true, "value": { "favorites": [{
  "path": "<absolute path>", "name": "report.md",
  "conversationId": "<root session id>", "conversationTitle": "<conversation title>",
  "addedAt": 1760000600000, "available": true,
  "kind": "md", "size": 12034, "mtime": 1760000500000
}] } }
```

### `POST /api/dsh-doc-panel/favorites/toggle`

Body `{ "path": "<absolute path>", "name": "<file name>", "conversationId": "<id>", "conversationTitle": "<title>" }`.
Adds the favorite or removes it when the normalized path already exists; `favorited`
says which happened, and the response carries the same enriched list. A missing/relative
path or empty name returns `{ "ok": false, "error": { "code": "dsh-doc-panel/bad-request", … } }`.

### `POST|GET /api/dsh-doc-panel/diag`

```json
{ "ok": true, "value": {
  "phaseMs": { "list": 1, "readSessions": 6800, "scan": 27, "attribute": 11 },
  "sessionCount": 53,
  "failedSessions": [{ "id": "<session id>", "error": "…" }],
  "fileCount": 114, "attributed": 113, "unattributed": 1,
  "cachedAt": 1760000700000, "complete": true,
  "cachePath": "<defaultDirectory>/.dsh-doc-panel/index.json",
  "favorites": { "count": 2, "path": "<defaultDirectory>/.dsh-doc-panel/favorites.json" }
} }
```

## Behaviour notes

- `refresh: true` skips the TTL but stays incremental (only live sessions whose sequence
  advanced are re-read); concurrent list calls share one refresh.
- The persisted index also stores a `diag` snapshot incl. a favorites count at write
  time; the `/diag` route is the live source of truth.
- Directory exclusion is fixed in code (vendor/build/asar/dot directories, dot/underscore
  file names) and not configurable; change document types with `extensions`.
