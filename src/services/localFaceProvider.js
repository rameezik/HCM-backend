const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const ApiError = require("../utils/ApiError");

const PROVIDER = "local-opencv-sface";
const MODEL_VERSION = "opencv-sface-2021dec-yunet-2023mar-v1";
const BACKEND_ROOT = path.resolve(__dirname, "../..");
const MODEL_FILES = [
  "face_detection_yunet_2023mar.onnx",
  "face_recognition_sface_2021dec.onnx",
];
const INFERENCE_SCRIPT = path.join(BACKEND_ROOT, "scripts/local-face/infer.py");
const READINESS_TTL = 30000;

let pendingRequests = 0;
let inferenceQueue = Promise.resolve();
let readinessCache;

function executableFile(filename) {
  if (!filename) return false;
  try {
    fs.accessSync(filename, fs.constants.X_OK);
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

function resolvePythonPath(value) {
  if (!value) {
    return path.join(
      BACKEND_ROOT,
      process.platform === "win32"
        ? ".local-face-venv/Scripts/python.exe"
        : ".local-face-venv/bin/python",
    );
  }
  if (path.isAbsolute(value) || /[\\/]/.test(value)) {
    return path.resolve(BACKEND_ROOT, value);
  }
  const extensions =
    process.platform === "win32" && !path.extname(value)
      ? ["", ...(process.env.PATHEXT || ".EXE").split(";")]
      : [""];
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(directory, value + extension);
      if (executableFile(candidate)) return candidate;
    }
  }
  return null;
}

function numericSetting(name, fallback) {
  const value = process.env[name]?.trim();
  return value ? Number(value) : fallback;
}

function configuration() {
  const modelDir = path.resolve(
    BACKEND_ROOT,
    process.env.BIOMETRIC_MODEL_DIR?.trim() || "models/local-face",
  );
  const pythonPath = resolvePythonPath(
    process.env.BIOMETRIC_PYTHON_PATH?.trim(),
  );

  const missing = [];

  for (const filename of MODEL_FILES) {
    try {
      const size = fs.statSync(path.join(modelDir, filename)).size;

      if (size < 100000) {
        missing.push(filename);
      }
    } catch {
      missing.push(filename);
    }
  }

  if (!executableFile(pythonPath)) {
    missing.push("BIOMETRIC_PYTHON_PATH");
  }

  const similarityThreshold = numericSetting(
    "BIOMETRIC_MATCH_THRESHOLD",
    0.363,
  );
  const retentionDays = numericSetting("BIOMETRIC_RETENTION_DAYS", 365);

  if (
    !Number.isFinite(similarityThreshold) ||
    similarityThreshold < 0.363 ||
    similarityThreshold > 0.99
  ) {
    missing.push("BIOMETRIC_MATCH_THRESHOLD");
  }

  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 365
  ) {
    missing.push("BIOMETRIC_RETENTION_DAYS");
  }

  return {
    provider: PROVIDER,
    modelVersion: MODEL_VERSION,
    configured: missing.length === 0,
    missing,
    modelDir,
    pythonPath,
    similarityThreshold,
    retentionDays,
    livenessSupported: false,
  };
}

function workerEnvironment(config) {
  return {
    ...process.env,
    BIOMETRIC_MODEL_DIR: config.modelDir,
    OPENCV_LOG_LEVEL: "ERROR",
    OMP_NUM_THREADS: "1",
    OPENBLAS_NUM_THREADS: "1",
  };
}

function fileSignature(filename) {
  try {
    const file = fs.statSync(filename);
    return [file.size, file.mtimeMs, file.ctimeMs, file.ino];
  } catch {
    return null;
  }
}

function readinessKey(config) {
  return JSON.stringify([
    config.pythonPath,
    config.modelDir,
    fileSignature(config.pythonPath),
    fileSignature(INFERENCE_SCRIPT),
    ...MODEL_FILES.map((filename) =>
      fileSignature(path.join(config.modelDir, filename)),
    ),
  ]);
}

function probeRuntime(config) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = spawn(config.pythonPath, [INFERENCE_SCRIPT, "--check"], {
        env: workerEnvironment(config),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ checked: true, ready: false, reason: "runtime-unavailable" });
      return;
    }
    const chunks = [];
    let outputSize = 0;
    let finished = false;
    const timeout = setTimeout(() => {
      worker.kill("SIGKILL");
      finish(false);
    }, 20000);
    function finish(ready) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      chunks.forEach((chunk) => chunk.fill(0));
      resolve({
        checked: true,
        ready,
        reason: ready ? null : "runtime-unavailable",
      });
    }
    worker.on("error", () => finish(false));
    worker.stderr.on("data", () => {});
    worker.stdout.on("data", (chunk) => {
      if (finished) return;
      outputSize += chunk.length;
      if (outputSize > 16384) {
        worker.kill("SIGKILL");
        finish(false);
      } else chunks.push(chunk);
    });
    worker.on("close", (code) => {
      if (finished) return;
      const output = Buffer.concat(chunks);
      try {
        const result = JSON.parse(output.toString("utf8"));
        finish(
          code === 0 &&
            result.ready === true &&
            result.modelVersion === MODEL_VERSION,
        );
      } catch {
        finish(false);
      } finally {
        output.fill(0);
      }
    });
  });
}

