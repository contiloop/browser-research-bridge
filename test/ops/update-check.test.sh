#!/bin/bash
# Tests for ops/update-check.sh, the opener's update check (Open Settings.command).
#
# Run from anywhere:  bash test/ops/update-check.test.sh      (exit 0 = every check passed)
#
# Everything happens in a temporary folder: a local bare repository plays the upstream, a clone of it
# plays the project folder. npm and the background-service installer are stubs (npm on PATH, the
# installer committed into the temporary repository as ops/install-launchd.sh), and the settings
# page is a small Node server that answers the token exchange and GET /api/jobs like the real one.
# Nothing touches launchd, the real installer, or a running bridge. Needs git, curl, node, perl.
# The shell options are the opener's.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# shellcheck source=../../ops/update-check.sh
. "$ROOT/ops/update-check.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/brb-update-test.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    {
      kill "$SERVER_PID"
      wait "$SERVER_PID"
    } 2>/dev/null
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# An isolated git: no user or system configuration, fixed identity.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_SSH_COMMAND GIT_SSH
export HOME="$TMP/home"
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export TMPDIR="$TMP/tmp"
mkdir -p "$HOME" "$TMPDIR" "$TMP/bin"
git config --global init.defaultBranch main
git config --global advice.detachedHead false

PASSED=0
FAILED=0
ok() {
  PASSED=$((PASSED + 1))
  printf 'ok   %s\n' "$1"
}
not_ok() {
  FAILED=$((FAILED + 1))
  printf 'FAIL %s\n' "$1"
  [[ $# -ge 2 ]] && printf '     %s\n' "$2"
}
expect_eq() { # <name> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else not_ok "$1" "expected [$2], got [$3]"; fi
}
expect_contains() { # <name> <needle> <haystack>
  if [[ "$3" == *"$2"* ]]; then ok "$1"; else not_ok "$1" "missing [$2] in [$3]"; fi
}
expect_not_contains() { # <name> <needle> <haystack>
  if [[ "$3" != *"$2"* ]]; then ok "$1"; else not_ok "$1" "unexpected [$2] in [$3]"; fi
}

# ---------------------------------------------------------------- stubs
# npm: records "<cwd> <args>" and exits with the number in $TMP/npm.exit (default 0).
cat >"$TMP/bin/npm" <<EOF
#!/bin/bash
printf '%s %s\n' "\$PWD" "\$*" >>"$TMP/npm.log"
exit "\$(cat "$TMP/npm.exit" 2>/dev/null || echo 0)"
EOF
chmod +x "$TMP/bin/npm"
export PATH="$TMP/bin:$PATH"
NPM="$TMP/bin/npm"

# Stand-in for ssh that never answers (the fetch time limit must end it).
cat >"$TMP/bin/hanging-ssh" <<EOF
#!/bin/bash
echo "\$\$" >"$TMP/hanging-ssh.pid"
exec sleep 60
EOF
chmod +x "$TMP/bin/hanging-ssh"

# ---------------------------------------------------------------- repositories
# new_case <name> [opener]: <name>/upstream.git (bare), <name>/seed (where "new versions" are
# committed), <name>/work (the project folder, a clone with origin/main as upstream). With `opener`
# the repository also carries this project's opener and the two scripts it sources. Prints the work path.
new_case() {
  local base="$TMP/$1"
  mkdir -p "$base"
  git init -q --bare "$base/upstream.git"
  git clone -q "$base/upstream.git" "$base/seed" 2>/dev/null
  mkdir -p "$base/seed/ops" "$base/seed/sites/shared" "$base/seed/config"
  printf 'readme\n' >"$base/seed/README.md"
  printf '{}\n' >"$base/seed/package-lock.json"
  printf '{}\n' >"$base/seed/config/bridge.example.json"
  printf 'shared\n' >"$base/seed/sites/shared/adapter.ts"
  printf '.env\ndata\nconfig/bridge.json\nnode_modules\n' >"$base/seed/.gitignore"
  if [[ "${2:-}" == opener ]]; then
    cp "$ROOT/Open Settings.command" "$base/seed/"
    cp "$ROOT/ops/find-node.sh" "$ROOT/ops/update-check.sh" "$base/seed/ops/"
  fi
  # The installer stub records its arguments and exits with the number in <case>/installer.exit.
  cat >"$base/seed/ops/install-launchd.sh" <<EOF
#!/bin/bash
printf '%s %s\n' "\$PWD" "\$*" >>"$base/installer.log"
exit "\$(cat "$base/installer.exit" 2>/dev/null || echo 0)"
EOF
  chmod +x "$base/seed/ops/install-launchd.sh"
  git -C "$base/seed" add -A
  git -C "$base/seed" commit -q -m initial
  git -C "$base/seed" push -q origin main 2>/dev/null
  git clone -q "$base/upstream.git" "$base/work" 2>/dev/null
  printf '%s\n' "$base/work"
}

# publish <name> <count>: <count> new commits on the upstream.
publish() {
  local seed="$TMP/$1/seed" i
  for ((i = 1; i <= $2; i++)); do
    printf 'change %s\n' "$i" >>"$seed/README.md"
    git -C "$seed" commit -q -am "change $i"
  done
  git -C "$seed" push -q origin main 2>/dev/null
}

head_of() { git -C "$1" rev-parse HEAD; }
upstream_head() { git -C "$TMP/$1/upstream.git" rev-parse main; }

# ---------------------------------------------------------------- the fake settings page
TOKEN="tok_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
mkdir -p "$TMP/srv"
printf '%s\n' "$TOKEN" >"$TMP/srv/admin-token"
cat >"$TMP/srv/server.mjs" <<'EOF'
// Mimics the settings page's guards: Host must be 127.0.0.1:<port>; GET /?token= sets the cookie
// bridge_admin_<port> and redirects; /api/jobs needs the cookie. The mode file picks the answer.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const dir = process.argv[2];
const token = readFileSync(`${dir}/admin-token`, "utf8").trim();
let port = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const cookie = req.headers.cookie ?? "";
  appendFileSync(`${dir}/requests.log`, `${req.method} ${url.pathname} host=${req.headers.host}\n`);
  if (req.headers.host !== `127.0.0.1:${port}`) return res.writeHead(403).end("{}");
  if (url.pathname === "/" && url.searchParams.has("token")) {
    if (url.searchParams.get("token") !== token) return res.writeHead(401).end("no");
    res.writeHead(303, {
      location: "/",
      "set-cookie": `bridge_admin_${port}=${token}; Path=/; HttpOnly; SameSite=Strict`,
    });
    return res.end();
  }
  if (url.pathname === "/api/jobs") {
    if (!cookie.split(/;\s*/).includes(`bridge_admin_${port}=${token}`)) {
      return res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
    }
    const mode = readFileSync(`${dir}/mode`, "utf8").trim();
    if (mode === "not_running") {
      return res.writeHead(503, { "content-type": "application/json" }).end('{"error":"not_running"}');
    }
    if (mode === "error") return res.writeHead(500).end("{}");
    const jobs =
      mode === "running"
        ? [{ id: "a", state: "succeeded" }, { id: "b", state: "running" }]
        : [{ id: "c", state: "queued", note: '"state":"running"' }, { id: "d", state: "paused" }];
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jobs }));
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  writeFileSync(`${dir}/port`, String(port));
});
EOF
printf 'running\n' >"$TMP/srv/mode"
node "$TMP/srv/server.mjs" "$TMP/srv" &
SERVER_PID=$!
for ((i = 0; i < 100; i++)); do
  [[ -s "$TMP/srv/port" ]] && break
  sleep 0.1
