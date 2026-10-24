#!/usr/bin/env bash
set -euo pipefail
backend_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_binary="${PYTHON_BINARY:-python3}"
"$python_binary" -m venv "$backend_root/.local-face-venv"
"$backend_root/.local-face-venv/bin/python" -m pip install --disable-pip-version-check --cache-dir /tmp/hcm-face-pip-cache -r "$backend_root/scripts/local-face/requirements.txt"
"$backend_root/.local-face-venv/bin/python" "$backend_root/scripts/local-face/install_models.py"
"$backend_root/.local-face-venv/bin/python" "$backend_root/scripts/local-face/infer.py" --check
