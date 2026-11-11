const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const models = require("../src/models");
const provider = require("../src/services/localFaceProvider");

test(
  "face enrollment reports changed encryption keys and recovers without deleting templates",
  { timeout: 90000 },
  async (t) => {
    const environmentNames = [
      "JWT_SECRET",
      "BIOMETRIC_TEMPLATE_KEY",
      "BIOMETRIC_TEMPLATE_KEY_ID",
      "NODE_ENV",
    ];
    const previous = Object.fromEntries(
      environmentNames.map((name) => [name, process.env[name]]),
    );
    const originalKey = crypto.randomBytes(32).toString("base64");
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
    process.env.BIOMETRIC_TEMPLATE_KEY = originalKey;
    process.env.BIOMETRIC_TEMPLATE_KEY_ID = "isolated-key-v1";
    process.env.NODE_ENV = "test";
    t.after(() => {
      for (const name of environmentNames) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    });

    assert.equal(
      (await provider.readiness()).configured,
      true,
      "Install the genuine local models before running encryption enrollment tests.",
    );
    const dbName = `hcm_test_key_rotation_${process.pid}_${Date.now()}`;
    await mongoose.connect(
      process.env.TEST_MONGODB_URI ||
        "mongodb://127.0.0.1:27017/?replicaSet=hcm",
      { dbName, serverSelectionTimeoutMS: 10000 },
    );
    t.after(async () => {
      assert.match(mongoose.connection.name, /^hcm_test_key_rotation_/);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });
    await Promise.all(Object.values(models).map((model) => model.init()));
    const server = require("../src/app").listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    let cookie = "";

    async function request(
      endpoint,
      method = "GET",
      body,
      expectedStatus = 200,
    ) {
      const response = await fetch(base + endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const session = response.headers.getSetCookie()[0];
      if (session) cookie = session.split(";")[0];
      const result = await response.json();
      assert.equal(
        response.status,
        expectedStatus,
        `${method} ${endpoint}: ${result.message || response.statusText}`,
      );
      return result;
    }

    const password = crypto.randomBytes(20).toString("base64url");
    const owner = await request(
      "/auth/register",
      "POST",
      {
        company: { name: "Isolated biometric key recovery", weekend: [] },
        name: "Isolated recovery Admin",
        email: "admin@key-recovery.example.test",
        password,
      },
      201,
    );
    const department = await request(
      "/departments",
      "POST",
      { name: "Recovery department" },
      201,
    );
    const designation = await request(
      "/designations",
      "POST",
      { name: "Recovery designation" },
      201,
    );

    async function employee(suffix, filename) {
      const row = await request(
        "/employees",
        "POST",
        {
          name: `Isolated ${suffix}`,
          email: `${suffix}@key-recovery.example.test`,
          code: `RECOVERY-${suffix}`,
          password,
          department: department._id,
          designation: designation._id,
          joinDate: "2020-01-01",
          basic: 100000,
        },
        201,
      );
      const image = fs
        .readFileSync(path.join(__dirname, "fixtures/local-face", filename))
        .toString("base64");
      await request(`/employees/${row._id}/photo`, "POST", {
        image: `data:image/jpeg;base64,${image}`,
      });
      return row;
    }

    // Public-domain portraits are processed by the actual local model and stored
    // only in this disposable database, never as production employee records.
    const enrolled = await employee("enrolled", "grace_hopper.jpg");
    const target = await employee("target", "astronaut.jpg");
    const management = "/attendance-terminal-management";
    const settings = () => request(`${management}/employees`);
    const consentVersion = (await settings()).consent.version;
    const enable = (employeeId, expectedStatus = 200) =>
      request(
        `${management}/employees/${employeeId}/enrollment`,
        "POST",
        { consent: true, consentVersion },
        expectedStatus,
      );
    const template = (employeeId) =>
      models.BiometricEnrollment.findOne({
        company: owner.company,
        employee: employeeId,
      })
        .select("+protectedTemplate")
        .lean();
    const fingerprint = (row) =>
      crypto
        .createHash("sha256")
        .update(JSON.stringify(row.protectedTemplate))
        .digest("hex");

    await enable(enrolled._id);
    const stored = await template(enrolled._id);
    const originalFingerprint = fingerprint(stored);

    await t.test(
      "a new valid key leaves readiness true but cannot decrypt previously enrolled employees",
      async () => {
        process.env.BIOMETRIC_TEMPLATE_KEY = crypto
          .randomBytes(32)
          .toString("base64");
        try {
          const readiness = await settings();
          assert.equal(readiness.configured, true);
          assert.equal(readiness.runtime.ready, true);
          const failure = await enable(target._id, 503);
          assert.equal(failure.code, "BIOMETRIC_TEMPLATE_UNREADABLE");
          assert.doesNotMatch(
            JSON.stringify(failure),
            /ciphertext|protectedTemplate/,
          );
          assert.equal(JSON.stringify(failure).includes(originalKey), false);
          assert.equal(
            JSON.stringify(failure).includes(
              process.env.BIOMETRIC_TEMPLATE_KEY,
            ),
            false,
          );
          assert.equal(
            fingerprint(await template(enrolled._id)),
            originalFingerprint,
          );
          assert.equal(await template(target._id), null);
          assert.equal(
            await models.BiometricEnrollment.countDocuments({
              company: owner.company,
            }),
            1,
          );
        } finally {
          process.env.BIOMETRIC_TEMPLATE_KEY = originalKey;
        }
        assert.equal((await enable(target._id)).faceAttendance.enabled, true);
        assert.equal(
          await models.BiometricEnrollment.countDocuments({
            company: owner.company,
          }),
          2,
        );
        assert.equal(
          fingerprint(await template(enrolled._id)),
          originalFingerprint,
        );
      },
    );

    await t.test(
      "a changed key ID is distinct from damaged or incorrectly decrypted data",
      async () => {
        const targetFingerprint = fingerprint(await template(target._id));
        process.env.BIOMETRIC_TEMPLATE_KEY_ID = "isolated-key-v2";
        try {
          const failure = await enable(target._id, 503);
          assert.equal(failure.code, "BIOMETRIC_KEY_VERSION_MISMATCH");
          assert.equal(
            fingerprint(await template(enrolled._id)),
            originalFingerprint,
          );
          assert.equal(
            fingerprint(await template(target._id)),
            targetFingerprint,
          );
          assert.equal(
            await models.BiometricEnrollment.countDocuments({
              company: owner.company,
            }),
            2,
          );
        } finally {
          process.env.BIOMETRIC_TEMPLATE_KEY_ID = "isolated-key-v1";
        }
        assert.equal((await enable(target._id)).faceAttendance.enabled, true);
        assert.equal(
          fingerprint(await template(enrolled._id)),
          originalFingerprint,
        );
        assert.equal(
          await models.BiometricEnrollment.countDocuments({
            company: owner.company,
          }),
          2,
        );
        assert.equal(
          await models.Attendance.countDocuments({ company: owner.company }),
          0,
        );
      },
    );
  },
);
