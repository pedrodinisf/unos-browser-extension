#!/bin/bash
# Launcher for UNOS native messaging host.
# Chrome launches native hosts with a minimal PATH, so pyenv/nvm etc. won't work.
# This script ensures we use the venv Python that has yt-dlp installed.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/native-host.log"
exec "$SCRIPT_DIR/.venv/bin/python3" "$SCRIPT_DIR/unos_video_host.py" 2>>"$LOG"
