# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-09

### Fixed

- Relative document references (`write`/`edit` file paths and paths mentioned by
  write-capable tools) now resolve against a POSIX working directory as well as a
  Windows one, so Linux and macOS workspaces attribute documents correctly. Added a
  cross-platform regression test; the CI matrix (Node 22 and 24) is green.

## [0.1.0] - 2026-11-09

First public release.

### Added

- Sidebar entry and dashboard panel listing only the conversations that produced documents.
- Conversation-granular index derived from the session corpus: `write`/`edit`/`present`
  references, write-capable tool argument paths, workspace scan, and turn-time-window
  attribution, with child/subagent sessions folded into their root conversation.
- Dashboard UI: conversation count / document count / favorites / weekly additions KPIs,
  seven-day sparkline, document-type donut with legend, conversation card grid with
  composition rings and summaries, folder table view, cross-conversation search, and
  favorites as a card grid.
- Inline previews: rendered Markdown (React element tree, no `innerHTML`), sandboxed
  HTML iframe (`allow-scripts`, no `allow-same-origin`), embedded PDF, Office download cards.
- Durable favorites stored as JSON with atomic writes, plus index caching with TTL,
  incremental refresh, warm-on-startup scan, and a diagnostics route.
- English and Chinese UI dictionaries, light/dark theme token styling, zero runtime dependencies.
- Offline test suites and a static check script; portable synthetic fixtures keep real
  conversation data out of the repository.
