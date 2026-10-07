#!/usr/bin/env bash
# Installs (or removes) the optional per-user LaunchAgents for the Browser Research Bridge:
#   com.browser-research-bridge               the bridge (npm start equivalent)
#   com.browser-research-bridge.tunnel-client OpenAI Secure MCP Tunnel for ChatGPT (README "Path A")
#   com.browser-research-bridge.cloudflared   named Cloudflare Tunnel for Claude (README "Path B")
#
# It fills the templates in ops/launchd/ with this machine's absolute paths, writes them to
# ~/Library/LaunchAgents/, and loads them with `launchctl bootstrap gui/$UID`. Running it again
# replaces and reloads the same agents (idempotent). No secret is ever written into a plist: the
# bridge reads .env, tunnel-client reads its profile, cloudflared reads ~/.cloudflared/.
# Each run touches only the agents it is asked for: `--bridge` leaves the tunnel agents alone. An existing
# registration is found by its label (launchctl) and its plist path, whatever its contents.
#
# Usage: see `ops/install-launchd.sh --help` and ops/README.md.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TEMPLATE_DIR="$REPO_DIR/ops/launchd"
# shellcheck source=find-node.sh
. "$REPO_DIR/ops/find-node.sh"
LABEL_BRIDGE="com.browser-research-bridge"
LABEL_TUNNEL_CLIENT="com.browser-research-bridge.tunnel-client"
LABEL_CLOUDFLARED="com.browser-research-bridge.cloudflared"

usage() {
  cat <<'EOF'
Usage: ops/install-launchd.sh [components] [--uninstall] [--dry-run <dir>]

Components (default when none is given: --bridge; with --uninstall: all three):
  --bridge                     the bridge itself (needs npm install and a .env file; the passphrase in it may
                               still be empty: the bridge then starts with only the settings page)
  --tunnel-client <profile>    tunnel-client run --profile <profile> (the profile must already exist)
  --cloudflared <tunnel>       cloudflared tunnel run <tunnel> (a NAMED tunnel; never a quick tunnel)

Options:
  --uninstall                  unload the selected agents and delete their plists (logs are kept)
  --dry-run <dir>              only render and lint the plists into <dir>; no launchctl, nothing in ~/Library
  -h, --help                   show this help

Environment overrides (defaults are detected):
  NODE_BIN            node >= 24              (default: `node` on PATH, else the usual install locations;
                                               see ops/find-node.sh)
  ASIDE_CLI           Aside CLI               (default: `command -v aside`, else ~/.local/bin/aside)
  ENV_FILE            bridge env file         (default: <repo>/.env)
  TUNNEL_CLIENT_BIN   tunnel-client           (default: `command -v tunnel-client`, else ~/.local/bin/tunnel-client)
  CODEX_BIN           Codex CLI               (default: `command -v codex`, else Homebrew, ~/.local/bin, next to node)
                      ASIDE_CLI, TUNNEL_CLIENT_BIN and CODEX_BIN are passed into the bridge agent's environment
                      when found and left out when not installed.
  CLOUDFLARED_BIN     cloudflared             (default: `command -v cloudflared`)
  PUBLIC_PORT         bridge public port      (default: BRIDGE_PUBLIC_PORT in ENV_FILE, else publicPort in
                                               config/bridge.json, else 8787)
  LOG_DIR             log directory           (default: ~/Library/Logs/browser-research-bridge)
  LAUNCH_AGENTS_DIR   plist destination       (default: ~/Library/LaunchAgents)
EOF
}

die() {
  echo "install-launchd: $*" >&2
  exit 1
}
note() { echo "install-launchd: $*"; }

