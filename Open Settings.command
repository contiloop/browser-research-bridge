#!/bin/bash
# Open Settings.command: double-click in Finder to open the Browser Research Bridge settings page.
#
# In order: checks Node.js >= 24; if the settings page already answers, only opens it; otherwise
# installs the dependencies (first time), creates .env and config/bridge.json from the examples,
# registers the background service once (after one confirmation) with ops/install-launchd.sh --bridge
# or starts it when it is registered but not running, waits for the page, and opens it signed in in
# the default browser. Messages are shown in Korean and English.
#
# The admin token in <data>/admin-token is read only to build the link handed to `open`; it is never
# printed. The program is controlled only through launchctl and the label below, never by matching
# its command line (docs/engineering-notes.md). macOS only; runs under the system bash 3.2.
set -uo pipefail

LABEL="com.browser-research-bridge"
WAIT_SECONDS=150

say() { printf '%s\n%s\n\n' "$1" "$2"; }
fail() {
  say "$1" "$2"
  say "이 창은 닫아도 됩니다." "You can close this window."
  exit 1
}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
cd "$REPO_DIR" || exit 1

DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/browser-research-bridge"

echo "Browser Research Bridge"
echo

# ---------------------------------------------------------------- 1. Node.js >= 24
# shellcheck source=ops/find-node.sh
. "$REPO_DIR/ops/find-node.sh"
if ! brb_find_node; then
  found_ko="Node.js를 찾지 못했습니다."
  found_en="Node.js was not found."
  if [[ -n "$BRB_NODE_OLD" ]]; then
    found_ko="찾은 Node.js가 너무 오래되었습니다: $BRB_NODE_OLD"
    found_en="The Node.js found is too old: $BRB_NODE_OLD"
  fi
  fail "$found_ko Node.js 24 이상이 필요합니다. https://nodejs.org/ 에서 LTS 버전(24 이상)을 설치한 뒤 이 파일을 다시 더블클릭하세요." \
    "$found_en Node.js 24 or later is needed. Install the LTS version (24 or later) from https://nodejs.org/ and double-click this file again."
fi
NODE="$BRB_NODE"
NODE_DIR="$(dirname "$NODE")"
export PATH="$NODE_DIR:$PATH"

# Settings-page port and data folder, resolved like the bridge does: .env, else config/bridge.json,
# else the built-in defaults (8788, data). A value that is missing or invalid falls through.
read_settings() {
  local out
  out="$(
    "$NODE" -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const { parseEnv } = require("node:util");
      let env = {};
      try { env = parseEnv(fs.readFileSync(".env", "utf8")); } catch {}
      let json = {};
      try { json = JSON.parse(fs.readFileSync("config/bridge.json", "utf8")) ?? {}; } catch {}
      const set = (v) => (typeof v === "string" ? (v.trim() === "" ? undefined : v.trim()) : v);
      const asPort = (v) => {
        const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
        return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
      };
      const asDir = (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
      const port = asPort(set(env.BRIDGE_ADMIN_PORT)) ?? asPort(json.adminPort) ?? 8788;
      const dir = asDir(set(env.BRIDGE_DATA_DIR)) ?? asDir(json.dataDir) ?? "data";
      process.stdout.write(port + "\n" + path.resolve(process.cwd(), dir) + "\n");
    ' 2>/dev/null
  )" || out=""
  ADMIN_PORT="$(printf '%s\n' "$out" | sed -n 1p)"
  DATA_DIR="$(printf '%s\n' "$out" | sed -n 2p)"
  [[ "$ADMIN_PORT" =~ ^[0-9]+$ ]] || ADMIN_PORT=8788
  [[ -n "$DATA_DIR" ]] || DATA_DIR="$REPO_DIR/data"
  TOKEN_FILE="$DATA_DIR/admin-token"
}

# True when anything answers HTTP on the settings-page port (the page answers 401 without its cookie).
page_answers() {
  local code
  code="$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' "http://127.0.0.1:$ADMIN_PORT/" 2>/dev/null)"
  [[ -n "$code" && "$code" != "000" ]]
}

# ---------------------------------------------------------------- 2. already running?
read_settings
if page_answers; then
  say "프로그램이 이미 실행 중입니다. 설정 페이지를 엽니다." "The program is already running. Opening the settings page."
