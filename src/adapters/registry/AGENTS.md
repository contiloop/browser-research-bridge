# src/adapters/registry

## Scope

The registration source of truth and everything that changes which adapter code is live:
- `registry.ts`: `SiteRegistryService`, which reconciles `data/sites.json` with `sites/` at startup, keeps the in-memory snapshot (`list`, `get`, `findByHostname`), enforces hostname ownership (`checkAddHostname`, `hostnameOwner`, `registerOnboarding`), loads and hot-reloads adapters, and applies lifecycle transitions with their effects (cache clear, scheduler cool-down; removal also clears the site's cool-down);
- `folders.ts`: folder inspection and the loadability rule;
- `loader.ts`: `ModuleAdapterLoader`, which runs the static check, then a version-stamped dynamic import, and shape-checks the default export;
- `site-task.ts`: `runAdapterTask` (site lock → scoped browser session → `AdapterContext` → dispose) and `browserHostnames`;
- `operations.ts`: `promoteStaging` and `removeSite`.

Not in scope: deciding transitions (pure function in `src/core/lifecycle.ts`), validation logic, job orchestration, git internals (an injected committer).

## Boundaries

- Imports `src/core`, `src/ports`, `src/adapters/storage` (JSON helpers), and `src/adapters/validation` (report reading, hash, static check); never `onboarding`, `mcp`, `dashboard`, `oauth`, or `src/app`.
- Writes only `data/sites.json` (through the injected store) and files inside `sites/<key>/`; never another site's folder.

## Invariants

- Loadable = manifest parses with `key` equal to the folder name, `adapter.ts` exists, `validation.json` records a passed full validation. Only loadable folders of serving sites (`active`, `needs_login`, `degraded`) are imported.
- Startup: loadable folder without state → `active` with no last check; state without folder → dropped; serving site whose folder is not loadable → `failed`; `onboarding` site whose folder is loadable → `active`; non-loadable folder without state, or a folder whose hostname another site owns → ignored.
- A hostname (compared without `www.`, case-insensitive) belongs to at most one site, counting provisional hostnames of sites still onboarding.
- The static check always runs before any adapter code is imported, for live and staged folders alike.
- A loaded adapter is cached per generation; only `reload` (called by promotion) re-imports. Hand edits are not picked up until a restart.
- `promoteStaging` refuses unless `.staging/` holds a passed full validation whose `adapterHash` matches the staged files, a manifest for this key whose hostnames no other site owns, and a clean static check; on success it moves live files to `.previous/` (one generation), staged files live, reloads, marks `active`, and commits; on any failure it restores live, `.previous/`, and `.staging/` exactly.
- `removeSite` cancels the job first, deletes the folder before the state (so a crash leaves only an orphan state entry, dropped at the next start), clears the cache, and commits the removal.
- All state mutations are serialized through one queue.

## Patterns

- Lifecycle changes go through `apply(state, event)` → `transitionSite` → effects; never set `status` directly.
- `runAdapterTask` is the only way adapter code touches the browser: it names the lock holder (`search`, `read`, `health check`, `validation`, `onboarding running`, `repair running`) for `timeout` messages.

## Tests

`registry.test.ts` (reconciliation rows, ownership, recordOutcome effects, reload) and `operations.test.ts` (promotion refusals, swap and restore on failure, removal order, commit calls) use temporary folders from `test/support/site-fixtures.ts`. Any change to the loadability rule needs a reconciliation test for both fresh-clone and crash-after-swap cases.