done
PORT="$(cat "$TMP/srv/port" 2>/dev/null)"
[[ "$PORT" =~ ^[0-9]+$ ]] || {
  echo "the fake settings page did not start" >&2
  exit 1
}
mode() { printf '%s\n' "$1" >"$TMP/srv/mode"; }

echo "# brb_update_upstream / brb_update_state"

W="$(new_case states)"
expect_eq "upstream of a fresh clone" "origin/main" "$(brb_update_upstream "$W")"
brb_update_fetch "$W"
expect_eq "fetch succeeds" "0" "$?"
expect_eq "fresh clone is up_to_date" "up_to_date" "$(brb_update_state "$W")"

publish states 2
expect_eq "before the fetch the clone does not know" "up_to_date" "$(brb_update_state "$W")"
brb_update_fetch "$W"
expect_eq "behind after the fetch" "behind 2" "$(brb_update_state "$W")"

printf 'untracked\n' >"$W/notes.txt"
mkdir -p "$W/data" && printf 'x\n' >"$W/data/state.json"
printf 'BRIDGE_PASSPHRASE=x\n' >"$W/.env"
expect_eq "untracked and ignored files do not make it dirty" "behind 2" "$(brb_update_state "$W")"

printf 'edit\n' >>"$W/README.md"
expect_eq "a modified tracked file is dirty" "dirty" "$(brb_update_state "$W")"
git -C "$W" add README.md
expect_eq "a staged change is dirty" "dirty" "$(brb_update_state "$W")"
git -C "$W" reset -q --hard
expect_eq "clean again" "behind 2" "$(brb_update_state "$W")"

