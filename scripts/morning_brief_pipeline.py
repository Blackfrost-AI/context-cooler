#!/usr/bin/env python3
"""Morning brief pipeline — gathers data, formats, and delivers via iMessage.

NO AGENT NEEDED. This script does everything:
1. Gathers trading data through ctx_run.py (Context Cooler)
2. Formats into a clean brief
3. Sends directly via `imsg send`

Usage:
    python3 morning_brief_pipeline.py --to +12025550100
    python3 morning_brief_pipeline.py --to +12025550100 --detailed
    python3 morning_brief_pipeline.py --to +12025550100 --to +12025550101  # Multiple recipients
    python3 morning_brief_pipeline.py --print-only   # Don't send, just print
"""

import argparse
import json
import os
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("CONTEXT_COOLER_HOME", os.path.expanduser("~"))
CTX_RUN = os.path.join(SCRIPT_DIR, "ctx_run.py")
ENV_FILE = os.path.join(DATA_DIR, ".env")
DELIVER = os.path.join(SCRIPT_DIR, "deliver.py")


def load_env():
    """Load environment from .env file."""
    env = os.environ.copy()
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    env[key.strip()] = value.strip().strip("\"'")
    return env


def run_ctx(skill, cmd, intent=None, fields=None):
    """Run a command through ctx_run.py and return parsed result."""
    args = ["python3", CTX_RUN, "--skill", skill, "--cmd", cmd]
    if intent:
        args.extend(["--intent", intent])
    if fields:
        args.extend(["--fields", fields])

    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=30,
            env=load_env(),
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
        return {"success": False, "error": result.stderr.strip() or "No output"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def send_message(to, text, backend="auto"):
    """Send a message using the unified deliver.py backend."""
    cmd = ["python3", DELIVER, "--text", text]
    if to:
        cmd.extend(["--to", to])
    if backend != "auto":
        cmd.extend(["--backend", backend])

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=20,
        )
        return result.returncode == 0, result.stdout.strip() or result.stderr.strip() or "sent"
    except Exception as e:
        return False, str(e)


def format_brief(account, positions, movers, detailed=False):
    """Format gathered data into a clean morning brief."""
    lines = []
    lines.append("📊 Morning Market Brief")
    lines.append("=" * 30)

    # Account summary
    if account.get("success"):
        summary = account.get("summary", {})
        if isinstance(summary, str):
            lines.append(f"\n💰 Account: {summary}")
        else:
            equity = summary.get("equity", summary.get("portfolio_value", "N/A"))
            buying_power = summary.get("buying_power", "N/A")
            cash = summary.get("cash", "N/A")
            day_pnl = summary.get("day_pnl", summary.get("unrealized_pl", "N/A"))

            lines.append(f"\n💰 Portfolio")
            lines.append(f"  Equity: ${_fmt_num(equity)}")
            lines.append(f"  Buying Power: ${_fmt_num(buying_power)}")
            lines.append(f"  Cash: ${_fmt_num(cash)}")
            if day_pnl != "N/A":
                lines.append(f"  Day P&L: ${_fmt_num(day_pnl)}")
    else:
        lines.append(f"\n⚠️ Account: {account.get('error', 'unavailable')}")

    # Positions
    if positions.get("success"):
        summary = positions.get("summary", [])
        pos_list = summary
        if isinstance(summary, dict):
            pos_list = summary.get("positions", summary.get("data", []))
            count = summary.get("count", len(pos_list) if isinstance(pos_list, list) else "?")
        elif isinstance(summary, list):
            count = len(summary)
        else:
            count = "?"
            pos_list = []

        if isinstance(pos_list, list) and pos_list:
            lines.append(f"\n📈 Positions ({count} holdings)")
            if detailed:
                for pos in pos_list:
                    if isinstance(pos, dict):
                        sym = pos.get("symbol", pos.get("s", "?"))
                        qty = pos.get("qty", "?")
                        pl = pos.get("unrealized_pl", pos.get("pnl", "?"))
                        price = pos.get("current_price", pos.get("market_value", ""))
                        plpc = pos.get("unrealized_plpc", "")
                        pct_str = f" ({float(plpc)*100:+.1f}%)" if plpc else ""
                        if price:
                            lines.append(f"  {sym}: {qty} shares @ ${_fmt_num(price)}, P&L: ${_fmt_num(pl)}{pct_str}")
                        else:
                            lines.append(f"  {sym}: {qty} shares, P&L: ${_fmt_num(pl)}{pct_str}")
            else:
                symbols = [p.get("symbol", p.get("s", "?")) for p in pos_list if isinstance(p, dict)]
                lines.append(f"  Holdings: {', '.join(symbols)}")
        else:
            lines.append(f"\n📈 Positions: {count} holdings")
    else:
        lines.append(f"\n⚠️ Positions: {positions.get('error', 'unavailable')}")

    # Movers
    if movers.get("success"):
        summary = movers.get("summary", [])
        mover_list = summary
        if isinstance(summary, dict):
            # Handle both verbose ("movers") and compact ("top") key names
            mover_list = summary.get("movers", summary.get("top", summary.get("data", [])))

        if isinstance(mover_list, list) and mover_list:
            lines.append(f"\n🔥 Top Movers")
            for m in mover_list[:5]:
                if isinstance(m, dict):
                    sym = m.get("symbol", m.get("s", "?"))
                    change = m.get("change_pct", m.get("chg", m.get("percent_change", m.get("change", "?"))))
                    price = m.get("price", "")
                    price_str = f" (${_fmt_num(price)})" if price else ""
                    lines.append(f"  {sym}: {_fmt_num(change)}%{price_str}")
        else:
            lines.append(f"\n🔥 Movers: {summary}")

    # Token savings footer
    total_raw = sum(r.get("raw_bytes", 0) for r in [account, positions, movers])
    total_summary = sum(r.get("summary_bytes", 0) for r in [account, positions, movers])
    total_saved = sum(r.get("bytes_saved", 0) for r in [account, positions, movers])

    if total_raw > 0:
        pct = round(total_saved / total_raw * 100, 1)
        lines.append(f"\n🪶 Saved {pct}% via Context Saver")

    return "\n".join(lines)


