const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const net = require("node:net");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const M = require("../src/models");

// A genuine local SMTP protocol receiver used only for isolated transport tests.
// No real address receives these fixture messages and no API response is mocked.
async function smtpReceiver() {
  const messages = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 isolated-test.local ESMTP\r\n");
    let pending = "",
      data = null;
    socket.on("data", (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\r\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (data) {
          if (line === ".") {
            messages.push(data.join("\r\n"));
            data = null;
            socket.write("250 queued in isolated fixture\r\n");
          } else data.push(line.replace(/^\.\./, "."));
        } else if (/^(EHLO|HELO) /i.test(line)) {
          socket.write("250-isolated-test.local\r\n250 SIZE 1000000\r\n");
        } else if (/^(MAIL FROM:|RCPT TO:|RSET|NOOP)/i.test(line)) {
          socket.write("250 ok\r\n");
        } else if (line.toUpperCase() === "DATA") {
          data = [];
          socket.write("354 finish with a dot\r\n");
        } else if (line.toUpperCase() === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("500 unsupported fixture command\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test(
  "real company registration and SMTP-backed one-use password recovery",
  { timeout: 120000 },
  async (t) => {
    const names = [
      "JWT_SECRET",
      "NODE_ENV",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_FROM",
      "SMTP_SECURE",
      "SMTP_USER",
      "SMTP_PASSWORD",
      "AUTH_APP_URL",
    ];
    const previous = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
    process.env.NODE_ENV = "test";
    for (const name of names.filter((name) => name.startsWith("SMTP_")))
      delete process.env[name];
    const dbName = `hcm_test_auth_recovery_${process.pid}_${Date.now()}`;
    await mongoose.connect(
      process.env.TEST_MONGODB_URI ||
        "mongodb://127.0.0.1:27017/?replicaSet=hcm",
      { dbName, serverSelectionTimeoutMS: 10000 },
    );
    await Promise.all(Object.values(M).map((model) => model.init()));
    const appServer = require("../src/app").listen(0, "127.0.0.1");
    await new Promise((resolve) => appServer.once("listening", resolve));
    const smtp = await smtpReceiver();
    const base = `http://127.0.0.1:${appServer.address().port}/api`;
    t.after(async () => {
      await new Promise((resolve) => appServer.close(resolve));
      await smtp.close();
      assert.match(mongoose.connection.name, /^hcm_test_auth_recovery_/);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    });
    const firstPassword = crypto.randomBytes(18).toString("base64url");
    const resetPassword = crypto.randomBytes(18).toString("base64url");
    function client() {
      let cookie = "";
      const request = async (
        endpoint,
        method = "GET",
        body,
        expected = 200,
      ) => {
        const response = await fetch(base + endpoint, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) cookie = setCookie.split(";")[0];
        const result = await response.json();
        assert.equal(
          response.status,
          expected,
          `${method} ${endpoint}: ${result.message || response.statusText}`,
        );
        return { data: result, setCookie };
      };
      return request;
    }
    const owner = client(),
      other = client(),
      anonymous = client(),
      restored = client();
    let admin;

    await t.test(
      "public registration atomically creates a company, linked Admin and authenticated session",
      async () => {
        const registration = await owner(
          "/auth/register",
          "POST",
          {
            name: "Isolated owner",
            email: "owner@auth.example.test",
            password: firstPassword,
            company: { name: "Isolated registered company A" },
          },
          201,
        );
        admin = registration.data;
        assert.equal(admin.role, "admin");
        assert.equal(admin.mustChangePassword, false);
        assert.ok(admin.company);
        assert.match(registration.setCookie, /HttpOnly/i);
        assert.match(registration.setCookie, /SameSite=Strict/i);
        assert.equal((await owner("/auth/me")).data._id, admin._id);
        assert.equal((await owner("/dashboard")).data.headcount, 0);
        assert.equal(await M.Company.countDocuments(), 1);
        assert.equal(await M.User.countDocuments(), 1);
        assert.equal(
          await M.LeaveType.countDocuments({ company: admin.company }),
          4,
        );
        const user = await M.User.findById(admin._id).select("+passwordHash");
        assert.equal(
          await bcrypt.compare(firstPassword, user.passwordHash),
          true,
        );
        assert.equal(JSON.stringify(admin).includes("passwordHash"), false);
        assert.ok(
          await M.AuditLog.exists({
            company: admin.company,
            action: "company_registered",
          }),
        );
      },
    );

    await t.test(
      "a second company registers independently and duplicate email rolls back all records",
      async () => {
        const second = (
          await other(
            "/auth/register",
            "POST",
            {
              name: "Other isolated owner",
              email: "second@auth.example.test",
              password: firstPassword,
              company: { name: "Isolated registered company B" },
            },
            201,
          )
        ).data;
        assert.notEqual(second.company, admin.company);
        const companies = await M.Company.find().lean();
        assert.equal(
          new Set(companies.map((company) => company.singleton)).size,
          2,
        );
        await anonymous(
          "/auth/register",
          "POST",
          {
            name: "Rejected owner",
            email: admin.email,
            password: firstPassword,
            company: { name: "Must roll back" },
          },
          409,
        );
        assert.equal(await M.Company.countDocuments(), 2);
        assert.equal(await M.User.countDocuments(), 2);
        assert.equal(await M.LeaveType.countDocuments(), 8);
        assert.equal((await owner("/users")).data.length, 1);
        assert.equal((await other("/users")).data.length, 1);
        assert.equal((await anonymous("/setup")).data.required, false);
      },
    );

    await t.test(
      "missing SMTP configuration fails clearly for both known and unknown accounts",
      async () => {
        const known = (
          await anonymous(
            "/auth/forgot-password",
            "POST",
            { email: admin.email },
            503,
          )
        ).data;
        const unknown = (
          await anonymous(
            "/auth/forgot-password",
            "POST",
            { email: "unknown@auth.example.test" },
            503,
          )
        ).data;
        assert.equal(known.message, unknown.message);
        assert.match(known.message, /not configured|administrator/i);
        assert.equal(await M.PasswordResetToken.countDocuments(), 0);
        assert.equal(smtp.messages.length, 0);
      },
    );

    function configureMail() {
      process.env.SMTP_HOST = "127.0.0.1";
      process.env.SMTP_PORT = String(smtp.port);
      process.env.SMTP_FROM = "noreply@isolated.example.test";
      process.env.SMTP_SECURE = "false";
      process.env.AUTH_APP_URL = "http://localhost:3000";
    }
    let token;
    await t.test(
      "real SMTP delivery contains a reset link while APIs and MongoDB expose no raw token",
      async () => {
        configureMail();
        const known = (
          await anonymous(
            "/auth/forgot-password",
            "POST",
            { email: admin.email },
            202,
          )
        ).data;
        const unknown = (
          await anonymous(
            "/auth/forgot-password",
            "POST",
            { email: "unknown@auth.example.test" },
            202,
          )
        ).data;
        assert.deepEqual(known, unknown);
        assert.equal(smtp.messages.length, 1);
        const message = smtp.messages[0]
          .replace(/=\r\n/g, "")
          .replace(/=3D/g, "=");
        const link = message.match(
          /http:\/\/localhost:3000\/reset-password\?token=([a-f\d]{64})/i,
        );
        assert.ok(
          link,
          "Actual locally received SMTP message must contain the reset link",
        );
        token = link[1];
        const hidden = await M.PasswordResetToken.findOne({
          user: admin._id,
        }).lean();
        const stored = await M.PasswordResetToken.findOne({ user: admin._id })
          .select("+tokenHash")
          .lean();
        assert.equal(hidden.tokenHash, undefined);
        assert.equal(
          stored.tokenHash,
          crypto.createHash("sha256").update(token).digest("hex"),
        );
        assert.equal(String(stored.company), admin.company);
        assert.ok(stored.deliveredAt);
        assert.ok(stored.expiresAt > new Date());
        assert.equal(JSON.stringify(stored).includes(token), false);
        assert.equal(JSON.stringify(known).includes(token), false);
        const audit = await M.AuditLog.find().lean();
        assert.equal(JSON.stringify(audit).includes(token), false);
        assert.equal(JSON.stringify(audit).includes(stored.tokenHash), false);
      },
    );

    await t.test(
      "reset consumes the token once, changes the real hash and revokes older sessions",
      async () => {
        await anonymous(
          "/auth/reset-password",
          "POST",
          { token: "f".repeat(64), password: resetPassword },
          422,
        );
        const reset = await restored("/auth/reset-password", "POST", {
          token,
          password: resetPassword,
        });
        assert.equal(reset.data._id, admin._id);
        assert.match(reset.setCookie, /HttpOnly/i);
        await owner("/auth/me", "GET", undefined, 401);
        await anonymous(
          "/auth/login",
          "POST",
          { email: admin.email, password: firstPassword },
          401,
        );
        assert.equal(
          (
            await anonymous("/auth/login", "POST", {
              email: admin.email,
              password: resetPassword,
            })
          ).data._id,
          admin._id,
        );
        await anonymous(
          "/auth/reset-password",
          "POST",
          { token, password: firstPassword },
          422,
        );
        assert.equal(
          await M.PasswordResetToken.countDocuments({ user: admin._id }),
          0,
        );
        assert.equal((await restored("/auth/me")).data._id, admin._id);
      },
    );

    await t.test(
      "expired tokens cannot reset accounts and production sessions use Secure cookies",
      async () => {
        await anonymous(
          "/auth/forgot-password",
          "POST",
          { email: admin.email },
          202,
        );
        const message = smtp.messages
          .at(-1)
          .replace(/=\r\n/g, "")
          .replace(/=3D/g, "=");
        const expiredToken = message.match(/token=([a-f\d]{64})/i)[1];
        await M.PasswordResetToken.updateOne(
          { user: admin._id },
          { expiresAt: new Date(Date.now() - 1000) },
        );
        await anonymous(
          "/auth/reset-password",
          "POST",
          { token: expiredToken, password: firstPassword },
          422,
        );
        process.env.NODE_ENV = "production";
        try {
          const signedIn = await anonymous("/auth/login", "POST", {
            email: admin.email,
            password: resetPassword,
          });
          assert.match(signedIn.setCookie, /Secure/i);
          await anonymous(
            "/auth/forgot-password",
            "POST",
            { email: admin.email },
            503,
          ); // HTTP reset URL is never accepted in production.
        } finally {
          process.env.NODE_ENV = "test";
        }
      },
    );

    await t.test(
      "Admin activation and temporary-password rotation work and invalidate old recovery links",
      async () => {
        const temporaryPassword = crypto.randomBytes(18).toString("base64url");
        const rotated = crypto.randomBytes(18).toString("base64url");
        const staff = (
          await anonymous(
            "/users",
            "POST",
            {
              name: "Isolated HR activation",
              email: "activation@auth.example.test",
              password: temporaryPassword,
            },
            201,
          )
        ).data;
        const staffClient = client();
        await anonymous(
          "/auth/forgot-password",
          "POST",
          { email: staff.email },
          202,
        );
        const message = smtp.messages
          .at(-1)
          .replace(/=\r\n/g, "")
          .replace(/=3D/g, "=");
        const oldToken = message.match(/token=([a-f\d]{64})/i)[1];
        await anonymous(`/users/${staff._id}`, "PATCH", { active: false });
        await staffClient(
          "/auth/login",
          "POST",
          { email: staff.email, password: temporaryPassword },
          401,
        );
        await staffClient(
          "/auth/reset-password",
          "POST",
          { token: oldToken, password: resetPassword },
          422,
        );
        await anonymous(`/users/${staff._id}`, "PATCH", { active: true });
        assert.equal(
          (
            await staffClient("/auth/login", "POST", {
              email: staff.email,
              password: temporaryPassword,
            })
          ).data.mustChangePassword,
          true,
        );
        await staffClient("/dashboard", "GET", undefined, 403);
        assert.equal(
          (
            await staffClient("/auth/password", "POST", {
              currentPassword: temporaryPassword,
              password: rotated,
            })
          ).data.mustChangePassword,
          false,
        );
        await staffClient("/dashboard");
        await staffClient(
          "/auth/reset-password",
          "POST",
          { token: oldToken, password: resetPassword },
          422,
        );
        assert.equal((await anonymous("/auth/me")).data._id, admin._id);
      },
    );

    await t.test(
      "HR login-email changes invalidate old-mail recovery links and sessions without revoking ordinary edits",
      async () => {
        const temporary = crypto.randomBytes(18).toString("base64url");
        const activePassword = crypto.randomBytes(18).toString("base64url");
        const hr = client(),
          employeeClient = client();
        await anonymous(
          "/users",
          "POST",
          {
            name: "Isolated email-change HR",
            email: "email-hr@auth.example.test",
            password: temporary,
          },
          201,
        );
        await hr("/auth/login", "POST", {
          email: "email-hr@auth.example.test",
          password: temporary,
        });
        await hr("/auth/password", "POST", {
          currentPassword: temporary,
          password: activePassword,
        });
        const department = (
          await anonymous(
            "/departments",
            "POST",
            { name: "Email-change fixture department" },
            201,
          )
        ).data;
        const designation = (
          await anonymous(
            "/designations",
            "POST",
            { name: "Email-change fixture role" },
            201,
          )
        ).data;
        const fields = {
          name: "Isolated email-change employee",
          email: "old-mail@auth.example.test",
          code: "AUTH-EMAIL-1",
          department: department._id,
          designation: designation._id,
          joinDate: "2020-01-01",
          basic: 100000,
        };
        const employee = (
          await hr(
            "/employees",
            "POST",
            { ...fields, password: temporary },
            201,
          )
        ).data;
        await employeeClient("/auth/login", "POST", {
          email: fields.email,
          password: temporary,
        });
        await employeeClient("/auth/password", "POST", {
          currentPassword: temporary,
          password: activePassword,
        });
        await anonymous(
          "/auth/forgot-password",
          "POST",
          { email: fields.email },
          202,
        );
        const delivered = smtp.messages
          .at(-1)
          .replace(/=\r\n/g, "")
          .replace(/=3D/g, "=");
        const oldMailToken = delivered.match(/token=([a-f\d]{64})/i)[1];
        const before = await M.User.findById(employee.user).lean();
        await hr(`/employees/${employee._id}`, "PATCH", {
          ...fields,
          phone: "+92 000 0000",
        });
        assert.equal(
          (await M.User.findById(employee.user).lean()).tokenVersion,
          before.tokenVersion,
        );
        assert.equal(
          (await employeeClient("/auth/me")).data.email,
          fields.email,
        );

        const changed = { ...fields, email: "new-mail@auth.example.test" };
        await hr(`/employees/${employee._id}`, "PATCH", changed);
        const updated = await M.User.findById(employee.user).lean();
        assert.equal(updated.tokenVersion, before.tokenVersion + 1);
        await employeeClient("/auth/me", "GET", undefined, 401);
        await employeeClient(
          "/auth/reset-password",
          "POST",
          { token: oldMailToken, password: resetPassword },
          422,
        );
        await employeeClient(
          "/auth/login",
          "POST",
          { email: fields.email, password: activePassword },
          401,
        );
        assert.equal(
          (
            await employeeClient("/auth/login", "POST", {
              email: changed.email,
              password: activePassword,
            })
          ).data.email,
          changed.email,
        );

        await hr(`/employees/${employee._id}`, "PATCH", {
          ...changed,
          email: "exited-mail@auth.example.test",
          status: "exited",
          exitDate: new Date().toISOString().slice(0, 10),
        });
        const exited = await M.User.findById(employee.user).lean();
        assert.equal(exited.tokenVersion, updated.tokenVersion + 1);
        assert.equal(exited.active, false);
        await employeeClient("/auth/me", "GET", undefined, 401);
      },
    );
  },
);