git -C "$W" commit -q --allow-empty -m "local work"
expect_eq "local commit + upstream commits is diverged" "diverged" "$(brb_update_state "$W")"
git -C "$W" reset -q --hard origin/main
expect_eq "at the upstream commit" "up_to_date" "$(brb_update_state "$W")"
git -C "$W" commit -q --allow-empty -m "local only"
expect_eq "only ahead is up_to_date (nothing to pull)" "up_to_date" "$(brb_update_state "$W")"

mkdir -p "$TMP/plain"
expect_eq "not a git folder" "no_upstream" "$(brb_update_state "$TMP/plain")"
brb_update_upstream "$TMP/plain" >/dev/null
expect_eq "no upstream outside git" "1" "$?"
mkdir -p "$W/sub"
expect_eq "a subfolder of a clone is not the clone" "no_upstream" "$(brb_update_state "$W/sub")"
git -C "$W" checkout -q -b local-branch
expect_eq "a branch without upstream" "no_upstream" "$(brb_update_state "$W")"
git -C "$W" checkout -q --detach origin/main
expect_eq "detached HEAD" "no_upstream" "$(brb_update_state "$W")"

echo "# private folders (.git/info/exclude)"

W="$(new_case private)"
mkdir -p "$W/sites/my-blog"
printf 'mine\n' >"$W/sites/my-blog/adapter.ts"
printf 'sites/my-blog/\n' >>"$W/.git/info/exclude"
publish private 1
# commit_upstream <case> <path> <message>: adds or changes one file on the upstream.
commit_upstream() {
  local seed="$TMP/$1/seed"
  mkdir -p "$(dirname "$seed/$2")"
  printf 'upstream %s\n' "$3" >"$seed/$2"
  git -C "$seed" add -A
  git -C "$seed" commit -q -m "$3"
  git -C "$seed" push -q origin main 2>/dev/null
}
commit_upstream private sites/new-site/adapter.ts "add a new site folder"
brb_update_fetch "$W"
expect_eq "an update that adds new folders, with a private folder present" "behind 2" "$(brb_update_state "$W")"
commit_upstream private sites/my-blog/other.ts "add a file into the private folder's place"
brb_update_fetch "$W"
expect_eq "an update that would add a file into the private folder" "excluded" "$(brb_update_state "$W")"
git -C "$TMP/private/seed" rm -q sites/my-blog/other.ts
git -C "$TMP/private/seed" commit -q -m "take it back"
commit_upstream private sites/my-blog/adapter.ts "overwrite the private file"
brb_update_fetch "$W"
expect_eq "an update that would overwrite a file in the private folder" "excluded" "$(brb_update_state "$W")"
expect_eq "the private file is still there" "mine" "$(cat "$W/sites/my-blog/adapter.ts")"

