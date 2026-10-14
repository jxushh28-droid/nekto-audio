#!/bin/sh
# Start a virtual X display so Chromium runs headful (not headless) on the server,
# then hand off to the bot. exec keeps node as PID 1 for clean signal handling.
set -e
rm -f /tmp/.X99-lock 2>/dev/null || true
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
# Give Xvfb a moment to come up before Chromium tries to connect to the display.
for i in 1 2 3 4 5 6 7 8 9 10; do
  [ -e /tmp/.X99-lock ] && break
  sleep 0.3
done
exec node src/index.js
