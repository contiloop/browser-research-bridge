# Sourced (not executed) by "Open Settings.command": the opener's update check. It offers a newer
# version from the clone's upstream and, after the user's Enter, installs it. Works under the macOS
# system bash 3.2 with `set -u`; needs git, curl, and (for the time limits) perl, all on stock macOS.
#
#   brb_update_upstream <dir>          prints the upstream (e.g. origin/main) and returns 0 when <dir> is the
#                                      top of a git clone whose current branch has an upstream; else returns 1
#   brb_update_fetch <dir>             fetches that upstream, ended after BRB_UPDATE_FETCH_SECONDS (15) seconds
#                                      together with its transport; never prompts; returns non-zero on any failure
#   brb_update_state <dir>             prints `behind <N>` | `up_to_date` | `diverged` | `dirty` | `excluded` |
#                                      `no_upstream`, from what the last fetch brought (no network)
#   brb_update_job_running <port> <token-file>
#                                      prints `yes` when the settings page lists a helper job in state
#                                      `running`, else `no` (core off = 503, no answer, any non-200)
#   brb_update_apply <dir> <npm> <service here|none> [resume]
#                                      git pull --ff-only, npm ci, and (service here) ops/install-launchd.sh
#                                      --bridge; `resume` skips the pull. Sets BRB_UPDATE_STEP to the failed
#                                      step (pull | npm | installer; empty on success) and returns 0 or 1.
#                                      Call it directly, not inside $(...).
#   brb_update_offer <dir> <service here|none> <running 0|1> <port> <token-file> <npm>
#                                      the whole bilingual flow; sets BRB_UPDATE_RESULT to none | skipped |
#                                      busy | declined | updated | failed (with BRB_UPDATE_STEP). Call directly.
#
# `excluded`: the new version would write to a path that exists here but is not tracked (for example a
# site folder kept only on this Mac through .git/info/exclude, which git would silently overwrite), or
# would change a tracked path that .git/info/exclude lists. Such an update is skipped like a dirty one.
#
# After a successful pull and until npm ci and the installer succeed, <git dir>/brb-update-pending
# marks the update as unfinished; the next run offers to finish it (npm ci and the installer again).
# The admin token is read only to build the cookie exchange; it is passed to curl on stdin (never as an
# argument), never printed, and the temporary cookie jar is deleted before the function returns.

BRB_UPDATE_RESULT=""
BRB_UPDATE_STEP=""
BRB_UPDATE_GIT_CMD=()

brb_update_say() { printf '%s\n%s\n\n' "$1" "$2"; }

# brb_update_limited <seconds> <command...>: runs the command with stdin/stdout/stderr on /dev/null in its
# own process group (perl setpgrp) and ends the whole group (TERM, then KILL) after <seconds>. Returns the
# command's status, or 124 at the limit. macOS has no `timeout`.
brb_update_limited() {
  local limit="$1" pid ticks=0 max status=0 perl_bin="" group=""
  shift
  [[ "$limit" =~ ^[0-9]+$ && "$limit" -gt 0 ]] || limit=15
  max=$((limit * 10))
  if [[ -x /usr/bin/perl ]]; then
    perl_bin=/usr/bin/perl
  else
    perl_bin="$(command -v perl 2>/dev/null || true)"
  fi
  if [[ -n "$perl_bin" ]]; then
    "$perl_bin" -e 'setpgrp(0, 0); exec { $ARGV[0] } @ARGV or exit 127;' "$@" </dev/null >/dev/null 2>&1 &
    pid=$!
    group="-$pid"
  else
    "$@" </dev/null >/dev/null 2>&1 &
    pid=$!
    group="$pid"
  fi
  # Shell notices about the ended job ("Terminated: 15") go to /dev/null with this block's stderr.
  {
    while kill -0 "$pid"; do
      if [[ $ticks -ge $max ]]; then
        kill -TERM -- "$group" || kill -TERM "$pid"
        ticks=0
        while kill -0 "$pid" && [[ $ticks -lt 30 ]]; do
          sleep 0.1
          ticks=$((ticks + 1))
        done
        kill -KILL -- "$group" || kill -KILL "$pid"
        wait "$pid"
        status=124
        break
      fi
      sleep 0.1
      ticks=$((ticks + 1))
    done
    [[ $status -eq 124 ]] || {
      wait "$pid"
      status=$?
    }
  } 2>/dev/null
  return "$status"
}

