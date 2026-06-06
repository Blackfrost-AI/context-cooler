#!/usr/bin/env python3
"""Unified message delivery for Context Cooler pipelines.

Supports multiple backends: iMessage, Telegram, Slack, Discord, webhook.
Each backend is auto-detected based on available CLI tools and env vars.

Usage:
    # iMessage (default if imsg is available)
    python3 deliver.py --to +15551234567 --text "Hello"

    # Telegram
    python3 deliver.py --backend telegram --to 5328771204 --text "Hello"

    # Slack webhook
    python3 deliver.py --backend slack --text "Hello"

    # Auto-detect: tries imsg first, then telegram, then slack
    python3 deliver.py --to +15551234567 --text "Hello"

    # Pipe from stdin (for pipeline chaining)
    echo "Hello" | python3 deliver.py --to +15551234567

Environment variables:
    TELEGRAM_BOT_TOKEN   — Telegram bot token for telegram backend
    TELEGRAM_CHAT_ID     — Default Telegram chat ID
    SLACK_WEBHOOK_URL    — Slack incoming webhook URL
    DISCORD_WEBHOOK_URL  — Discord webhook URL
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import urllib.error

DATA_DIR = os.environ.get("CONTEXT_COOLER_HOME", os.path.expanduser("~"))
ENV_FILE = os.path.join(DATA_DIR, ".env")


def load_env():
    """Load environment variables from .env file."""
    env = os.environ.copy()
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    env[key.strip()] = value.strip().strip("\"'")
    return env


# ─────────────────────────────────────────────
# Backend implementations
# ─────────────────────────────────────────────

def _validate_phone(number):
    """Validate phone number format (E.164: +countrycode then 7-14 digits)."""
    import re
    return bool(number and re.match(r'^\+[1-9]\d{7,14}$', number))


def send_imessage(to, text, env):
    """Send via imsg CLI."""
    imsg = shutil.which("imsg") or "/opt/homebrew/bin/imsg"
    if not os.path.isfile(imsg):
        return False, "imsg CLI not found"

    # SECURITY: Validate phone number with strict E.164 pattern
    if not _validate_phone(to):
        return False, f"Invalid phone number format (must be E.164: +1XXXXXXXXXX)"

    try:
        result = subprocess.run(
            [imsg, "send", "--to", to, "--text", text],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            return True, "delivered"
        return False, result.stderr.strip() or f"exit code {result.returncode}"
    except subprocess.TimeoutExpired:
        return False, "imsg send timed out"
    except Exception as e:
        return False, str(e)


def send_telegram(to, text, env):
    """Send via Telegram Bot API (stdlib only, no requests)."""
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = to or env.get("TELEGRAM_CHAT_ID", "")

    if not token:
        return False, "TELEGRAM_BOT_TOKEN not set"
    if not chat_id:
        return False, "No chat_id provided and TELEGRAM_CHAT_ID not set"

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown",
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            if result.get("ok"):
                return True, "delivered"
            return False, result.get("description", "unknown error")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:200]
        return False, f"HTTP {e.code}: {body}"
    except Exception as e:
        return False, str(e)


def send_slack(to, text, env):
    """Send via Slack incoming webhook."""
    webhook_url = env.get("SLACK_WEBHOOK_URL", "")
    if not webhook_url:
        return False, "SLACK_WEBHOOK_URL not set"

    payload = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return True, "delivered"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)


def send_discord(to, text, env):
    """Send via Discord webhook."""
    webhook_url = env.get("DISCORD_WEBHOOK_URL", "")
    if not webhook_url:
        return False, "DISCORD_WEBHOOK_URL not set"

    payload = json.dumps({"content": text}).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return True, "delivered"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)


BACKENDS = {
    "imessage": send_imessage,
    "telegram": send_telegram,
    "slack": send_slack,
    "discord": send_discord,
}


def detect_backend(env):
    """Auto-detect the best available backend."""
    # iMessage first (macOS only)
    imsg = shutil.which("imsg") or "/opt/homebrew/bin/imsg"
    if os.path.isfile(imsg):
        return "imessage"

    # Telegram if token exists
    if env.get("TELEGRAM_BOT_TOKEN"):
        return "telegram"

    # Slack if webhook exists
    if env.get("SLACK_WEBHOOK_URL"):
        return "slack"

    # Discord if webhook exists
    if env.get("DISCORD_WEBHOOK_URL"):
        return "discord"

    return None


def deliver(backend, to, text, env):
    """Send a message through the specified backend."""
    if backend not in BACKENDS:
        return False, f"Unknown backend: {backend}. Available: {', '.join(BACKENDS.keys())}"
    return BACKENDS[backend](to, text, env)


def main():
    parser = argparse.ArgumentParser(
        description="Unified message delivery for Context Cooler pipelines",
        epilog="Backends: imessage, telegram, slack, discord",
    )
    parser.add_argument("--backend", "-b", default="auto",
                        help="Delivery backend (default: auto-detect)")
    parser.add_argument("--to", "-t", action="append",
                        help="Recipient (phone for imessage, chat_id for telegram)")
    parser.add_argument("--text", help="Message text (or pipe via stdin)")
    parser.add_argument("--json", action="store_true",
                        help="Output JSON result")
    args = parser.parse_args()

    env = load_env()

    # Get text from args or stdin
    text = args.text
    if not text and not sys.stdin.isatty():
        text = sys.stdin.read().strip()
    if not text:
        parser.error("--text required (or pipe via stdin)")

    # Detect backend
    backend = args.backend
    if backend == "auto":
        backend = detect_backend(env)
        if not backend:
            print("❌ No delivery backend available", file=sys.stderr)
            print("   Configure one of: imsg CLI, TELEGRAM_BOT_TOKEN, SLACK_WEBHOOK_URL, DISCORD_WEBHOOK_URL",
                  file=sys.stderr)
            sys.exit(1)

    # Send to each recipient
    recipients = args.to or [None]  # None = use default for backend
    results = []
    for recipient in recipients:
        ok, detail = deliver(backend, recipient, text, env)
        results.append({
            "backend": backend,
            "to": recipient,
            "status": "delivered" if ok else "failed",
            "detail": detail,
        })
        if not args.json:
            icon = "✅" if ok else "❌"
            target = recipient or "default"
            print(f"{icon} [{backend}] {target}: {detail}")

    if args.json:
        print(json.dumps(results, indent=2))

    # Exit with error if any delivery failed
    if not all(r["status"] == "delivered" for r in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
