const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const M = require("../src/models");

test(
  "real Admin and HR account, department and access-management workflows",
  { timeout: 120000 },
  async (t) => {
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
    const dbName = `hcm_test_account_department_${process.pid}_${Date.now()}`;
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
      assert.match(mongoose.connection.name, /^hcm_test_account_department_/);
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
        assert.ok(
          (Array.isArray(expected) ? expected : [expected]).includes(r.status),
          `${method} ${path}: ${r.status} ${data.message || ""}`,
        );
        return { data, status: r.status };
      };
    }
    const admin = client(),
      foreign = client(),
      hr = client(),
      employee = client(),
      secondAdmin = client();
    const temporary = crypto.randomBytes(18).toString("base64url");
    const rotated = crypto.randomBytes(18).toString("base64url");
    let owner,
      department,
      designation,
      hrRecord,
      employeeRecord,
      adminRecord,
      hrDepartment;
    const fields = (name, email, code) => ({
      name,
      email,
      code,
      department: department._id,
      designation: designation._id,
      joinDate: "2020-01-01",
      basic: 100000,
    });
    async function activate(account, record) {
      await account("/auth/login", "POST", {
        email: record.email,
        password: temporary,
      });
      await account("/dashboard", "GET", undefined, 403);
      const changed = (
        await account("/auth/password", "POST", {
          currentPassword: temporary,
          password: rotated,
        })
      ).data;
      assert.equal(changed.mustChangePassword, false);
      return changed;
    }
    await t.test(
      "Admin creates departments and staff accounts with real role-specific logins",
      async () => {
        owner = (
          await admin(
            "/auth/register",
            "POST",
            {
              name: "Isolated company owner",
              email: "owner@management.example.test",
              password: rotated,
              company: { name: "Isolated account management A", weekend: [] },
            },
            201,
          )
        ).data;
        await foreign(
          "/auth/register",
          "POST",
          {
            name: "Foreign fixture owner",
            email: "foreign@management.example.test",
            password: rotated,
            company: { name: "Isolated account management B", weekend: [] },
          },
          201,
        );
        department = (
          await admin("/departments", "POST", { name: "Operations" }, 201)
        ).data;
        designation = (
          await admin("/designations", "POST", { name: "Specialist" }, 201)
        ).data;
        assert.equal((await admin("/departments")).data[0].employeeCount, 0);
        hrRecord = (
          await admin(
            "/employees",
            "POST",
            {
              ...fields(
                "Linked HR fixture",
                "hr@management.example.test",
                "HR-1",
              ),
              role: "hr",
              password: temporary,
              requirePasswordChange: true,
            },
            201,
          )
        ).data;
        employeeRecord = (
          await admin(
            "/employees",
            "POST",
            {
              ...fields(
                "Employee fixture",
                "employee@management.example.test",
                "EMP-1",
              ),
              role: "employee",
              password: temporary,
              requirePasswordChange: true,
            },
            201,
          )
        ).data;
        adminRecord = (
          await admin(
            "/employees",
            "POST",
            {
              ...fields(
                "Additional Admin fixture",
                "second-admin@management.example.test",
                "ADMIN-1",
              ),
              role: "admin",
              password: temporary,
              requirePasswordChange: true,
            },
            201,
          )
        ).data;
        assert.equal(hrRecord.user.role, "hr");
        assert.equal(employeeRecord.user.role, "employee");
        assert.equal(adminRecord.user.role, "admin");
        assert.equal((await activate(hr, hrRecord)).role, "hr");
        assert.equal(
          (await activate(employee, employeeRecord)).role,
          "employee",
        );
        assert.equal((await activate(secondAdmin, adminRecord)).role, "admin");
        assert.equal((await employee("/employees")).data.items.length, 1);
        assert.equal(
          (await employee("/employees")).data.items[0]._id,
          employeeRecord._id,
        );
        assert.equal((await employee("/dashboard")).data.weeklyHours, 0);
        assert.equal((await employee("/dashboard")).data.headcount, undefined);
        assert.equal((await admin("/departments")).data[0].employeeCount, 3);
        assert.ok(
          !(await admin("/employees")).data.items.some((row) =>
            JSON.stringify(row.user).includes("passwordHash"),
          ),
        );
      },
    );
    await t.test(
      "HR manages departments, assignments and ordinary employees without privileged-role escalation",
      async () => {
        hrDepartment = (
          await hr(
            "/departments",
            "POST",
            { name: "HR-created department" },
            201,
          )
        ).data;
        await hr(`/departments/${hrDepartment._id}`, "PUT", {
          name: "Delivery",
        });
        await hr("/designations", "POST", { name: "HR-managed role" }, 201);
        const changed = {
          ...fields(
            employeeRecord.name,
            employeeRecord.email,
            employeeRecord.code,
          ),
          department: hrDepartment._id,
        };
        const updated = (
          await hr(`/employees/${employeeRecord._id}`, "PATCH", changed)
        ).data;
        assert.equal(updated.department.name, "Delivery");
        assert.equal(updated.user.role, "employee");
        assert.equal(
          (await admin(`/employees?department=${hrDepartment._id}`)).data.items
            .length,
          1,
        );
        assert.equal(
          (await admin("/departments")).data.find(
            (row) => row._id === hrDepartment._id,
          ).employeeCount,
          1,
        );
        await hr(
          "/employees",
          "POST",
          {
            ...fields(
              "Rejected elevated fixture",
              "rejected@management.example.test",
              "REJECTED",
            ),
            role: "admin",
            password: temporary,
          },
          403,
        );
        await hr(
          `/employees/${employeeRecord._id}`,
          "PATCH",
          { ...changed, role: "hr" },
          403,
        );
        await hr(
          `/employees/${adminRecord._id}`,
          "PATCH",
          fields(adminRecord.name, adminRecord.email, adminRecord.code),
          403,
        );
        await hr(
          "/users",
          "POST",
          {
            name: "Forbidden HR",
            email: "forbidden@management.example.test",
            password: temporary,
          },
          403,
        );
        await employee(
          "/departments",
          "POST",
          { name: "Forbidden employee department" },
          403,
        );
        await admin(`/employees/${employeeRecord._id}`, "PATCH", {
          ...changed,
          role: "hr",
        });
        await employee("/auth/me", "GET", undefined, 401);
        await hr(`/employees/${employeeRecord._id}`, "PATCH", changed, 403);
        await admin(`/users/${employeeRecord.user._id}`, "PATCH", {
          role: "employee",
        });
        assert.equal(
          (
            await employee("/auth/login", "POST", {
              email: employeeRecord.email,
              password: rotated,
            })
          ).data.role,
          "employee",
        );
      },
    );
    await t.test(
      "department removal is safe for employee and historical payroll references",
      async () => {
        await hr(`/departments/${hrDepartment._id}`, "DELETE", undefined, 409);
        const unused = (
          await hr(
            "/departments",
            "POST",
            { name: "Unused removable department" },
            201,
          )
        ).data;
        assert.equal(
          (await hr(`/departments/${unused._id}`, "DELETE")).data.deleted,
          true,
        );
        const historical = (
          await admin(
            "/departments",
            "POST",
            { name: "Historical payroll department" },
            201,
          )
        ).data;
        await M.Payroll.create({
          company: owner.company,
          month: "2020-01",
          createdBy: owner._id,
          slips: [
            {
              employee: employeeRecord._id,
              user: employeeRecord.user._id,
              department: historical._id,
              designation: designation._id,
            },
          ],
        });
        await admin(`/departments/${historical._id}`, "DELETE", undefined, 409);
        assert.ok(await M.Department.exists({ _id: historical._id }));
      },
    );
    await t.test(
      "Admin reviews leave and attendance corrections and generates payroll with financial locks intact",
      async () => {
        const annual = (await employee("/leave-types")).data.find(
          (row) => row.name === "Annual",
        );
        const future = new Date(Date.now() + 7 * 86400000)
          .toISOString()
          .slice(0, 10);
        const pending = (
          await employee(
            "/leave",
            "POST",
            {
              type: annual._id,
              start: future,
              end: future,
              reason: "Isolated approved leave fixture",
            },
            201,
          )
        ).data;
        assert.equal(
          (
            await admin(`/leave/${pending._id}`, "PATCH", {
              status: "approved",
              comment: "Admin company review",
            })
          ).data.status,
          "approved",
        );
        const ownLeave = (
          await hr(
            "/leave",
            "POST",
            {
              type: annual._id,
              start: future,
              end: future,
              reason: "Isolated HR self-approval guard",
            },
            201,
          )
        ).data;
        await hr(
          `/leave/${ownLeave._id}`,
          "PATCH",
          { status: "approved", comment: "Forbidden self decision" },
          403,
        );
        await admin(`/leave/${ownLeave._id}`, "PATCH", {
          status: "approved",
          comment: "Separate Admin review",
        });
        const prior = new Date(Date.now() - 86400000)
          .toISOString()
          .slice(0, 10);
        const correction = (
          await employee(
            "/corrections",
            "POST",
            {
              date: prior,
              checkIn: prior + "T09:00:00.000Z",
              checkOut: prior + "T17:00:00.000Z",
              reason: "Isolated completed shift correction",
            },
            201,
          )
        ).data;
        assert.equal(
          (
            await admin(`/corrections/${correction._id}`, "PATCH", {
              status: "approved",
              comment: "Admin verified completed shift",
            })
          ).data.status,
          "approved",
        );
        assert.ok(
          await M.Attendance.exists({
            company: owner.company,
            employee: employeeRecord._id,
            date: prior,
            verificationMethod: "hr-correction",
          }),
        );
        const month = new Date().toISOString().slice(0, 7);
        const payroll = (await admin("/payroll", "POST", { month }, 201)).data;
        assert.equal(payroll.status, "draft");
        assert.equal(payroll.slips.length, 3);
        await hr(`/payroll/${payroll._id}/finalize`, "POST", undefined, 403);
        assert.equal(
          (await admin(`/payroll/${payroll._id}/finalize`, "POST")).data.status,
          "finalized",
        );
        await admin("/payroll", "POST", { month }, 409);
      },
    );
    await t.test(
      "Admin activation and temporary reset preserve secure existing credential rotation",
      async () => {
        await admin(`/users/${employeeRecord.user._id}`, "PATCH", {
          active: false,
        });
        await employee("/auth/me", "GET", undefined, 401);
        await employee(
          "/auth/login",
          "POST",
          { email: employeeRecord.email, password: rotated },
          401,
        );
        await admin(`/users/${employeeRecord.user._id}`, "PATCH", {
          active: true,
          password: temporary,
          requirePasswordChange: true,
        });
        assert.equal(
          (
            await employee("/auth/login", "POST", {
              email: employeeRecord.email,
              password: temporary,
            })
          ).data.mustChangePassword,
          true,
        );
        await employee("/dashboard", "GET", undefined, 403);
        await employee("/auth/password", "POST", {
          currentPassword: temporary,
          password: rotated,
        });
        await employee("/dashboard");
        const linkedPromotion = (
          await admin(
            "/users",
            "POST",
            {
              name: "Promoted linked HR",
              email: "promoted@management.example.test",
              password: temporary,
              employee: employeeRecord._id,
              role: "hr",
            },
            201,
          )
        ).data;
        assert.equal(linkedPromotion.role, "hr");
        const actualEmployee = await M.Employee.findById(
          employeeRecord._id,
        ).lean();
        assert.equal(actualEmployee.email, linkedPromotion.email);
        assert.equal(actualEmployee.name, linkedPromotion.name);
        await admin(`/users/${employeeRecord.user._id}`, "PATCH", {
          role: "employee",
        });
      },
    );
    await t.test(
      "company-scoped catalogs and account operations cannot modify a foreign tenant",
      async () => {
        assert.equal((await foreign("/employees")).data.total, 0);
        await foreign(
          `/users/${employeeRecord.user._id}`,
          "PATCH",
          { active: false },
          404,
        );
        await foreign(
          `/departments/${department._id}`,
          "PUT",
          { name: "Forbidden change" },
          404,
        );
        await foreign(
          "/employees",
          "POST",
          {
            ...fields(
              "Foreign injected fixture",
              "injected@management.example.test",
              "INJECTED",
            ),
            password: temporary,
          },
          404,
        );
        assert.equal(
          (await M.User.findById(employeeRecord.user._id).lean()).active,
          true,
        );
        assert.equal(
          (await M.Department.findById(department._id).lean()).name,
          "Operations",
        );
      },
    );
    await t.test(
      "self-demotion and self-exit are blocked through both account and employee APIs",
      async () => {
        await admin(`/users/${owner._id}`, "PATCH", { active: false }, 403);
        await admin(`/users/${owner._id}`, "PATCH", { role: "hr" }, 403);
        await secondAdmin(
          `/employees/${adminRecord._id}`,
          "PATCH",
          {
            ...fields(adminRecord.name, adminRecord.email, adminRecord.code),
            role: "employee",
          },
          403,
        );
        await secondAdmin(
          `/employees/${adminRecord._id}`,
          "PATCH",
          {
            ...fields(adminRecord.name, adminRecord.email, adminRecord.code),
            status: "exited",
            exitDate: new Date().toISOString().slice(0, 10),
          },
          403,
        );
        assert.equal(
          await M.User.countDocuments({
            company: owner.company,
            role: "admin",
            active: true,
          }),
          2,
        );
      },
    );
    await t.test(
      "concurrent administrators cannot deactivate one another and strand the company",
      async () => {
        const outcomes = await Promise.all([
          admin(
            `/users/${adminRecord.user._id}`,
            "PATCH",
            { active: false },
            [200, 401, 403, 409],
          ),
          secondAdmin(
            `/users/${owner._id}`,
            "PATCH",
            { active: false },
            [200, 401, 403, 409],
          ),
        ]);
        assert.equal(
          outcomes.filter((result) => result.status === 200).length,
          1,
        );
        assert.equal(
          await M.User.countDocuments({
            company: owner.company,
            role: "admin",
            active: true,
          }),
          1,
        );
      },
    );
  },
);