# brb_update_git_net <dir> <git args...>: sets BRB_UPDATE_GIT_CMD to an `env ... git -C <dir> <args>`
# command line (a plain command, so brb_update_limited can run it) for git commands that reach the
# network: never ask on the terminal, give up on a stalled HTTP transfer, and, unless the user
# configured an ssh command, let ssh fail instead of prompting.
brb_update_git_net() {
  local dir="$1"
  shift
  local -a vars=(GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=15)
  if [[ -z "${GIT_SSH_COMMAND:-}" && -z "${GIT_SSH:-}" ]] &&
    ! git -C "$dir" config --get core.sshCommand >/dev/null 2>&1; then
    vars+=("GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=10")
  fi
  BRB_UPDATE_GIT_CMD=(env "${vars[@]}" git -C "$dir" "$@")
}

brb_update_upstream() {
  local dir="$1" top here
  # A folder without .git (a ZIP download) is never handed to git: on a Mac without the developer
  # tools, /usr/bin/git would pop up an install dialog.
  [[ -d "$dir" && -e "$dir/.git" ]] || return 1
  top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ -n "$top" ]] || return 1
  top="$(cd "$top" 2>/dev/null && pwd -P)" || return 1
  here="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
  [[ "$top" == "$here" ]] || return 1
  git -C "$dir" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null
}

brb_update_fetch() {
  local dir="$1" branch remote merge
  brb_update_upstream "$dir" >/dev/null || return 1
  branch="$(git -C "$dir" symbolic-ref -q --short HEAD 2>/dev/null)" || return 1
  remote="$(git -C "$dir" config --get "branch.$branch.remote" 2>/dev/null)" || return 1
  merge="$(git -C "$dir" config --get "branch.$branch.merge" 2>/dev/null)" || return 1
  # An upstream that is a local branch needs no fetch.
  [[ "$remote" == "." ]] && return 0
  brb_update_git_net "$dir" fetch --quiet --no-tags --no-recurse-submodules "$remote" "$merge"
  brb_update_limited "${BRB_UPDATE_FETCH_SECONDS:-15}" "${BRB_UPDATE_GIT_CMD[@]}"
}

# True when the update from HEAD to the upstream would write to an untracked path that exists here or
# into an untracked folder that exists here (git overwrites ignored files without asking), or would
# change a tracked path listed in .git/info/exclude.
brb_update_touches_local_files() {
  local dir="$1" path common exclude listed
  # Each added path itself, and its first parent folder that HEAD does not track (one per path).
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    if [[ -e "$dir/$path" || -L "$dir/$path" ]]; then
      return 0
    fi
  done < <(
    {
      git -C "$dir" -c core.quotePath=false ls-tree -r -d --name-only HEAD 2>/dev/null | sed 's/^/D /'
      git -C "$dir" -c core.quotePath=false diff --name-only --no-renames --diff-filter=A \
        HEAD '@{upstream}' 2>/dev/null | sed 's/^/A /'
    } | awk '
      { kind = substr($0, 1, 1); path = substr($0, 3) }
      kind == "D" { tracked[path] = 1; next }
      {
        print path
        n = split(path, part, "/")
        prefix = ""
        for (i = 1; i < n; i++) {
          prefix = (i == 1) ? part[1] : prefix "/" part[i]
          if (!(prefix in tracked)) { print prefix; break }
        }
      }'
  )
  common="$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [[ "$common" == /* ]] || common="$dir/$common"
  exclude="$common/info/exclude"
  [[ -s "$exclude" ]] || return 1
  listed="$(git -C "$dir" -c core.quotePath=false ls-files --cached --ignored --exclude-from="$exclude" 2>/dev/null)"
  [[ -n "$listed" ]] || return 1
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    if grep -Fxq -- "$path" <<<"$listed"; then
      return 0
    fi
  done < <(git -C "$dir" -c core.quotePath=false diff --name-only --no-renames HEAD '@{upstream}' 2>/dev/null)
  return 1
}

