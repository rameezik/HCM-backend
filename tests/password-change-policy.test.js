const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const M = require("../src/models");

test(
  "issued credentials access dashboards unless Admin explicitly enforces a password change",
  { timeout: 60000 },
  async (t) => {
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
    const dbName = `hcm_test_password_policy_${process.pid}_${Date.now()}`;
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
      assert.match(mongoose.connection.name, /^hcm_test_password_policy_/);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });
    function client() {
      let cookie = "";
      return async (path, method = "GET", body, expected = 200) => {
        const r = await fetch(base + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (r.headers.get("set-cookie"))
          cookie = r.headers.get("set-cookie").split(";")[0];
        const data = await r.json();
        assert.equal(
          r.status,
          expected,
          `${method} ${path}: ${data.message || r.statusText}`,
        );
        return data;
      };
    }
    const admin = client(),
      normal = client(),
      enforced = client(),
      hr = client();
    const issued = crypto.randomBytes(18).toString("base64url"),
      rotated = crypto.randomBytes(18).toString("base64url");
    await admin(
      "/auth/register",
      "POST",
      {
        name: "Isolated password policy Admin",
        email: "admin@password-policy.example.test",
        password: issued,
        company: { name: "Isolated password policy company", weekend: [] },
      },
      201,
    );
    const department = await admin(
      "/departments",
      "POST",
      { name: "Password policy department" },
      201,
    );
    const designation = await admin(
      "/designations",
      "POST",
      { name: "Password policy role" },
      201,
    );
    const fields = (suffix) => ({
      name: "Isolated " + suffix,
      email: suffix + "@password-policy.example.test",
      code: "POLICY-" + suffix,
      department: department._id,
      designation: designation._id,
      joinDate: "2020-01-01",
      basic: 100000,
      password: issued,
    });
    let employee;
    await t.test(
      "new Employee and HR issued passwords immediately reach their actual dashboards",
      async () => {
        employee = await admin("/employees", "POST", fields("normal"), 201);
        const login = await normal("/auth/login", "POST", {
          email: employee.email,
          password: issued,
        });
        assert.equal(login.mustChangePassword, false);
        assert.equal(login.passwordChangeRecommended, true);
        assert.equal(login.passwordChangeEnforced, false);
        await normal("/dashboard");
        await normal("/attendance");
        await normal(`/employees/${employee._id}`);
        await normal("/biometrics/status");
        const staff = await admin(
          "/users",
          "POST",
          {
            name: "Isolated normal HR",
            email: "hr@password-policy.example.test",
            password: issued,
          },
          201,
        );
        assert.equal(staff.mustChangePassword, false);
        assert.equal(
          (
            await hr("/auth/login", "POST", {
              email: staff.email,
              password: issued,
            })
          ).role,
          "hr",
        );
        await hr("/dashboard");
        await hr("/employees");
      },
    );
    await t.test(
      "legacy recommended-password records without the new enforcement field remain usable",
      async () => {
        await M.User.collection.updateOne(
          { _id: new mongoose.Types.ObjectId(employee.user._id) },
          {
            $set: { mustChangePassword: true },
            $unset: { passwordChangeEnforced: 1 },
          },
        );
        const restored = await normal("/auth/me");
        assert.equal(restored.mustChangePassword, false);
        assert.equal(restored.passwordChangeRecommended, true);
        await normal("/dashboard");
        await normal("/attendance");
        await normal(`/employees/${employee._id}`);
      },
    );
    await t.test(
      "explicit Admin enforcement blocks protected work until the employee changes their password once",
      async () => {
        const required = await admin(
          "/employees",
          "POST",
          { ...fields("enforced"), requirePasswordChange: true },
          201,
        );
        const login = await enforced("/auth/login", "POST", {
          email: required.email,
          password: issued,
        });
        assert.equal(login.mustChangePassword, true);
        assert.equal(login.passwordChangeEnforced, true);
        await enforced("/dashboard", "GET", undefined, 403);
        await enforced("/attendance", "GET", undefined, 403);
        await enforced(`/employees/${required._id}`, "GET", undefined, 403);
        const changed = await enforced("/auth/password", "POST", {
          currentPassword: issued,
          password: rotated,
        });
        assert.equal(changed.mustChangePassword, false);
        assert.equal(changed.passwordChangeEnforced, false);
        assert.equal(changed.passwordChangeRecommended, false);
        await enforced("/dashboard");
        await enforced("/attendance");
        await enforced(`/employees/${required._id}`);
      },
    );
    await t.test(
      "Admin access reset revokes prior sessions while default reset credentials work immediately",
      async () => {
        await admin(`/users/${employee.user._id}`, "PATCH", {
          password: rotated,
        });
        await normal("/auth/me", "GET", undefined, 401);
        const login = await normal("/auth/login", "POST", {
          email: employee.email,
          password: rotated,
        });
        assert.equal(login.mustChangePassword, false);
        assert.equal(login.passwordChangeRecommended, true);
        await normal("/dashboard");
        await normal("/attendance");
        await admin(`/users/${employee.user._id}`, "PATCH", {
          requirePasswordChange: true,
        });
        assert.equal(
          (
            await normal("/auth/login", "POST", {
              email: employee.email,
              password: rotated,
            })
          ).mustChangePassword,
          true,
        );
        await normal("/dashboard", "GET", undefined, 403);
        await admin(`/users/${employee.user._id}`, "PATCH", {
          requirePasswordChange: false,
        });
        assert.equal(
          (
            await normal("/auth/login", "POST", {
              email: employee.email,
              password: rotated,
            })
          ).mustChangePassword,
          false,
        );
        await normal("/dashboard");
      },
    );
  },
);
