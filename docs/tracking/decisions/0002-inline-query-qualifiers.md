# 0002 — Inline query qualifiers instead of JSON in the query string

## Context

ChatGPT's `search` accepts a single string. Site restriction, a date window, page size, and page number have to travel inside that string. Research models emit free text reliably but emit JSON inside a string field unreliably (quoting and escaping errors).

## Decision

Free text plus whitespace-separated qualifiers anywhere in the string: `site:` (repeatable), `after:`/`before:` (`YYYY-MM-DD`), `limit:`, `page:`. An invalid qualifier value degrades to search text; out-of-range numbers are clamped; an unknown site is reported as `unsupported` and ignored. `search_sites` accepts the same string and structured fields that win over the qualifiers.

## Alternatives

- **JSON in the query string**: one malformed quote turns the whole call into an error, and models would have to learn a schema per call.
- **Free text only**: no way to restrict to a site or a date range from ChatGPT.

## Consequences

- Search terms that look like qualifiers (`site:x`, `limit:5`) cannot be searched literally.
- The qualifier syntax is part of the tool descriptions the models read; renaming or adding a qualifier is a contract change.
- Must not be changed to JSON.
