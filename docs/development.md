# Development

The repository is a DeepSeek Harness (DSH) plugin bundle: plain ESM, no build step, no
runtime dependencies. `index.js` is the Host half (Node), `client.js` is the Web half
(loaded as-is by the Harness module loader), and `cordis.patch.yml` wires the plugin row.

## Requirements

- Node.js `>= 22.19.0` (the bundled DSH runtime is fine).
- A DSH installation `>= 0.2.0-rc.2` (see `engines` in `package.json`).
- Nothing else: no `npm install`, no bundler, no TypeScript.

## Repository layout

```
index.js                 Host half: signals, attribution, scan, cache, favorites, routes
client.js                Web half: slots, dashboard, markdown renderer, previews, favorites UI
cordis.patch.yml         bundle patch that inserts the plugin row
package.json             bundle manifest (exports, dsh bundle/client fields, scripts)
locale/zh.json, en.json  plugin metadata strings (UI strings are inside client.js)
icon.svg                 sidebar/plugin icon
docs/                    architecture, configuration, privacy, development (this file)
test/                    portable synthetic-fixture suites (no framework, plain node ESM)
scripts/static-check.mjs release/privacy/static checks
scripts/test-all.mjs     aggregate test runner (also `npm test`)
scripts/dev/             developer-only, real-corpus helpers (not shipped; see below)
assets/                  README screenshots
.github/                 CI (test-all + npm pack), release workflow, issue/PR templates
LICENSE, README.md, README.zh.md, CHANGELOG.md, CONTRIBUTING.md,
CODE_OF_CONDUCT.md, SECURITY.md
```

`package.json` `files` controls what reaches npm: `index.js`, `client.js`,
`cordis.patch.yml`, `locale/*.json`, `icon.svg`, `README*.md`, `LICENSE`. Tests,
scripts, docs, assets and `.github/` stay in the repository only.

## Local installation

Use the Harness plugin manager with the absolute path of this checkout (no build step
is involved — the files are used as written):

```
plugin_manager({ action: "install_bundle", target: "/path/to/dsh-doc-panel" })
```

Remove with `plugin_manager({ action: "remove_bundle", target: "dsh-doc-panel" })`.
After editing either half, uninstall + install (or restart the app) so the Host module
and client bundle are reloaded; there is no hot reload guarantee for a linked bundle.
The plugin then appears as a documents icon in the sidebar (`sidebar.panellist`, order
30) and as the `dsh-doc-panel` main panel.

## Checks and tests

Everything runs with the Node binary your Harness installation bundles (or any Node
≥ 22.19):

```
node --check index.js          # Host syntax
node --check client.js         # client syntax
npm run check                  # both of the above
npm test                       # node scripts/test-all.mjs (all suites)
node scripts/static-check.mjs  # manifest/locale/icon/forbidden-pattern checks
node test/host-scan.test.mjs   # Host: signals, scan, attribution against fixtures
node test/host-favorites.test.mjs  # Host: favorites helpers/routes
node test/client-render.test.mjs   # client: offline React-tree render + markdown
node test/client-explorer.test.mjs # client: explorer/favorites UI smoke
npm run pack:check             # npm pack --dry-run: verify the published file list
```

Suites print per-check PASS/FAIL lines and a `*_SUMMARY` JSON block; a non-zero exit
means at least one hard failure. Tests do not need a running Harness instance. The
GitHub Actions CI workflow runs `node scripts/test-all.mjs` on Node 22 and 24 and then
`npm pack --dry-run`; the release workflow publishes on `v*` tags.

## Synthetic fixtures only

The committed test suite must never depend on a real user's session corpus or
workspace. Fixtures are built from small, synthetic session records shaped exactly
like `extractSessionSignals` output:

```
{ id, header: { id, cwd, parentSession, createdAt, delegationDepth },
  title, firstTime, lastTime, turns: [{ turn, start, end }],
  refs: [{ path, strong, delivered, authored, time }] }
```

Tests create their workspace trees under the OS temporary directory (never inside the
repository), use placeholder conversation titles/paths, and assert attribution,
folding, cache and favorites behavior deterministically. Any fixture generated from a
real corpus is local output: `test/fixture.json` and `test/.local/` are git-ignored,
and generated data must never be committed or pasted into issues/PRs.

## Developer-only real-corpus scripts

`scripts/dev/` holds helpers that read a local DSH profile (session logs, caches) for
manual verification, for example regenerating a fixture from a real session corpus
(`make-fixture.mjs`) or diffing a live persisted index against offline expectations
(`live-verify.mjs`). Rules for these scripts:

- take explicit configuration (`DSH_SESSIONS_ROOT`, `DSH_DOC_CACHE`,
  `DSH_DOC_WORKSPACE`, `--sessions-root`, `--cache`, `--out`, …); never hardcode a
  machine path or username;
- by default write output to an OS temporary file (`DSH_FIXTURE_OUT` /
  `DSH_LIVE_VERIFY_OUT` or `--out`); scratch output under `test/.local/` is
  git-ignored if you choose it;
- are not run by `npm test` or CI;
- treat their input and output as personal data — do not commit, attach or quote it.

## Adding a document kind

1. **Host** — add the extension to the default list (`DEFAULT_EXTENSIONS` in
   `index.js`) or let users configure it through `config.extensions`; map it in
   `normalizeDocKind()`; if the type needs preview behavior, add its MIME type to
   `MIME_BY_EXTENSION` and decide `INLINE_EXTENSIONS` for the raw route.
2. **Client** — map the kind in `kindKey()` (aliases), give it an accent in
   `KIND_COLORS` using `--dsw-alias-*` tokens (no literal colors), and add the badge
   label under `type.<kind>` in both the `zh` and `en` dictionaries in `client.js`.
3. **Tests** — extend the fixture document set and the kind mapping assertions; run
   `npm run check`, `npm test`, `node scripts/static-check.mjs`.

Unknown kinds are handled defensively: the Host maps them to `other`, the client
badges them as `type.other`.

## Debugging

- **Diagnostics route** — `POST|GET /api/dsh-doc-panel/diag` returns phase timings,
  session count, `failedSessions`, file/attributed/unattributed counts, the cache
  path, `complete`, and the favorites count/path. From the Web app's devtools console:
  `fetch('api/dsh-doc-panel/diag',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(console.log)`
- **Cache files** — inspect `<defaultDirectory>/.dsh-doc-panel/index.json` for the
  persisted conversations/documents and `favorites.json` for the store. Delete either
  to force a rebuild/reset; they are plain JSON.
- **Scan control** — `warmOnStartup: false` stops the startup timer; `{ "refresh": true }`
  on `/list` bypasses the TTL; `timeoutMs` bounds a scan. Slow scans usually mean a
  large session log or a workspace with many files (`maxFiles`/`maxDepth`).
- **Client** — watch the browser console; the client logs fetch/render failures and
  never throws during render. Slot issues: inspect the `sidebar.panellist` and `main`
  slot trees; the registrations are `dsh-doc-panel` (id and main key).
- **Rendering** — `client.js` exposes `__renderMarkdown(text, h)` on its module object
  for offline inspection of the Markdown renderer without a browser.
- **Unattributed documents** — compare `diag.unattributed` with the workspace scan;
  files created while no turn was running typically need a `write`/`present` reference
  or will be attributed on a later scan.

## Release checklist

- no personal paths/usernames/titles in committed files (`grep -R` for the usual
  suspects before publishing);
- `npm run check && npm test && node scripts/static-check.mjs && npm run pack:check`;
- README/docs match the code (route names, config keys, defaults);
- version bumped in `package.json` and `CHANGELOG.md` updated.