else
  # -------------------------------------------------------------- 3. dependencies
  if [[ ! -f "$REPO_DIR/node_modules/tsx/dist/cli.mjs" ]]; then
    NPM="$NODE_DIR/npm"
    [[ -x "$NPM" ]] || NPM="$(command -v npm || true)"
    [[ -n "$NPM" ]] || fail "npm을 찾지 못했습니다. Node.js를 https://nodejs.org/ 에서 다시 설치하세요." \
      "npm was not found. Reinstall Node.js from https://nodejs.org/."
    say "필요한 구성 요소를 설치합니다(처음 한 번). 몇 분 걸릴 수 있습니다." \
      "Installing the required components (first time only). This can take a few minutes."
    if [[ -f "$REPO_DIR/package-lock.json" ]]; then
      "$NPM" ci --no-audit --no-fund
    else
      "$NPM" install --no-audit --no-fund
    fi
    status=$?
    if [[ $status -ne 0 || ! -f "$REPO_DIR/node_modules/tsx/dist/cli.mjs" ]]; then
      fail "구성 요소 설치에 실패했습니다(위의 메시지 참고). 인터넷 연결을 확인하고 다시 시도하세요." \
        "Installing the components failed (see the messages above). Check the internet connection and try again."
    fi
    echo
  fi

  # -------------------------------------------------------------- 4. settings files
  if [[ ! -f "$REPO_DIR/.env" ]]; then
    (umask 077 && cp "$REPO_DIR/.env.example" "$REPO_DIR/.env") ||
      fail ".env 파일을 만들지 못했습니다." "Could not create the .env file."
    chmod 600 "$REPO_DIR/.env"
    say "설정 파일 .env를 만들었습니다." "Created the settings file .env."
  fi
  if [[ ! -f "$REPO_DIR/config/bridge.json" ]]; then
    cp "$REPO_DIR/config/bridge.example.json" "$REPO_DIR/config/bridge.json" ||
      fail "config/bridge.json 파일을 만들지 못했습니다." "Could not create config/bridge.json."
    say "설정 파일 config/bridge.json을 만들었습니다." "Created the settings file config/bridge.json."
  fi
  read_settings

  # -------------------------------------------------------------- 5. background service
  loaded=0
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && loaded=1
  if [[ $loaded -eq 0 && ! -f "$PLIST" ]]; then
    say "이 프로그램을 백그라운드 서비스로 등록합니다. 로그인할 때마다 자동으로 시작되어 백그라운드에서 실행됩니다." \
      "This registers the program as a background service: it will start at every login and run in the background."
    say "계속하려면 Enter 키를 누르세요. 취소하려면 이 창을 닫으세요." \
      "Press Enter to continue, or close this window to cancel."
    if ! read -r _; then
      fail "입력이 없어 취소했습니다." "No answer; cancelled."
    fi
    NODE_BIN="$NODE" "$REPO_DIR/ops/install-launchd.sh" --bridge ||
      fail "백그라운드 서비스 등록에 실패했습니다(위의 메시지 참고)." \
        "Registering the background service failed (see the messages above)."
    echo
  else
    # Registered already (by the installer or by hand): only check that it is this folder's, then start it.
    registered_dir=""
    if [[ -f "$PLIST" ]]; then
      registered_dir="$(plutil -extract WorkingDirectory raw -o - "$PLIST" 2>/dev/null || true)"
      [[ -n "$registered_dir" && -d "$registered_dir" ]] && registered_dir="$(cd "$registered_dir" && pwd -P)"
    fi
    if [[ "$registered_dir" != "$REPO_DIR" ]]; then
      fail "백그라운드 서비스가 다른 폴더(${registered_dir:-알 수 없음})용으로 등록되어 있어 그대로 두었습니다. 이 폴더($REPO_DIR)로 옮기려면 이 폴더에서 ops/install-launchd.sh --bridge 를 실행하세요." \
        "The background service is registered for another folder (${registered_dir:-unknown}), so it was left alone. To move it to this folder ($REPO_DIR), run ops/install-launchd.sh --bridge in this folder."
    fi
    say "백그라운드 서비스를 시작합니다." "Starting the background service."
    if [[ $loaded -eq 1 ]]; then
      # Without -k: starts it if it is not running, leaves a running one alone.
      launchctl kickstart "$DOMAIN/$LABEL" >/dev/null 2>&1 ||
        fail "백그라운드 서비스를 시작하지 못했습니다." "Could not start the background service."
    else
      launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
      launchctl bootstrap "$DOMAIN" "$PLIST" ||
        fail "백그라운드 서비스를 시작하지 못했습니다." "Could not start the background service."
    fi
  fi
fi

# ---------------------------------------------------------------- 6. wait, then open signed in
printf '%s\n%s\n' "설정 페이지가 준비되기를 기다리는 중..." "Waiting for the settings page..."
ready=0
for ((i = 0; i < WAIT_SECONDS; i++)); do
  if [[ -s "$TOKEN_FILE" ]] && page_answers; then
    ready=1
    break
  fi
  sleep 1
done
echo
if [[ $ready -ne 1 ]]; then
  if page_answers; then
    fail "포트 $ADMIN_PORT 에서 다른 프로그램이 응답하고 있습니다(이 폴더의 프로그램이 아닙니다). 그 프로그램을 끄거나 .env의 BRIDGE_ADMIN_PORT를 바꾼 뒤 다시 시도하세요." \
      "Another program answers on port $ADMIN_PORT (not this folder's program). Stop it, or change BRIDGE_ADMIN_PORT in .env, and try again."
  fi
  fail "설정 페이지가 ${WAIT_SECONDS}초 안에 준비되지 않았습니다. 잠시 뒤 이 파일을 다시 더블클릭하세요. 계속되면 $LOG_DIR/bridge.err.log 를 확인하세요." \
    "The settings page was not ready within ${WAIT_SECONDS} seconds. Double-click this file again in a moment. If it keeps happening, look at $LOG_DIR/bridge.err.log."
fi

token="$(tr -d '[:space:]' <"$TOKEN_FILE" 2>/dev/null)"
if [[ ! "$token" =~ ^[A-Za-z0-9_-]+$ ]]; then
  unset token
  fail "설정 페이지의 접속 정보를 읽지 못했습니다. 잠시 뒤 다시 시도하세요." \
    "Could not read the settings page's sign-in data. Try again in a moment."
fi
open "http://127.0.0.1:$ADMIN_PORT/?token=$token"
open_status=$?
unset token
if [[ $open_status -ne 0 ]]; then
  fail "브라우저를 열지 못했습니다." "Could not open the browser."
fi

# ---------------------------------------------------------------- 7. done
say "설정 페이지를 기본 브라우저에서 열었습니다. 이 창은 닫아도 됩니다." \
  "The settings page is open in the default browser. You can close this window."
exit 0
