#!/usr/bin/env bash
set -euo pipefail

cd /opt/bian-reporter
mkdir -p logs

log="logs/daily_$(date -u +%Y%m%d_%H%M%S).log"

{
  flock -n 9 || {
    echo "Another report run is already active."
    exit 0
  }

  /usr/bin/python3 ./linux_auto_invest_report.py
} 9>/tmp/bian-reporter.lock >> "$log" 2>&1
