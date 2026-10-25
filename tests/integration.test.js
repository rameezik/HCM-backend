const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const M = require("../src/models");
const { today, workingDays } = require("../src/services/rules");
process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
// Run the complete core lifecycle with optional hosted AI deliberately unconfigured.
delete process.env.AI_API_KEY;
const dbName = `hcm_test_${process.pid}_${Date.now()}`;
const passwd = crypto.randomBytes(18).toString("base64url");
const rotated = crypto.randomBytes(18).toString("base64url");
test("real MongoDB API lifecycle and role boundaries", async (t) => {
  const uri =
    process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=hcm";
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10000 });
  await Promise.all(Object.values(M).map((model) => model.init()));
  const server = require("../src/app").listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  function client() {
    let cookie = "";
    return async (path, method = "GET", body, expected = 200) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.headers.get("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      const content = response.headers.get("content-type") || "";
      const output = content.includes("json")
        ? await response.json()
        : Buffer.from(await response.arrayBuffer());
      assert.equal(
        response.status,
        expected,
        `${method} ${path}: ${JSON.stringify(output)}`,
      );
      return output;
    };
  }
  const admin = client(),
    hr = client(),
    alice = client(),
    bob = client(),
    anonymous = client();
  let department, designation, aliceRecord, bobRecord, leave, run, correction;
  const currentDay = today(),
    month = currentDay.slice(0, 7),
    first = `${month}-01`;
  await t.test(
    "fresh setup is empty and initializes exactly once",
    async () => {
      assert.equal((await anonymous("/setup")).required, true);
      await anonymous("/employees", "GET", undefined, 401);
      await anonymous(
        "/setup",
        "POST",
        {
          name: "Test Admin",
          email: "admin@example.test",
          password: passwd,
          company: { name: "Integration Company", weekend: [] },
        },
        201,
      );
      await anonymous(
        "/setup",
        "POST",
        {
          name: "Other",
          email: "other@example.test",
          password: passwd,
          company: { name: "Other" },
        },
        409,
      );
      assert.equal(await M.Employee.countDocuments(), 0);
      assert.equal(await M.User.countDocuments(), 1);
    },
  );
  await t.test("Admin authenticates and manages organization", async () => {
    await admin(
      "/auth/login",
      "POST",
      { email: "admin@example.test", password: "invalid" },
      401,
    );
    assert.equal(
      (
        await admin("/auth/login", "POST", {
          email: "admin@example.test",
          password: passwd,
        })
      ).role,
      "admin",
    );
    department = await admin(
      "/departments",
      "POST",
      { name: "Engineering" },
      201,
    );
    designation = await admin(
      "/designations",
      "POST",
      { name: "Engineer" },
      201,
    );
    await admin("/departments", "POST", { name: "Engineering" }, 409);
    await admin(
      "/users",
      "POST",
      { name: "HR Person", email: "hr@example.test", password: passwd },
      201,
    );
  });
  await t.test(
    "temporary password forces rotation and HR cannot alter company",
    async () => {
      assert.equal(
        (
          await hr("/auth/login", "POST", {
            email: "hr@example.test",
            password: passwd,
          })
        ).mustChangePassword,
        true,
      );
      await hr("/employees", "GET", undefined, 403);
      await hr("/auth/password", "POST", {
        currentPassword: passwd,
        password: rotated,
      });
      await hr("/company", "PUT", { name: "Unauthorized" }, 403);
      await hr("/users", "POST", {}, 403);
      await hr("/audit", "GET", undefined, 403);
    },
  );
  await t.test(
    "HR registers employees and creates real hashed logins",
    async () => {
      const payload = {
        department: department._id,
        designation: designation._id,
        joinDate: first,
        basic: 100000,
        password: passwd,
      };
      aliceRecord = await hr(
        "/employees",
        "POST",
        {
          ...payload,
          name: "Alice Example",
          email: "alice@example.test",
          code: "E001",
        },
        201,
      );
      bobRecord = await hr(
        "/employees",
        "POST",
        {
          ...payload,
          name: "Bob Example",
          email: "bob@example.test",
          code: "E002",
        },
        201,
      );
      const login = await M.User.findById(aliceRecord.user).select(
        "+passwordHash",
      );
      assert.notEqual(login.passwordHash, passwd);
      assert.match(login.passwordHash, /^\$2/);
      await admin("/employees", "POST", {}, 422);
      await hr(
        "/employees",
        "POST",
        {
          ...payload,
          name: "Duplicate",
          email: "alice@example.test",
          code: "E003",
        },
        409,
      );
      assert.equal(await M.Employee.countDocuments(), 2);
      const search = await hr("/employees?search=Alice&limit=1");
      assert.equal(search.total, 1);
      assert.equal(search.items[0].code, "E001");
    },
  );
  await t.test(
    "employee scope blocks peer records and privileged writes",
    async () => {
      await alice("/auth/login", "POST", {
        email: "alice@example.test",
        password: passwd,
      });
      await alice("/auth/password", "POST", {
        currentPassword: passwd,
        password: rotated,
      });
      await bob("/auth/login", "POST", {
        email: "bob@example.test",
        password: passwd,
      });
      await bob("/auth/password", "POST", {
        currentPassword: passwd,
        password: rotated,
      });
      const own = await alice("/employees");
      assert.equal(own.total, 1);
      assert.equal(own.items[0]._id, aliceRecord._id);
      await alice(`/employees/${bobRecord._id}`, "GET", undefined, 404);
      await alice(`/employees/${aliceRecord._id}`, "PATCH", { basic: 1 }, 422);
      await alice(`/employees/${aliceRecord._id}`, "PATCH", {
        phone: "03000000000",
        address: "Test Address",
      });
      await alice("/company", "GET", undefined, 403);
      await alice("/audit", "GET", undefined, 403);
      await alice("/users", "GET", undefined, 403);
    },
  );
  await t.test(
    "web attendance uses server time, rejects repeats, and stores rule snapshot",
    async () => {
      const attendance = await alice("/attendance/check-in", "POST");
      assert.equal(attendance.date, currentDay);
      assert.equal(attendance.status, "missing_checkout");
      assert.ok(Math.abs(Date.now() - Date.parse(attendance.checkIn)) < 10000);
      await alice("/attendance/check-in", "POST", undefined, 409);
      const out = await alice("/attendance/check-out", "POST");
      assert.equal(out.status, "half_day");
      await alice("/attendance/check-out", "POST", undefined, 409);
      const rows = await alice(`/attendance?start=${first}&end=${currentDay}`);
      assert.ok(rows.every((r) => r.employee._id === aliceRecord._id));
    },
  );
  await t.test(
    "corrections require HR review and update real attendance",
    async () => {
      const d = new Date(currentDay);
      d.setUTCDate(d.getUTCDate() - 1);
      const day = d.toISOString().slice(0, 10);
      correction = await alice(
        "/corrections",
        "POST",
        {
          date: day,
          checkIn: `${day}T09:00:00.000Z`,
          checkOut: `${day}T17:00:00.000Z`,
          reason: "Forgot to check in",
        },
        201,
      );
      await alice(
        `/corrections/${correction._id}`,
        "PATCH",
        { status: "approved", comment: "Unauthorized" },
        403,
      );
      await hr(`/corrections/${correction._id}`, "PATCH", {
        status: "approved",
        comment: "Verified against work record",
      });
      await hr(
        `/corrections/${correction._id}`,
        "PATCH",
        { status: "approved", comment: "Again" },
        409,
      );
      const row = await M.Attendance.findOne({
        employee: aliceRecord._id,
        date: day,
      });
      assert.equal(row.status, "present");
      assert.equal(row.hours, 8);
    },
  );
  await t.test(
    "leave reserves balance, rejects overlap, requires authorized approval and notifies recipient",
    async () => {
      const types = await alice("/leave-types");
      const casual = types.find((x) => x.name === "Casual");
      const future = new Date();
      future.setUTCDate(future.getUTCDate() + 2);
      const day = future.toISOString().slice(0, 10);
      leave = await alice(
        "/leave",
        "POST",
        { type: casual._id, start: day, end: day, reason: "Wedding" },
        201,
      );
      await alice(
        "/leave",
        "POST",
        { type: casual._id, start: day, end: day, reason: "Overlap" },
        422,
      );
      const reserved = (await alice("/leave/balance")).find(
        (x) => x._id === casual._id,
      );
      assert.equal(reserved.pending, 1);
      assert.equal(reserved.remaining, 9);
      await alice(
        `/leave/${leave._id}`,
        "PATCH",
        { status: "approved", comment: "Unauthorized" },
        403,
      );
      await admin(
        `/leave/${leave._id}`,
        "PATCH",
        { status: "pending", comment: "Invalid decision" },
        422,
      );
      await hr(`/leave/${leave._id}`, "PATCH", {
        status: "approved",
        comment: "Approved",
      });
      const used = (await alice("/leave/balance")).find(
        (x) => x._id === casual._id,
      );
      assert.equal(used.used, 1);
      assert.equal(used.pending, 0);
      assert.ok(
        (await alice("/notifications")).some((n) =>
          n.message.includes("Leave approved"),
        ),
      );
      assert.equal((await bob("/leave")).length, 0);
    },
  );
  await t.test(
    "CSV dry run returns row/field/reason without saving data",
    async () => {
      const csv = `code,name,email,department,designation,joinDate,basic\nE003,Invalid,not-email,${department._id},${designation._id},2026-02-30,-1`;
      const result = await hr("/employees/import", "POST", {
        csv,
        dryRun: true,
      });
      assert.ok(result.errors.length >= 3);
      assert.ok(result.errors.every((e) => e.row === 2 && e.field && e.reason));
      assert.equal(await M.Employee.countDocuments(), 2);
      const exported = await hr("/employees/export");
      assert.match(exported.toString(), /Alice Example/);
      await alice("/employees/export", "GET", undefined, 403);
    },
  );
  await t.test(
    "CSV valid dry run and atomic import create a forced-password login",
    async () => {
      const csv = `code,name,email,department,designation,joinDate,basic\nE003,Carol Example,carol@example.test,${department._id},${designation._id},${first},100000`;
      assert.equal(
        (await hr("/employees/import", "POST", { csv, dryRun: true })).valid,
        1,
      );
      assert.equal(
        (
          await hr(
            "/employees/import",
            "POST",
            { csv, dryRun: false, password: passwd },
            201,
          )
        ).imported,
        1,
      );
      const imported = client();
      assert.equal(
        (
          await imported("/auth/login", "POST", {
            email: "carol@example.test",
            password: passwd,
          })
        ).mustChangePassword,
        true,
      );
      assert.equal(await M.Employee.countDocuments(), 3);
    },
  );
  await t.test(
    "leave cancellation releases reservation and quota is enforced",
    async () => {
      const types = await bob("/leave-types");
      const sick = types.find((x) => x.name === "Sick");
      const future = new Date();
      future.setUTCDate(future.getUTCDate() + 3);
      const day = future.toISOString().slice(0, 10);
      const request = await bob(
        "/leave",
        "POST",
        { type: sick._id, start: day, end: day, reason: "Medical appointment" },
        201,
      );
      await alice(
        `/leave/${request._id}`,
        "PATCH",
        { status: "cancelled", comment: "Not mine" },
        403,
      );
      await bob(`/leave/${request._id}`, "PATCH", {
        status: "cancelled",
        comment: "Appointment moved",
      });
      assert.equal(
        (await bob("/leave/balance")).find((x) => x._id === sick._id).remaining,
        8,
      );
      await bob(
        "/leave",
        "POST",
        {
          type: sick._id,
          start: "2026-12-01",
          end: "2026-12-12",
          reason: "Too many days",
        },
        422,
      );
    },
  );
  await t.test(
    "dashboard aggregates real records and employee metrics contain no peer salaries",
    async () => {
      const stats = await hr(`/dashboard?start=${first}&end=${currentDay}`);
      assert.equal(stats.headcount, 3);
      assert.equal(stats.averageSalary, 150000);
      assert.equal(stats.byDepartment[0].count, 3);
      assert.equal(stats.pendingApprovals, 0);
      const own = await alice(`/dashboard?start=${first}&end=${currentDay}`);
      assert.equal(own.averageSalary, undefined);
      assert.equal(own.byDepartment, undefined);
    },
  );
  await t.test(
    "payroll generated by HR, finalized only by Admin, PDF is real and scoped",
    async () => {
      await admin("/payroll", "POST", {}, 422);
      run = await hr("/payroll", "POST", { month }, 201);
      assert.equal(run.slips.length, 3);
      assert.equal(run.slips[0].gross, 150000);
      await hr(`/payroll/${run._id}/finalize`, "POST", undefined, 403);
      await alice(
        `/payroll/${run._id}/payslip/${aliceRecord._id}`,
        "GET",
        undefined,
        409,
      );
      const aliceDoc = await M.Employee.findById(aliceRecord._id);
      await hr(`/employees/${aliceRecord._id}`, "PATCH", {
        name: aliceDoc.name,
        email: aliceDoc.email,
        code: aliceDoc.code,
        department: String(aliceDoc.department),
        designation: String(aliceDoc.designation),
        joinDate: aliceDoc.joinDate,
        basic: 110000,
      });
      await admin(`/payroll/${run._id}/finalize`, "POST", undefined, 409);
      run = await hr("/payroll", "POST", { month }, 201);
      await admin(`/payroll/${run._id}/finalize`, "POST");
      await admin(`/payroll/${run._id}/finalize`, "POST", undefined, 409);
      await hr("/payroll", "POST", { month }, 409);
      const pdf = await alice(`/payroll/${run._id}/payslip/${aliceRecord._id}`);
      assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
      assert.ok(pdf.length > 1000);
      await alice(
        `/payroll/${run._id}/payslip/${bobRecord._id}`,
        "GET",
        undefined,
        403,
      );
      const own = await alice("/payroll");
      assert.equal(own[0].slips.length, 1);
      assert.equal(own[0].slips[0].employee, aliceRecord._id);
      await alice(
        `/leave/${leave._id}`,
        "PATCH",
        { status: "cancelled", comment: "After lock" },
        409,
      );
    },
  );
  await t.test(
    "announcements, notifications and audit are persisted and scoped",
    async () => {
      await hr(
        "/announcements",
        "POST",
        { title: "Office update", body: "Company meeting tomorrow." },
        201,
      );
      assert.equal((await alice("/announcements"))[0].title, "Office update");
      const notes = await alice("/notifications");
      assert.ok(notes.length >= 2);
      await bob(`/notifications/${notes[0]._id}`, "PATCH", undefined, 404);
      assert.equal(
        (await alice(`/notifications/${notes[0]._id}`, "PATCH")).read,
        true,
      );
      const audit = await admin("/audit");
      assert.ok(audit.some((a) => a.action === "finalize"));
      assert.ok(!JSON.stringify(audit).includes("passwordHash"));
      await hr("/audit", "GET", undefined, 403);
      await admin("/audit", "POST", {}, 404);
    },
  );
  await t.test(
    "seven AI tools reuse real services and preserve employee scope without a hosted model",
    async () => {
      const { executeTool } = require("../src/services/aiService");
      const employee = await M.User.findById(aliceRecord.user);
      const hrUser = await M.User.findOne({ email: "hr@example.test" });
      assert.equal(
        (await executeTool("get_headcount", {}, hrUser)).headcount,
        3,
      );
      assert.ok((await executeTool("get_headcount", {}, employee)).error);
      assert.equal(
        (await executeTool("search_employees", { search: "Bob" }, employee))
          .length,
        0,
      );
      assert.equal(
        (await executeTool("search_employees", {}, employee)).length,
        1,
      );
      const balance = await executeTool("get_my_leave_balance", {}, employee);
      assert.ok(balance.some((b) => b.name === "Sick"));
      assert.equal(
        (await executeTool("get_attendance_summary", {}, employee)).filters
          .department,
        null,
      );
      assert.equal(
        (await executeTool("get_late_comers", {}, employee)).ownLateCount,
        await M.Attendance.countDocuments({
          employee: aliceRecord._id,
          late: true,
        }),
      );
      assert.ok(
        (await executeTool("get_leave_summary", {}, employee)).utilization,
      );
      const ownPay = await executeTool("get_payroll_summary", {}, employee);
      assert.equal(ownPay.byMonthDepartment, undefined);
      assert.ok(ownPay.lastOwnPayslip);
    },
  );
  await t.test(
    "missing AI configuration fails honestly, logs calls, and normal services remain usable",
    async () => {
        const availability = await alice('/ai/status');
      assert.equal(availability.configured,false);
      assert.equal(availability.code,'AI_NOT_CONFIGURED');
      assert.deepEqual(availability.features,{chat:false,summary:false,smartLeave:false});
    const saved = process.env.AI_API_KEY;
      delete process.env.AI_API_KEY;
      try {
        const unavailable = await alice(
          "/ai/chat",
          "POST",
          { message: "What is my sick leave balance?" },
          503,
        );
        assert.equal(unavailable.code, 'AI_NOT_CONFIGURED');
        assert.equal(
          await M.AiLog.countDocuments({ actor: aliceRecord.user }),
          1,
        );
      } finally {
        if (saved) process.env.AI_API_KEY = saved;
      }
      assert.equal((await anonymous("/health")).database, "connected");
    },
  );
  await t.test(
    "deactivation revokes sessions and logout invalidates JWT",
    async () => {
      await admin(`/users/${bobRecord.user?._id || bobRecord.user}`, "PATCH", { active: false });
      await bob("/auth/me", "GET", undefined, 401);
      await alice("/auth/logout", "POST");
      await alice("/auth/me", "GET", undefined, 401);
    },
  );
});
