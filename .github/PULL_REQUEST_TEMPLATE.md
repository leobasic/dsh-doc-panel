## What does this change?

<!-- One or two sentences. Link the issue if there is one. -->

## Why?

<!-- The user-facing problem this solves. -->

## How was it verified?

<!-- Commands you ran and their result. -->
- [ ] `node --check index.js`
- [ ] `node --check client.js`
- [ ] `node scripts/test-all.mjs`
- [ ] `npm pack --dry-run` looks correct (runtime files only)
- [ ] Exercised the change in a running Harness (panel opens, preview works, no console errors)

## Checklist

- [ ] No real conversation titles, absolute machine paths, session logs, or unmasked screenshots are included.
- [ ] No runtime dependency, build step, or Harness Client package import was added.
- [ ] Colors use `--dsw-alias-*` theme tokens only; light and dark themes work.
- [ ] Every new visible string exists in both `zh` and `en` dictionaries.
- [ ] `docs/` and `CHANGELOG.md` are updated when behavior or configuration changed.
