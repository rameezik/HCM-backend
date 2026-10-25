const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const M = require("../src/models");
const provider = require("../src/services/localFaceProvider");

// Public-domain portraits are isolated test inputs to the real local models.
// They do not demonstrate physical presence, trusted-camera provenance or PAD.
const fixture = (name) =>
  fs
    .readFileSync(path.join(__dirname, "fixtures/local-face", name))
    .toString("base64");
const samples = [
  fixture("astronaut.jpg"),
  fixture("astronaut-transformed-1.jpg"),
  fixture("astronaut-transformed-2.jpg"),
];
const otherSamples = [
  fixture("grace_hopper.jpg"),
  fixture("grace_hopper-transformed-1.jpg"),
  fixture("grace_hopper-transformed-2.jpg"),
];
const variableNames = [
  "JWT_SECRET",
  "BIOMETRIC_TEMPLATE_KEY",
  "NODE_ENV",
  "KIOSK_SCAN_COOLDOWN_SECONDS",
  "BIOMETRIC_MODEL_DIR",
  "AI_API_KEY",
];
const originalEnvironment = Object.fromEntries(
  variableNames.map((name) => [name, process.env[name]]),
);

test(
  "paired public kiosks recognize real local embeddings without employee sessions and preserve portal tenant boundaries",
  { timeout: 180000 },
  async (t) => {
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
    process.env.BIOMETRIC_TEMPLATE_KEY = crypto
      .randomBytes(32)
      .toString("base64");
    process.env.NODE_ENV = "test";
    process.env.KIOSK_SCAN_COOLDOWN_SECONDS = "30";
    delete process.env.AI_API_KEY;
    t.after(() => {
      for (const name of variableNames) {
        if (originalEnvironment[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnvironment[name];
      }
    });
    assert.equal(
      provider.configuration().configured,
      true,
      "Install the genuine YuNet/SFace model files before running this suite.",
    );
    const dbName = `hcm_test_kiosk_recognition_${process.pid}_${Date.now()}`;
    await mongoose.connect(
      process.env.TEST_MONGODB_URI ||
        "mongodb://127.0.0.1:27017/?replicaSet=hcm",
      { dbName, serverSelectionTimeoutMS: 10000 },
    );
    t.after(async () => {
      assert.match(mongoose.connection.name, /^hcm_test_kiosk_recognition_/);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });
    await Promise.all(Object.values(M).map((model) => model.init()));
    const server = require("../src/app").listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const password = crypto.randomBytes(24).toString("base64url");
    const passwordHash = await bcrypt.hash(password, 12);
    const company = await M.Company.create({
      singleton: `kiosk-real-a-${process.pid}`,
      name: "Isolated real-model kiosk company A",
      weekend: [],
      timezone: "UTC",
      latitude: 24.8607,
      longitude: 67.0011,
      radius: 150,
    });
    const foreignCompany = await M.Company.create({
      singleton: `kiosk-real-b-${process.pid}`,
      name: "Isolated real-model kiosk company B",
      weekend: [],
      timezone: "UTC",
      latitude: 24.8607,
      longitude: 67.0011,
      radius: 150,
    });
    async function user(tenant, suffix, role = "employee") {
      return M.User.create({
        company: tenant._id,
        name: `Isolated kiosk ${suffix}`,
        email: `kiosk-real-${suffix}@example.test`,
        passwordHash,
        role,
        active: true,
        mustChangePassword: false,
      });
    }
    async function person(tenant, suffix) {
      const account = await user(tenant, suffix);
      const department = await M.Department.create({
        company: tenant._id,
        name: `Kiosk fixture department ${suffix}`,
      });
      const designation = await M.Designation.create({
        company: tenant._id,
        name: `Kiosk fixture role ${suffix}`,
      });
      const employee = await M.Employee.create({
        company: tenant._id,
        user: account._id,
        name: account.name,
        email: account.email,
        code: `KIOSK-${suffix}`,
        department: department._id,
        designation: designation._id,
        joinDate: "2020-01-01",
        basic: 100000,
      });
      account.employee = employee._id;
      await account.save();
      return { account, employee };
    }
    const owner = await user(company, "admin", "admin");
    const foreignOwner = await user(foreignCompany, "foreign-admin", "admin");
    const target = await person(company, "target");
    await person(foreignCompany, "foreign-target");
    const originalUserCount = await M.User.countDocuments();
    const originalEmployeeCount = await M.Employee.countDocuments();

    function client() {
      const cookies = new Map();
      const responseCookies = [];
      async function request(endpoint, method = "GET", body, expected = 200) {
        const response = await fetch(base + endpoint, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(cookies.size
              ? {
                  Cookie: [...cookies]
                    .map(([key, value]) => `${key}=${value}`)
                    .join("; "),
                }
              : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        for (const value of response.headers.getSetCookie()) {
          responseCookies.push(value);
          const entry = value.split(";")[0],
            separator = entry.indexOf("=");
          const name = entry.slice(0, separator),
            content = entry.slice(separator + 1);
          if (!content || /max-age=0/i.test(value)) cookies.delete(name);
          else cookies.set(name, content);
        }
        let result;
        try {
          result = await response.json();
        } catch {
          throw new Error(`${method} ${endpoint}: API did not return JSON`);
        }
        assert.equal(
          response.status,
          expected,
          `${method} ${endpoint}: ${result.message || response.statusText}`,
        );
        return result;
      }
      return { request, cookies, responseCookies };
    }
    const admin = client(),
      foreignAdmin = client(),
      kiosk = client(),
      foreignKiosk = client(),
      unpaired = client();
    await admin.request("/auth/login", "POST", {
      email: owner.email,
      password,
    });
    await foreignAdmin.request("/auth/login", "POST", {
      email: foreignOwner.email,
      password,
    });
    assert.equal(admin.cookies.has("hcm_session"), true);
    const challenge = (purpose) =>
      kiosk.request("/kiosk/challenges", "POST", { purpose }, 201);
    const grant = async () =>
      (
        await admin.request(
          "/kiosk-management/enrollment-grants",
          "POST",
          { employee: String(target.employee._id) },
          201,
        )
      ).code;
    const enroll = async (code, capture = samples, expected = 200) => {
      const status = await kiosk.request("/kiosk/status");
      const session = await challenge("enroll");
      return kiosk.request(
        "/kiosk/enroll",
        "POST",
        {
          challengeId: session.challengeId,
          enrollmentCode: code,
          consent: true,
          consentVersion: status.consent.version,
          samples: capture,
        },
        expected,
      );
    };
    const scan = async (purpose, capture = samples, expected = 200) => {
      const session = await challenge(purpose);
      lastScanChallenge = session;
      return kiosk.request(
        "/kiosk/attendance",
        "POST",
        { challengeId: session.challengeId, action: purpose, samples: capture },
        expected,
      );
    };
    const clearFixtureCooldown = () =>
      M.Employee.updateOne(
        { _id: target.employee._id, company: company._id },
        { kioskLastAttendanceAt: new Date(Date.now() - 60000) },
      );
    let device, lastScanChallenge, successfulCheckInChallenge;

    await t.test(
      "an Admin pairs a seven-day company device without creating an employee login",
      async () => {
        assert.equal((await unpaired.request("/kiosk/status")).paired, false);
        await unpaired.request(
          "/kiosk/challenges",
          "POST",
          { purpose: "check-in" },
          401,
        );
        const created = await admin.request(
          "/kiosk-management/devices",
          "POST",
          { label: "Isolated reception device" },
          201,
        );
        assert.ok(created.pairingToken);
        device = created.device;
        const paired = await kiosk.request("/kiosk/pair", "POST", {
          pairingToken: created.pairingToken,
        });
        assert.equal(paired.paired, true);
        assert.deepEqual([...kiosk.cookies.keys()], ["hcm_kiosk"]);
        assert.ok(
          kiosk.responseCookies.some(
            (cookie) =>
              /^hcm_kiosk=/.test(cookie) &&
              /HttpOnly/i.test(cookie) &&
              /Path=\/api\/kiosk(?:;|$)/i.test(cookie) &&
              /Max-Age=604800/i.test(cookie),
          ),
        );
        assert.equal(
          kiosk.responseCookies.some((cookie) => /^hcm_session=/.test(cookie)),
          false,
        );
        await kiosk.request("/auth/me", "GET", undefined, 401);
        const status = await kiosk.request("/kiosk/status");
        assert.equal(status.paired, true);
        assert.equal(status.companyName, company.name);
        assert.equal(status.configured, true);
        assert.ok(status.consent.version);
        assert.equal(JSON.stringify(paired).includes("tokenHash"), false);
      },
    );

    await t.test(
      "missing local models fail closed without inventing an unregistered recognition result",
      async () => {
        const previous = process.env.BIOMETRIC_MODEL_DIR;
        process.env.BIOMETRIC_MODEL_DIR = path.join(
          __dirname,
          "fixtures/kiosk-models-not-installed",
        );
        try {
          const status = await kiosk.request("/kiosk/status");
          assert.equal(status.configured, false);
          assert.ok(
            status.missingConfiguration.includes(
              "face_detection_yunet_2023mar.onnx",
            ),
          );
          await scan("check-in", samples, 503);
          assert.equal(await M.Attendance.countDocuments(), 0);
        } finally {
          if (previous === undefined) delete process.env.BIOMETRIC_MODEL_DIR;
          else process.env.BIOMETRIC_MODEL_DIR = previous;
        }
      },
    );

    await t.test(
      "a genuine face with no registered kiosk enrollment cannot create attendance",
      async () => {
        const result = await scan("check-in");
        assert.equal(result.matched, false);
        assert.equal(result.code, "UNREGISTERED_PROFILE");
        assert.equal(result.message, "Unregistered profile");
        assert.equal(await M.Attendance.countDocuments(), 0);
        assert.equal(await M.User.countDocuments(), originalUserCount);
        assert.equal(await M.Employee.countDocuments(), originalEmployeeCount);
      },
    );

    await t.test(
      "photo-backed grants, explicit consent and strict server validation are required",
      async () => {
        await admin.request(
          "/kiosk-management/enrollment-grants",
          "POST",
          { employee: String(target.employee._id) },
          422,
        );
        await admin.request(`/employees/${target.employee._id}/photo`, "POST", {
          image: `data:image/jpeg;base64,${samples[0]}`,
        });
        const code = await grant();
        const session = await challenge("enroll");
        const status = await kiosk.request("/kiosk/status");
        await kiosk.request(
          "/kiosk/enroll",
          "POST",
          {
            challengeId: session.challengeId,
            enrollmentCode: code,
            consent: false,
            consentVersion: status.consent.version,
            samples,
          },
          422,
        );
        await kiosk.request(
          "/kiosk/enroll",
          "POST",
          {
            challengeId: session.challengeId,
            enrollmentCode: code,
            consent: true,
            consentVersion: status.consent.version,
            samples,
            verified: true,
          },
          422,
        );
        assert.equal(await M.BiometricEnrollment.countDocuments(), 0);
        await enroll(code, otherSamples, 422);
        assert.equal(await M.BiometricEnrollment.countDocuments(), 0);
      },
    );

    await t.test(
      "actual local inference enrolls only the photo-matched employee and hides the encrypted template",
      async () => {
        const result = await enroll(await grant());
        assert.equal(result.enrollment.enrolled, true);
        assert.equal(result.enrollment.kioskEnabled, true);
        assert.equal(result.employee.code, target.employee.code);
        const ordinary = await M.BiometricEnrollment.findOne({
          company: company._id,
          employee: target.employee._id,
        }).lean();
        assert.equal(ordinary.protectedTemplate, undefined);
        const stored = await M.BiometricEnrollment.findOne({
          company: company._id,
          employee: target.employee._id,
        })
          .select("+protectedTemplate")
          .lean();
        assert.ok(stored.protectedTemplate.ciphertext);
        assert.equal(JSON.stringify(result).includes("embedding"), false);
        assert.equal(
          JSON.stringify(result).includes("protectedTemplate"),
          false,
        );
        assert.deepEqual([...kiosk.cookies.keys()], ["hcm_kiosk"]);
        await kiosk.request("/auth/me", "GET", undefined, 401);
      },
    );

    await t.test(
      "different-person local inference returns only an unregistered result and no attendance",
      async () => {
        const result = await scan("check-in", otherSamples);
        assert.equal(result.matched, false);
        assert.equal(result.code, "UNREGISTERED_PROFILE");
        assert.equal(result.message, "Unregistered profile");
        assert.equal(result.employee, undefined);
        assert.equal(await M.Attendance.countDocuments(), 0);
      },
    );

    await t.test(
      "real kiosk recognition records check-in for the identified employee without an employee session",
      async () => {
        const result = await scan("check-in");
        assert.equal(result.matched, true);
        successfulCheckInChallenge = lastScanChallenge;
        assert.deepEqual(Object.keys(result.employee).sort(), ["code", "name"]);
        assert.equal(result.employee.code, target.employee.code);
        assert.equal(result.attendance.verificationMethod, "face");
        assert.ok(result.attendance.checkIn);
        const stored = await M.Attendance.findOne({
          company: company._id,
          employee: target.employee._id,
        }).lean();
        assert.ok(stored.checkIn);
        assert.equal(stored.verification.provider, "local-opencv-sface");
        assert.equal(stored.verification.livenessVerified, false);
        const portal = await admin.request("/attendance/analytics");
        assert.equal(portal.summary.recordedDays, 1);
        assert.equal(
          portal.history.some(
            (row) => row.employee.code === target.employee.code && row.recorded,
          ),
          true,
        );
        assert.deepEqual([...kiosk.cookies.keys()], ["hcm_kiosk"]);
        await kiosk.request("/auth/me", "GET", undefined, 401);
      },
    );

    await t.test(
      "cooldown, purpose binding and one-use challenges cannot create duplicate attendance",
      async () => {
        await kiosk.request(
          "/kiosk/attendance",
          "POST",
          {
            challengeId: successfulCheckInChallenge.challengeId,
            action: "check-in",
            samples,
          },
          409,
        );
        await scan("check-out", samples, 429);
        await clearFixtureCooldown();
        const session = await challenge("check-in");
        await kiosk.request(
          "/kiosk/attendance",
          "POST",
          { challengeId: session.challengeId, action: "check-out", samples },
          409,
        );
        await kiosk.request(
          "/kiosk/attendance",
          "POST",
          { challengeId: session.challengeId, action: "check-in", samples },
          409,
        );
        assert.equal(
          await M.Attendance.countDocuments({ employee: target.employee._id }),
          1,
        );
      },
    );

    await t.test(
      "a genuine kiosk match records checkout and portal hours using actual server timestamps",
      async () => {
        await clearFixtureCooldown();
        // Move only isolated test failure-history metadata past its rate-limit window.
        // Genuine attendance/check-in timestamps and inference results are untouched.
        await M.KioskChallenge.collection.updateMany(
          {
            company: company._id,
            device: new mongoose.Types.ObjectId(device._id),
            state: "failed",
          },
          { $set: { createdAt: new Date(Date.now() - 120000) } },
        );
        const result = await scan("check-out");
        assert.equal(result.matched, true);
        assert.ok(result.attendance.checkOut);
        assert.equal(result.cooldownSeconds, 30);
        const stored = await M.Attendance.findOne({
          company: company._id,
          employee: target.employee._id,
        }).lean();
        assert.ok(stored.checkOut);
        assert.equal(
          stored.checkOutVerification.provider,
          "local-opencv-sface",
        );
        assert.equal(
          stored.hours,
          (stored.checkOut - stored.checkIn) / 3600000,
        );
        const portal = await admin.request("/attendance/analytics");
        assert.ok(
          portal.history.find(
            (row) => row.employee.code === target.employee.code,
          ).checkOut,
        );
        assert.equal(await M.Attendance.countDocuments(), 1);
      },
    );

    await t.test(
      "a kiosk paired to another company cannot identify a foreign enrolled employee",
      async () => {
        const foreignDevice = await foreignAdmin.request(
          "/kiosk-management/devices",
          "POST",
          { label: "Isolated foreign device" },
          201,
        );
        await foreignKiosk.request("/kiosk/pair", "POST", {
          pairingToken: foreignDevice.pairingToken,
        });
        const session = await foreignKiosk.request(
          "/kiosk/challenges",
          "POST",
          { purpose: "check-in" },
          201,
        );
        const result = await foreignKiosk.request("/kiosk/attendance", "POST", {
          challengeId: session.challengeId,
          action: "check-in",
          samples,
        });
        assert.equal(result.matched, false);
        assert.equal(result.message, "Unregistered profile");
        assert.equal(
          await M.Attendance.countDocuments({ company: foreignCompany._id }),
          0,
        );
        assert.deepEqual([...foreignKiosk.cookies.keys()], ["hcm_kiosk"]);
      },
    );

    await t.test(
      "profile photo replacement invalidates the old kiosk identity binding",
      async () => {
        await admin.request(`/employees/${target.employee._id}/photo`, "POST", {
          image: `data:image/jpeg;base64,${otherSamples[0]}`,
        });
        await clearFixtureCooldown();
        const result = await scan("check-in");
        assert.equal(result.matched, false);
        assert.equal(result.code, "UNREGISTERED_PROFILE");
        assert.equal(await M.Attendance.countDocuments(), 1);
      },
    );

    await t.test(
      "revoked pairing blocks the old public device cookie",
      async () => {
        const result = await admin.request(
          `/kiosk-management/devices/${device._id}`,
          "DELETE",
        );
        assert.equal(result.revoked, true);
        await kiosk.request(
          "/kiosk/challenges",
          "POST",
          { purpose: "check-in" },
          401,
        );
        assert.equal(await M.Attendance.countDocuments(), 1);
      },
    );
  },
);
