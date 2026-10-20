#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module -e 'const r = await fetch("http://127.0.0.1:3000/health"); if (!r.ok || (await r.json()).service !== "arigato") process.exit(1)' 2>/dev/null && exit 0
nohup npm start >/tmp/arigato-proxy.log 2>&1 </dev/null &
for attempt in {1..50}; do
  if node --input-type=module -e 'const r = await fetch("http://127.0.0.1:3000/health"); if (!r.ok || (await r.json()).service !== "arigato") process.exit(1)' 2>/dev/null; then
    exit 0
  fi
  sleep 0.2
done
cat /tmp/arigato-proxy.log
exit 1