W="$(new_case tracked-private)"
printf 'sites/shared/\n' >>"$W/.git/info/exclude"
git -C "$TMP/tracked-private/seed" rm -q -r sites/shared
git -C "$TMP/tracked-private/seed" commit -q -m "remove shared"
git -C "$TMP/tracked-private/seed" push -q origin main 2>/dev/null
brb_update_fetch "$W"
expect_eq "an update that removes a tracked folder listed in exclude" "excluded" "$(brb_update_state "$W")"

echo "# brb_update_fetch failures and the time limit"

W="$(new_case offline)"
publish offline 1
git -C "$W" remote set-url origin "$TMP/does-not-exist.git"
brb_update_fetch "$W" 2>/dev/null
expect_eq "an unreachable upstream fails" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"
out="$(brb_update_offer "$W" here 0 "$PORT" "$TMP/srv/admin-token" "$NPM" </dev/null 2>&1)"
expect_eq "an unreachable upstream is skipped silently" "" "$out"

W="$(new_case hanging)"
git -C "$W" remote set-url origin "ssh://example.invalid/repo.git"
start=$SECONDS
BRB_UPDATE_FETCH_SECONDS=2 GIT_SSH_COMMAND="$TMP/bin/hanging-ssh" brb_update_fetch "$W"
status=$?
elapsed=$((SECONDS - start))
expect_eq "a hanging fetch fails" "1" "$([[ $status -ne 0 ]] && echo 1 || echo 0)"
expect_eq "a hanging fetch ends at the time limit" "1" "$([[ $elapsed -le 6 ]] && echo 1 || echo 0)"
sleep 0.3
hung="$(cat "$TMP/hanging-ssh.pid" 2>/dev/null)"
expect_eq "the hanging transport was stopped too" "gone" \
  "$([[ -n "$hung" ]] && kill -0 "$hung" 2>/dev/null && echo alive || echo gone)"
start=$SECONDS
out="$(BRB_UPDATE_FETCH_SECONDS=2 GIT_SSH_COMMAND="$TMP/bin/hanging-ssh" \
  brb_update_offer "$W" here 0 "$PORT" "$TMP/srv/admin-token" "$NPM" </dev/null 2>&1)"
expect_eq "a hanging fetch is skipped silently" "" "$out"

echo "# brb_update_job_running"

mode running
out="$(brb_update_job_running "$PORT" "$TMP/srv/admin-token" 2>&1)"
expect_eq "a running helper job" "yes" "$out"
expect_contains "the page was asked with Host 127.0.0.1:<port>" "GET /api/jobs host=127.0.0.1:$PORT" \
  "$(cat "$TMP/srv/requests.log")"
mode idle
expect_eq "queued and paused jobs are not running" "no" "$(brb_update_job_running "$PORT" "$TMP/srv/admin-token" 2>&1)"
mode not_running
expect_eq "503 not_running counts as no job" "no" "$(brb_update_job_running "$PORT" "$TMP/srv/admin-token" 2>&1)"
mode error
expect_eq "another non-200 counts as no job" "no" "$(brb_update_job_running "$PORT" "$TMP/srv/admin-token" 2>&1)"
mode running
printf 'tok_wrong\n' >"$TMP/wrong-token"
expect_eq "a stale token counts as no job" "no" "$(brb_update_job_running "$PORT" "$TMP/wrong-token" 2>&1)"
expect_eq "a missing token file counts as no job" "no" \
  "$(brb_update_job_running "$PORT" "$TMP/missing-token" 2>&1)"
