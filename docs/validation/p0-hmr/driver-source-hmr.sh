#!/bin/sh
# Source-level HMR: modify plugin source while one DSH process runs.
set -eu
RUN_DIR='<server_path>/Workspace/dsh-opencode-live-models/.temp/p0-hmr-verify'
cd "$RUN_DIR"
rm -f run2.log driver2.log
sh launch.sh > run2.log 2>&1 &
PID=$!
echo "PID=$PID" >> driver2.log
sleep 18
echo "SRC=modified" >> driver2.log
printf '\n// p0-source-hmr-probe marker\n' >> plugin/lib/index.js
sleep 16
echo "SRC=restored" >> driver2.log
cp plugin/lib/index.js.orig plugin/lib/index.js
sleep 10
kill -INT "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
echo "DONE" >> driver2.log
echo '--- P0_WATCH ---'
grep 'P0_WATCH' run2.log || echo NONE
echo '--- hmr signals ---'
grep -iE 'reload|hmr|failed to import|did not activate' run2.log | head -12 || true
echo '--- driver2 ---'
cat driver2.log
