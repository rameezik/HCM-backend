const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const M = require("../src/models");
const C = require("../src/services/context");
const access = require("../src/services/kioskAccessService");
const { withCompany } = require("../src/services/companyContext");

test(
  "company-paired public kiosk credentials, nonce and enrollment grants use real MongoDB",
  { timeout: 60000 },
  async (t) => {
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
    process.env.NODE_ENV = "test";
    const dbName = `hcm_test_kiosk_access_${process.pid}_${Date.now()}`;
    await mongoose.connect(
      process.env.TEST_MONGODB_URI ||
        "mongodb://127.0.0.1:27017/?replicaSet=hcm",
      { dbName, serverSelectionTimeoutMS: 10000 },
    );
    await Promise.all(Object.values(M).map((model) => model.init()));
    const server = require("../src/app").listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      assert.match(mongoose.connection.name, /^hcm_test_kiosk_access_/);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });
    const company = await M.Company.create({
      singleton: `kiosk-access-a-${process.pid}`,
      name: "Isolated kiosk access A",
      latitude: 24.8607,
      longitude: 67.0011,
    });
    const otherCompany = await M.Company.create({
      singleton: `kiosk-access-b-${process.pid}`,
      name: "Isolated kiosk access B",
      latitude: 30,
      longitude: 70,
    });
    const passwordHash = crypto.randomBytes(48).toString("hex");
    const admin = await M.User.create({
      company: company._id,
      name: "Isolated kiosk Admin",
      email: "admin@kiosk-access.example.test",
      role: "admin",
      passwordHash,
      mustChangePassword: false,
    });
    const otherAdmin = await M.User.create({
      company: otherCompany._id,
      name: "Foreign kiosk Admin",
      email: "other@kiosk-access.example.test",
      role: "admin",
      passwordHash,
      mustChangePassword: false,
    });
    const employeeId = new mongoose.Types.ObjectId();
    const employeeUser = await M.User.create({
      company: company._id,
      employee: employeeId,
      name: "Isolated kiosk employee",
      email: "employee@kiosk-access.example.test",
      role: "employee",
      passwordHash,
      mustChangePassword: false,
    });
    const department = await M.Department.create({
      company: company._id,
      name: "Kiosk access department",
    });
    const designation = await M.Designation.create({
      company: company._id,
      name: "Kiosk access role",
    });
    const image = await sharp({
      create: { width: 80, height: 80, channels: 3, background: "#007ba7" },
    })
      .jpeg()
      .toBuffer();
    await M.Employee.create({
      _id: employeeId,
      company: company._id,
      user: employeeUser._id,
      code: "KIOSK-ACCESS-1",
      name: employeeUser.name,
      email: employeeUser.email,
      department: department._id,
      designation: designation._id,
      joinDate: "2020-01-01",
      basic: 100000,
      photo: image,
      photoUpdatedAt: new Date(),
    });
    function client(user) {
      let kioskCookie = "";
      const request = async (path, method = "GET", body, expected = 200) => {
        const userToken = user
          ? jwt.sign(
              {
                sub: String(user._id),
                company: String(user.company),
                version: user.tokenVersion,
              },
              process.env.JWT_SECRET,
              { algorithm: "HS256", expiresIn: "1h" },
            )
          : null;
        const r = await fetch(base + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(userToken ? { Authorization: `Bearer ${userToken}` } : {}),
            ...(kioskCookie ? { Cookie: kioskCookie } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (r.headers.get("set-cookie"))
          kioskCookie = r.headers.get("set-cookie").split(";")[0];
        const data = await r.json();
        assert.equal(
          r.status,
          expected,
          `${method} ${path}: ${data.message || r.statusText}`,
        );
        return { data, headers: r.headers };
      };
      request.cookie = () => kioskCookie;
      return request;
    }
    const owner = client(admin),
      foreign = client(otherAdmin),
      staff = client(employeeUser),
      kiosk = client(),
      kioskTwo = client();
    let paired, second, rawPairing;
    await t.test(
      "Admin creates a scoped device with a one-time pairing code; public kiosk requires no employee session",
      async () => {
        assert.equal((await kiosk("/kiosk/status")).data.paired, false);
        await kiosk("/kiosk/challenges", "POST", { purpose: "check-in" }, 401);
        await staff(
          "/kiosk-management/devices",
          "POST",
          { label: "Forbidden device" },
          403,
        );
        const created = (
          await owner(
            "/kiosk-management/devices",
            "POST",
            { label: "Isolated lobby kiosk" },
            201,
          )
        ).data;
        rawPairing = created.pairingToken;
        assert.match(rawPairing, /^[a-f\d]{64}$/);
        assert.equal(created.device.office.latitude, company.latitude);
        const ordinary = await M.KioskDevice.findById(
          created.device._id,
        ).lean();
        assert.equal(ordinary.pairingTokenHash, undefined);
        const stored = await M.KioskDevice.findById(created.device._id)
          .select("+pairingTokenHash")
          .lean();
        assert.equal(
          stored.pairingTokenHash,
          crypto.createHash("sha256").update(rawPairing).digest("hex"),
        );
        const response = await kiosk("/kiosk/pair", "POST", {
          pairingToken: rawPairing,
        });
        paired = response.data.device;
        assert.equal(response.data.companyName, company.name);
        assert.match(response.headers.get("set-cookie"), /hcm_kiosk=/);
        assert.match(response.headers.get("set-cookie"), /HttpOnly/);
        assert.match(response.headers.get("set-cookie"), /SameSite=Strict/);
        assert.match(response.headers.get("set-cookie"), /Path=\/api\/kiosk/);
        assert.equal(kiosk.cookie().includes("hcm_session"), false);
        await kioskTwo(
          "/kiosk/pair",
          "POST",
          { pairingToken: rawPairing },
          422,
        );
        const another = (
          await owner(
            "/kiosk-management/devices",
            "POST",
            { label: "Second isolated kiosk" },
            201,
          )
        ).data;
        second = (
          await kioskTwo("/kiosk/pair", "POST", {
            pairingToken: another.pairingToken,
          })
        ).data.device;
        const listed = (await owner("/kiosk-management/devices")).data;
        assert.equal(listed.length, 2);
        assert.equal(JSON.stringify(listed).includes(rawPairing), false);
        assert.equal(JSON.stringify(listed).includes("credentialHash"), false);
        assert.equal(
          (await foreign("/kiosk-management/devices")).data.length,
          0,
        );
      },
    );
    function internal(device) {
      return { ...device, company: company._id, tokenVersion: 1 };
    }
    const scoped = (device, work) =>
      withCompany(company._id, () => work(internal(device)));
    await t.test(
      "camera challenges bind device, purpose, expiry and one-time consumption",
      async () => {
        const challenge = (
          await kiosk("/kiosk/challenges", "POST", { purpose: "check-in" }, 201)
        ).data;
        await assert.rejects(
          scoped(paired, (device) =>
            access.claimChallenge(device, challenge.challengeId, "check-out"),
          ),
          { status: 409 },
        );
        await assert.rejects(
          scoped(second, (device) =>
            access.claimChallenge(device, challenge.challengeId, "check-in"),
          ),
          { status: 409 },
        );
        const claimed = await scoped(paired, (device) =>
          access.claimChallenge(device, challenge.challengeId, "check-in"),
        );
        await scoped(paired, (device) =>
          C.transaction((session) =>
            access.consumeChallenge(device, claimed, session),
          ),
        );
        await assert.rejects(
          scoped(paired, (device) =>
            access.claimChallenge(device, challenge.challengeId, "check-in"),
          ),
          { status: 409 },
        );
        const expired = (
          await kiosk(
            "/kiosk/challenges",
            "POST",
            { purpose: "check-out" },
            201,
          )
        ).data;
        await M.KioskChallenge.updateOne(
          { _id: expired.challengeId },
          { expiresAt: new Date(Date.now() - 1000) },
        );
        await assert.rejects(
          scoped(paired, (device) =>
            access.claimChallenge(device, expired.challengeId, "check-out"),
          ),
          { status: 409 },
        );
      },
    );
    await t.test(
      "enrollment grants bind a real active profile and photo and permit only three same-device attempts",
      async () => {
        const issued = (
          await owner(
            "/kiosk-management/enrollment-grants",
            "POST",
            { employee: String(employeeId) },
            201,
          )
        ).data;
        assert.match(issued.code, /^[a-f\d]{64}$/);
        const ordinary = await M.KioskEnrollmentGrant.findOne({
          employee: employeeId,
        }).lean();
        assert.equal(ordinary.codeHash, undefined);
        assert.equal(ordinary.userTokenVersion, employeeUser.tokenVersion);
        assert.ok(ordinary.photoUpdatedAt);
        const first = await scoped(paired, (device) =>
          access.claimEnrollmentGrant(device, issued.code),
        );
        await scoped(paired, (device) =>
          access.failEnrollmentGrant(device, first),
        );
        await assert.rejects(
          scoped(second, (device) =>
            access.claimEnrollmentGrant(device, issued.code),
          ),
          { status: 422 },
        );
        for (let attempt = 2; attempt <= 3; attempt++) {
          const claim = await scoped(paired, (device) =>
            access.claimEnrollmentGrant(device, issued.code),
          );
          assert.equal(claim.attempts, attempt);
          await scoped(paired, (device) =>
            access.failEnrollmentGrant(device, claim),
          );
        }
        await assert.rejects(
          scoped(paired, (device) =>
            access.claimEnrollmentGrant(device, issued.code),
          ),
          { status: 422 },
        );
        const replaced = (
          await owner(
            "/kiosk-management/enrollment-grants",
            "POST",
            { employee: String(employeeId) },
            201,
          )
        ).data;
        const grant = await scoped(paired, (device) =>
          access.claimEnrollmentGrant(device, replaced.code),
        );
        await scoped(paired, (device) =>
          C.transaction((session) =>
            access.consumeEnrollmentGrant(device, grant, session),
          ),
        );
        await assert.rejects(
          scoped(paired, (device) =>
            access.claimEnrollmentGrant(device, replaced.code),
          ),
          { status: 422 },
        );
        await foreign(
          "/kiosk-management/enrollment-grants",
          "POST",
          { employee: String(employeeId) },
          422,
        );
        const audit = JSON.stringify(await M.AuditLog.find().lean());
        assert.equal(audit.includes(issued.code), false);
        assert.equal(audit.includes(replaced.code), false);
        assert.equal(audit.includes(rawPairing), false);
      },
    );
    await t.test(
      "failed-scan limits also block already-created camera challenges",
      async () => {
        const challenges = [];
        for (let index = 0; index < 6; index++)
          challenges.push(
            (
              await kiosk(
                "/kiosk/challenges",
                "POST",
                { purpose: "check-in" },
                201,
              )
            ).data,
          );
        for (const challenge of challenges.slice(0, 5)) {
          const claimed = await scoped(paired, (device) =>
            access.claimChallenge(device, challenge.challengeId, "check-in"),
          );
          await scoped(paired, (device) =>
            access.failChallenge(device, claimed),
          );
        }
        await kiosk("/kiosk/challenges", "POST", { purpose: "check-in" }, 429);
        await kiosk(
          "/kiosk/attendance",
          "POST",
          {
            challengeId: challenges[5].challengeId,
            action: "check-in",
            samples: [
              image.toString("base64"),
              image.toString("base64"),
              image.toString("base64"),
            ],
          },
          429,
        );
        // Backdate isolated security-test metadata only; no business attendance is altered.
        await M.KioskChallenge.collection.updateMany(
          { device: new mongoose.Types.ObjectId(paired._id), state: "failed" },
          { $set: { createdAt: new Date(Date.now() - 61000) } },
        );
      },
    );
    await t.test(
      "paired device revocation and local unpairing invalidate credentials and pending challenges",
      async () => {
        const pending = (
          await kiosk("/kiosk/challenges", "POST", { purpose: "check-in" }, 201)
        ).data;
        await foreign(
          `/kiosk-management/devices/${paired._id}`,
          "DELETE",
          undefined,
          404,
        );
        await owner(`/kiosk-management/devices/${paired._id}`, "DELETE");
        await kiosk("/kiosk/challenges", "POST", { purpose: "check-in" }, 401);
        assert.equal((await kiosk("/kiosk/status")).data.paired, false);
        assert.equal(
          (await M.KioskChallenge.findById(pending.challengeId).lean()).state,
          "failed",
        );
        await kioskTwo("/kiosk/unpair", "POST", {});
        assert.equal((await kioskTwo("/kiosk/status")).data.paired, false);
        await kioskTwo(
          "/kiosk/challenges",
          "POST",
          { purpose: "check-in" },
          401,
        );
      },
    );
    await t.test(
      "production kiosk endpoints require HTTPS and device pairing requires configured office coordinates",
      async () => {
        process.env.NODE_ENV = "production";
        try {
          await kiosk("/kiosk/status", "GET", undefined, 400);
          await owner("/kiosk-management/devices", "GET", undefined, 400);
        } finally {
          process.env.NODE_ENV = "test";
        }
        await M.Company.updateOne(
          { _id: company._id },
          { $unset: { latitude: 1, longitude: 1 } },
        );
        await owner(
          "/kiosk-management/devices",
          "POST",
          { label: "No configured office" },
          422,
        );
      },
    );
  },
);
