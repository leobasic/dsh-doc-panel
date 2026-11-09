# Contributing

Thanks for taking the time to improve `dsh-doc-panel`.

## Ground rules

- **No real user data in the repository.** This plugin reads conversation history and
  workspace files. Never commit session logs, generated indexes/favorites, real
  conversation titles, absolute paths from your machine, or screenshots that show them.
  Tests use synthetic fixtures (see `docs/development.md`).
- **No runtime dependencies.** The plugin is plain JavaScript loaded by the Harness
  module loader. Do not add a build step, a bundler, or an npm dependency for the shipped code.
- **Match the host UI.** Use only `--dsw-alias-*` theme tokens for colors, keep light and
  dark themes working, and register resources through the plugin context so they unload cleanly.
- **Keep locale parity.** Every visible string lives in `client.js` dictionaries with
  complete `zh` and `en` entries. `scripts/test-all.mjs` fails on parity gaps.

## Development setup

1. Clone the repository:

   ```bash
   git clone https://github.com/leobasic/dsh-doc-panel.git
   cd dsh-doc-panel
   ```

2. Install it into a DeepSeek Harness profile (this links the checkout, so edits need only
   a plugin reload rather than a reinstall):

   ```js
   plugin_manager({ action: 'install_bundle', target: '/absolute/path/to/dsh-doc-panel' })
   ```

3. Reload the plugin (or the app) and open the documents icon in the left sidebar.

## Checks

Run these before opening a pull request:

```bash
node --check index.js
node --check client.js
node scripts/test-all.mjs
npm pack --dry-run    # confirms the published file list
```

CI runs the same suite on Node 22 and Node 24 for every push and pull request.

## Code conventions

- Plain ESM in `index.js` (Host half) and a `window.__ModuleLoader__` factory in
  `client.js` (Client half). No TypeScript, no JSX, no imports of Harness Client packages.
- Never use `innerHTML`, `dangerouslySetInnerHTML`, or `document.body` writes in the client.
- Host route handlers must never throw: return `{ ok: false, error }` instead.
- Persist plugin-owned state atomically (temporary file + rename) and under the profile
  directory; never write into a user's workspace.
- Add or update the relevant file in `docs/` when behavior or configuration changes.

## Pull requests

- Keep pull requests focused; describe the user-visible change and the verification you ran.
- Update `CHANGELOG.md` under an "Unreleased" section for user-visible changes.
- Screenshots are welcome but must not show real conversation titles, file names, or
  absolute paths; mask or use a demo dataset.