brb_update_state() {
  local dir="$1" counts ahead behind
  if ! brb_update_upstream "$dir" >/dev/null; then
    echo no_upstream
    return 0
  fi
  counts="$(git -C "$dir" rev-list --left-right --count 'HEAD...@{upstream}' 2>/dev/null)"
  ahead="$(printf '%s\n' "$counts" | awk '{ print $1 }')"
  behind="$(printf '%s\n' "$counts" | awk '{ print $2 }')"
  if [[ ! "$ahead" =~ ^[0-9]+$ || ! "$behind" =~ ^[0-9]+$ ]]; then
    echo no_upstream
    return 0
  fi
  if [[ "$behind" -eq 0 ]]; then
    echo up_to_date
  elif [[ "$ahead" -gt 0 ]]; then
    echo diverged
  elif [[ -n "$(git --no-optional-locks -C "$dir" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
    echo dirty
  elif brb_update_touches_local_files "$dir"; then
    echo excluded
  else
    echo "behind $behind"
  fi
}

brb_update_job_running() {
  local port="$1" token_file="$2" token="" tmp code node_bin answer=no
  [[ "$port" =~ ^[0-9]+$ ]] || {
    echo no
    return 0
  }
  [[ -f "$token_file" && -r "$token_file" ]] && token="$(tr -d '[:space:]' 2>/dev/null <"$token_file")"
  if [[ ! "$token" =~ ^[A-Za-z0-9_-]+$ ]]; then
    token=""
    echo no
    return 0
  fi
  tmp="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/brb-update.XXXXXX" 2>/dev/null)" || {
    token=""
    echo no
    return 0
  }
  # 1. The token exchange the opener uses for the browser link: GET /?token= answers 303 with the cookie.
  #    The URL (with the token) goes to curl through its config on stdin, so it is not in the process list.
  code="$(printf 'url = "http://127.0.0.1:%s/?token=%s"\n' "$port" "$token" |
    (umask 077 && curl -s -o /dev/null --max-time 5 -c "$tmp/cookies" -w '%{http_code}' -K - 2>/dev/null))"
  token=""
  if [[ "$code" =~ ^3[0-9][0-9]$ ]]; then
    # 2. The job list with that cookie and the page's own Host.
    code="$(curl -s --max-time 5 -b "$tmp/cookies" -H "Host: 127.0.0.1:$port" -o "$tmp/jobs.json" \
      -w '%{http_code}' "http://127.0.0.1:$port/api/jobs" 2>/dev/null)"
    if [[ "$code" == "200" && -s "$tmp/jobs.json" ]]; then
      node_bin="${BRB_NODE:-}"
      [[ -n "$node_bin" && -x "$node_bin" ]] || node_bin="$(command -v node 2>/dev/null || true)"
      if [[ -n "$node_bin" ]]; then
        answer="$("$node_bin" -e '
          let jobs = [];
          try { jobs = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).jobs; } catch {}
          const running = Array.isArray(jobs) && jobs.some((job) => job !== null && job.state === "running");
          process.stdout.write(running ? "yes" : "no");
        ' "$tmp/jobs.json" 2>/dev/null)"
      elif grep -q '"state":"running"' "$tmp/jobs.json"; then
        answer=yes
      fi
    fi
  fi
  rm -rf "$tmp"
  [[ "$answer" == yes ]] && echo yes || echo no
  return 0
}

brb_update_marker() {
  local git_dir
  git_dir="$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  [[ -n "$git_dir" ]] || return 1
  printf '%s/brb-update-pending\n' "$git_dir"
}

brb_update_apply() {
  local dir="$1" npm="$2" service="$3" mode="${4:-}" marker
  BRB_UPDATE_STEP=""
  marker="$(brb_update_marker "$dir")" || marker=""
  if [[ "$mode" != resume ]]; then
    brb_update_git_net "$dir" pull --ff-only --no-rebase --quiet
    if ! "${BRB_UPDATE_GIT_CMD[@]}" </dev/null; then
      BRB_UPDATE_STEP=pull
      return 1
    fi
    [[ -n "$marker" ]] && : >"$marker"
  fi
  if ! (cd "$dir" && "$npm" ci --no-audit --no-fund </dev/null); then
    BRB_UPDATE_STEP=npm
    return 1
  fi
  if [[ "$service" == here ]]; then
    # The installer re-renders the plist from the new templates and restarts the service (idempotent).
    if ! (cd "$dir" && NODE_BIN="${NODE_BIN:-${BRB_NODE:-}}" "$dir/ops/install-launchd.sh" --bridge </dev/null); then
      BRB_UPDATE_STEP=installer
      return 1
    fi
  fi
  [[ -n "$marker" ]] && rm -f "$marker"
  return 0
}

# brb_update_ask: reads one answer; only an empty one (Enter, spaces allowed) means yes.
brb_update_ask() {
  local answer
  IFS= read -r answer || return 1
  answer="$(printf '%s' "$answer" | tr -d '[:space:]')"
  [[ -z "$answer" ]]
}

# The job question, asked only while the program runs. True when the update must wait.
brb_update_helper_busy() {
  local running="$1" port="$2" token_file="$3"
  [[ "$running" == 1 ]] || return 1
  [[ "$(brb_update_job_running "$port" "$token_file")" == yes ]] || return 1
  brb_update_say \
    "새 버전이 있지만 사이트 추가 도우미가 작업 중이라 이번에는 업데이트하지 않습니다. 도우미 작업이 끝난 뒤 이 파일을 다시 더블클릭하면 업데이트할 수 있습니다." \
    "A new version is available, but the site-add helper is working, so the update waits until it finishes. Double-click this file again after the helper is done to update."
  return 0
}

