const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const models = require("../src/models");

const newPassword = () => crypto.randomBytes(6).toString("base64url");

test(
  "account workflows accept eight-character passwords and reject shorter passwords",
  { timeout: 60000 },
  async (t) => {
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
    const database = `hcm_test_password_length_${process.pid}_${Date.now()}`;
    await mongoose.connect(
      process.env.TEST_MONGODB_URI ||
        "mongodb://127.0.0.1:27017/?replicaSet=hcm",
      {
        dbName: database,
        serverSelectionTimeoutMS: 10000,
      },
    );
    await Promise.all(Object.values(models).map((model) => model.init()));
    const server = require("../src/app").listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      assert.match(mongoose.connection.name, /^hcm_test_password_length_/);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });

    function client() {
      let cookie = "";
      return async (path, method = "GET", body, expected = 200) => {
        const response = await fetch(base + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const session = response.headers.get("set-cookie");
        if (session) cookie = session.split(";")[0];
        const result = await response.json();
        assert.equal(
          response.status,
          expected,
          `${method} ${path}: ${result.message || response.statusText}`,
        );
        return result;
      };
    }

    const admin = client();
    const employeeClient = client();
    const initialPassword = newPassword();
    const shortPassword = initialPassword.slice(0, 7);
    let employee;

    await t.test(
      "first-run setup validates eight characters before creating company records",
      async () => {
        const body = {
          company: { name: "Isolated password length setup" },
          name: "Password Length Admin",
          email: "admin@password-length.example.test",
          password: shortPassword,
        };
        await admin("/setup", "POST", body, 422);
        assert.equal(await models.Company.countDocuments(), 0);
        await admin(
          "/setup",
          "POST",
          { ...body, password: initialPassword },
          201,
        );
        await admin("/auth/login", "POST", {
          email: body.email,
          password: initialPassword,
        });
      },
    );

    await t.test(
      "company registration accepts eight characters and rejects seven",
      async () => {
        const registration = client();
        const body = {
          company: { name: "Isolated password length registration" },
          name: "Registered Length Admin",
          email: "registration@password-length.example.test",
          password: shortPassword,
        };
        await registration("/auth/register", "POST", body, 422);
        const result = await registration(
          "/auth/register",
          "POST",
          { ...body, password: initialPassword },
          201,
        );
        assert.equal(result.role, "admin");
        assert.equal(await models.Company.countDocuments(), 2);
      },
    );

    await t.test(
      "Admin creates employee and HR accounts with eight-character passwords",
      async () => {
        const department = await admin(
          "/departments",
          "POST",
          { name: "Password length department" },
          201,
        );
        const designation = await admin(
          "/designations",
          "POST",
          { name: "Password length designation" },
          201,
        );
        const body = {
          name: "Password Length Employee",
          email: "employee@password-length.example.test",
          code: "PW-LENGTH-1",
          department: department._id,
          designation: designation._id,
          joinDate: "2020-01-01",
          basic: 100000,
          password: shortPassword,
        };
        await admin("/employees", "POST", body, 422);
        employee = await admin(
          "/employees",
          "POST",
          { ...body, password: initialPassword },
          201,
        );
        const login = await employeeClient("/auth/login", "POST", {
          email: body.email,
          password: initialPassword,
        });
        assert.equal(login.role, "employee");
        const account = await models.User.findById(login._id).select(
          "+passwordHash",
        );
        assert.equal(
          await bcrypt.compare(initialPassword, account.passwordHash),
          true,
        );
        assert.equal(bcrypt.getRounds(account.passwordHash), 12);
        const staff = {
          name: "Password Length HR",
          email: "hr@password-length.example.test",
          password: shortPassword,
        };
        await admin("/users", "POST", staff, 422);
        await admin(
          "/users",
          "POST",
          { ...staff, password: initialPassword },
          201,
        );
        assert.equal(
          (
            await client()("/auth/login", "POST", {
              email: staff.email,
              password: initialPassword,
            })
          ).role,
          "hr",
        );
      },
    );

    let currentPassword;
    await t.test(
      "employees can change passwords to eight characters",
      async () => {
        currentPassword = newPassword();
        await employeeClient(
          "/auth/password",
          "POST",
          { currentPassword: initialPassword, password: shortPassword },
          422,
        );
        await employeeClient("/auth/password", "POST", {
          currentPassword: initialPassword,
          password: currentPassword,
        });
        await client()(
          "/auth/login",
          "POST",
          { email: employee.email, password: initialPassword },
          401,
        );
        await employeeClient("/auth/login", "POST", {
          email: employee.email,
          password: currentPassword,
        });
      },
    );

    await t.test(
      "Admin access resets use the same minimum and revoke previous sessions",
      async () => {
        const replacement = newPassword();
        await admin(
          `/users/${employee.user._id}`,
          "PATCH",
          { password: shortPassword },
          422,
        );
        await admin(`/users/${employee.user._id}`, "PATCH", {
          password: replacement,
        });
        await employeeClient("/auth/me", "GET", undefined, 401);
        await employeeClient("/auth/login", "POST", {
          email: employee.email,
          password: replacement,
        });
        currentPassword = replacement;
      },
    );

    await t.test(
      "password recovery accepts eight characters without weakening single-use reset tokens",
      async () => {
        const account = await models.User.findById(employee.user._id);
        const token = crypto.randomBytes(32).toString("hex");
        await models.PasswordResetToken.create({
          company: account.company,
          user: account._id,
          tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
          userTokenVersion: account.tokenVersion,
          deliveredAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        });
        const recovery = client();
        const replacement = newPassword();
        await recovery(
          "/auth/reset-password",
          "POST",
          { token, password: shortPassword },
          422,
        );
        assert.equal(await models.PasswordResetToken.countDocuments(), 1);
        await recovery("/auth/reset-password", "POST", {
          token,
          password: replacement,
        });
        assert.equal(await models.PasswordResetToken.countDocuments(), 0);
        await client()(
          "/auth/login",
          "POST",
          { email: employee.email, password: currentPassword },
          401,
        );
        await client()("/auth/login", "POST", {
          email: employee.email,
          password: replacement,
        });
        await recovery(
          "/auth/reset-password",
          "POST",
          { token, password: newPassword() },
          422,
        );
      },
    );
  },
);
