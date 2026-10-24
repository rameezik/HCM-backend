"""Bounded, local CPU face detection/alignment/embedding inference.

JSON input/output travels on a child process pipe, never an HTTP inference service.
No input image, aligned crop or embedding is written to disk or logged.
"""
import base64
import json
import os
from pathlib import Path
import sys

os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
import cv2
import numpy as np

cv2.setNumThreads(1)
ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = Path(os.environ.get("BIOMETRIC_MODEL_DIR") or ROOT / "models/local-face").resolve()
MODEL_VERSION = "opencv-sface-2021dec-yunet-2023mar-v1"


def models():
    detector = cv2.FaceDetectorYN.create(str(MODEL_DIR / "face_detection_yunet_2023mar.onnx"), "", (320, 320), 0.9, 0.3, 5000)
    recognizer = cv2.FaceRecognizerSF.create(str(MODEL_DIR / "face_recognition_sface_2021dec.onnx"), "")
    return detector, recognizer


def extract(payload):
    images = payload.get("images")
    if not isinstance(images, list) or not 1 <= len(images) <= 5:
        raise ValueError("Provide between one and five camera samples.")
    detector, recognizer = models()
    embeddings, quality = [], []
    for encoded in images:
        if not isinstance(encoded, str) or len(encoded) > 700000:
            raise ValueError("A camera sample exceeded the permitted size.")
        if encoded.startswith("data:image/jpeg;base64,"):
            encoded = encoded[len("data:image/jpeg;base64,"):]
        try:
            raw = bytearray(base64.b64decode(encoded, validate=True))
        except Exception:
            raise ValueError("Camera samples must be valid base64 JPEG images.") from None
        if not 100 <= len(raw) <= 512 * 1024 or raw[:3] != b"\xff\xd8\xff":
            raise ValueError("Camera samples must be JPEG images no larger than 512 KiB.")
        image = None
        aligned = None
        try:
            # Read the JPEG header before decoding, so a compressed image bomb is
            # rejected without allocating its claimed pixel dimensions.
            width, height = jpeg_size(raw)
            if not 160 <= width <= 1920 or not 160 <= height <= 1920:
                raise ValueError("Use a camera image between 160 and 1920 pixels per side.")
            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None or image.shape[:2] != (height, width):
                raise ValueError("The camera image could not be decoded.")
            # Detection is bounded to 960px; alignCrop uses coordinates rescaled
            # to the original decoded image for the genuine five-point warp.
            scale = min(1.0, 960.0 / max(width, height))
            detection_image = cv2.resize(image, (int(width * scale), int(height * scale))) if scale < 1 else image
            detector.setInputSize((detection_image.shape[1], detection_image.shape[0]))
            _, faces = detector.detect(detection_image)
            if faces is None or len(faces) != 1:
                raise ValueError("Exactly one clearly visible face is required in every camera sample.")
            face = faces[0].copy()
            face[:14] /= scale
            if face[2] < 70 or face[3] < 70:
                raise ValueError("Move closer to the camera; the face is too small to verify.")
            aligned = recognizer.alignCrop(image, face)
            variance = float(cv2.Laplacian(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
            if not np.isfinite(variance) or variance < 20:
                raise ValueError("The face sample is too blurred. Use steady camera capture and good lighting.")
            feature = recognizer.feature(aligned).reshape(-1).astype(np.float32)
            norm = float(np.linalg.norm(feature))
            if feature.size != 128 or not np.isfinite(feature).all() or norm <= 1e-8:
                raise ValueError("The local recognition model could not produce a usable template.")
            feature /= norm
            embeddings.append(feature.tolist())
            quality.append({"detectionScore": float(face[14]), "faceWidth": round(float(face[2])), "faceHeight": round(float(face[3])), "blurVariance": round(variance, 2)})
            feature.fill(0)
        finally:
            raw[:] = b"\x00" * len(raw)
            if image is not None:
                image.fill(0)
            if aligned is not None:
                aligned.fill(0)
    return {"embeddings": embeddings, "quality": quality, "modelVersion": MODEL_VERSION}


def jpeg_size(raw):
    cursor = 2
    while cursor + 3 < len(raw):
        if raw[cursor] != 0xFF:
            raise ValueError("Invalid JPEG marker sequence.")
        while cursor < len(raw) and raw[cursor] == 0xFF:
            cursor += 1
        if cursor >= len(raw):
            break
        marker = raw[cursor]
        cursor += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if cursor + 2 > len(raw):
            break
        size = int.from_bytes(raw[cursor:cursor + 2], "big")
        if size < 2 or cursor + size > len(raw):
            break
        if marker in (0xC0, 0xC1, 0xC2):
            if size < 8:
                break
            return int.from_bytes(raw[cursor + 5:cursor + 7], "big"), int.from_bytes(raw[cursor + 3:cursor + 5], "big")
        if marker == 0xDA:
            break
        cursor += size
    raise ValueError("The camera sample has an unsupported JPEG header.")


def main():
    if "--check" in sys.argv:
        models()
        print(json.dumps({"ready": True, "runtime": f"opencv-{cv2.__version__}", "modelVersion": MODEL_VERSION}))
        return
    data = sys.stdin.buffer.read(3600001)
    if len(data) > 3600000:
        raise ValueError("The camera sample batch is too large.")
    try:
        result = extract(json.loads(data))
        print(json.dumps({"ok": True, **result}, separators=(",", ":"), allow_nan=False))
    except ValueError as error:
        print(json.dumps({"ok": False, "status": 422, "message": str(error)}))
    except Exception:
        print(json.dumps({"ok": False, "status": 503, "message": "Local face inference failed. Check the model files and Python runtime; ordinary attendance remains available."}))


if __name__ == "__main__":
    main()
