# 0001 — ChatGPT-compatible `search`/`fetch` plus typed tools for Claude

## Context

Two hosted research clients must use the same MCP server. ChatGPT's Deep Research only uses connector tools named `search` (input `{ query }`, output `{ results: [{ id, title, url }] }`) and `fetch` (input `{ id }`, output `{ id, title, text, url, metadata }`), and needs `structuredContent` plus the same JSON as text. Claude Research can call arbitrary tools with structured inputs and benefits from batch reads, explicit site selection, and a cursor. Claude also caps a tool result at about 150,000 characters.

## Decision

Expose exactly five tools: `search` and `fetch` in ChatGPT's shape (extra keys such as `publishedAt`, `site`, `excerpt`, `nextPage`, `siteStatuses` allowed), and `search_sites`, `read_documents` (1–5 refs), and `list_sites` for Claude. Both families share one search and one read service; budgets keep both copies of a `fetch` result under Claude's cap (60,000 characters of text) and split `read_documents` across 120,000 characters.

## Alternatives

- **Only `search`/`fetch`**: works in both clients, but Claude would have to encode site selection, dates, and paging in a free-text string and read one article per call, which wastes turns inside a 240-second-per-call, tens-of-calls session.
- **Only typed tools**: ChatGPT Deep Research would not use the connector at all.
- **Separate servers per client**: two OAuth resources, two connectors, and duplicated logic for one user.

## Consequences

- `search`/`fetch` shapes can never be changed to suit Claude; changes go into the typed tools.
- Every tool has to be maintained in two encodings (`structuredContent` + text for the ChatGPT pair, text only for the typed tools).
- The tool set is closed at five; any new capability must fit into one of them or be a deliberate contract change for both clients.
- Per-client tool scoping is not possible today: every authenticated client sees all five tools.