expect_eq "a closed port counts as no job" "no" "$(brb_update_job_running 1 "$TMP/srv/admin-token" 2>&1)"
expect_eq "no cookie jar is left behind" "" "$(ls -A "$TMPDIR")"

echo "# brb_update_offer"

# offer <answer|EOF> <folder> <service here|none> <running 0|1>: runs the flow in this shell with the
# answer on stdin; OUT holds what it printed, BRB_UPDATE_RESULT / BRB_UPDATE_STEP its result.
OUT=""
offer() {
  local answer="$1"
  shift
  if [[ "$answer" == EOF ]]; then
    brb_update_offer "$1" "$2" "$3" "$PORT" "$TMP/srv/admin-token" "$NPM" </dev/null >"$TMP/offer.out" 2>&1
  else
    brb_update_offer "$1" "$2" "$3" "$PORT" "$TMP/srv/admin-token" "$NPM" <<<"$answer" >"$TMP/offer.out" 2>&1
  fi
  OUT="$(cat "$TMP/offer.out")"
}

W="$(new_case offer)"
offer "" "$W" here 0
expect_eq "nothing new: result none" "none" "$BRB_UPDATE_RESULT"
expect_eq "nothing new: no output" "" "$OUT"
publish offer 3
before="$(head_of "$W")"

offer n "$W" here 0
expect_contains "the question in English" \
  "A new version is available (3 changes). Press Enter to update now, or type n and Enter to skip." "$OUT"
expect_contains "the question in Korean" "새 버전이 있습니다(변경 3개)." "$OUT"
expect_contains "n skips the update" "Skipped the update" "$OUT"
expect_eq "n sets the result" "declined" "$BRB_UPDATE_RESULT"
expect_eq "n leaves the folder as it was" "$before" "$(head_of "$W")"
expect_eq "n runs no npm" "" "$(cat "$TMP/npm.log" 2>/dev/null)"
offer n "$W" here 0
expect_contains "after n the question is asked again next time" "A new version is available (3 changes)." "$OUT"
offer "ㅜ" "$W" here 0
expect_eq "any other answer skips too (Korean keyboard n)" "declined" "$BRB_UPDATE_RESULT"
offer EOF "$W" here 0
expect_eq "no answer (end of input) skips" "declined" "$BRB_UPDATE_RESULT"
expect_eq "still not updated" "$before" "$(head_of "$W")"

mode running
offer "" "$W" here 1
expect_eq "a running helper job postpones the update" "busy" "$BRB_UPDATE_RESULT"
expect_contains "the wait is explained (English)" "the update waits until it finishes" "$OUT"
expect_contains "the wait is explained (Korean)" "사이트 추가 도우미가 작업 중이라" "$OUT"
expect_not_contains "the question is not asked while a helper job runs" "Press Enter to update now" "$OUT"
expect_eq "not updated while a helper job runs" "$before" "$(head_of "$W")"
offer "" "$W" here 0
expect_eq "the job question is asked only when the program runs" "updated" "$BRB_UPDATE_RESULT"
git -C "$W" reset -q --hard "$before"
: >"$TMP/npm.log"
: >"$TMP/offer/installer.log"

printf 'edit\n' >>"$W/README.md"
offer "" "$W" here 0
expect_eq "a dirty folder: skipped" "skipped" "$BRB_UPDATE_RESULT"
expect_contains "a dirty folder: the reason (English)" \
  "the update was skipped because this folder has local changes" "$OUT"
expect_contains "a dirty folder: the reason (Korean)" "직접 바꾼 내용이 있어" "$OUT"
expect_not_contains "a dirty folder is not asked" "Press Enter to update now" "$OUT"
git -C "$W" checkout -q README.md
git -C "$W" commit -q --allow-empty -m "local work"
offer "" "$W" here 0
expect_eq "a diverged folder: skipped" "skipped" "$BRB_UPDATE_RESULT"
expect_contains "a diverged folder: the reason" "this folder has local changes" "$OUT"
git -C "$W" reset -q --hard "$before"

