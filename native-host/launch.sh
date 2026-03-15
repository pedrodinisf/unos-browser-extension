#!/bin/bash
# Launcher for UNOS native messaging host.
# Chrome launches native hosts with a minimal PATH, so pyenv/nvm etc. won't work.
# This script ensures we use the venv Python that has yt-dlp installed.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/native-host.log"

# Diagnostic logging — helps debug Chrome native messaging issues
echo "$(date '+%Y-%m-%d %H:%M:%S') [launch.sh] Started (pid=$$, args=$*)" >> "$LOG"
echo "$(date '+%Y-%m-%d %H:%M:%S') [launch.sh] SCRIPT_DIR=$SCRIPT_DIR" >> "$LOG"

PYTHON="$SCRIPT_DIR/.venv/bin/python3"
SCRIPT="$SCRIPT_DIR/unos_video_host.py"

if [ ! -x "$PYTHON" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [launch.sh] ERROR: Python not found or not executable: $PYTHON" >> "$LOG"
  exit 1
fi

if [ ! -f "$SCRIPT" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [launch.sh] ERROR: Script not found: $SCRIPT" >> "$LOG"
  exit 1
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') [launch.sh] Executing: $PYTHON $SCRIPT" >> "$LOG"
exec "$PYTHON" "$SCRIPT" 2>>"$LOG"
