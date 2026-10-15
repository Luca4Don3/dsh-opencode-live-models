#!/bin/sh
# P0-10 same-process test: disable and re-enable the plugin while one DSH process runs.
set -eu
RUN_DIR='<server_path>/Workspace/dsh-opencode-live-models/.temp/p0-hmr-verify'
cd "$RUN_DIR"
rm -f run.log
sh launch.sh > run.log 2>&1 &
PID=$!
echo "DRIVER_PID=$PID" >> driver.log
sleep 16
echo "PATCH=disabled t=$(date +%H:%M:%S)" >> driver.log
cp patches/disabled.yml home/profiles/hmrlive/cordis.patch.yml
sleep 16
echo "PATCH=enabled t=$(date +%H:%M:%S)" >> driver.log
cp patches/enabled.yml home/profiles/hmrlive/cordis.patch.yml
sleep 16
echo "SIGNAL=int t=$(date +%H:%M:%S)" >> driver.log
kill -INT "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
echo "DRIVER_DONE" >> driver.log
echo '--- P0_WATCH sequence ---'
grep 'P0_WATCH' run.log || echo 'NO_WATCH_LINES'
echo '--- startup problems ---'
grep -E 'failed to import|did not activate|hmr.*error|watch.*error' run.log | head -6 || true
echo '--- driver ---'
cat driver.log
