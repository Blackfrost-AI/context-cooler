#!/usr/bin/env python3
"""Batch execution of multiple OpenClaw skill commands in a single call.

Runs multiple skill commands sequentially (or in parallel where possible),
applies intent filtering to each, and returns a combined compact summary.
Eliminates per-call overhead and reduces total context consumption.
"""

import argparse
import json
import os
import subprocess
import sys
import time

OPENCLAW_HOME = os.environ.get("OPENCLAW_HOME", os.path.expanduser("~/.openclaw"))
CTX_RUN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ctx_run.py")


def run_single(spec, env):
    """Execute a single command spec through ctx_run.py."""
    cmd_parts = ["python3", CTX_RUN, "--skill", spec["skill"], "--cmd", spec["cmd"]]

    if "intent" in spec:
        cmd_parts.extend(["--intent", spec["intent"]])
    if "fields" in spec:
        fields = spec["fields"]
        if isinstance(fields, list):
            fields = ",".join(fields)
        cmd_parts.extend(["--fields", fields])

    try:
        result = subprocess.run(
            cmd_parts,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        try:
            return json.loads(result.stdout.strip())
        except json.JSONDecodeError:
            return {
                "success": False,
                "error": result.stderr.strip() or "Failed to parse output",
                "skill": spec["skill"],
                "command": spec["cmd"],
            }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "error": "Command timed out",
            "skill": spec["skill"],
            "command": spec["cmd"],
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "skill": spec["skill"],
            "command": spec["cmd"],
        }


def main():
    parser = argparse.ArgumentParser(
        description="Execute multiple OpenClaw skill commands in a single batch call.",
        epilog=(
            "Example: ctx_batch.py --commands '[{\"skill\": \"my-api\", "
            "\"cmd\": \"dashboard\", \"fields\": [\"active_users\",\"error_rate\"]}]'"
        ),
    )
    parser.add_argument(
        "--commands",
        required=True,
        help="JSON array of command specs. Each spec: {skill, cmd, intent?, fields?}",
    )
    parser.add_argument(
        "--pipeline",
        help="Path to a pipeline JSON file to execute",
    )
    args = parser.parse_args()

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    env = os.environ.copy()

    # Load .env
    env_file = os.path.join(OPENCLAW_HOME, ".env")
    if os.path.exists(env_file):
        with open(env_file, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    env[key.strip()] = value.strip().strip("\"'")

    # Parse commands
    if args.pipeline:
        # SECURITY: Restrict pipeline files to within the OpenClaw workspace
        pipeline_path = os.path.realpath(args.pipeline)
        allowed_dir = os.path.realpath(os.path.join(OPENCLAW_HOME, "workspace"))
        if not pipeline_path.startswith(allowed_dir + os.sep) and pipeline_path != allowed_dir:
            print(json.dumps({"success": False, "error": "Pipeline file must be within the workspace directory"}))
            sys.exit(1)
        try:
            with open(pipeline_path, "r") as f:
                pipeline = json.load(f)
            specs = []
            for step in pipeline.get("steps", []):
                spec = {"skill": step.get("skill", ""), "cmd": step.get("cmd", "")}
                if "intent" in step:
                    spec["intent"] = step["intent"]
                if "fields" in step:
                    spec["fields"] = step["fields"]
                specs.append(spec)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            print(json.dumps({"success": False, "error": "Failed to load pipeline file"}))
            sys.exit(1)
    else:
        try:
            specs = json.loads(args.commands)
        except json.JSONDecodeError as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON in --commands: {e}"}))
            sys.exit(1)

    if not isinstance(specs, list):
        print(json.dumps({"success": False, "error": "--commands must be a JSON array"}))
        sys.exit(1)

    # Execute each command
    results = []
    total_raw = 0
    total_summary = 0
    errors = 0

    for spec in specs:
        if "skill" not in spec or "cmd" not in spec:
            results.append({"success": False, "error": "Missing 'skill' or 'cmd' in spec", "spec": spec})
            errors += 1
            continue

        result = run_single(spec, env)
        results.append(result)

        if result.get("success"):
            total_raw += result.get("raw_bytes", 0)
            total_summary += result.get("summary_bytes", 0)
        else:
            errors += 1

    total_saved = total_raw - total_summary
    savings_pct = (total_saved / total_raw * 100) if total_raw > 0 else 0

    output = {
        "success": errors == 0,
        "timestamp": timestamp,
        "commands_run": len(specs),
        "commands_succeeded": len(specs) - errors,
        "commands_failed": errors,
        "total_raw_bytes": total_raw,
        "total_summary_bytes": total_summary,
        "total_bytes_saved": total_saved,
        "total_savings_pct": round(savings_pct, 1),
        "results": results,
    }
    print(json.dumps(output))


if __name__ == "__main__":
    main()
