#!/usr/bin/env node
// test-all.mjs — portable test orchestrator for dsh-doc-panel.
//
// Runs from the repository root (resolved from this file, not from the cwd), with the
// current `node` binary and no external dependencies. Every step runs as a child
// process with inherited stdio so its own PASS/FAIL lines stay visible; this script
// prints one summary line per suite and exits non-zero if any suite fails.
//
// Usage: node scripts/test-all.mjs

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath

const steps = [
  { label: 'syntax index.js', file: 'index.js', args: ['--check', 'index.js'] },
  { label: 'syntax client.js', file: 'client.js', args: ['--check', 'client.js'] },
  { label: 'client-render', file: 'test/client-render.test.mjs', args: ['test/client-render.test.mjs'] },
  { label: 'client-explorer', file: 'test/client-explorer.test.mjs', args: ['test/client-explorer.test.mjs'] },
  { label: 'host-scan', file: 'test/host-scan.test.mjs', args: ['test/host-scan.test.mjs'] },
  { label: 'host-favorites', file: 'test/host-favorites.test.mjs', args: ['test/host-favorites.test.mjs'] },
  { label: 'static-check', file: 'scripts/static-check.mjs', args: ['scripts/static-check.mjs'] },
]

function line(ok, label, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  [test-all] ${label}${extra ? ` — ${extra}` : ''}`)
  return ok
}

const results = []
for (const step of steps) {
  if (!fs.existsSync(path.join(ROOT, step.file))) {
    results.push({ ok: false, label: step.label, detail: `missing ${step.file}` })
    line(false, step.label, `missing ${step.file}`)
    continue
  }
  console.log(`\n===== ${step.label}: node ${step.args.join(' ')} =====`)
  const run = spawnSync(NODE, step.args, { cwd: ROOT, stdio: 'inherit', env: process.env })
  if (run.error) {
    results.push({ ok: false, label: step.label, detail: `spawn failed: ${run.error.message}` })
    line(false, step.label, `spawn failed: ${run.error.message}`)
    continue
  }
  const ok = run.status === 0
  results.push({ ok, label: step.label, detail: ok ? '' : `exit code ${run.status}` })
  line(ok, step.label, ok ? '' : `exit code ${run.status}`)
}

const failed = results.filter((r) => !r.ok)
console.log('\nTEST_ALL_SUMMARY ' + JSON.stringify({
  root: ROOT,
  suites: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed.map((r) => `${r.label}${r.detail ? ` (${r.detail})` : ''}`),
}))
console.log(failed.length === 0 ? 'ALL SUITES PASSED' : `FAILED SUITES: ${failed.map((r) => r.label).join(', ')}`)
process.exitCode = failed.length ? 1 : 0