echo "# brb_update_apply (through brb_update_offer)"

mode not_running
: >"$TMP/npm.log"
printf 'keep\n' >"$W/.env"
mkdir -p "$W/config" "$W/data" "$W/sites/my-blog"
printf '{"adminPort":1}\n' >"$W/config/bridge.json"
printf 'state\n' >"$W/data/state.json"
printf 'mine\n' >"$W/sites/my-blog/adapter.ts"
printf 'sites/my-blog/\n' >>"$W/.git/info/exclude"
offer "" "$W" here 1
expect_eq "Enter updates (program running, core off)" "updated" "$BRB_UPDATE_RESULT"
expect_contains "the update is confirmed" "The update is installed." "$OUT"
expect_eq "fast-forwarded to the upstream" "$(upstream_head offer)" "$(head_of "$W")"
expect_eq "npm ci ran once in the folder" "$W ci --no-audit --no-fund" "$(cat "$TMP/npm.log")"
expect_eq "the installer ran once with --bridge" "$W --bridge" "$(cat "$TMP/offer/installer.log")"
expect_eq ".env untouched" "keep" "$(cat "$W/.env")"
expect_eq "config/bridge.json untouched" '{"adminPort":1}' "$(cat "$W/config/bridge.json")"
expect_eq "data/ untouched" "state" "$(cat "$W/data/state.json")"
expect_eq "the private site folder untouched" "mine" "$(cat "$W/sites/my-blog/adapter.ts")"
offer "" "$W" here 0
expect_eq "afterwards nothing is offered" "none" "$BRB_UPDATE_RESULT"

W="$(new_case noservice)"
publish noservice 1
: >"$TMP/npm.log"
offer "  " "$W" none 0
expect_eq "Enter with spaces counts as Enter" "updated" "$BRB_UPDATE_RESULT"
expect_eq "without a registered service: pulled" "$(upstream_head noservice)" "$(head_of "$W")"
expect_eq "without a registered service: npm ci ran" "$W ci --no-audit --no-fund" "$(cat "$TMP/npm.log")"
expect_eq "without a registered service: no installer (the opener asks before registering)" "" \
  "$(cat "$TMP/noservice/installer.log" 2>/dev/null)"

W="$(new_case pullfail)"
publish pullfail 1
brb_update_fetch "$W"
git -C "$W" remote set-url origin "$TMP/does-not-exist.git"
: >"$TMP/npm.log"
before="$(head_of "$W")"
brb_update_apply "$W" "$NPM" here >/dev/null 2>&1
expect_eq "a failed pull returns non-zero with the step pull" "1 pull" "$? $BRB_UPDATE_STEP"
expect_eq "a failed pull changes nothing" "$before" "$(head_of "$W")"
expect_eq "after a failed pull no npm" "" "$(cat "$TMP/npm.log")"
expect_eq "after a failed pull no installer" "" "$(cat "$TMP/pullfail/installer.log" 2>/dev/null)"
expect_eq "after a failed pull nothing is pending" "" "$(ls "$W/.git" | grep brb-update)"

W="$(new_case npmfail)"
publish npmfail 1
printf '1\n' >"$TMP/npm.exit"
: >"$TMP/npm.log"
offer "" "$W" here 0
expect_eq "the failed step is npm" "failed npm" "$BRB_UPDATE_RESULT $BRB_UPDATE_STEP"
expect_contains "a failed npm ci is reported (English)" \
  "Check the internet connection, then double-click this file again." "$OUT"
expect_contains "a failed npm ci is reported (Korean)" "인터넷 연결을 확인한 뒤 이 파일을 다시 더블클릭하세요." "$OUT"
expect_eq "after a failed npm ci the service is not restarted" "" \
  "$(cat "$TMP/npmfail/installer.log" 2>/dev/null)"
