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
#   5. Detects uv + the media_engine project and writes engine-config.json
#
# Prerequisites:
#   - python3
#   - ffmpeg  (brew install ffmpeg — needed by yt-dlp for merging streams)
#   - uv      (optional, for media_engine integration: https://docs.astral.sh/uv/)

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

# Detect uv (media_engine integration). Check known locations before PATH.
UV_PATH=""
for cand in "$HOME/.local/bin/uv" "/opt/homebrew/bin/uv" "/usr/local/bin/uv"; do
  if [ -x "$cand" ]; then
    UV_PATH="$cand"
    break
  fi
done
if [ -z "$UV_PATH" ] && command -v uv >/dev/null 2>&1; then
  UV_PATH="$(command -v uv)"
fi
if [ -n "$UV_PATH" ]; then
  echo "[OK] uv found: $UV_PATH"
else
  echo "[!!] uv not found. media_engine integration will be unavailable." >&2
  echo "     Install with: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
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

# Ensure Homebrew + uv binaries are in PATH — Chrome launches with minimal PATH
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

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

# ── Detect media_engine project and write engine-config.json ──

ENGINE_CONFIG="$INSTALL_DIR/engine-config.json"
ENGINE_PROJECT=""

# Preserve an existing configured path if it still looks valid
if [ -f "$ENGINE_CONFIG" ]; then
  ENGINE_PROJECT="$(python3 -c "
import json, sys
try:
    with open('$ENGINE_CONFIG') as f:
        data = json.load(f)
    print(data.get('engineProject') or data.get('engine_project') or '')
except Exception:
    print('')
" 2>/dev/null)"
  if [ -n "$ENGINE_PROJECT" ] && [ ! -f "$ENGINE_PROJECT/pyproject.toml" ]; then
    echo "[!!] Previously configured media_engine path is no longer valid: $ENGINE_PROJECT" >&2
    ENGINE_PROJECT=""
  fi
fi

# Environment override wins over auto-detection
if [ -z "$ENGINE_PROJECT" ] && [ -n "${MEDIA_ENGINE_PROJECT:-}" ]; then
  ENGINE_PROJECT="$MEDIA_ENGINE_PROJECT"
fi

# Auto-detect from common project locations
if [ -z "$ENGINE_PROJECT" ]; then
  for cand in \
    "$HOME/Documents/PROJECTS/media_engine" \
    "$HOME/PROJECTS/media_engine" \
    "$HOME/src/media_engine" \
    "$HOME/media_engine" \
    "$HOME/Documents/media_engine"; do
    if [ -f "$cand/pyproject.toml" ]; then
      ENGINE_PROJECT="$cand"
      break
    fi
  done
fi

# Prompt as a last resort (blank = skip engine integration)
if [ -z "$ENGINE_PROJECT" ] && [ -t 0 ]; then
  echo "media_engine project not found automatically."
  echo "Enter the media_engine project path (blank to skip engine integration):"
  read -r ENGINE_PROJECT
  ENGINE_PROJECT="${ENGINE_PROJECT/#\~/$HOME}"
fi

if [ -n "$ENGINE_PROJECT" ]; then
  if [ -f "$ENGINE_PROJECT/pyproject.toml" ]; then
    echo "[OK] media_engine project: $ENGINE_PROJECT"
    if [ -n "$UV_PATH" ] && [ -x "$ENGINE_PROJECT/.venv/bin/med" ]; then
      echo "[OK] media_engine venv ready: $ENGINE_PROJECT/.venv"
    elif [ -n "$UV_PATH" ]; then
      echo "[!!] media_engine venv not ready — run: cd $ENGINE_PROJECT && uv sync --extra acquire-url" >&2
    fi
  else
    echo "[!!] Invalid media_engine path (no pyproject.toml): $ENGINE_PROJECT" >&2
    echo "     Engine integration will need configuration in the extension settings." >&2
    ENGINE_PROJECT=""
  fi
fi

python3 - "$ENGINE_CONFIG" "$ENGINE_PROJECT" "$UV_PATH" << 'PYEOF'
import json, sys
from datetime import datetime, timezone

path, project, uv_path = sys.argv[1], sys.argv[2], sys.argv[3]
config = {
    "engineProject": project,
    "uvPath": uv_path,
    "configuredAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
PYEOF

if [ -n "$ENGINE_PROJECT" ]; then
  echo "[OK] Engine config written: $ENGINE_CONFIG"
else
  echo "[--] Engine integration not configured (feature stays disabled)."
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
echo "  uv:        ${UV_PATH:-not found}"
echo "  Engine:    ${ENGINE_PROJECT:-not configured}"
echo "  Host:      $HOST_PATH"
echo "  Manifest:  $MANIFEST_DIR/$MANIFEST_NAME.json"
echo "  Origins:   $ORIGINS"
echo "  Log:       $INSTALL_DIR/native-host.log"
echo ""
echo "Restart Chrome for the native host to take effect."
