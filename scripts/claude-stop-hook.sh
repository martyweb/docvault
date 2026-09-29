#!/usr/bin/env bash
# Claude Code Stop hook: publish to the NAS whenever a turn left changed source.
# Exit 2 (with the log tail on stderr) wakes Claude to fix a failed deploy.
cd "$(dirname "$0")/.."
exec 9>.deploy.lock
flock -n 9 || exit 0   # a deploy is already running

if ./scripts/deploy.sh > .deploy.log 2>&1; then
  exit 0
fi
{ echo "DocVault auto-deploy failed. Last output:"; tail -40 .deploy.log; } >&2
exit 2
