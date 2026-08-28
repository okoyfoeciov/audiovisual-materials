#!/usr/bin/env bash
# Git credential helper for this repo ONLY.
#
# It answers every github.com credential request with GH_TOKEN from this repo's
# .env, and nothing else. It never consults `gh auth`, the OS keyring, or
# ~/.git-credentials -- those hold a second, wrong account on this machine
# (see CLAUDE.md, "Remote access rule").
#
# This helper is what makes that rule real. Removing it lets git fall back to
# the `!gh auth git-credential` helper configured globally in ~/.gitconfig,
# which is exactly the failure this repo is guarding against. Keep it wired up:
#
#   git config --local credential.https://github.com.helper ""      # reset inherited helpers
#   git config --local --add credential.https://github.com.helper \
#       "/home/james/parakeet-ov/.githelpers/credential-from-env.sh"
#
# Expected .env line:
#   GH_TOKEN=gho_xxxxxxxx
set -euo pipefail

# Only "get" returns anything; "store"/"erase" are deliberate no-ops so nothing
# is ever cached outside .env.
[ "${1:-}" = "get" ] || exit 0

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/.env"

if [ ! -f "$env_file" ]; then
  echo "credential-from-env: $env_file not found" >&2
  exit 1
fi

# Parse rather than source: .env must never be executed.
token="$(
  grep -m1 -E '^[[:space:]]*GH_TOKEN[[:space:]]*=' "$env_file" \
    | sed -E 's/^[[:space:]]*GH_TOKEN[[:space:]]*=[[:space:]]*//; s/^["'"'"']//; s/["'"'"'][[:space:]]*$//' \
    | tr -d '[:space:]'
)" || true

if [ -z "$token" ]; then
  echo "credential-from-env: no GH_TOKEN=... line in $env_file" >&2
  exit 1
fi

printf 'username=x-access-token\npassword=%s\n' "$token"
