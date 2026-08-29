#!/usr/bin/env python3
"""
scripts/marathon_master_loop.py
Continuous Multi-Round Soak, Chaos, Memory Audit, and Benchmark Runner
"""

import os
import sys
import time
import json
import subprocess
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

WORKSPACE = Path(__file__).resolve().parent.parent
REPORT_FILE = WORKSPACE / "MARATHON_SOAK_REPORT.json"

def log(msg):
    t = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{t}] {msg}", flush=True)

def run_suite(name, cmd, cwd=WORKSPACE, timeout=900):
    log(f"▶ Starting suite: {name} (timeout: {timeout}s)...")
    t0 = time.time()
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            cwd=str(cwd),
            timeout=timeout,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace"
        )
        t1 = time.time()
        duration = t1 - t0
        passed = (proc.returncode == 0)
        if passed:
            log(f"✔ [{name}] PASSED in {duration:.2f}s")
        else:
            log(f"✖ [{name}] FAILED (exit code {proc.returncode}) in {duration:.2f}s\n--- STDOUT ---\n{proc.stdout[-1500:]}\n--- STDERR ---\n{proc.stderr[-1500:]}")
        return {
            "name": name,
            "passed": passed,
            "durationSec": duration,
            "exitCode": proc.returncode,
            "stdoutSnippet": proc.stdout[-500:] if proc.stdout else "",
            "stderrSnippet": proc.stderr[-500:] if proc.stderr else ""
        }
    except subprocess.TimeoutExpired:
        log(f"✖ [{name}] TIMED OUT after {timeout}s")
        return {"name": name, "passed": False, "durationSec": timeout, "exitCode": -1, "error": "TimeoutExpired"}
    except Exception as e:
        log(f"✖ [{name}] ERROR: {e}")
        return {"name": name, "passed": False, "durationSec": 0, "exitCode": -1, "error": str(e)}

def main():
    log("=" * 70)
    log("      NEARBY TRANSFER MARATHON SOAK & INTEGRATION SUITE       ")
    log("=" * 70)

    total_cycles = 5
    cycle_results = []

    for cycle in range(1, total_cycles + 1):
        log(f"\n######################################################################")
        log(f"                  MARATHON CYCLE {cycle:02d} / {total_cycles:02d}")
        log(f"######################################################################")
        cycle_start = time.time()
        suite_records = []

        # 1. Core & CLI unit/property/integration tests
        res1 = run_suite(f"Cycle {cycle}: Core Unit & Invariant Tests", "npm run test:core")
        suite_records.append(res1)

        res2 = run_suite(f"Cycle {cycle}: CLI Test Suite", "npm --prefix packages/cli run test")
        suite_records.append(res2)

        res3 = run_suite(f"Cycle {cycle}: LocalSend Adapter Suite", "npm --prefix packages/localsend-adapter run test")
        suite_records.append(res3)

        # 2. Desktop full test suites (41 suites)
        res4 = run_suite(f"Cycle {cycle}: Desktop Full Test Suite (41 Suites)", "npm test", timeout=300)
        suite_records.append(res4)

        # 3. WebDAV & Browser Portal E2E
        res5 = run_suite(f"Cycle {cycle}: Browser Portal E2E", "node test/browser-portal-e2e.js")
        suite_records.append(res5)

        res6 = run_suite(f"Cycle {cycle}: rclone & WebDAV Deep Interop", "python scripts/test_rclone_webdav_interop.py", timeout=180)
        suite_records.append(res6)

        # 4. 3-VM Extreme Chaos & Matrix Suite (53 Cases)
        res7 = run_suite(f"Cycle {cycle}: 3-VM Extreme Chaos & Security Suite (53 Cases)", "python scripts/master_vm_test_suite.py", timeout=600)
        suite_records.append(res7)

        # 5. Android Real Hardware Matrix Suite (9 Cases)
        res8 = run_suite(f"Cycle {cycle}: Android Real Device Matrix Suite (9 Cases)", "python scripts/master_android_test_suite.py", timeout=600)
        suite_records.append(res8)

        cycle_duration = time.time() - cycle_start
        all_passed = all(r["passed"] for r in suite_records)
        log(f"\n[Cycle {cycle} Summary] Duration: {cycle_duration:.2f}s | All Passed: {all_passed}")

        cycle_results.append({
            "cycle": cycle,
            "durationSec": cycle_duration,
            "allPassed": all_passed,
            "suites": suite_records
        })

        if not all_passed:
            log(f"[-] Cycle {cycle} encountered failures. Halting for investigation.")
            break

    # Save comprehensive report
    REPORT_FILE.write_text(json.dumps({
        "timestamp": datetime.now().isoformat(),
        "totalCycles": len(cycle_results),
        "allCyclesPassed": all(c["allPassed"] for c in cycle_results),
        "cycles": cycle_results
    }, indent=2), encoding="utf-8")
    log(f"\n[+] Marathon soak test report written to {REPORT_FILE}")

if __name__ == "__main__":
    main()
