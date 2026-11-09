# Architecture

`dsh-doc-panel` is a DeepSeek Harness (DSH) bundle with two halves:

| Half | File | Runs in | Role |
|---|---|---|---|
| Host | `index.js` | DSH Host (Node ESM) | Reads the session corpus and workspace, builds/persists the document index, serves HTTP routes, owns favorites |
| Client | `client.js` | Harness Web app (browser) | Registers one sidebar entry and one main panel; dashboard, search, previews, favorites UI |

No build step and no runtime dependencies: the Host uses Node builtins, the client uses
the loader-provided `react`, and `cordis.patch.yml` plus the `dsh` manifest fields wire the bundle.

## Data flow

```
  Host services                         conversation workspaces (disk)
  sessionQuery.listSessions()                 |
  sessionQuery.readSession()                  |  collectWorkspaceFiles(cwd)
    (observeSession fallback)                 |  extensions / depth / maxFiles /
        |                                     |  shared ignore rules
        v                                     v
  extractSessionSignals(events)          [{ path, size, mtime }]
        \                                      /
         +-----> buildIndex({sessions, files, config, now})
                          |
             four-tier attribution + child-session folding
                          |
                    { conversations[], counts, totals }
                          |
       in-memory cache (TTL) --atomic write--> <defaultDirectory>/.dsh-doc-panel/index.json
                          |
          POST /list · POST /read · GET /file · POST /favorites
          POST /favorites/toggle · POST|GET /diag
                          |
                     client.js (slots, dashboard, previews)
```

### Session discovery

`ctx.sessionQuery.listSessions()` yields records whose `header` carries `id`,
`createdAt`, `cwd`, `parentSession` and `delegationDepth`. Sessions are read one at a
time with `readSession(id)` so peak memory stays bounded (the largest logs decode to
over 100 MB; only compact signals survive each iteration).

If `readSession` throws, `observeSession(id, { projectionMode: 'none' })` is used and
disposed via `Symbol.dispose`. A `formatStatus: 'migration-required'` record whose
`readSession` result is empty is retried through the observer. Only when both fail
does the session land in `diag.failedSessions`; the rest of the index is still built
and `diag.complete` is `false` while unreadable sessions remain. Scans are hard-capped
by `timeoutMs` (180 s); on expiry the partial index comes back with the same flag.

### Signal reduction

`extractSessionSignals(events)` reduces one log to `title` (last `session/title`,
else the first human user text), `firstTime`/`lastTime` (min/max event time),
`turns[]` = `{ turn, start, end }` (no `turn/end` ⇒ ends at `lastTime`), and
`refs[]` = `{ path, strong, delivered, authored, time }`:

| Source | strong | authored | delivered |
|---|---|---|---|
| `write` / `edit` (`file_path`) | yes | yes | no |
| `present` (`files[].path`) | yes | no | yes |
| Other write-capable tools mentioning an absolute document path | no | no | no |

Read-only tools (`read`, `grep`, `glob`, `skill`, `web_fetch`, job/session/cordis
inspection tools, …) never contribute references — reading a file is not producing
it. Malformed tool arguments are ignored; references are deduped and capped per session.

### Workspace scan

Every distinct session `cwd` is walked (depth ≤ `maxDepth` 6; at most `maxFiles` 5000)
without following symlinks and within the scan deadline. The shared ignore predicate
drops paths with a segment named `node_modules`, `.agents`, `.claude`, `.git`,
`.venv`, `venv`, `__pycache__`, `.dsh-doc-panel`, `dist`, `build`, any dot-segment,
any `*.asar` segment, or a dot/underscore-prefixed file basename (underscore dirs are
still walked). Referenced documents outside scanned workspaces are stat'ed and listed
when they exist.

### Four-tier attribution

Each candidate file maps to exactly one producing session:

1. **Strong reference** — newest strong ref to the normalized path wins.
2. **Medium reference** — newest medium ref wins.
3. **Turn window** — sessions whose cwd contains the file and some turn contains the
   file mtime (60 s slack); closest turn end wins.
