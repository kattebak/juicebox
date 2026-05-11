#!/usr/bin/env bash
set -euo pipefail

AS_ME_HOME="${AS_ME_HOME:-$HOME/.local/share/as-me}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
REPO_URL="https://github.com/kattebak/as-me.git"

command -v git >/dev/null 2>&1 || { echo "error: git is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "error: node (>= 20) is required" >&2; exit 1; }

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 20 ]; then
  echo "error: node >= 20 required (have $(node -v))" >&2
  exit 1
fi

command -v gh >/dev/null 2>&1 || echo "warning: gh not found; bot mode requires gh on PATH" >&2

mkdir -p "$BIN_DIR"
if [ -d "$AS_ME_HOME/.git" ]; then
  git -C "$AS_ME_HOME" pull --ff-only
else
  mkdir -p "$(dirname "$AS_ME_HOME")"
  git clone "$REPO_URL" "$AS_ME_HOME"
fi

chmod +x "$AS_ME_HOME/bin/as-me.mjs"
ln -sfn "$AS_ME_HOME/bin/as-me.mjs" "$BIN_DIR/as-me"

SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/as-me}"
SKILL_SRC="$AS_ME_HOME/skills/as-me"

if [ -e "$SKILL_DIR" ] && [ ! -L "$SKILL_DIR" ]; then
  echo "note: $SKILL_DIR exists and is not a symlink — leaving as-is"
elif [ -d "$SKILL_SRC" ]; then
  mkdir -p "$(dirname "$SKILL_DIR")"
  ln -sfn "$SKILL_SRC" "$SKILL_DIR"
  echo "linked Claude Code skill: /as-me"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on PATH; add it with:"
     echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo "installed: $BIN_DIR/as-me"
echo "next:"
echo "  as-me init --org <name>"
echo "  as-me install --org <name>"
echo "  as-me login"
