# Sourced (not executed) by ops/install-launchd.sh and "Open Settings.command": finds a Node.js >= 24.
# Works under the macOS system bash 3.2.
#
#   brb_find_node        sets BRB_NODE to the absolute path of the first node >= 24 and returns 0; otherwise
#                        returns 1 with BRB_NODE empty and BRB_NODE_OLD set to "<path> (v<version>)" of the
#                        first older node found (empty when none). Call it directly, not inside $(...).
#
# Order: $NODE_BIN when set (it alone is checked), then `node` on PATH, then the usual install locations
# (Homebrew, the nodejs.org installer, Volta, mise, asdf, nodenv, nvm, fnm). Terminal windows opened from
# Finder and launchd agents do not always have a version manager's PATH, hence the fixed locations.

BRB_NODE=""
BRB_NODE_OLD=""

brb_node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

brb_find_node() {
  local candidate major
  local -a candidates=() versioned=()
  BRB_NODE=""
  BRB_NODE_OLD=""
  if [[ -n "${NODE_BIN:-}" ]]; then
    candidates=("$NODE_BIN")
  else
    # Version-manager folders sort lexically (oldest first); prepend each so the newest is tried first.
    for candidate in "$HOME"/.nvm/versions/node/*/bin/node \
      "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
      "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin/node; do
      [[ -x "$candidate" ]] && versioned=("$candidate" ${versioned[@]+"${versioned[@]}"})
    done
    candidates=("$(command -v node 2>/dev/null || true)"
      /opt/homebrew/bin/node /usr/local/bin/node
      "$HOME/.volta/bin/node"
      "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node" "$HOME/.nodenv/shims/node"
      ${versioned[@]+"${versioned[@]}"})
  fi
  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    major="$(brb_node_major "$candidate")"
    [[ "$major" =~ ^[0-9]+$ ]] || continue
    if [[ "$major" -ge 24 ]]; then
      BRB_NODE="$candidate"
      return 0
    fi
    [[ -n "$BRB_NODE_OLD" ]] || BRB_NODE_OLD="$candidate (v$("$candidate" -v 2>/dev/null | tr -d v))"
  done
  return 1
}
