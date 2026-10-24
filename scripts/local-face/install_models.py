"""Fetch official open-source models and verify the upstream Git LFS hashes.

Inference never downloads files. Run this setup script explicitly at installation.
"""
import hashlib
import os
from pathlib import Path
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = Path(os.environ.get("BIOMETRIC_MODEL_DIR") or ROOT / "models/local-face").resolve()
MODELS = (
    ("face_detection_yunet_2023mar.onnx", "face_detection_yunet", "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
    ("face_recognition_sface_2021dec.onnx", "face_recognition_sface", "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"),
)
UPSTREAM_REVISION = "48b10fa505aeb51fbd127fc60a5c660040e823b7"
MIRROR_REVISION = "d96f7798acb772a8383267b471d2ff2bd0d32701"


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def fetch(url, maximum):
    request = urllib.request.Request(url, headers={"User-Agent": "HCM-Lite-Local-Face-Setup"})
    with urllib.request.urlopen(request, timeout=45) as response:
        chunks, total = [], 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > maximum:
                raise RuntimeError("Model download exceeded the expected size bound")
            chunks.append(chunk)
        return b"".join(chunks)


def main():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    for filename, directory, expected in MODELS:
        target = MODEL_DIR / filename
        if target.is_file() and digest(target) == expected:
            print(f"Verified existing model: {filename}")
            continue
        url = f"https://media.githubusercontent.com/media/opencv/opencv_zoo/{UPSTREAM_REVISION}/models/{directory}/{filename}"
        descriptor, temporary = tempfile.mkstemp(prefix=filename + ".", suffix=".tmp", dir=MODEL_DIR)
        try:
            with os.fdopen(descriptor, "wb") as output:
                try:
                    data = fetch(url, 50 * 1024 * 1024)
                except (urllib.error.URLError, TimeoutError):
                    # Some restricted environments deny Git LFS media downloads.
                    # Read only ONNX data from a pinned ordinary-blob mirror.
                    # No mirror source code runs, and the model MUST match the
                    # official OpenCV Zoo Git LFS SHA-256 before installation.
                    print(f"Official download unavailable; fetching hash-verified pinned mirror: {filename}")
                    data = fetch(f"https://raw.githubusercontent.com/sun0801/YuNet_SFace2/{MIRROR_REVISION}/{filename}", 50 * 1024 * 1024)
                output.write(data)
            if digest(Path(temporary)) != expected:
                raise RuntimeError(f"SHA-256 mismatch for {filename}; model was not installed")
            os.chmod(temporary, 0o644)
            os.replace(temporary, target)
            print(f"Downloaded and SHA-256 verified: {filename}")
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


if __name__ == "__main__":
    main()
