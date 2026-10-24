const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  loadEnvironment,
  backendEnvPath,
} = require("../src/config/environment");
test("backend env location is independent of launch directory and never replaces an injected key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcm-env-"));
  try {
    const file = path.join(dir, ".env");
    const stored = crypto.randomBytes(48).toString("hex");
    const injected = crypto.randomBytes(48).toString("hex");
    fs.writeFileSync(file, `JWT_SECRET=${stored}\n`, { mode: 0o600 });
    const env = {};
    loadEnvironment({ filePath: file, env });
    assert.equal(env.JWT_SECRET, stored);
    const existing = { JWT_SECRET: injected };
    loadEnvironment({ filePath: file, env: existing });
    assert.equal(existing.JWT_SECRET, injected);
    assert.throws(
      () => loadEnvironment({ filePath: file, env: { JWT_SECRET: "short" } }),
      /setup:env/,
    );
    assert.equal(path.dirname(backendEnvPath), path.resolve(__dirname, ".."));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("missing signing keys fail with actionable instructions instead of insecure fallback", () => {
  assert.throws(
    () =>
      loadEnvironment({
        filePath: path.join(os.tmpdir(), crypto.randomUUID()),
        env: { NODE_ENV: "production" },
      }),
    /hosting environment/,
  );
});