async function readiness() {
  const config = configuration();
  if (!config.configured) {
    return {
      ...config,
      runtime: {
        checked: false,
        ready: false,
        reason: "configuration-required",
      },
    };
  }
  const key = readinessKey(config);
  if (
    !readinessCache ||
    readinessCache.key !== key ||
    (!readinessCache.promise && readinessCache.expiresAt <= Date.now())
  ) {
    const entry = { key, promise: probeRuntime(config) };
    readinessCache = entry;
    entry.promise.then((result) => {
      entry.result = result;
      entry.expiresAt = Date.now() + READINESS_TTL;
      entry.promise = null;
    });
  }
  const runtime = readinessCache.promise
    ? await readinessCache.promise
    : readinessCache.result;
  return {
    ...config,
    configured: runtime.ready,
    missing: runtime.ready
      ? config.missing
      : [...config.missing, "BIOMETRIC_RUNTIME"],
    runtime,
  };
}

function requireConfiguration() {
  const config = configuration();

  if (!config.configured) {
    const error = new ApiError(
      503,
      "Local face verification is not configured. Run npm run setup:face and npm run setup:env in HCM-backend; check the local model/runtime and encryption key. Ordinary attendance remains available.",
    );

    error.code = "BIOMETRIC_NOT_CONFIGURED";
    throw error;
  }

  return config;
}

function validateEmbedding(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 128 ||
    value.some((n) => typeof n !== "number" || !Number.isFinite(n))
  ) {
    throw new ApiError(422, "The local face template is invalid.");
  }

  const norm = Math.sqrt(value.reduce((sum, n) => sum + n * n, 0));

  if (norm < 0.99 || norm > 1.01) {
    throw new ApiError(422, "The local face template is not normalized.");
  }

  return value;
}

function compare(left, right) {
  validateEmbedding(left);
  validateEmbedding(right);

  const dotProduct = left.reduce(
    (sum, value, index) => sum + value * right[index],
    0,
  );

  const leftLength = Math.sqrt(left.reduce((sum, n) => sum + n * n, 0));

  const rightLength = Math.sqrt(right.reduce((sum, n) => sum + n * n, 0));

  return Math.max(-1, Math.min(1, dotProduct / (leftLength * rightLength)));
}

function runInference(images, config) {
  return new Promise((resolve, reject) => {
    // Keep image bytes on stdin, not process arguments.
    const worker = spawn(config.pythonPath, [INFERENCE_SCRIPT], {
      env: workerEnvironment(config),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const outputChunks = [];
    let outputBytes = 0;
    let finished = false;

    const timeout = setTimeout(() => {
      worker.kill("SIGKILL");

      finish(
        new ApiError(
          503,
          "Local face inference timed out. Try again or use ordinary attendance.",
        ),
      );
    }, 20000);

    function finish(error, result) {
      if (finished) return;

      finished = true;
      clearTimeout(timeout);

      outputChunks.forEach((chunk) => chunk.fill(0));

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }

    worker.on("error", () => {
      finish(
        new ApiError(
          503,
          "The local face runtime could not start. Run npm run setup:face; ordinary attendance remains available.",
        ),
      );
    });

    worker.stdin.on("error", () => {});

    // Do not expose inference diagnostics through API responses.
    worker.stderr.on("data", () => {});

    worker.stdout.on("data", (chunk) => {
      if (finished) return;

      outputBytes += chunk.length;

      if (outputBytes > 100000) {
        worker.kill("SIGKILL");

        finish(
          new ApiError(
            503,
            "The local face runtime returned an invalid response.",
          ),
        );
      } else {
        outputChunks.push(chunk);
      }
    });

    worker.on("close", (code) => {
      if (finished) return;

      let result;
      const output = Buffer.concat(outputChunks);

      try {
        if (code !== 0) {
          throw new Error("Runtime failed");
        }

        result = JSON.parse(output.toString("utf8"));

        if (!result.ok) {
          finish(
            new ApiError(
              result.status === 422 ? 422 : 503,
              result.message || "Local face inference failed.",
            ),
          );
          return;
        }

        if (
          result.modelVersion !== MODEL_VERSION ||
          !Array.isArray(result.embeddings) ||
          result.embeddings.length !== images.length
        ) {
          throw new Error("Invalid model output");
        }

        result.embeddings.forEach(validateEmbedding);

        finish(null, {
          embeddings: result.embeddings,
          quality: result.quality,
          modelVersion: result.modelVersion,
        });
      } catch {
        finish(
          new ApiError(
            503,
            "Local face inference failed. Check the model files and Python runtime; ordinary attendance remains available.",
          ),
        );
      } finally {
        output.fill(0);
      }
    });

    worker.stdin.end(JSON.stringify({ images }));
  });
}

async function extractSamples(images) {
  const config = requireConfiguration();

  if (
    !Array.isArray(images) ||
    images.length < 1 ||
    images.length > 5 ||
    images.some(
      (image) =>
        typeof image !== "string" ||
        image.length > 700000 ||
        !/^(?:data:image\/jpeg;base64,)?[A-Za-z0-9+/]+={0,2}$/.test(image),
    )
  ) {
    throw new ApiError(
      422,
      "Provide valid JPEG camera samples within the permitted size.",
    );
  }

  if (pendingRequests >= 4) {
    throw new ApiError(
      429,
      "The local face processor is busy. Retry shortly or use ordinary attendance.",
    );
  }

  pendingRequests += 1;

  const operation = inferenceQueue.then(() => runInference(images, config));

  inferenceQueue = operation.catch(() => {});

  try {
    return await operation;
  } finally {
    pendingRequests -= 1;
  }
}

module.exports = {
  PROVIDER,
  MODEL_VERSION,
  configuration,
  readiness,
  requireConfiguration,
  extractSamples,
  compare,
  validateEmbedding,
};
