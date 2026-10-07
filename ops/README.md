# ops/: launchd agents and the opener

Run the bridge (and, for hand-made setups, its tunnels) in the background at login, restarted after a crash, without a terminal. The bridge agent is the normal way to run the program; `npm start` in a terminal is for development. Operations (logs, restart, sleep) are in [docs/operations.md](../docs/operations.md).

The usual way to register the bridge agent is to double-click `Open Settings.command` at the top of the project (below); this script is what it runs.

| Template (`ops/launchd/`)                         | Runs                                                                                                                                                      | Needs first                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `com.browser-research-bridge.plist`               | `node node_modules/tsx/dist/cli.mjs --env-file=<.env> src/app/main.ts` in the repository                                                                  | `npm install`, a `.env` file (the passphrase may still be empty), Aside signed in     |
| `com.browser-research-bridge.tunnel-client.plist` | `tunnel-client run --profile <profile>` (ChatGPT, README Path A)                                                                                          | the profile, with the runtime key referenced as `file:...`                            |
| `com.browser-research-bridge.cloudflared.plist`   | `cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:20241 run --url http://127.0.0.1:<publicPort> <tunnel>` (Claude, README Path B, **named** tunnel) | `cloudflared tunnel login` + `create` + `route dns`; `PUBLIC_URL` set to the hostname |

A Cloudflare **quick** tunnel is not offered as an agent: its URL changes at every start, and the bridge must be restarted with the new `PUBLIC_URL` each time (README, Path B).

## Install

```sh
ops/install-launchd.sh                                       # bridge only
ops/install-launchd.sh --bridge --tunnel-client browser-research-bridge
ops/install-launchd.sh --bridge --cloudflared browser-research-bridge
ops/install-launchd.sh --bridge --tunnel-client browser-research-bridge --cloudflared browser-research-bridge
```

The script:

1. finds `node` (≥ 24; on `PATH`, else the usual install locations listed in `ops/find-node.sh`), the Aside CLI, `tunnel-client`, the Codex CLI, `cloudflared` (override with `NODE_BIN`, `ASIDE_CLI`, `TUNNEL_CLIENT_BIN`, `CODEX_BIN`, `CLOUDFLARED_BIN`), the env file (`ENV_FILE`, default `<repo>/.env`; it must exist, the passphrase in it may be empty) and the public port (`PUBLIC_PORT`, default from `.env` / `config/bridge.json` / 8787);
2. fills the double-underscore placeholders in the templates with these absolute paths, checks that none is left, and runs `plutil -lint`. The bridge agent's environment gets `ASIDE_CLI`, `TUNNEL_CLIENT_BIN`, and `CODEX_BIN` for each tool that is found (launchd's `PATH` is minimal); a tool that is not installed is left out, and the bridge reports it as missing;
3. creates `~/Library/Logs/browser-research-bridge/` (mode 700, because `bridge.out.log` holds the per-launch dashboard link);
4. for each agent: unloads it if loaded, writes `~/Library/LaunchAgents/<label>.plist`, `launchctl enable`, `launchctl bootstrap gui/$UID`.

It is idempotent: run it again after moving the repository, changing Node, installing a tool, or pulling new templates. It touches only the agents named on the command line (`--bridge` leaves the tunnel agents alone) and replaces an existing registration by its label and plist path, whatever that plist contains (a hand-written one included). It never writes a secret into a plist; the bridge reads `.env`, `tunnel-client` reads its profile (which references the key file), `cloudflared` reads `~/.cloudflared/`.

Preview without touching launchd or `~/Library`:

```sh
ops/install-launchd.sh --bridge --cloudflared my-tunnel --dry-run /tmp/brb-plists
```

## Open Settings.command

Double-click it in Finder (macOS may block a downloaded file on first open; the beginner guide says how to open it). In a Terminal window it:

1. checks for Node.js ≥ 24 (same search as the installer) and otherwise says where to get it and ends;
2. if the settings page already answers on its port (`BRIDGE_ADMIN_PORT` in `.env`, else `adminPort` in `config/bridge.json`, else 8788), goes straight to step 6;
3. runs `npm ci` when `node_modules` is missing;
4. creates `.env` (mode 600) and `config/bridge.json` from the examples when missing; with the empty passphrase the bridge starts with only the settings page;
5. if the bridge agent is not registered: explains, waits for Enter, and runs `ops/install-launchd.sh --bridge`. If it is registered for this folder but not running: `launchctl kickstart` (loaded) or `launchctl bootstrap` of the existing plist (not loaded). A registration whose `WorkingDirectory` is another folder is left alone and reported;
6. waits up to 150 s for the page and for `<dataDir>/admin-token`, then opens `http://127.0.0.1:<port>/?token=…` in the default browser with `open` (the token is never printed);
7. says the window can be closed.

Messages are in Korean and English. It never stops or restarts a running bridge.

## Uninstall

```sh
ops/install-launchd.sh --uninstall                           # all three agents
ops/install-launchd.sh --uninstall --tunnel-client x         # only that one (the name is ignored)
```

Unloads the agents (`launchctl bootout`) and deletes their plists. Logs stay in `~/Library/Logs/browser-research-bridge/`.

## Check and control

```sh
launchctl print gui/$(id -u)/com.browser-research-bridge | grep -E 'state|pid|last exit'
launchctl kickstart -k gui/$(id -u)/com.browser-research-bridge      # restart
tail -f ~/Library/Logs/browser-research-bridge/bridge.out.log        # banner + dashboard link
tail -f ~/Library/Logs/browser-research-bridge/bridge.err.log        # warnings and errors
```

Labels: `com.browser-research-bridge`, `com.browser-research-bridge.tunnel-client`, `com.browser-research-bridge.cloudflared`.

Behavior:

- The bridge agent restarts whenever it exits (including after a stray SIGTERM), at most every 30 seconds. To stop it on purpose, use `launchctl bootout`, not `kill`.
- The tunnel agents restart whenever they exit.
- LaunchAgents run only while you are logged in, and only while the Mac is awake. The Aside app must also be running; add it to System Settings → General → Login Items if you want it to start with your session (the exact UI labels may differ).
