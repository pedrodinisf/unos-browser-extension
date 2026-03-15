#!/bin/bash
# Installs the UNOS native messaging host for Chrome (macOS)
#
# Usage: ./install.sh
#
# What this does:
#   1. Creates a local .venv and installs yt-dlp into it
#   2. Registers the native messaging host with Chrome
#
# Prerequisites:
#   - python3
#   - ffmpeg  (brew install ffmpeg — needed by yt-dlp for merging streams)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/launch.sh"
VENV_DIR="$SCRIPT_DIR/.venv"
MANIFEST_NAME="com.unos.video_downloader"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

echo "UNOS Native Messaging Host Installer"
echo "====================================="
echo ""

# ── Check prerequisites ──

if [ ! -f "$HOST_PATH" ]; then
  echo "Error: unos_video_host.py not found at $HOST_PATH" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 not found. Install Python 3 first." >&2
  exit 1
fi
echo "[OK] python3: $(python3 --version) at $(command -v python3)"

if command -v ffmpeg >/dev/null 2>&1; then
  echo "[OK] ffmpeg found: $(command -v ffmpeg)"
else
  echo "[!!] ffmpeg not found. Install with: brew install ffmpeg" >&2
  echo "     Some video formats may not merge correctly without it." >&2
fi

echo ""

# ── Create venv and install yt-dlp ──

if [ -d "$VENV_DIR" ]; then
  echo "Existing .venv found. Updating yt-dlp..."
  "$VENV_DIR/bin/pip" install --upgrade --quiet yt-dlp
else
  echo "Creating .venv and installing yt-dlp..."
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install --upgrade --quiet pip
  "$VENV_DIR/bin/pip" install --quiet -r "$SCRIPT_DIR/requirements.txt"
fi

# Verify yt-dlp is installed
if [ -x "$VENV_DIR/bin/yt-dlp" ]; then
  echo "[OK] yt-dlp installed: $VENV_DIR/bin/yt-dlp"
  echo "     $("$VENV_DIR/bin/yt-dlp" --version)"
else
  echo "Error: yt-dlp installation failed." >&2
  exit 1
fi

echo ""

# ── Register native messaging host ──

echo "Enter your UNOS extension ID (find it at chrome://extensions):"
read -r EXT_ID

if [ -z "$EXT_ID" ]; then
  echo "Error: Extension ID is required." >&2
  exit 1
fi

# Validate extension ID format (32 lowercase letters)
if ! echo "$EXT_ID" | grep -qE '^[a-z]{32}$'; then
  echo "Warning: Extension ID looks unusual (expected 32 lowercase letters)." >&2
  echo "Proceeding anyway..." >&2
fi

mkdir -p "$MANIFEST_DIR"

# Escape backslashes and quotes in path for valid JSON
ESCAPED_HOST_PATH=$(printf '%s' "$HOST_PATH" | sed 's/\\/\\\\/g; s/"/\\"/g')

cat > "$MANIFEST_DIR/$MANIFEST_NAME.json" << EOF
{
  "name": "$MANIFEST_NAME",
  "description": "UNOS video downloader for X/Twitter bookmarks",
  "path": "$ESCAPED_HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

chmod +x "$HOST_PATH"

echo ""
echo "Done."
echo ""
echo "  venv:     $VENV_DIR"
echo "  yt-dlp:   $VENV_DIR/bin/yt-dlp"
echo "  Host:     $HOST_PATH"
echo "  Manifest: $MANIFEST_DIR/$MANIFEST_NAME.json"
echo ""
echo "Restart Chrome for the native host to take effect."
