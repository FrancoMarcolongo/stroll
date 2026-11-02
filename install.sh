#!/bin/bash
# Installs Stroll from this checkout: checks prerequisites, installs dependencies and puts
# `stroll` on your PATH. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }

OS=$(uname)
case "$OS" in
  Darwin|Linux) ;;
  *) fail "Stroll runs on macOS and Linux only." ;;
esac
command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is required: https://nodejs.org (or: brew install node / sudo dnf install nodejs)."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20 or newer is required (found $(node -v))."
if [ "$OS" = "Darwin" ]; then
  xcode-select -p >/dev/null 2>&1 || fail "Xcode Command Line Tools are required. Run: xcode-select --install — then run this script again."
else
  # node-pty compiles against Electron's Node: it needs a C++ compiler, make and Python.
  for tool in g++ make python3; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required to build the terminal module. On Fedora: sudo dnf install gcc-c++ make python3. On Debian/Ubuntu: sudo apt install build-essential python3."
  done
fi
command -v git >/dev/null 2>&1 || fail "git is required."
if ! command -v claude >/dev/null 2>&1; then
  warn "Claude Code (claude) isn't on your PATH. Install it from https://claude.com/claude-code and log in once in a terminal; Stroll needs it to start sessions."
fi

bold "Installing dependencies (this builds the terminal module for Electron, about a minute)…"
npm install --no-audit --no-fund

BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
chmod +x bin/stroll
ln -sf "$PWD/bin/stroll" "$BIN_DIR/stroll"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) RC="$HOME/.zshrc"; [ "$OS" = "Linux" ] && RC="$HOME/.bashrc"
     warn "$BIN_DIR isn't on your PATH. Add it with:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $RC  and open a new terminal." ;;
esac

bold "Done. Start Stroll with:  stroll"