brb_update_offer() {
  local dir="$1" service="$2" running="$3" port="$4" token_file="$5" npm="$6"
  local state n marker mode="" changes
  BRB_UPDATE_RESULT=none
  BRB_UPDATE_STEP=""
  brb_update_upstream "$dir" >/dev/null || return 0
  [[ -n "$npm" ]] || return 0
  marker="$(brb_update_marker "$dir")" || marker=""

  if [[ -n "$marker" && -f "$marker" ]]; then
    # An update was pulled but npm ci or the installer did not finish.
    if brb_update_helper_busy "$running" "$port" "$token_file"; then
      BRB_UPDATE_RESULT=busy
      return 0
    fi
    brb_update_say \
      "지난번 업데이트가 끝나지 않았습니다. 지금 마무리하려면 Enter 키를 누르고, 건너뛰려면 n을 입력한 뒤 Enter 키를 누르세요." \
      "The last update did not finish. Press Enter to finish it now, or type n and Enter to skip."
    mode=resume
  else
    brb_update_fetch "$dir" || return 0
    state="$(brb_update_state "$dir")"
    case "$state" in
      "behind "*) n="${state#behind }" ;;
      diverged | dirty)
        BRB_UPDATE_RESULT=skipped
        brb_update_say \
          "새 버전이 있지만 이 폴더에 직접 바꾼 내용이 있어 업데이트를 건너뜁니다." \
          "A new version is available, but the update was skipped because this folder has local changes."
        return 0
        ;;
      excluded)
        BRB_UPDATE_RESULT=skipped
        brb_update_say \
          "새 버전이 있지만 이 Mac에만 있는 파일(예: git에 올리지 않는 사이트 폴더)을 바꾸게 되어 업데이트를 건너뜁니다." \
          "A new version is available, but the update was skipped because it would change files that exist only on this Mac (such as a site folder kept out of git)."
        return 0
        ;;
      *) return 0 ;;
    esac
    if brb_update_helper_busy "$running" "$port" "$token_file"; then
      BRB_UPDATE_RESULT=busy
      return 0
    fi
    changes="$n changes"
    [[ "$n" == 1 ]] && changes="1 change"
    brb_update_say \
      "새 버전이 있습니다(변경 ${n}개). 지금 업데이트하려면 Enter 키를 누르고, 건너뛰려면 n을 입력한 뒤 Enter 키를 누르세요." \
      "A new version is available ($changes). Press Enter to update now, or type n and Enter to skip."
  fi

  if ! brb_update_ask; then
    BRB_UPDATE_RESULT=declined
    brb_update_say \
      "업데이트를 건너뛰고 지금 버전으로 엽니다. 다음에 이 파일을 열 때 다시 묻습니다." \
      "Skipped the update; opening the current version. You will be asked again next time."
    return 0
  fi

  # The answer may have taken a while: ask about helper jobs and local changes again.
  if brb_update_helper_busy "$running" "$port" "$token_file"; then
    BRB_UPDATE_RESULT=busy
    return 0
  fi
  if [[ "$mode" != resume ]]; then
    state="$(brb_update_state "$dir")"
    if [[ "$state" != "behind "* ]]; then
      BRB_UPDATE_RESULT=skipped
      brb_update_say \
        "업데이트 직전에 이 폴더가 바뀌어 업데이트를 건너뜁니다." \
        "The folder changed just before the update, so the update was skipped."
      return 0
    fi
  fi

  brb_update_say "업데이트하는 중입니다. 몇 분 걸릴 수 있습니다." "Updating. This can take a few minutes."
  if brb_update_apply "$dir" "$npm" "$service" "$mode"; then
    BRB_UPDATE_RESULT=updated
    echo
    brb_update_say "업데이트했습니다." "The update is installed."
    return 0
  fi
  BRB_UPDATE_RESULT=failed
  echo
  case "$BRB_UPDATE_STEP" in
    pull)
      brb_update_say \
        "새 버전을 받지 못했습니다(위의 메시지 참고). 지금 버전으로 엽니다." \
        "Downloading the new version failed (see the messages above). Opening the current version."
      ;;
    npm)
      brb_update_say \
        "새 버전의 구성 요소 설치에 실패했습니다(위의 메시지 참고). 백그라운드 서비스는 다시 시작하지 않았습니다. 인터넷 연결을 확인한 뒤 이 파일을 다시 더블클릭하세요." \
        "Installing the new version's components failed (see the messages above). The background service was not restarted. Check the internet connection, then double-click this file again."
      ;;
    *)
      brb_update_say \
        "백그라운드 서비스를 새 버전으로 다시 시작하지 못했습니다(위의 메시지 참고). 이 파일을 다시 더블클릭하세요." \
        "Restarting the background service with the new version failed (see the messages above). Double-click this file again."
      ;;
  esac
  return 0
}