def _fmt_num(val):
    """Format a number for display."""
    try:
        num = float(val)
        if abs(num) >= 1000:
            return f"{num:,.2f}"
        return f"{num:.2f}"
    except (ValueError, TypeError):
        return str(val)


def main():
    parser = argparse.ArgumentParser(description="Morning brief: gather → format → deliver via iMessage")
    parser.add_argument("--to", action="append", help="Recipient (phone for imessage, chat_id for telegram)")
    parser.add_argument("--backend", default="auto", help="Delivery backend: imessage, telegram, slack, discord, auto")
    parser.add_argument("--detailed", action="store_true", help="Include position-level P&L")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of formatted text")
    parser.add_argument("--print-only", action="store_true", help="Print brief without sending")
    args = parser.parse_args()

    if not args.to and not args.print_only and not args.json:
        parser.error("--to <phone> required (or use --print-only)")

    # Gather data through Context Cooler
    account = run_ctx("alpaca-trader", "account", fields="equity,buying_power,cash,day_pnl,portfolio_value")
    positions = run_ctx("alpaca-trader", "positions", intent="summary" if not args.detailed else "summary 20")
    movers = run_ctx("alpaca-trader", "movers", intent="top 5")

    if args.json:
        output = {
            "account": account,
            "positions": positions,
            "movers": movers,
        }
        print(json.dumps(output, indent=2))
        return

    brief = format_brief(account, positions, movers, detailed=args.detailed)

    if args.print_only:
        print(brief)
        return

    # Deliver via unified backend (imessage, telegram, slack, etc.)
    results = {"brief": brief, "backend": args.backend, "deliveries": []}
    for recipient in args.to:
        ok, msg = send_message(recipient, brief, backend=args.backend)
        results["deliveries"].append({
            "to": recipient,
            "status": "delivered" if ok else "failed",
            "detail": msg,
        })
        if ok:
            print(f"✅ Sent to {recipient}")
        else:
            print(f"❌ Failed to send to {recipient}: {msg}", file=sys.stderr)

    # Log delivery
    log_file = os.path.join(DATA_DIR, "workspace/memory/morning-brief-deliveries.log")
    os.makedirs(os.path.dirname(log_file), exist_ok=True)
    with open(log_file, "a") as f:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        for d in results["deliveries"]:
            f.write(f"[{ts}] {d['to']}: {d['status']}\n")

    # Print JSON summary for pipeline consumers
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