rm -f "$TMP/npm.exit"
: >"$TMP/npm.log"
offer n "$W" here 0
expect_contains "the next double-click offers to finish the update" "The last update did not finish." "$OUT"
expect_eq "n leaves it pending" "declined" "$BRB_UPDATE_RESULT"
offer "" "$W" here 0
expect_eq "finishing" "updated" "$BRB_UPDATE_RESULT"
expect_eq "finishing runs npm ci" "$W ci --no-audit --no-fund" "$(cat "$TMP/npm.log")"
expect_eq "finishing runs the installer" "$W --bridge" "$(cat "$TMP/npmfail/installer.log" 2>/dev/null)"
offer "" "$W" here 0
expect_eq "once finished nothing is pending" "none" "$BRB_UPDATE_RESULT"

W="$(new_case installfail)"
publish installfail 1
printf '1\n' >"$TMP/installfail/installer.exit"
offer "" "$W" here 0
expect_eq "the failed step is installer" "failed installer" "$BRB_UPDATE_RESULT $BRB_UPDATE_STEP"
expect_contains "a failed installer is reported" "Restarting the background service with the new version failed" "$OUT"
mode running
offer "" "$W" here 1
expect_eq "finishing also waits for a running helper job" "busy" "$BRB_UPDATE_RESULT"
offer n "$W" here 0
expect_contains "a failed installer keeps the update pending" "The last update did not finish." "$OUT"

echo "# Open Settings.command (synthetic clone; launchctl, open, npm, and the installer are stubs)"

# Stubs for the opener: launchctl (records calls; `print` answers with the status in launchctl.print),
# open (records whether it got the signed-in link of the fake page, never the link itself), and a
# node folder with a stub npm next to the real node (the opener prefers the npm next to node).
cat >"$TMP/bin/launchctl" <<STUB
#!/bin/bash
printf '%s\\n' "\$*" >>"$TMP/launchctl.log"
[[ "\$1" == print ]] && exit "\$(cat "$TMP/launchctl.print" 2>/dev/null || echo 1)"
exit 0
STUB
cat >"$TMP/bin/open" <<STUB
#!/bin/bash
if [[ "\$1" == "http://127.0.0.1:$PORT/?token=$TOKEN" ]]; then echo signed-in-link; else echo other; fi >>"$TMP/open.log"
STUB
chmod +x "$TMP/bin/launchctl" "$TMP/bin/open"
mkdir -p "$TMP/nodebin"
ln -s "$(command -v node)" "$TMP/nodebin/node"
cp "$TMP/bin/npm" "$TMP/nodebin/npm"

W="$(new_case opener opener)"
mkdir -p "$W/node_modules/tsx/dist"
: >"$W/node_modules/tsx/dist/cli.mjs"
printf 'BRIDGE_ADMIN_PORT=%s\nBRIDGE_DATA_DIR=%s\n' "$PORT" "$TMP/srv" >"$W/.env"
printf '{}\n' >"$W/config/bridge.json"
PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"
# plist_for <folder>: the registered background service runs in <folder>.
plist_for() {
  rm -f "$PLIST_DIR/com.browser-research-bridge.plist"
  plutil -create xml1 "$PLIST_DIR/com.browser-research-bridge.plist"
  plutil -insert WorkingDirectory -string "$1" "$PLIST_DIR/com.browser-research-bridge.plist"
}
plist_for "$W"
printf '0\n' >"$TMP/launchctl.print"