# ---------------------------------------------------------------- arguments
want_bridge=0
tunnel_profile=""
cf_tunnel=""
uninstall=0
dry_run_dir=""
any_component=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bridge)
      want_bridge=1
      any_component=1
      shift
      ;;
    --tunnel-client)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "--tunnel-client needs a profile name"
      tunnel_profile="$2"
      any_component=1
      shift 2
      ;;
    --cloudflared)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "--cloudflared needs a tunnel name or UUID"
      cf_tunnel="$2"
      any_component=1
      shift 2
      ;;
    --uninstall)
      uninstall=1
      shift
      ;;
    --dry-run)
      [[ $# -ge 2 && -n "$2" ]] || die "--dry-run needs a directory"
      dry_run_dir="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "launchd agents exist only on macOS"

LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/browser-research-bridge}"
DOMAIN="gui/$(id -u)"

is_loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

unload() {
  local label="$1" i
  if is_loaded "$label"; then
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    for i in $(seq 1 20); do
      is_loaded "$label" || break
      sleep 0.5
    done
    is_loaded "$label" && die "$label is still loaded after bootout"
    note "unloaded $label"
  fi
}

# ---------------------------------------------------------------- uninstall
if [[ $uninstall -eq 1 ]]; then
  labels=()
  if [[ $any_component -eq 0 ]]; then
    labels=("$LABEL_BRIDGE" "$LABEL_TUNNEL_CLIENT" "$LABEL_CLOUDFLARED")
  else
    [[ $want_bridge -eq 1 ]] && labels+=("$LABEL_BRIDGE")
    [[ -n "$tunnel_profile" ]] && labels+=("$LABEL_TUNNEL_CLIENT")
    [[ -n "$cf_tunnel" ]] && labels+=("$LABEL_CLOUDFLARED")
  fi
  for label in ${labels[@]+"${labels[@]}"}; do
    if [[ -n "$dry_run_dir" ]]; then
      note "dry run: would unload $label and delete $LAUNCH_AGENTS_DIR/$label.plist"
      continue
    fi
    unload "$label"
    if [[ -f "$LAUNCH_AGENTS_DIR/$label.plist" ]]; then
      rm -f "$LAUNCH_AGENTS_DIR/$label.plist"
      note "deleted $LAUNCH_AGENTS_DIR/$label.plist"
    fi
  done
  note "uninstall done (logs kept in $LOG_DIR)"
  exit 0
fi

[[ $any_component -eq 0 ]] && want_bridge=1

# ---------------------------------------------------------------- helpers
first_executable() {
  local candidate
  for candidate in "$@"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# PATH for the agents: the directories of the tools they use, then the system defaults.
build_path() {
  local out="" dir
  for dir in "$@" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    [[ -n "$dir" && -d "$dir" ]] || continue
    case ":$out:" in *":$dir:"*) continue ;; esac
    out="${out:+$out:}$dir"
  done
  printf '%s' "$out"
}

xml_escape() {
  printf '%s' "$1" | perl -pe 's/&/&amp;/g; s/</&lt;/g; s/>/&gt;/g'
}

# render <template> <output>: replaces every __NAME__ with the XML-escaped value of R_NAME from the
# environment (or, for a ready-made XML fragment, the raw value of RAW_NAME), and fails when a
# placeholder is left or the result is not a valid plist.
render() {
  local template="$1" output="$2"
  perl -pe 's{__([A-Z_]+)__}{
      exists $ENV{"R_$1"}
        ? do { my $v = $ENV{"R_$1"}; $v =~ s/&/&amp;/g; $v =~ s/</&lt;/g; $v =~ s/>/&gt;/g; $v }
        : exists $ENV{"RAW_$1"} ? $ENV{"RAW_$1"} : "__$1__"
    }gex' "$template" >"$output"
  if grep -Eq '__[A-Z_]+__' "$output"; then
    die "unfilled placeholder in $output: $(grep -Eo '__[A-Z_]+__' "$output" | sort -u | tr '\n' ' ')"
  fi
  plutil -lint -s "$output" >/dev/null || die "$output is not a valid plist"
}

