const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const provider = require("../src/services/localFaceProvider");

const backendRoot = path.resolve(__dirname, "..");
const environmentNames = [
  "BIOMETRIC_MODEL_DIR",
  "BIOMETRIC_PYTHON_PATH",
  "BIOMETRIC_MATCH_THRESHOLD",
  "BIOMETRIC_RETENTION_DAYS",
  "PATH",
  "PYTHONPATH",
];

test(
  "runtime readiness uses the same actual interpreter and model paths as inference",
  { timeout: 120000 },
  async (t) => {
    const saved = Object.fromEntries(
      environmentNames.map((name) => [name, process.env[name]]),
    );
    const originalDirectory = process.cwd();
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "hcm-face-runtime-"),
    );
    t.after(() => {
      process.chdir(originalDirectory);
      for (const name of environmentNames) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    });

    function defaults() {
      process.chdir(originalDirectory);
      for (const name of environmentNames.slice(0, 4)) delete process.env[name];
      if (saved.PATH === undefined) delete process.env.PATH;
      else process.env.PATH = saved.PATH;
      if (saved.PYTHONPATH === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = saved.PYTHONPATH;
    }
    defaults();
    const installed = provider.configuration();
    assert.equal(
      installed.configured,
      true,
      "Run npm run setup:face before actual runtime tests.",
    );

    await t.test(
      "relative paths are trimmed and rooted at the backend, regardless of the start directory",
      async () => {
        process.env.BIOMETRIC_MODEL_DIR = " models/local-face ";
        process.env.BIOMETRIC_PYTHON_PATH = ` ${path.relative(backendRoot, installed.pythonPath)} `;
        process.chdir(temporary);
        const config = provider.configuration();
        assert.equal(config.pythonPath, installed.pythonPath);
        assert.equal(config.modelDir, installed.modelDir);
        const result = await provider.readiness();
        assert.equal(result.configured, true);
        assert.deepEqual(result.runtime, {
          checked: true,
          ready: true,
          reason: null,
        });
        const image = fs
          .readFileSync(
            path.join(__dirname, "fixtures/local-face/astronaut.jpg"),
          )
          .toString("base64");
        const actual = await provider.extractSamples([image]);
        assert.equal(actual.modelVersion, provider.MODEL_VERSION);
        assert.equal(actual.embeddings[0].length, 128);
        assert.ok(Math.abs(Math.hypot(...actual.embeddings[0]) - 1) < 0.01);
      },
    );

    await t.test(
      "a bare Python command resolves through PATH instead of becoming a nonexistent project file",
      async () => {
        defaults();
        process.env.PATH = `${path.dirname(installed.pythonPath)}${path.delimiter}${saved.PATH || ""}`;
        process.env.BIOMETRIC_PYTHON_PATH = ` ${path.basename(installed.pythonPath)} `;
        const result = await provider.readiness();
        assert.equal(result.pythonPath, installed.pythonPath);
        assert.equal(result.configured, true);
        assert.equal(result.runtime.ready, true);
      },
    );

    await t.test(
      "invalid explicit interpreter overrides fail closed without falling back to another runtime",
      async () => {
        defaults();
        for (const value of [
          path.join(temporary, "missing-python"),
          "hcm-missing-python-command-987654",
        ]) {
          process.env.BIOMETRIC_PYTHON_PATH = value;
          const result = await provider.readiness();
          assert.equal(result.configured, false);
          assert.ok(result.missing.includes("BIOMETRIC_PYTHON_PATH"));
          assert.equal(result.runtime.checked, false);
          assert.throws(() => provider.requireConfiguration(), {
            status: 503,
            code: "BIOMETRIC_NOT_CONFIGURED",
          });
        }
      },
    );

    await t.test(
      "blank optional numeric settings use defaults while nonblank invalid values are rejected",
      () => {
        defaults();
        process.env.BIOMETRIC_MATCH_THRESHOLD = "  ";
        process.env.BIOMETRIC_RETENTION_DAYS = "";
        const blank = provider.configuration();
        assert.equal(blank.similarityThreshold, 0.363);
        assert.equal(blank.retentionDays, 365);
        assert.equal(blank.configured, true);
        process.env.BIOMETRIC_MATCH_THRESHOLD = "0";
        process.env.BIOMETRIC_RETENTION_DAYS = "invalid";
        const invalid = provider.configuration();
        assert.equal(invalid.configured, false);
        assert.ok(invalid.missing.includes("BIOMETRIC_MATCH_THRESHOLD"));
        assert.ok(invalid.missing.includes("BIOMETRIC_RETENTION_DAYS"));
      },
    );

    await t.test(
      "concurrent status checks share the successful actual model probe",
      async () => {
        defaults();
        const results = await Promise.all([
          provider.readiness(),
          provider.readiness(),
          provider.readiness(),
        ]);
        for (const result of results) {
          assert.equal(result.configured, true);
          assert.equal(result.runtime.ready, true);
          assert.strictEqual(result.runtime, results[0].runtime);
        }
      },
    );

    await t.test(
      "an executable Python without OpenCV is unavailable even when the ONNX files exist",
      async () => {
        defaults();
        process.env.PYTHONPATH = "";
        const emptyEnvironment = path.join(temporary, "python-without-opencv");
        const created = spawnSync(
          installed.pythonPath,
          ["-m", "venv", "--without-pip", emptyEnvironment],
          { encoding: "utf8", timeout: 30000 },
        );
        assert.equal(
          created.status,
          0,
          "A dependency-free Python fixture must be created successfully.",
        );
        process.env.BIOMETRIC_PYTHON_PATH = path.join(
          emptyEnvironment,
          process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
        );
        assert.equal(
          provider.configuration().configured,
          true,
          "File presence alone does not verify imported runtime dependencies.",
        );
        const result = await provider.readiness();
        assert.equal(result.configured, false);
        assert.ok(result.missing.includes("BIOMETRIC_RUNTIME"));
        assert.deepEqual(result.runtime, {
          checked: true,
          ready: false,
          reason: "runtime-unavailable",
        });
        assert.doesNotMatch(
          JSON.stringify(result.runtime),
          /Traceback|ModuleNotFoundError|stderr/,
        );
      },
    );

    await t.test(
      "replacing a model invalidates cached readiness and corrupt models cannot report ready",
      async () => {
        defaults();
        const copyDirectory = path.join(temporary, "models");
        fs.mkdirSync(copyDirectory);
        for (const name of [
          "face_detection_yunet_2023mar.onnx",
          "face_recognition_sface_2021dec.onnx",
        ]) {
          fs.copyFileSync(
            path.join(installed.modelDir, name),
            path.join(copyDirectory, name),
          );
        }
        process.env.BIOMETRIC_MODEL_DIR = copyDirectory;
        assert.equal((await provider.readiness()).configured, true);
        const detector = path.join(
          copyDirectory,
          "face_detection_yunet_2023mar.onnx",
        );
        const handle = fs.openSync(detector, "r+");
        try {
          fs.writeSync(handle, Buffer.alloc(32), 0, 32, 0);
        } finally {
          fs.closeSync(handle);
        }
        assert.equal(
          provider.configuration().configured,
          true,
          "The model still exceeds the file-size check.",
        );
        const invalid = await provider.readiness();
        assert.equal(invalid.configured, false);
        assert.ok(invalid.missing.includes("BIOMETRIC_RUNTIME"));
        fs.copyFileSync(
          path.join(installed.modelDir, "face_detection_yunet_2023mar.onnx"),
          detector,
        );
        assert.equal((await provider.readiness()).configured, true);
      },
    );

    await t.test(
      "missing models retain clear configuration failures and do not run the probe",
      async () => {
        defaults();
        process.env.BIOMETRIC_MODEL_DIR = path.join(
          temporary,
          "missing-model-directory",
        );
        const result = await provider.readiness();
        assert.equal(result.configured, false);
        assert.ok(result.missing.includes("face_detection_yunet_2023mar.onnx"));
        assert.equal(result.runtime.checked, false);
      },
    );
  },
);
