// Genuine local CPU inference using the official YuNet + SFace ONNX models.
// The Python child is a bounded pipe, not an external inference API.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const ApiError = require("../utils/ApiError");

const PROVIDER = "local-opencv-sface";
const MODEL_VERSION = "opencv-sface-2021dec-yunet-2023mar-v1";
const ROOT = path.resolve(__dirname, "../..");
let pending = 0;
let queue = Promise.resolve();

function configuration() {
  const modelDir = path.resolve(process.env.BIOMETRIC_MODEL_DIR || path.join(ROOT, "models/local-face"));
  const pythonPath = path.resolve(process.env.BIOMETRIC_PYTHON_PATH || path.join(ROOT, ".local-face-venv/bin/python"));
  const missing = [];
  for (const filename of ["face_detection_yunet_2023mar.onnx", "face_recognition_sface_2021dec.onnx"]) {
    try {
      const size = fs.statSync(path.join(modelDir, filename)).size;
      if (size < 100000) missing.push(filename);
    } catch {
      missing.push(filename);
    }
  }
  try { fs.accessSync(pythonPath, fs.constants.X_OK); } catch { missing.push("BIOMETRIC_PYTHON_PATH"); }
  const similarityThreshold = Number(process.env.BIOMETRIC_MATCH_THRESHOLD ?? 0.363);
  const retentionDays = Number(process.env.BIOMETRIC_RETENTION_DAYS ?? 365);
  if (!Number.isFinite(similarityThreshold) || similarityThreshold < 0.363 || similarityThreshold > 0.99) missing.push("BIOMETRIC_MATCH_THRESHOLD");
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) missing.push("BIOMETRIC_RETENTION_DAYS");
  return { provider: PROVIDER, modelVersion: MODEL_VERSION, configured: missing.length === 0, missing, modelDir, pythonPath, similarityThreshold, retentionDays, livenessSupported: false };
}

function requireConfiguration() {
  const config = configuration();
  if (!config.configured) {
    const error = new ApiError(503, "Local face verification is not configured. Run npm run setup:face and npm run setup:env in HCM-backend; check the local model/runtime and encryption key. Ordinary attendance remains available.");
    error.code = "BIOMETRIC_NOT_CONFIGURED";
    throw error;
  }
  return config;
}

function validateEmbedding(value) {
  if (!Array.isArray(value) || value.length !== 128 || value.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new ApiError(422, "The local face template is invalid.");
  const norm = Math.sqrt(value.reduce((sum, n) => sum + n * n, 0));
  if (norm < 0.99 || norm > 1.01) throw new ApiError(422, "The local face template is not normalized.");
  return value;
}

function compare(left, right) {
  validateEmbedding(left);
  validateEmbedding(right);
  const dot = left.reduce((sum, n, i) => sum + n * right[i], 0);
  const normLeft = Math.sqrt(left.reduce((sum, n) => sum + n * n, 0));
  const normRight = Math.sqrt(right.reduce((sum, n) => sum + n * n, 0));
  return Math.max(-1, Math.min(1, dot / (normLeft * normRight)));
}

function runInference(images, config) {
  return new Promise((resolve, reject) => {
    // No shell, no client-supplied paths/arguments, and no face data in argv/logs.
    const child = spawn(config.pythonPath, [path.join(ROOT, "scripts/local-face/infer.py")], {
      env: { ...process.env, BIOMETRIC_MODEL_DIR: config.modelDir, OPENCV_LOG_LEVEL: "ERROR", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new ApiError(503, "Local face inference timed out. Try again or use ordinary attendance.")); }, 20000);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.forEach((chunk) => chunk.fill(0));
      if (error) reject(error); else resolve(result);
    }
    child.on("error", () => finish(new ApiError(503, "The local face runtime could not start. Run npm run setup:face; ordinary attendance remains available.")));
    child.stdin.on("error", () => {});
    // Never forward Python stderr, which might contain implementation/data details.
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 100000) {
        child.kill("SIGKILL");
        finish(new ApiError(503, "The local face runtime returned an invalid response."));
      } else chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      let result;
      const output = Buffer.concat(chunks);
      try {
        if (code !== 0) throw new Error("Runtime failed");
        result = JSON.parse(output.toString("utf8"));
        if (!result.ok) {
          finish(new ApiError(result.status === 422 ? 422 : 503, result.message || "Local face inference failed."));
          return;
        }
        if (result.modelVersion !== MODEL_VERSION || !Array.isArray(result.embeddings) || result.embeddings.length !== images.length) throw new Error("Invalid model output");
        result.embeddings.forEach(validateEmbedding);
        finish(null, { embeddings: result.embeddings, quality: result.quality, modelVersion: result.modelVersion });
      } catch {
        finish(new ApiError(503, "Local face inference failed. Check the model files and Python runtime; ordinary attendance remains available."));
      } finally { output.fill(0); }
    });
    child.stdin.end(JSON.stringify({ images }));
  });
}

async function extractSamples(images) {
  const config = requireConfiguration();
  if (!Array.isArray(images) || images.length < 1 || images.length > 5 || images.some((image) => typeof image !== "string" || image.length > 700000 || !/^(?:data:image\/jpeg;base64,)?[A-Za-z0-9+/]+={0,2}$/.test(image))) throw new ApiError(422, "Provide valid JPEG camera samples within the permitted size.");
  if (pending >= 4) throw new ApiError(429, "The local face processor is busy. Retry shortly or use ordinary attendance.");
  pending += 1;
  const operation = queue.then(() => runInference(images, config));
  queue = operation.catch(() => {});
  try { return await operation; } finally { pending -= 1; }
}

module.exports = { PROVIDER, MODEL_VERSION, configuration, requireConfiguration, extractSamples, compare, validateEmbedding };