install_agent() {
  local label="$1" rendered="$2"
  if [[ -n "$dry_run_dir" ]]; then
    note "dry run: rendered $dry_run_dir/$label.plist (not loaded)"
    return 0
  fi
  mkdir -p "$LAUNCH_AGENTS_DIR"
  unload "$label"
  install -m 0644 "$rendered" "$LAUNCH_AGENTS_DIR/$label.plist"
  launchctl enable "$DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/$label.plist" ||
    die "launchctl bootstrap failed for $label (see: launchctl print $DOMAIN/$label)"
  note "loaded $label ($LAUNCH_AGENTS_DIR/$label.plist)"
}

if [[ -n "$dry_run_dir" ]]; then
  mkdir -p "$dry_run_dir"
  out_dir="$(cd "$dry_run_dir" && pwd -P)"
else
  out_dir="$(mktemp -d "${TMPDIR:-/tmp}/brb-launchd.XXXXXX")"
  trap 'rm -rf "$out_dir"' EXIT
fi

# The log directory holds the dashboard link (an admin token) in bridge.out.log: owner-only.
if [[ -z "$dry_run_dir" ]]; then
  mkdir -p "$LOG_DIR"
  chmod 700 "$LOG_DIR"
fi
export R_LOG_DIR
R_LOG_DIR="$LOG_DIR"

# ---------------------------------------------------------------- bridge
if [[ $want_bridge -eq 1 ]]; then
  if ! brb_find_node; then
    if [[ -n "$BRB_NODE_OLD" ]]; then
      die "found only $BRB_NODE_OLD; Node >= 24 is required (or set NODE_BIN)"
    fi
    die "node not found; install Node >= 24 or set NODE_BIN"
  fi
  NODE_BIN="$BRB_NODE"

  TSX_CLI="$REPO_DIR/node_modules/tsx/dist/cli.mjs"
  [[ -f "$TSX_CLI" ]] || die "$TSX_CLI is missing; run npm install in $REPO_DIR first"

  # The file must exist (node --env-file fails without it); the passphrase in it may still be empty.
  ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing; cp .env.example .env (or double-click Open Settings.command)"
  ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd -P)/$(basename "$ENV_FILE")"

  # Tools the bridge starts itself. launchd's PATH is minimal, so their absolute locations go into the
  # agent's environment; one that is not installed is left out (the bridge then reports it as missing).
  ASIDE_CLI="${ASIDE_CLI:-$(first_executable "$(command -v aside || true)" "$HOME/.local/bin/aside" || true)}"
  TUNNEL_CLIENT_BIN="${TUNNEL_CLIENT_BIN:-$(first_executable "$(command -v tunnel-client || true)" "$HOME/.local/bin/tunnel-client" || true)}"
  CODEX_BIN="${CODEX_BIN:-$(first_executable "$(command -v codex || true)" /opt/homebrew/bin/codex /usr/local/bin/codex \
    "$HOME/.local/bin/codex" "$(dirname "$NODE_BIN")/codex" || true)}"
  optional_env=""
  tool_dirs=()
  for name in ASIDE_CLI TUNNEL_CLIENT_BIN CODEX_BIN; do
    value="${!name}"
    if [[ -n "$value" && -x "$value" ]]; then
      optional_env+=$'\n'"    <key>$name</key>"$'\n'"    <string>$(xml_escape "$value")</string>"
      tool_dirs+=("$(dirname "$value")")
      note "$name=$value"
    else
      if [[ -n "$value" ]]; then
        note "warning: $name=$value is not executable; left out of the bridge agent's environment"
      else
        note "$name not found (not installed?); left out of the bridge agent's environment"
      fi
    fi
  done

  git_dir="$(dirname "$(command -v git || echo /usr/bin/git)")"
  export R_REPO_DIR R_NODE_BIN R_TSX_CLI R_ENV_FILE R_PATH RAW_OPTIONAL_ENV
  R_REPO_DIR="$REPO_DIR"
  R_NODE_BIN="$NODE_BIN"
  R_TSX_CLI="$TSX_CLI"
  R_ENV_FILE="$ENV_FILE"
  RAW_OPTIONAL_ENV="$optional_env"
  R_PATH="$(build_path "$(dirname "$NODE_BIN")" "$git_dir" ${tool_dirs[@]+"${tool_dirs[@]}"})"
  render "$TEMPLATE_DIR/$LABEL_BRIDGE.plist" "$out_dir/$LABEL_BRIDGE.plist"
  install_agent "$LABEL_BRIDGE" "$out_dir/$LABEL_BRIDGE.plist"
