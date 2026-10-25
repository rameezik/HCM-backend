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
test('local setup works without an example file and preserves generated keys on repeated setup', () => {
  const { spawnSync } = require('node:child_process');
  const dotenv = require('dotenv');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcm-env-setup-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(__dirname, '../scripts/setup-env.js'), path.join(dir, 'scripts/setup-env.js'));
    const env = { ...process.env, NODE_ENV: 'development', NODE_PATH: path.join(__dirname, '../node_modules') };
    delete env.JWT_SECRET;
    delete env.BIOMETRIC_TEMPLATE_KEY;
    const run = () => spawnSync(process.execPath, [path.join(dir, 'scripts/setup-env.js')], { env, encoding: 'utf8' });
    assert.equal(run().status, 0);
    const first = dotenv.parse(fs.readFileSync(path.join(dir, '.env')));
    assert.equal(first.PORT, '4000');
    assert.match(first.MONGODB_URI, /^mongodb:\/\/127\.0\.0\.1/);
    assert.ok(first.JWT_SECRET.length >= 32);
    assert.ok(Buffer.from(first.BIOMETRIC_TEMPLATE_KEY, 'base64').length === 32);
    assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
    assert.equal(run().status, 0);
    const next = dotenv.parse(fs.readFileSync(path.join(dir, '.env')));
    assert.ok(first.JWT_SECRET === next.JWT_SECRET);
    assert.ok(first.BIOMETRIC_TEMPLATE_KEY === next.BIOMETRIC_TEMPLATE_KEY);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
