#!/bin/sh
# Block until tailscaled's backend is actually Running, then exit 0.
#
# WHY THIS EXISTS. av-materials-serve.service is a systemd *user* unit;
# tailscaled is a *system* unit. A user unit cannot order itself against a
# system unit, so an `After=tailscaled.service` in av-materials-serve.service
# would silently resolve to a nonexistent user unit and do nothing at all.
# This script is the ordering that directive could never give.
#
# Usage: tailscale-wait.sh [tries]   (default 60 tries x 2s = 120s)
set -eu

TS="${TAILSCALE_BIN:-/usr/bin/tailscale}"
tries="${1:-60}"
i=0

while [ "$i" -lt "$tries" ]; do
	if "$TS" status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then
		exit 0
	fi
	i=$((i + 1))
	sleep 2
done

echo "tailscale-wait: BackendState never reached Running after $((tries * 2))s" >&2
exit 1
