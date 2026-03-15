#!/usr/bin/env python3
"""
UNOS Native Messaging Host — downloads X/Twitter videos via yt-dlp.

Chrome launches this script via Native Messaging (through launch.sh).
It reads one JSON message from stdin (length-prefixed), runs yt-dlp,
and writes one JSON response to stdout (length-prefixed).

Protocol: 4 bytes (uint32 LE) message length, then JSON bytes.
No third-party imports — only stdlib. yt-dlp runs as a subprocess
from the local .venv (falls back to system PATH).
"""
import json
import logging
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

# Resolve paths relative to this script's directory
SCRIPT_DIR = Path(__file__).resolve().parent
VENV_BIN = SCRIPT_DIR / ".venv" / "bin"
LOG_FILE = SCRIPT_DIR / "native-host.log"

# Configure file logging (stderr may be redirected by launch.sh, but this is a backup)
logging.basicConfig(
    filename=str(LOG_FILE),
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("unos-native-host")


def read_message():
    """Read a Chrome native messaging message from stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data)


def send_response(obj):
    """Write a Chrome native messaging response to stdout."""
    encoded = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
    # Brief pause so Chrome can read the response before the process exits.
    # Without this, Chrome may report "Native host has exited" on fast completions.
    import time
    time.sleep(0.1)


def cookies_to_netscape(cookies):
    """Convert Chrome cookie objects to Netscape cookie file format."""
    lines = ["# Netscape HTTP Cookie File"]
    for c in cookies:
        domain = c.get("domain", "")
        if not domain.startswith("."):
            domain = "." + domain
        path = c.get("path", "/")
        secure = "TRUE" if c.get("secure") else "FALSE"
        expiry = int(c.get("expirationDate", 0))
        name = c.get("name", "")
        value = c.get("value", "")
        lines.append("\t".join([domain, "TRUE", path, secure, str(expiry), name, value]))
    return "\n".join(lines)


def validate_url(url):
    """Ensure the URL is a valid X/Twitter post URL."""
    if not isinstance(url, str):
        return False
    return bool(re.match(r"^https://(x\.com|twitter\.com)/", url))


def find_executable(name):
    """Find an executable: check local .venv/bin first, then system PATH."""
    venv_path = VENV_BIN / name
    if venv_path.is_file() and os.access(venv_path, os.X_OK):
        return str(venv_path)
    return shutil.which(name)


def download_video(url, cookies, output_dir):
    """Download a video using yt-dlp subprocess."""
    # Check yt-dlp availability (venv first, then system)
    yt_dlp_path = find_executable("yt-dlp")
    log.info("yt-dlp path: %s", yt_dlp_path)
    if not yt_dlp_path:
        log.error("yt-dlp not found in venv (%s) or system PATH", VENV_BIN)
        return {
            "success": False,
            "error": "yt-dlp not found. Run: cd native-host && ./install.sh",
        }

    # Prepare output directory (expand ~ to home dir)
    out_dir = Path(output_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # Write cookies to temp file
    cookie_path = None
    try:
        fd, cookie_path = tempfile.mkstemp(suffix=".txt", prefix="unos_cookies_")
        with os.fdopen(fd, "w") as f:
            f.write(cookies_to_netscape(cookies))

        # Strip query string from URL
        clean_url = url.split("?")[0].strip()

        # Find ffmpeg for merge and audio extraction
        ffmpeg_path = shutil.which("ffmpeg")
        ffmpeg_args = ["--ffmpeg-location", ffmpeg_path] if ffmpeg_path else []
        if ffmpeg_path:
            log.info("ffmpeg path: %s", ffmpeg_path)
        else:
            log.warning("ffmpeg not found — merge and audio extraction may fail")

        # 1) Download merged video+audio
        cmd = [
            yt_dlp_path,
            "--cookies", cookie_path,
            "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best",
            "--merge-output-format", "mp4",
            "-o", str(out_dir / "%(id)s.%(ext)s"),
            "--no-warnings",
            *ffmpeg_args,
            clean_url,
        ]

        log.info("Running video: %s", " ".join(cmd))
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout
        )

        log.info("yt-dlp video exit code: %d", result.returncode)
        if result.stdout.strip():
            log.debug("yt-dlp stdout: %s", result.stdout.strip()[:1000])
        if result.stderr.strip():
            log.debug("yt-dlp stderr: %s", result.stderr.strip()[:1000])

        if result.returncode != 0:
            error_msg = result.stderr.strip() or result.stdout.strip() or "yt-dlp failed"
            if len(error_msg) > 500:
                error_msg = error_msg[:500] + "..."
            log.error("yt-dlp failed: %s", error_msg)
            return {"success": False, "error": error_msg}

        # 2) Extract audio-only as separate file
        audio_cmd = [
            yt_dlp_path,
            "--cookies", cookie_path,
            "-f", "bestaudio[ext=m4a]/bestaudio",
            "-x", "--audio-format", "m4a",
            "-o", str(out_dir / "%(id)s_audio.%(ext)s"),
            "--no-warnings",
            *ffmpeg_args,
            clean_url,
        ]

        log.info("Running audio: %s", " ".join(audio_cmd))
        audio_result = subprocess.run(
            audio_cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )
        log.info("yt-dlp audio exit code: %d", audio_result.returncode)
        if audio_result.returncode != 0:
            log.warning("Audio extraction failed (non-fatal): %s",
                        (audio_result.stderr.strip() or audio_result.stdout.strip())[:500])

        # Find the downloaded video file — extract tweet ID from URL
        tweet_id_match = re.search(r"/status/(\d+)", clean_url)
        if tweet_id_match:
            tweet_id = tweet_id_match.group(1)
            expected_path = out_dir / f"{tweet_id}.mp4"
            if expected_path.exists():
                return {"success": True, "filePath": str(expected_path)}

        # Fallback: find most recently created mp4 in output dir
        mp4s = sorted(out_dir.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
        if mp4s:
            return {"success": True, "filePath": str(mp4s[0])}

        return {"success": True, "filePath": str(out_dir), "note": "Download completed but file path uncertain"}

    finally:
        # Clean up temp cookie file
        if cookie_path and Path(cookie_path).exists():
            Path(cookie_path).unlink(missing_ok=True)


def main():
    log.info("Native host started (pid=%d)", os.getpid())
    log.info("Python: %s", sys.executable)
    log.info("Script dir: %s", SCRIPT_DIR)
    log.info("argv: %s", sys.argv)

    msg = read_message()
    if not msg:
        log.error("No message received from stdin")
        send_response({"success": False, "error": "No message received"})
        return

    action = msg.get("action")
    log.info("Action: %s", action)

    if action != "download_video":
        send_response({"success": False, "error": f"Unknown action: {action}"})
        return

    url = msg.get("url", "")
    log.info("URL: %s", url)

    if not validate_url(url):
        log.error("Invalid URL: %s", url)
        send_response({"success": False, "error": f"Invalid URL: {url}"})
        return

    cookies = msg.get("cookies", [])
    log.info("Cookies received: %d", len(cookies))
    output_dir = msg.get("outputDir", str(Path.home() / "Downloads"))

    result = download_video(url, cookies, output_dir)
    log.info("Result: %s", result)
    send_response(result)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Catch ALL exceptions so Chrome gets a proper response instead of a crash
        error_tb = traceback.format_exc()
        log.critical("Unhandled exception:\n%s", error_tb)
        try:
            send_response({"success": False, "error": f"Native host error: {error_tb[-500:]}"})
        except Exception:
            pass  # stdout may be broken; at least the log has it
        sys.exit(1)
