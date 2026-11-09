# Privacy

`dsh-doc-panel` runs entirely on your machine and inside your own Harness profile.

**The plugin makes no network requests and embeds no telemetry.** It has no analytics,
crash reporting, update checks or remote configuration. The only network traffic is
your browser talking to your own Harness server: `client.js` calls the same-origin
`/api/dsh-doc-panel/*` routes over the existing authenticated session. No CDN, fonts,
scripts, images or documentation snippets are fetched, and there is no runtime
dependency to supply them.

## What the plugin reads

| Source | How | Why |
|---|---|---|
| Session corpus | Through the Host `sessionQuery` service (`listSessions`, `readSession`, `observeSession` fallback) | Derive conversations, titles, turn times and document references. The plugin never opens session log files itself; decoding is done by the Harness service. |
| Conversation workspaces | `fs` reads directory entries and file metadata (`path`, `size`, `mtime`) | Find document files by extension. File **contents** are read only when you preview a document (`/read` text preview or `/file` bytes). |
| Referenced file metadata | `fs.stat` on document paths referenced by tool calls | Confirm a referenced file still exists outside the scanned workspace before listing it. |

The index keeps only compact summaries: conversation title, timestamps, absolute file
paths, sizes, mtimes and producing session ids. It does not keep message text, tool
output or file contents, and the persisted index contains none of these either.

## What the plugin writes

Only two files, both under the Harness default directory
(`<defaultDirectory>/.dsh-doc-panel/` by default; `cachePath` / `favoritesPath` can
override):

| File | Contents | Lifetime |
|---|---|---|
| `index.json` | `{ version, generatedAt, diag, conversations }` | Cache. Safe to delete; rebuilt on the next scan. |
| `favorites.json` | `{ version, updatedAt, favorites: [{ path, name, conversationId, conversationTitle, addedAt }] }` | Durable user state. Deleted only by you. |

Both are written atomically (temporary file + rename). The plugin writes no logs of
its own (failure diagnostics only go to the Host logger when debug logging is enabled),
no databases, no environment files and nothing to the session corpus.

## Sandboxed HTML and safe previews

A conversation can produce any HTML file, including hostile content. The client
previews HTML inside an iframe served from the raw-file route with:

```html
<iframe sandbox="allow-scripts allow-downloads" src="…/api/dsh-doc-panel/file?p=…"></iframe>
```

`allow-scripts` lets the page's own scripts run (otherwise many legitimate reports
would render blank). The deliberate omission of `allow-same-origin` puts the frame in
an opaque origin, so the page cannot read the Harness application DOM, cookies,
`localStorage` or the authenticated API, and without `allow-top-navigation` it cannot
navigate the app tab. Note that scripts in a previewed HTML file can still make their
own network requests subject to browser rules; preview only documents you trust.

Markdown is rendered by a small pure parser into React elements — never through
`innerHTML` — so raw HTML inside Markdown is displayed as text, not executed. Links
are limited to `http`, `https` and `mailto`; relative assets are not resolvable;
Markdown images from absolute paths go through the raw route, while `http(s)`/`data:`
image URLs are left to the browser (they are document content, not plugin traffic).

## Allow-lists and unavailable favorites

`/read` and `/file` accept only paths present in the **current index**. The raw route
additionally refuses non-regular files and symlinks, so an indexed path cannot be
swapped for a link outside the workspace. Favorites are a separate store: an entry
whose document has disappeared stays in the list with `available: false` and `null`
metadata, the UI disables opening it, and the server would refuse it anyway because
it is not in the index.

## Reducing what is indexed

- **Document types** — set `config.extensions` to the only extensions you want
  listed/scanned; anything else is ignored (for both the workspace scan and reference
  extraction).
- **Directories** — vendor/build/asar/dot directories are always skipped, and file
  names starting with `.` or `_` are never listed. An underscore-prefixed *directory*
  is still walked, so name private *files* with a leading `_`/`.` (or move them into a
  dot directory) if you need them skipped. There is no per-directory include list;
  conversation workspaces are whatever the sessions used as cwd.
- **Everything at once** — delete `.dsh-doc-panel/index.json` and stop the plugin
  (or set `warmOnStartup: false` and never open the panel). `favorites.json` can be
  deleted to reset the favorites list.

## Threat model

| Scenario | Exposure | Mitigation |
|---|---|---|
| Malicious HTML document in a conversation | Scripts run in the preview iframe | Opaque origin (`allow-scripts`, no `allow-same-origin`), no top navigation, no plugin API access; do not trust previewed content beyond that |
| Malicious Markdown | Raw HTML is escaped; links restricted to http(s)/mailto | Rendered as React elements, never `innerHTML` |
| Untrusted local files | A file listed in the panel may be read by the Host when previewed | Reads are limited to indexed paths and regular files; content never leaves the machine |
| Symlink swap between scan and preview | Path could resolve outside the workspace | Raw route uses `lstat` and refuses symlinks/non-regular files |
| Shared machine | `index.json` / `favorites.json` contain absolute paths, conversation titles and document names in plain text | Rely on OS profile permissions; delete the files before handing the machine over; the plugin adds no encryption |
| Stale cache | The panel can show a document that was deleted or moved | `/read` and `/file` fail closed with `not-found`; refresh re-stats files |
| Third-party networking from document content | Remote images/links inside a previewed document can load from the network | That traffic is the document's, not the plugin's; preview untrusted content deliberately |

## What is never collected

No usage statistics, no file contents in the cache, no message text, no credentials,
no machine identifiers, no author metadata. The open-source repository itself contains
no user data: tests run on synthetic fixtures, and developer-only scripts that read a
real session corpus must not commit their output (see `docs/development.md`).
