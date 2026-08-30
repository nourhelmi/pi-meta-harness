#!/bin/bash
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
uv run --no-project --with harbor-rewardkit==0.1 python /tests/run_rewardkit.py
