#!/bin/bash
# Run the native (Apple Silicon / Metal) Kokoro-FastAPI server on 127.0.0.1:8880, fully offline.
set -euo pipefail
KOKORO_DIR="${1:-$HOME/local-ai-book-reader/Kokoro-FastAPI}"
cd "$KOKORO_DIR"
export PYTHONPATH="$PWD:$PWD/api"
export MODEL_DIR="src/models"
export VOICES_DIR="src/voices/v1_0"
export USE_GPU=true
export DEVICE_TYPE=mps
export PYTORCH_ENABLE_MPS_FALLBACK=1
export HF_HUB_OFFLINE=1
export HF_HUB_DISABLE_TELEMETRY=1
export TRANSFORMERS_OFFLINE=1
export ENABLE_WEB_PLAYER=false
exec .venv/bin/python -m uvicorn api.src.main:app --host 127.0.0.1 --port "${KOKORO_PORT:-8880}"