fi

# ---------------------------------------------------------------- tunnel-client (ChatGPT)
if [[ -n "$tunnel_profile" ]]; then
  TUNNEL_CLIENT_BIN="${TUNNEL_CLIENT_BIN:-$(first_executable "$(command -v tunnel-client || true)" "$HOME/.local/bin/tunnel-client" || true)}"
  [[ -n "$TUNNEL_CLIENT_BIN" ]] || die "tunnel-client not found; install it or set TUNNEL_CLIENT_BIN"
  export R_TUNNEL_CLIENT_BIN R_TUNNEL_PROFILE R_PATH
  R_TUNNEL_CLIENT_BIN="$TUNNEL_CLIENT_BIN"
  R_TUNNEL_PROFILE="$tunnel_profile"
  R_PATH="$(build_path "$(dirname "$TUNNEL_CLIENT_BIN")")"
  render "$TEMPLATE_DIR/$LABEL_TUNNEL_CLIENT.plist" "$out_dir/$LABEL_TUNNEL_CLIENT.plist"
  install_agent "$LABEL_TUNNEL_CLIENT" "$out_dir/$LABEL_TUNNEL_CLIENT.plist"
fi

# ---------------------------------------------------------------- cloudflared (Claude, named tunnel)
if [[ -n "$cf_tunnel" ]]; then
  CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$(command -v cloudflared || true)}"
  [[ -n "$CLOUDFLARED_BIN" && -x "$CLOUDFLARED_BIN" ]] || die "cloudflared not found; install it or set CLOUDFLARED_BIN"
  if [[ -z "${PUBLIC_PORT:-}" ]]; then
    env_file_for_port="${ENV_FILE:-$REPO_DIR/.env}"
    PUBLIC_PORT="$(
      cd "$REPO_DIR" && ENV_FILE_FOR_PORT="$env_file_for_port" "${NODE_BIN:-node}" -e '
        const fs = require("node:fs");
        let port = null;
        try {
          const m = fs.readFileSync(process.env.ENV_FILE_FOR_PORT, "utf8").match(/^\s*BRIDGE_PUBLIC_PORT=\s*(\d+)\s*$/m);
          if (m) port = m[1];
        } catch {}
        if (port === null) {
          try { port = JSON.parse(fs.readFileSync("config/bridge.json", "utf8")).publicPort ?? null; } catch {}
        }
        console.log(port ?? 8787);
      ' 2>/dev/null || echo 8787
    )"
  fi
  [[ "$PUBLIC_PORT" =~ ^[0-9]+$ ]] || die "PUBLIC_PORT must be a number (got: $PUBLIC_PORT)"
  export R_CLOUDFLARED_BIN R_CF_TUNNEL R_PUBLIC_PORT R_PATH
  R_CLOUDFLARED_BIN="$CLOUDFLARED_BIN"
  R_CF_TUNNEL="$cf_tunnel"
  R_PUBLIC_PORT="$PUBLIC_PORT"
  R_PATH="$(build_path "$(dirname "$CLOUDFLARED_BIN")")"
  render "$TEMPLATE_DIR/$LABEL_CLOUDFLARED.plist" "$out_dir/$LABEL_CLOUDFLARED.plist"
  install_agent "$LABEL_CLOUDFLARED" "$out_dir/$LABEL_CLOUDFLARED.plist"
fi

if [[ -z "$dry_run_dir" ]]; then
  note "logs: $LOG_DIR"
  note "status: launchctl print $DOMAIN/<label> | grep -E 'state|pid|last exit'"
fi
