#!/usr/bin/env python3
"""
UNOS Native Messaging Host — downloads X/Twitter videos and ingests bookmark content.

Chrome launches this script via Native Messaging (through launch.sh).
It reads one JSON message from stdin (length-prefixed), processes it,
and writes one JSON response to stdout (length-prefixed).

Protocol: 4 bytes (uint32 LE) message length, then JSON bytes.
No third-party imports — only stdlib. yt-dlp runs as a subprocess
from the local .venv (falls back to system PATH).

Actions:
  - download_video:    Download video via yt-dlp (existing)
  - ingest_bookmark:   Create folder, download images at max quality, write metadata+text
  - validate_folder:   Check/create a folder path, return resolved absolute path
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
import urllib.request
from datetime import datetime, timezone
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

# User-Agent for image downloads (X CDN may reject bare urllib requests)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"


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


# ── Image URL helpers ──


def maximize_image_quality(url):
    """Transform X/Twitter image URL to request maximum quality (name=orig)."""
    if "pbs.twimg.com" in url:
        # Replace name=small/medium/large/240x240/360x360/etc with name=orig
        if "name=" in url:
            return re.sub(r"name=\w+", "name=orig", url)
        # If no name param, append it
        separator = "&" if "?" in url else "?"
        return url + separator + "name=orig"
    return url


def guess_extension(url):
    """Guess file extension from URL (format param or path)."""
    # Check format= param first
    fmt_match = re.search(r"format=(\w+)", url)
    if fmt_match:
        fmt = fmt_match.group(1).lower()
        return f".{fmt}" if fmt in ("jpg", "jpeg", "png", "gif", "webp") else ".jpg"
    # Fall back to path extension
    path = url.split("?")[0]
    ext = Path(path).suffix.lower()
    return ext if ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4") else ".jpg"


def download_file(url, filepath):
    """Download a file from URL to local path using urllib."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as response:
        with open(filepath, "wb") as f:
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                f.write(chunk)
    return os.path.getsize(filepath)


# ── Actions ──


def action_validate_folder(msg):
    """Validate and optionally create a folder path. Returns resolved absolute path."""
    folder = msg.get("folder", "")
    if not folder:
        return {"success": False, "error": "No folder path provided"}

    try:
        resolved = Path(folder).expanduser().resolve()
        resolved.mkdir(parents=True, exist_ok=True)

        # Check writable
        test_file = resolved / ".unos_write_test"
        test_file.write_text("ok")
        test_file.unlink()

        return {
            "success": True,
            "resolvedPath": str(resolved),
            "exists": True,
            "writable": True,
        }
    except PermissionError:
        return {"success": False, "error": f"Permission denied: {folder}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def action_ingest_bookmark(msg):
    """
    Ingest a single X bookmark:
      1. Create {rootDir}/{tweetId}/ folder
      2. Download images at maximum quality
      3. Write metadata.json and content.txt
      4. Optionally download video via yt-dlp (if cookies provided and hasVideo)

    Returns list of created files.
    """
    bookmark = msg.get("bookmark", {})
    root_dir = msg.get("rootDir", "")
    cookies = msg.get("cookies", [])

    tweet_id = bookmark.get("tweetId", "")
    if not tweet_id:
        return {"success": False, "error": "No tweetId in bookmark"}
    if not root_dir:
        return {"success": False, "error": "No rootDir specified"}

    try:
        root = Path(root_dir).expanduser().resolve()
        tweet_dir = root / tweet_id
        tweet_dir.mkdir(parents=True, exist_ok=True)
        log.info("Ingesting %s into %s", tweet_id, tweet_dir)

        files_created = []

        # ── 1. Write metadata.json ──
        metadata = {
            "tweetId": bookmark.get("tweetId"),
            "authorHandle": bookmark.get("authorHandle", ""),
            "authorName": bookmark.get("authorName", ""),
            "text": bookmark.get("text", ""),
            "timestamp": bookmark.get("timestamp", ""),
            "tweetUrl": bookmark.get("tweetUrl", ""),
            "mediaUrls": bookmark.get("mediaUrls", []),
            "hasVideo": bookmark.get("hasVideo", False),
            "isQuoteTweet": bookmark.get("isQuoteTweet", False),
            "tags": bookmark.get("tags", []),
            "notes": bookmark.get("notes", ""),
            "categories": bookmark.get("categories", []),
            "ingestedAt": datetime.now(timezone.utc).isoformat(),
        }
        meta_path = tweet_dir / "metadata.json"
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False)
        files_created.append("metadata.json")

        # ── 2. Write content.txt ──
        handle = bookmark.get("authorHandle", "")
        name = bookmark.get("authorName", "")
        text_lines = [
            f"{name} ({handle})",
            bookmark.get("timestamp", ""),
            bookmark.get("tweetUrl", ""),
            "",
            bookmark.get("text", ""),
        ]
        if bookmark.get("tags"):
            text_lines.append("")
            text_lines.append("Tags: " + ", ".join(bookmark["tags"]))
        if bookmark.get("notes"):
            text_lines.append("")
            text_lines.append("Notes: " + bookmark["notes"])

        content_path = tweet_dir / "content.txt"
        with open(content_path, "w", encoding="utf-8") as f:
            f.write("\n".join(text_lines))
        files_created.append("content.txt")

        # ── 3. Download images at max quality ──
        images_downloaded = []
        for i, url in enumerate(bookmark.get("mediaUrls", [])):
            # Skip video thumbnails — we'll get the actual video
            if bookmark.get("hasVideo") and "video_thumb" in url:
                continue

            max_url = maximize_image_quality(url)
            ext = guess_extension(max_url)
            filename = f"img_{i + 1:03d}{ext}"
            filepath = tweet_dir / filename

            try:
                size = download_file(max_url, str(filepath))
                images_downloaded.append(filename)
                files_created.append(filename)
                log.info("  Downloaded %s (%d bytes)", filename, size)
            except Exception as e:
                log.warning("  Failed to download image %s: %s", max_url, e)

        # ── 4. Download video if applicable ──
        video_file = None
        if bookmark.get("hasVideo") and bookmark.get("tweetUrl"):
            if cookies:
                log.info("  Downloading video for %s", tweet_id)
                video_result = download_video(
                    bookmark["tweetUrl"], cookies, str(tweet_dir)
                )
                if video_result.get("success"):
                    video_file = video_result.get("filePath")
                    vname = Path(video_file).name if video_file else None
                    if vname:
                        files_created.append(vname)
                else:
                    log.warning("  Video download failed: %s", video_result.get("error"))
            else:
                log.info("  Skipping video download (no cookies)")

        return {
            "success": True,
            "tweetDir": str(tweet_dir),
            "filesCreated": files_created,
            "imagesDownloaded": len(images_downloaded),
            "videoFile": video_file,
        }

    except Exception as e:
        log.error("Ingest failed for %s: %s", tweet_id, traceback.format_exc())
        return {"success": False, "error": str(e)}


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

    if action == "download_video":
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

    elif action == "validate_folder":
        result = action_validate_folder(msg)
        log.info("Result: %s", result)
        send_response(result)

    elif action == "ingest_bookmark":
        result = action_ingest_bookmark(msg)
        log.info("Result: %s", result)
        send_response(result)

    else:
        send_response({"success": False, "error": f"Unknown action: {action}"})


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
