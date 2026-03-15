#!/bin/bash
# Installs the UNOS native messaging host for Chrome (macOS)
#
# Usage: ./install.sh [extension-id]
#
# What this does:
#   1. Copies native host files to ~/Library/Application Support/UNOS/
#      (outside macOS-protected ~/Documents, so Chrome can execute them)
#   2. Creates a venv there with yt-dlp installed
#   3. Registers the native messaging host manifest with Chrome
#   4. Auto-detects extension ID(s) from Chrome profiles
#
# Prerequisites:
#   - python3
#   - ffmpeg  (brew install ffmpeg — needed by yt-dlp for merging streams)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/Library/Application Support/UNOS/native-host"
VENV_DIR="$INSTALL_DIR/.venv"
MANIFEST_NAME="com.unos.video_downloader"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

echo "UNOS Native Messaging Host Installer"
echo "====================================="
echo ""

# ── Check prerequisites ──

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

# ── Install native host files ──

echo "Installing to: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# Copy host files from source to install location
cp "$SCRIPT_DIR/unos_video_host.py" "$INSTALL_DIR/unos_video_host.py"
cp "$SCRIPT_DIR/requirements.txt"   "$INSTALL_DIR/requirements.txt" 2>/dev/null || true

# Create launch.sh at the install location
cat > "$INSTALL_DIR/launch.sh" << 'LAUNCHER'
#!/bin/bash
# Launcher for UNOS native messaging host.
# Chrome launches native hosts with a minimal PATH, so pyenv/nvm etc. won't work.
# This script ensures we use the venv Python that has yt-dlp installed.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/native-host.log"
echo "$(date '+%Y-%m-%d %H:%M:%S') [launch.sh] Started (pid=$$)" >> "$LOG"

PYTHON="$SCRIPT_DIR/.venv/bin/python3"
SCRIPT="$SCRIPT_DIR/unos_video_host.py"

if [ ! -x "$PYTHON" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [launch.sh] ERROR: Python not found: $PYTHON" >> "$LOG"
  exit 1
fi

exec "$PYTHON" "$SCRIPT" 2>>"$LOG"
LAUNCHER
chmod +x "$INSTALL_DIR/launch.sh"

echo "[OK] Host files installed"
echo ""

# ── Create venv and install yt-dlp ──

if [ -d "$VENV_DIR" ]; then
  echo "Existing .venv found. Updating yt-dlp..."
  "$VENV_DIR/bin/pip" install --upgrade --quiet yt-dlp
else
  echo "Creating .venv and installing yt-dlp..."
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install --upgrade --quiet pip
  "$VENV_DIR/bin/pip" install --quiet yt-dlp
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

# ── Find extension ID(s) ──

EXT_IDS=()

if [ -n "$1" ]; then
  EXT_IDS+=("$1")
  echo "Using provided extension ID: $1"
else
  echo "Auto-detecting UNOS extension IDs from Chrome profiles..."
  CHROME_DIR="$HOME/Library/Application Support/Google/Chrome"

  if [ -d "$CHROME_DIR" ]; then
    while IFS= read -r prefs_file; do
      ids=$(python3 -c "
import json, sys, os
try:
    with open(os.path.expandvars('$prefs_file')) as f:
        prefs = json.load(f)
    exts = prefs.get('extensions', {}).get('settings', {})
    for eid, data in exts.items():
        path = data.get('path', '')
        if 'unos' in path.lower():
            print(eid)
except Exception:
    pass
" 2>/dev/null)

      for id in $ids; do
        if [[ ! " ${EXT_IDS[*]} " =~ " $id " ]]; then
          EXT_IDS+=("$id")
          profile_name=$(basename "$(dirname "$prefs_file")")
          echo "  Found: $id (profile: $profile_name)"
        fi
      done
    done < <(find "$CHROME_DIR" -name "Secure Preferences" -maxdepth 2 2>/dev/null)
  fi

  if [ ${#EXT_IDS[@]} -eq 0 ]; then
    echo ""
    echo "Could not auto-detect extension ID."
    echo "Enter your UNOS extension ID (find it at chrome://extensions):"
    read -r MANUAL_ID
    if [ -z "$MANUAL_ID" ]; then
      echo "Error: Extension ID is required." >&2
      exit 1
    fi
    EXT_IDS+=("$MANUAL_ID")
  fi
fi

echo ""

# ── Register native messaging host ──

mkdir -p "$MANIFEST_DIR"

# Build allowed_origins JSON array
ORIGINS=""
for id in "${EXT_IDS[@]}"; do
  if [ -n "$ORIGINS" ]; then
    ORIGINS="$ORIGINS, "
  fi
  ORIGINS="${ORIGINS}\"chrome-extension://${id}/\""
done

HOST_PATH="$INSTALL_DIR/launch.sh"

cat > "$MANIFEST_DIR/$MANIFEST_NAME.json" << EOF
{
  "name": "$MANIFEST_NAME",
  "description": "UNOS video downloader for X/Twitter bookmarks",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
EOF

echo "Done."
echo ""
echo "  Installed: $INSTALL_DIR"
echo "  venv:      $VENV_DIR"
echo "  yt-dlp:    $VENV_DIR/bin/yt-dlp"
echo "  Host:      $HOST_PATH"
echo "  Manifest:  $MANIFEST_DIR/$MANIFEST_NAME.json"
echo "  Origins:   $ORIGINS"
echo "  Log:       $INSTALL_DIR/native-host.log"
echo ""
echo "Restart Chrome for the native host to take effect."
