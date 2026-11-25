#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
trial=$(mktemp -d /tmp/bettergit-keyring-XXXXXX)
trap 'rm -rf "$trial"' EXIT HUP INT TERM
export BETTERGIT_E2E_SCRIPT="$root/tests/keyring-e2e.py"
dbus-run-session -- env XDG_DATA_HOME="$trial/data" XDG_CONFIG_HOME="$trial/config" sh -c '
  printf "bettergit-disposable-test\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  python3 "$BETTERGIT_E2E_SCRIPT"
'
