const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const M = require("../src/models");
const provider = require("../src/services/localFaceProvider");

const fixture = (name) =>
  fs
    .readFileSync(path.join(__dirname, "fixtures/local-face", name))
    .toString("base64");
const samples = [
  "astronaut.jpg",
  "astronaut-transformed-1.jpg",
  "astronaut-transformed-2.jpg",
].map(fixture);
const otherSamples = [
  "grace_hopper.jpg",
  "grace_hopper-transformed-1.jpg",
  "grace_hopper-transformed-2.jpg",
].map(fixture);

// These public-domain images are isolated test inputs to the actual local model.
// They do not establish physical-camera provenance or anti-spoofing accuracy.
test(
  "profile photo attendance uses real local matching without an employee login",
  { timeout: 180000 },
  async (t) => {
    const names = [
      "JWT_SECRET",
      "BIOMETRIC_TEMPLATE_KEY",
      "NODE_ENV",
      "KIOSK_SCAN_COOLDOWN_SECONDS",
      "BIOMETRIC_MODEL_DIR",
      "AI_API_KEY",
    ];
    const saved = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
    process.env.BIOMETRIC_TEMPLATE_KEY = crypto
      .randomBytes(32)
      .toString("base64");
    process.env.NODE_ENV = "test";
    process.env.KIOSK_SCAN_COOLDOWN_SECONDS = "30";
    delete process.env.AI_API_KEY;
    t.after(() => {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });
    assert.equal(
      provider.configuration().configured,
      true,
      "Install the local YuNet/SFace models before running recognition tests.",
    );
    const dbName = `hcm_test_profile_terminal_${process.pid}_${Date.now()}`;
    await mongoose.connect(
      process.env.TEST_MONGODB_URI ||
        "mongodb://127.0.0.1:27017/?replicaSet=hcm",
      { dbName, serverSelectionTimeoutMS: 10000 },
    );
    t.after(async () => {
      assert.match(mongoose.connection.name, /^hcm_test_profile_terminal_/);
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
      singleton: `profile-terminal-a-${process.pid}`,
      name: "Isolated profile terminal A",
      weekend: [],
      timezone: "UTC",
      latitude: 24.8607,
      longitude: 67.0011,
      radius: 150,
    });
    const foreignCompany = await M.Company.create({
      singleton: `profile-terminal-b-${process.pid}`,
      name: "Isolated profile terminal B",
      weekend: [],
      timezone: "UTC",
      latitude: 24.8607,
      longitude: 67.0011,
      radius: 150,
    });
    const account = (tenant, suffix, role = "employee") =>
      M.User.create({
        company: tenant._id,
        name: `Isolated photo ${suffix}`,
        email: `photo-terminal-${suffix}@example.test`,
        passwordHash,
        role,
        active: true,
        mustChangePassword: false,
      });
    const owner = await account(company, "admin", "admin");
    const foreignOwner = await account(
      foreignCompany,
      "foreign-admin",
      "admin",
    );
    async function employee(suffix) {
      const user = await account(company, suffix);
      const department = await M.Department.create({
        company: company._id,
        name: `Photo department ${suffix}`,
      });
      const designation = await M.Designation.create({
        company: company._id,
        name: `Photo role ${suffix}`,
      });
      const row = await M.Employee.create({
        company: company._id,
        user: user._id,
        name: user.name,
        email: user.email,
        code: `PHOTO-${suffix}`,
        department: department._id,
        designation: designation._id,
        joinDate: "2020-01-01",
        basic: 100000,
      });
      user.employee = row._id;
      await user.save();
      return { user, row };
    }
    const target = await employee("target");
    const invalid = await employee("invalid");
    function client() {
      const cookies = new Map();
      async function request(endpoint, method = "GET", body, expected = 200) {
        const response = await fetch(base + endpoint, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(cookies.size
              ? {
                  Cookie: [...cookies]
                    .map(([name, value]) => `${name}=${value}`)
                    .join("; "),
                }
              : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        for (const entry of response.headers.getSetCookie()) {
          const pair = entry.split(";")[0],
            separator = pair.indexOf("=");
          if (pair.slice(separator + 1))
            cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
          else cookies.delete(pair.slice(0, separator));
        }
        const result = await response.json();
        assert.equal(
          response.status,
          expected,
          `${method} ${endpoint}: ${result.message || response.statusText}`,
        );
        return result;
      }
      return { request, cookies };
    }
    const admin = client(),
      foreignAdmin = client(),
      terminal = client(),
      foreignTerminal = client(),
      signedEmployee = client(),
      visitor = client();
    for (const [api, user] of [
      [admin, owner],
      [foreignAdmin, foreignOwner],
      [signedEmployee, target.user],
    ])
      await api.request("/auth/login", "POST", { email: user.email, password });

    const management = "/attendance-terminal-management";
    const publicPath = "/attendance-terminal";
    const enrollmentPath = (id = target.row._id) =>
      `${management}/employees/${id}/enrollment`;
    const upload = (id, image) =>
      admin.request(`/employees/${id}/photo`, "POST", {
        image: `data:image/jpeg;base64,${image}`,
      });
    const enable = async (id = target.row._id) => {
      const settings = await admin.request(`${management}/employees`);
      return admin.request(enrollmentPath(id), "POST", {
        consent: true,
        consentVersion: settings.consent.version,
      });
    };
    const scan = async (
      capture = samples,
      action = "check-in",
      expected = 200,
      api = terminal,
    ) => {
      const challenge = await api.request(
        `${publicPath}/challenges`,
        "POST",
        { purpose: action },
        201,
      );
      return api.request(
        `${publicPath}/attendance`,
        "POST",
        { challengeId: challenge.challengeId, action, samples: capture },
        expected,
      );
    };
    const clearCooldown = () =>
      M.Employee.updateOne(
        { _id: target.row._id, company: company._id },
        { kioskLastAttendanceAt: new Date(Date.now() - 60000) },
      );
    const clearFailedFixtureScans = () =>
      M.KioskChallenge.collection.updateMany(
        { company: company._id, state: "failed" },
        { $set: { createdAt: new Date(Date.now() - 120000) } },
      );
    let device;

    await t.test(
      "only company Admin manages photo attendance; an unpaired visitor cannot scan",
      async () => {
        assert.equal(
          (await visitor.request(`${publicPath}/status`)).paired,
          false,
        );
        await visitor.request(
          `${publicPath}/challenges`,
          "POST",
          { purpose: "check-in" },
          401,
        );
        await visitor.request(`${management}/employees`, "GET", undefined, 401);
        await signedEmployee.request(
          `${management}/employees`,
          "GET",
          undefined,
          403,
        );
        await foreignAdmin.request(
          enrollmentPath(),
          "POST",
          { consent: true, consentVersion: "2026-11-11-terminal-photo-v1" },
          404,
        );
        const settings = await admin.request(`${management}/employees`);
        assert.equal(settings.configured, true);
        assert.equal(
          settings.employees.find(
            (row) => String(row._id) === String(target.row._id),
          ).faceAttendance.state,
          "photo_required",
        );
        await admin.request(
          enrollmentPath(),
          "POST",
          { consent: true, consentVersion: settings.consent.version },
          422,
        );
        const created = await admin.request(
          `${management}/devices`,
          "POST",
          { label: "Isolated reception terminal" },
          201,
        );
        device = created.device;
        await terminal.request(`${publicPath}/pair`, "POST", {
          pairingToken: created.pairingToken,
        });
        assert.equal(
          (await terminal.request(`${publicPath}/status`)).paired,
          true,
        );
        assert.equal(terminal.cookies.has("hcm_session"), false);
        await terminal.request("/auth/me", "GET", undefined, 401);
      },
    );

    await t.test(
      "a profile photo requires explicit consent before real inference enables attendance",
      async () => {
        await upload(target.row._id, samples[0]);
        const settings = await admin.request(`${management}/employees`);
        const row = settings.employees.find(
          (person) => String(person._id) === String(target.row._id),
        );
        assert.equal(row.faceAttendance.enabled, false);
        await admin.request(
          enrollmentPath(),
          "POST",
          { consent: false, consentVersion: settings.consent.version },
          422,
        );
        await admin.request(
          enrollmentPath(),
          "POST",
          { consent: true, consentVersion: "outdated" },
          422,
        );
        await admin.request(
          enrollmentPath(),
          "POST",
          {
            consent: true,
            consentVersion: settings.consent.version,
            verified: true,
          },
          422,
        );
        assert.equal(
          await M.BiometricEnrollment.countDocuments({
            employee: target.row._id,
          }),
          0,
        );
        const result = await enable();
        assert.equal(result.faceAttendance.enabled, true);
        assert.equal(result.faceAttendance.state, "ready");
        const ordinary = await M.BiometricEnrollment.findOne({
          company: company._id,
          employee: target.row._id,
        }).lean();
        assert.equal(ordinary.protectedTemplate, undefined);
        const stored = await M.BiometricEnrollment.findOne({
          company: company._id,
          employee: target.row._id,
        })
          .select("+protectedTemplate")
          .lean();
        assert.ok(stored.protectedTemplate.ciphertext);
        assert.equal(JSON.stringify(result).includes("embedding"), false);
        assert.equal(
          JSON.stringify(result).includes("protectedTemplate"),
          false,
        );
      },
    );

    await t.test(
      "an actual different face returns Record not found and creates no employee or attendance",
      async () => {
        const userCount = await M.User.countDocuments();
        const employeeCount = await M.Employee.countDocuments();
        const result = await scan(otherSamples);
        assert.equal(result.matched, false);
        assert.equal(result.message, "Record not found");
        assert.equal(result.employee, undefined);
        assert.equal(await M.Attendance.countDocuments(), 0);
        assert.equal(await M.User.countDocuments(), userCount);
        assert.equal(await M.Employee.countDocuments(), employeeCount);
        const status = await terminal.request(`${publicPath}/status`);
        assert.equal(status.employees, undefined);
        assert.equal(status.templates, undefined);
        assert.equal(status.embeddings, undefined);
      },
    );

    await t.test(
      "blank camera frames and photos cannot be mistaken for verified identities",
      async () => {
        const blank = fixture("no-face.jpg");
        await scan([blank, blank, blank], "check-in", 422);
        await upload(invalid.row._id, blank);
        const settings = await admin.request(`${management}/employees`);
        await admin.request(
          enrollmentPath(invalid.row._id),
          "POST",
          { consent: true, consentVersion: settings.consent.version },
          422,
        );
        assert.equal(
          await M.BiometricEnrollment.countDocuments({
            employee: invalid.row._id,
          }),
          0,
        );
        assert.equal(await M.Attendance.countDocuments(), 0);
      },
    );

    await t.test(
      "a public scan matches the saved profile photo and persists actual attendance without login",
      async () => {
        const result = await scan();
        assert.equal(result.matched, true);
        assert.equal(result.employee.code, target.row.code);
        assert.ok(result.attendance.checkIn);
        const stored = await M.Attendance.findOne({
          company: company._id,
          employee: target.row._id,
        }).lean();
        assert.equal(
          new Date(result.attendance.checkIn).getTime(),
          stored.checkIn.getTime(),
        );
        assert.equal(stored.verificationMethod, "face");
        assert.equal(stored.verification.livenessVerified, false);
        const portal = await admin.request("/attendance/analytics");
        assert.ok(
          portal.history.some(
            (row) =>
              String(row.employee._id) === String(target.row._id) &&
              row.checkIn,
          ),
        );
        assert.equal(terminal.cookies.has("hcm_session"), false);
        await terminal.request("/auth/me", "GET", undefined, 401);
      },
    );

    await t.test(
      "repeated recognition cannot create duplicate attendance",
      async () => {
        await clearCooldown();
        await scan(samples, "check-in", 409);
        assert.equal(
          await M.Attendance.countDocuments({ employee: target.row._id }),
          1,
        );
      },
    );

    await t.test(
      "public matching never searches a different company",
      async () => {
        const created = await foreignAdmin.request(
          `${management}/devices`,
          "POST",
          { label: "Isolated other company terminal" },
          201,
        );
        await foreignTerminal.request(`${publicPath}/pair`, "POST", {
          pairingToken: created.pairingToken,
        });
        const result = await scan(samples, "check-in", 200, foreignTerminal);
        assert.equal(result.matched, false);
        assert.equal(result.message, "Record not found");
        assert.equal(
          await M.Attendance.countDocuments({ company: foreignCompany._id }),
          0,
        );
        await foreignAdmin.request(enrollmentPath(), "DELETE", undefined, 404);
      },
    );

    await t.test(
      "replacing a profile photo disables the previous face until explicit reactivation",
      async () => {
        await upload(target.row._id, otherSamples[0]);
        const settings = await admin.request(`${management}/employees`);
        const person = settings.employees.find(
          (row) => String(row._id) === String(target.row._id),
        );
        assert.equal(person.faceAttendance.enabled, false);
        assert.equal(person.faceAttendance.state, "photo_changed");
        const old = await scan();
        assert.equal(old.matched, false);
        assert.equal(old.message, "Record not found");
        assert.equal(await M.Attendance.countDocuments(), 1);
        const reactivated = await enable();
        assert.equal(reactivated.faceAttendance.enabled, true);
        await clearCooldown();
        await clearFailedFixtureScans();
        const result = await scan(otherSamples, "check-out");
        assert.equal(result.matched, true);
        assert.equal(result.employee.code, target.row.code);
        assert.ok(result.attendance.checkOut);
        const stored = await M.Attendance.findOne({
          employee: target.row._id,
        }).lean();
        assert.ok(stored.checkOut);
        assert.equal(await M.Attendance.countDocuments(), 1);
      },
    );

    await t.test(
      "withdrawal deletes the template and immediately stops public matching",
      async () => {
        await admin.request(enrollmentPath(), "DELETE");
        assert.equal(
          await M.BiometricEnrollment.countDocuments({
            company: company._id,
            employee: target.row._id,
          }),
          0,
        );
        const result = await scan(otherSamples);
        assert.equal(result.matched, false);
        assert.equal(result.message, "Record not found");
        assert.equal(await M.Attendance.countDocuments(), 1);
      },
    );

    await t.test(
      "missing model files return a configuration error instead of a false recognition result",
      async () => {
        const previous = process.env.BIOMETRIC_MODEL_DIR;
        process.env.BIOMETRIC_MODEL_DIR = path.join(
          __dirname,
          "fixtures/terminal-models-not-installed",
        );
        try {
          const status = await terminal.request(`${publicPath}/status`);
          assert.equal(status.configured, false);
          const response = await scan(otherSamples, "check-in", 503);
          assert.equal(response.code, "BIOMETRIC_NOT_CONFIGURED");
          assert.notEqual(response.message, "Record not found");
          const settings = await admin.request(`${management}/employees`);
          assert.equal(settings.configured, false);
          await admin.request(
            enrollmentPath(),
            "POST",
            { consent: true, consentVersion: settings.consent.version },
            503,
          );
          assert.equal(await M.Attendance.countDocuments(), 1);
        } finally {
          if (previous === undefined) delete process.env.BIOMETRIC_MODEL_DIR;
          else process.env.BIOMETRIC_MODEL_DIR = previous;
        }
      },
    );

    await t.test(
      "revoking a terminal blocks its existing credential",
      async () => {
        await admin.request(`${management}/devices/${device._id}`, "DELETE");
        await terminal.request(
          `${publicPath}/challenges`,
          "POST",
          { purpose: "check-in" },
          401,
        );
        assert.equal(await M.Attendance.countDocuments(), 1);
      },
    );

    await t.test(
      "a reusable link connects separate public browsers without exposing its secret",
      async () => {
        const created = await admin.request(
          `${management}/devices`,
          "POST",
          { label: "Isolated shared attendance link", reusable: true },
          201,
        );
        assert.match(created.accessToken, /^[a-f\d]{24}\.\d+\.[a-f\d]{64}$/i);
        assert.ok(Date.parse(created.expiresAt) > Date.now());
        const first = client(),
          second = client(),
          forged = client();
        for (const api of [first, second]) {
          const connected = await api.request(`${publicPath}/connect`, "POST", {
            accessToken: created.accessToken,
          });
          assert.equal(connected.paired, true);
          assert.equal(connected.companyName, company.name);
          assert.equal(api.cookies.has("hcm_attendance_terminal"), true);
          assert.equal(api.cookies.has("hcm_session"), false);
          await api.request("/auth/me", "GET", undefined, 401);
          await api.request(
            `${publicPath}/challenges`,
            "POST",
            { purpose: "check-in" },
            201,
          );
        }
        assert.equal(
          (await first.request(`${publicPath}/status`)).paired,
          true,
          "Connecting another browser must not invalidate the existing terminal.",
        );
        await first.request(`${publicPath}/disconnect`, "POST", {});
        assert.equal(first.cookies.has("hcm_attendance_terminal"), false);
        assert.equal(
          (await first.request(`${publicPath}/status`)).paired,
          false,
        );
        assert.equal(
          (await second.request(`${publicPath}/status`)).paired,
          true,
          "Disconnecting one browser must not revoke the shared link.",
        );
        const third = client();
        assert.equal(
          (
            await third.request(`${publicPath}/connect`, "POST", {
              accessToken: created.accessToken,
            })
          ).paired,
          true,
        );
        assert.equal(
          (
            await first.request(`${publicPath}/connect`, "POST", {
              accessToken: created.accessToken,
            })
          ).paired,
          true,
        );
        await first.request(`${publicPath}/unpair`, "POST", {});
        assert.equal(
          (await first.request(`${publicPath}/status`)).paired,
          false,
        );
        assert.equal(
          (await second.request(`${publicPath}/status`)).paired,
          true,
        );
        assert.equal(
          (await third.request(`${publicPath}/status`)).paired,
          true,
        );
        assert.equal(
          (
            await first.request(`${publicPath}/connect`, "POST", {
              accessToken: created.accessToken,
            })
          ).paired,
          true,
        );
        for (let index = 0; index < 16; index++) {
          const browser = client();
          assert.equal(
            (
              await browser.request(`${publicPath}/connect`, "POST", {
                accessToken: created.accessToken,
              })
            ).paired,
            true,
            "Successful connections from a shared office network must not exhaust the failed-link limit.",
          );
        }
        const secret = created.accessToken.split(".").at(-1);
        const persisted = await M.KioskDevice.collection.findOne({
          _id: new mongoose.Types.ObjectId(created.device._id),
        });
        assert.equal(persisted.reusable, true);
        assert.equal(
          persisted.credentialHash,
          crypto.createHash("sha256").update(secret).digest("hex"),
        );
        assert.equal(JSON.stringify(persisted).includes(secret), false);
        const listed = await admin.request(`${management}/devices`);
        assert.equal(JSON.stringify(listed).includes(secret), false);
        assert.equal(JSON.stringify(listed).includes("credentialHash"), false);
        const audits = await M.AuditLog.find({ company: company._id }).lean();
        assert.equal(JSON.stringify(audits).includes(secret), false);
        assert.equal(
          JSON.stringify(audits).includes(created.accessToken),
          false,
        );
        const invalid =
          created.accessToken.slice(0, -1) +
          (created.accessToken.endsWith("a") ? "b" : "a");
        await forged.request(
          `${publicPath}/connect`,
          "POST",
          { accessToken: invalid },
          401,
        );
        await forged.request(
          `${publicPath}/connect`,
          "POST",
          { accessToken: "invalid" },
          422,
        );
        assert.equal(
          (await forged.request(`${publicPath}/status`)).paired,
          false,
        );
        await admin.request(
          `${management}/devices/${created.device._id}`,
          "DELETE",
        );
        for (const api of [first, second, third]) {
          assert.equal(
            (await api.request(`${publicPath}/status`)).paired,
            false,
          );
          await api.request(
            `${publicPath}/challenges`,
            "POST",
            { purpose: "check-in" },
            401,
          );
          await api.request(
            `${publicPath}/connect`,
            "POST",
            { accessToken: created.accessToken },
            401,
          );
        }
        assert.equal(await M.Attendance.countDocuments(), 1);
      },
    );
  },
);
