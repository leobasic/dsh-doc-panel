# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Please report security issues privately through GitHub's
[Security Advisories](https://github.com/leobasic/dsh-doc-panel/security/advisories/new)
("Report a vulnerability"). Do not open a public issue for a vulnerability before a fix
is available. Include the plugin version, the DSH version, reproduction steps, and impact.

## Scope and design notes

`dsh-doc-panel` is a local, single-user plugin. It has no network code, no telemetry, no
credentials, and no runtime dependencies. Its security-relevant behavior is:

- **Reads local data through Host services.** Conversation history comes from the Harness
  session query service; documents are read from the workspace directories of the
  conversations in the index. Only configured document extensions are listed, and
  harness-internal, hidden, and build/dependency directories are ignored.
- **Writes only plugin state.** An index cache and a favorites file under the DSH profile
  directory, both written atomically. Favorites store document paths and conversation
  titles; they contain no document contents.
- **Serves files over an allow-list.** The raw-file route serves only paths present in the
  current index. It refuses non-regular files and symlinks and supports HTTP range reads.
- **Sandboxes rendered HTML.** HTML documents are previewed inside
  `<iframe sandbox="allow-scripts allow-downloads">` with no `allow-same-origin`, so a
  document's scripts run without access to the Harness application origin, cookies, or
  storage. Markdown is rendered into React elements; raw HTML inside Markdown is shown as
  text and never executed.
- **Trust boundary.** Documents are assumed to be produced or downloaded by the user's own
  conversations. Opening a preview is equivalent to opening that local file yourself.

## Out of scope

- Vulnerabilities in DeepSeek Harness itself (report them to the Harness project).
- Malicious documents the user deliberately generated or downloaded.
- Data exposure by another plugin or by the OS account being shared.
