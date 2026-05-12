#!/usr/bin/env bash
set -euo pipefail

JUICEBOX_HOME="${JUICEBOX_HOME:-$HOME/.local/share/juicebox}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
REPO_URL="https://github.com/kattebak/juicebox.git"

command -v git >/dev/null 2>&1 || { echo "error: git is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "error: curl is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "error: openssl is required" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || echo "warning: gh not found; bot mode requires gh on PATH" >&2

mkdir -p "$BIN_DIR"
if [ -d "$JUICEBOX_HOME/.git" ]; then
  git -C "$JUICEBOX_HOME" pull --ff-only
else
  mkdir -p "$(dirname "$JUICEBOX_HOME")"
  git clone "$REPO_URL" "$JUICEBOX_HOME"
fi

chmod +x "$JUICEBOX_HOME/bin/juicebox"
ln -sfn "$JUICEBOX_HOME/bin/juicebox" "$BIN_DIR/juicebox"

SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/juicebox}"
SKILL_SRC="$JUICEBOX_HOME/skills/juicebox"

if [ -e "$SKILL_DIR" ] && [ ! -L "$SKILL_DIR" ]; then
  echo "note: $SKILL_DIR exists and is not a symlink — leaving as-is"
elif [ -d "$SKILL_SRC" ]; then
  mkdir -p "$(dirname "$SKILL_DIR")"
  ln -sfn "$SKILL_SRC" "$SKILL_DIR"
  echo "linked Claude Code skill: /juicebox"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on PATH; add it with:"
     echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo "installed: $BIN_DIR/juicebox"
echo "next:"
echo "  juicebox init --org <name>"
echo "  juicebox install --org <name>"
echo "  juicebox login"
