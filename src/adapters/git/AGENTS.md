# src/adapters/git

## Scope

`GitSiteCommitter`: commits one `sites/<key>/` folder after a successful add, repair, or removal (`git.autoCommit`).

Not in scope: deciding when to commit (registry operations call it), pushing, branches, any path outside `sites/<key>/`.

## Boundaries

- Imports `src/core` (site-key validation) and `src/ports` only; runs the `git` executable through `execFile`, never a shell.

## Invariants

- The pathspec is `:(literal)<sites path>/<key>` relative to the work-tree root, used for both `git add --all` and `git commit`; changes staged elsewhere stay staged and are not included.
- The message is exactly `site: add <key>`, `site: repair <key>`, or `site: remove <key>`.
- Commits use `--no-verify` and `--quiet` and set `GIT_TERMINAL_PROMPT=0`; nothing is ever pushed.
- Never throws: a disabled committer, an invalid key, a sites directory outside the work tree, "nothing to commit", and git failures come back as `{ committed: false, reason }` and are logged.

## Patterns

- The commit lands on whatever branch is checked out in the bridge's working tree.

## Tests

`auto-commit.test.ts` runs against temporary git repositories: only `sites/<key>/` is committed (no `.staging/`/`.previous/`, other staged changes stay out), no-op when unchanged or disabled, removals, and the never-throw cases (outside a repository, invalid key).