4. **Session window** — sessions whose cwd contains the file and whose
   `[firstTime, lastTime]` contains the mtime; closest `lastTime` wins.

A file matched by no tier is counted in `diag.unattributed` and not listed. Identity
is always the case-insensitive, forward-slash-normalized absolute path; same-named
files in different folders are separate documents.

### Conversations

The conversation is the root of the `parentSession` chain: child/subagent sessions
fold into it, so `sessionCount` can exceed 1 while each document keeps the producing
`sessionId`. The id is the root session id, the title is the root title (fallback
`Session <last 6 chars>`), the workspace is the root `cwd`. Conversations sort by
newest document mtime; documents sort by mtime descending; conversations without
documents are omitted.

## Caching and refresh

- **Memory cache** — index, per-session signals and a normalized-path document map,
  fresh for `cacheTtlMs` (default 60 s).
- **Incremental refresh** — re-lists sessions, re-reads only live sessions whose
  `sessions.list()` `seq` advanced (plus unseen/failed ones), reuses closed sessions'
  cached signals, re-walks workspaces and re-attributes. `{ "refresh": true }`
  bypasses the TTL but stays incremental; concurrent requests share one refresh.
- **Persisted index** — atomic write (temp + rename) of
  `{ version, generatedAt, diag, conversations }` to
  `<defaultDirectory>/.dsh-doc-panel/index.json`; it holds no per-session signals, so a
  restart serves it within the TTL but the first refresh after TTL re-reads logs.
- **Warm scan** — `warmOnStartup` (default on) schedules one scan 2.5 s after
  activation through the same `ensureIndex` path (skipped if `/list` already cached,
  cancelled by the plugin effect disposer).

## HTTP surface

| Route | Method | Purpose |
|---|---|---|
| `/api/dsh-doc-panel/list` | POST | Index grouped by conversation |
| `/api/dsh-doc-panel/read` | POST | Text preview (≤ 300 000 chars) or binary URL |
| `/api/dsh-doc-panel/file` | GET | Raw bytes for an indexed path; Range supported |
| `/api/dsh-doc-panel/favorites` | POST | Enriched favorites list |
| `/api/dsh-doc-panel/favorites/toggle` | POST | Add/remove one favorite |
| `/api/dsh-doc-panel/diag` | POST, GET | Scan diagnostics, cache/favorites paths |

Handlers never throw: failures return `{ ok: false, error: { code, message } }` with
HTTP 200. `/read` and `/file` are allow-listed to paths in the current index.

## Favorites

A separate store (`favorites.json`, `favoritesPath` override) holds up to 1000 entries:
normalized path identity, original casing, atomic writes, lazy defensive load. Responses
enrich each entry from the current index (`available`, `kind`, `size`, `mtime`);
unavailable entries stay listed with `null` fields and cannot be opened because the
read/file allow-list is unchanged.

## Client half

`client.js` registers `sidebar.panellist` (id `dsh-doc-panel`, order 30) and `main`
(key `dsh-doc-panel`) through `ctx.slots.inject`, plus its zh/en dictionaries through
`ctx.effect`, so everything is disposed with the plugin. The panel is a dashboard: KPI
tiles, document-type donut, conversation cards with composition rings, folder table,
cross-conversation search, favorites and preview views. Markdown renders to React
elements by a pure renderer (no `innerHTML`); HTML displays in
`<iframe sandbox="allow-scripts allow-downloads">` (no `allow-same-origin`); PDFs embed
through the raw route; Office files get a metadata/download card. Styling uses
`--dsw-alias-*` theme tokens only.

## Why attribution is heuristic

The log never says “this turn created that file”, so the Host infers it. Known limits,
all visible in `diag`: mtime windows can match several sessions (closest turn end wins,
and late modifications need a reference); medium references prove intent, not
authorship; files created while no turn ran may stay unattributed; a live session is read
at its current state; a permanently unreadable legacy log keeps `diag.complete` false
even though everything else is complete (`diag.failedSessions` names it).
