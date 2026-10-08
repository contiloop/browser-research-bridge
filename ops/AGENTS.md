# ops

## Scope

Optional background operation on macOS: `launchd/com.browser-research-bridge.plist` (the bridge), `launchd/com.browser-research-bridge.tunnel-client.plist` (ChatGPT tunnel), `launchd/com.browser-research-bridge.cloudflared.plist` (named Cloudflare tunnel), `install-launchd.sh`, which fills the templates and installs them as per-user LaunchAgents, `find-node.sh`, the Node ≥ 24 search sourced by the installer and by `../Open Settings.command` (the double-click opener at the project top, documented in `README.md` here), and `update-check.sh`, the opener's update check (sourced by the opener only). `README.md` is the user guide for these.

Not in scope: quick Cloudflare tunnels (their URL changes on every start, so the bridge would need a new `PUBLIC_URL` each time), secrets, tunnel profile creation.

## Boundaries

- Templates use `__NAME__` placeholders (`REPO_DIR`, `NODE_BIN`, `TSX_CLI`, `ENV_FILE`, `PATH`, `LOG_DIR`, `OPTIONAL_ENV`, and the tunnel names/binaries); `R_NAME` values are XML-escaped, `RAW_NAME` values (only `OPTIONAL_ENV`, a key/string fragment built from escaped values) are inserted as-is. The installer must leave none unfilled and runs `plutil -lint` on every result.
- The opener controls the bridge only through `launchctl` by label (`print`, `kickstart` without `-k`, `enable` + `bootstrap` of the existing plist) or the installer; it restarts a running bridge only by running `install-launchd.sh --bridge` after the user accepted an update with Enter, and never matches a command line. It reads `<dataDir>/admin-token` only to pass the link to `open` and for the update check's cookie exchange (token on `curl`'s stdin, cookie jar in a 0700 temporary folder deleted afterwards), and never prints it.
- The update check changes the folder only with `git pull --ff-only` on the user's Enter, on a clean tree that is behind and not diverged, never while a helper job is `running`, never when the update would write into an existing untracked path (an ignored or `.git/info/exclude`d site folder) or change a tracked path listed in `.git/info/exclude`, and never for a folder whose service is registered for another folder or that runs without the service. It never force-pulls, never resets, and always runs the installer after `npm ci` when the service is this folder's.
- No secret is ever written into a plist: the bridge reads `.env` through `--env-file`, tunnel-client reads its profile (which references the key file), cloudflared reads `~/.cloudflared/`.

## Invariants

- The bridge agent runs `<node> <repo>/node_modules/tsx/dist/cli.mjs --env-file=<.env> src/app/main.ts` with `WorkingDirectory` = the repository, `PATH` holding node's, git's, and the found tools' directories, and absolute `ASIDE_CLI`, `TUNNEL_CLIENT_BIN`, `CODEX_BIN` for each tool found (left out when not installed; launchd's `PATH` lacks `~/.local/bin`). `.env` must exist; its passphrase may be empty (the bridge then runs only the settings page).
- Bridge agent: `RunAtLoad`, `KeepAlive` true (restart after any exit, including SIGTERM), `ThrottleInterval` 30 s, `ExitTimeOut` 20 s, `ProcessType Interactive`, stdout to `bridge.out.log`, stderr to `bridge.err.log`. Tunnel agents restart whenever they exit; cloudflared exposes metrics on `127.0.0.1:20241`.
- The log directory `~/Library/Logs/browser-research-bridge/` is created with mode 0700 because `bridge.out.log` holds each start's dashboard link.
- The installer is idempotent and touches only the agents asked for (`--bridge` leaves the tunnel agents alone): it unloads an agent by label before rewriting its plist, whatever the old plist contains, then `launchctl enable` and `launchctl bootstrap gui/$UID`; `--uninstall` boots out and deletes the plists but keeps logs; `--dry-run <dir>` writes filled plists without touching launchd.
- The opener treats the bridge as registered when its label is loaded or `~/Library/LaunchAgents/com.browser-research-bridge.plist` exists, and acts on it only when that plist's `WorkingDirectory` is its own folder.

## Patterns

- Binaries are found on `PATH` (node also in the usual install locations) or overridden with `NODE_BIN`, `ASIDE_CLI`, `TUNNEL_CLIENT_BIN`, `CODEX_BIN`, `CLOUDFLARED_BIN`; the env file with `ENV_FILE`; the public port with `PUBLIC_PORT` (else `.env`, `config/bridge.json`, 8787).
- Re-run the installer with the same options after moving the repository, changing Node, or changing a template.

## Tests

`bash test/ops/update-check.test.sh` must exit 0 after any change to `update-check.sh` or the opener; it runs in temporary clones with stub `npm`, installer, `launchctl`, and `open`, and is not part of `npm run verify`. Otherwise no automated tests: `bash -n` every script. Exercise the opener by hand only in a copy of the repository with a temporary `HOME`, non-default ports in its `.env`, and stub `launchctl`/`open` first on `PATH` (the owner's live bridge answers on 8788). Check an installer change with `ops/install-launchd.sh --bridge --cloudflared x --tunnel-client y --dry-run <dir>` (placeholders filled, `plutil -lint` passes), then on the real Mac with `launchctl print gui/$(id -u)/com.browser-research-bridge | grep -E 'state|pid|last exit'` and the banner in `bridge.out.log`.
