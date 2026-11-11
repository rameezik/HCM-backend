#!/usr/bin/env bash
set -euo pipefail
backend_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_binary="${PYTHON_BINARY:-python3}"
if ! command -v "$python_binary" >/dev/null 2>&1; then
  echo "Local face setup requires Python 3.10–3.13 with venv support. Install python3 and python3-venv, or deploy the supplied Dockerfile on Render." >&2
  exit 1
fi
"$python_binary" - <<'PY'
import sys
if not (3, 10) <= sys.version_info[:2] <= (3, 13):
    raise SystemExit("Local face dependencies require Python 3.10–3.13. Use the supplied Node24/Debian12 Dockerfile for a known Python3.11 runtime.")
PY
if ! "$python_binary" -m venv "$backend_root/.local-face-venv"; then
  echo "Python venv creation failed. Install python3-venv, or use the supplied Render Dockerfile. No face verification can run until setup succeeds." >&2
  exit 1
fi
"$backend_root/.local-face-venv/bin/python" -m pip install --disable-pip-version-check --cache-dir /tmp/hcm-face-pip-cache -r "$backend_root/scripts/local-face/requirements.txt"
"$backend_root/.local-face-venv/bin/python" "$backend_root/scripts/local-face/install_models.py"
"$backend_root/.local-face-venv/bin/python" "$backend_root/scripts/local-face/infer.py" --check



#!/usr/bin/env bash
set -euo pipefail

backend_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Detect Python
if [[ -n "${PYTHON_BINARY:-}" ]]; then
  python_binary="$PYTHON_BINARY"
elif command -v python3 >/dev/null 2>&1; then
  python_binary="python3"
elif command -v python >/dev/null 2>&1; then
  python_binary="python"
else
  echo "Python 3.10–3.13 is required."
  exit 1
fi

# Check Python version
"$python_binary" - <<'PY'
import sys
if not (3, 10) <= sys.version_info[:2] <= (3, 13):
    raise SystemExit("Python 3.10–3.13 required.")
PY

# Create virtual environment
venv_dir="$backend_root/.local-face-venv"
"$python_binary" -m venv "$venv_dir"

# Detect Windows or Linux venv
if [[ -f "$venv_dir/Scripts/python.exe" ]]; then
  venv_python="$venv_dir/Scripts/python.exe"
else
  venv_python="$venv_dir/bin/python"
fi

# Install dependencies
"$venv_python" -m pip install \
  --disable-pip-version-check \
  -r "$backend_root/scripts/local-face/requirements.txt"

# Install models
"$venv_python" "$backend_root/scripts/local-face/install_models.py"

# Verify installation
"$venv_python" "$backend_root/scripts/local-face/infer.py" --check

echo "Local face setup completed successfully."