# run_opener <answers>: runs the opener in the synthetic clone (the fake page answers: the program
# runs). OPENER_OUT holds its output, OPENER_STATUS its exit status.
OPENER_OUT=""
OPENER_STATUS=0
run_opener() {
  : >"$TMP/open.log"
  : >"$TMP/launchctl.log"
  printf '%s' "$1" | NODE_BIN="$TMP/nodebin/node" bash "$W/Open Settings.command" >"$TMP/opener.out" 2>&1
  OPENER_STATUS=$?
  OPENER_OUT="$(cat "$TMP/opener.out")"
}
# appears_before <first> <second> <text>: true when <first> appears in <text> before <second>.
appears_before() {
  local head="${3%%"$2"*}"
  [[ "$3" == *"$2"* && "$head" == *"$1"* ]]
}
: >"$TMP/npm.log"
: >"$TMP/opener/installer.log"

publish opener 2
start_head="$(head_of "$W")"
mode running
run_opener $'\n'
expect_eq "opener, helper job running: exit 0" "0" "$OPENER_STATUS"
expect_contains "opener, helper job running: the update waits" "the update waits until it finishes" "$OPENER_OUT"
expect_not_contains "opener, helper job running: no update question" "Press Enter to update now" "$OPENER_OUT"
expect_contains "opener, helper job running: then opens as before" "The program is already running." "$OPENER_OUT"
expect_eq "opener, helper job running: not updated" "$start_head" "$(head_of "$W")"
expect_eq "opener, helper job running: the page was opened signed in" "signed-in-link" "$(cat "$TMP/open.log")"

mode idle
run_opener $'n\n'
expect_eq "opener, n: exit 0" "0" "$OPENER_STATUS"
if appears_before "A new version is available (2 changes)." "Waiting for the settings page" "$OPENER_OUT"; then
  ok "opener, n: the question comes before the page is opened"
else
  not_ok "opener, n: the question comes before the page is opened" "$OPENER_OUT"
fi
expect_contains "opener, n: opens the current version" "The program is already running." "$OPENER_OUT"
expect_eq "opener, n: not updated" "$start_head" "$(head_of "$W")"
expect_eq "opener, n: the page was opened signed in" "signed-in-link" "$(cat "$TMP/open.log")"
expect_eq "opener, n: no npm, no installer" "" "$(cat "$TMP/npm.log" "$TMP/opener/installer.log")"

run_opener $'\n'
expect_eq "opener, Enter: exit 0" "0" "$OPENER_STATUS"
expect_eq "opener, Enter: updated to the upstream" "$(upstream_head opener)" "$(head_of "$W")"
expect_eq "opener, Enter: npm ci" "$W ci --no-audit --no-fund" "$(cat "$TMP/npm.log")"
expect_eq "opener, Enter: the installer restarted the service" "$W --bridge" "$(cat "$TMP/opener/installer.log")"
if appears_before "The update is installed." "Waiting for the settings page" "$OPENER_OUT"; then
  ok "opener, Enter: updates before waiting for the page"
else
  not_ok "opener, Enter: updates before waiting for the page" "$OPENER_OUT"
fi
expect_not_contains "opener, Enter: no 'already running' after a restart" "The program is already running." "$OPENER_OUT"
expect_eq "opener, Enter: the page was opened signed in" "signed-in-link" "$(cat "$TMP/open.log")"
expect_not_contains "opener: never restarts or stops the service itself" "kickstart" "$(cat "$TMP/launchctl.log")"
expect_not_contains "opener: the token is never printed" "$TOKEN" "$OPENER_OUT"

run_opener ""
expect_eq "opener, up to date: exit 0" "0" "$OPENER_STATUS"
expect_not_contains "opener, up to date: nothing asked" "A new version is available" "$OPENER_OUT"
expect_eq "opener, up to date: opened" "signed-in-link" "$(cat "$TMP/open.log")"

publish opener 1
plist_for "$TMP/somewhere-else"
start_head="$(head_of "$W")"
run_opener $'\n'
expect_not_contains "opener, service registered for another folder: no update question" \
  "A new version is available" "$OPENER_OUT"
expect_eq "opener, service registered for another folder: not updated" "$start_head" "$(head_of "$W")"

echo
echo "passed: $PASSED  failed: $FAILED"
[[ $FAILED -eq 0 ]]
