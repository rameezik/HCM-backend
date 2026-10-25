const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const M = require("../src/models");
const { withCompany } = require("../src/services/companyContext");
const { dashboard } = require("../src/services/dashboardService");

test("staff company dashboard counters use real current tenant records and stay private from employees", async (t) => {
  const dbName = `hcm_test_company_summary_${process.pid}_${Date.now()}`;
  await mongoose.connect(
    process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=hcm",
    { dbName, serverSelectionTimeoutMS: 10000 },
  );
  t.after(async () => {
    assert.match(mongoose.connection.name, /^hcm_test_company_summary_/);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await Promise.all(Object.values(M).map((model) => model.init()));
  const company = await M.Company.create({
    name: "Isolated summary fixture",
    singleton: `summary-${process.pid}`,
    timezone: "Asia/Karachi",
    weekend: [],
  });
  const foreign = await M.Company.create({
    name: "Isolated foreign summary fixture",
    singleton: `summary-foreign-${process.pid}`,
    weekend: [],
  });
  const department = await M.Department.create({
    company: company._id,
    name: "Summary engineering fixture",
  });
  const departmentTwo = await M.Department.create({
    company: company._id,
    name: "Summary support fixture",
  });
  const foreignDepartment = await M.Department.create({
    company: foreign._id,
    name: "Foreign summary department",
  });
  const designation = await M.Designation.create({
    company: company._id,
    name: "Summary designation fixture",
  });
  const foreignDesignation = await M.Designation.create({
    company: foreign._id,
    name: "Foreign summary designation",
  });
  async function account(tenant, name, role, active = true) {
    return M.User.create({
      company: tenant._id,
      name,
      email: `${name.toLowerCase().replaceAll(" ", "-")}@example.test`,
      passwordHash: "isolated-test-nonlogin-hash",
      role,
      active,
      mustChangePassword: false,
    });
  }
  async function employee(name, dep = department, tenant = company) {
    const user = await account(tenant, name, "employee");
    const person = await M.Employee.create({
      company: tenant._id,
      user: user._id,
      name,
      email: user.email,
      code: name.replaceAll(" ", "-"),
      department: dep._id,
      designation:
        tenant === company ? designation._id : foreignDesignation._id,
      basic: 100000,
      joinDate: "2026-10-01",
    });
    user.employee = person._id;
    await user.save();
    return { user, person };
  }
  const admin = await account(company, "Summary Admin", "admin");
  const hr = await account(company, "Summary HR active", "hr");
  await account(company, "Summary HR disabled", "hr", false);
  const present = await employee("Summary Present");
  await employee("Summary Absent", departmentTwo);
  const onLeave = await employee("Summary Leave", departmentTwo);
  const former = await employee("Summary Former");
  await M.Employee.updateOne(
    { _id: former.person._id },
    { status: "exited", exitDate: "2026-10-20" },
  );
  const future = await employee("Summary Future");
  await M.Employee.updateOne(
    { _id: future.person._id },
    { joinDate: "2026-11-01" },
  );
  const foreignPerson = await employee(
    "Summary Foreign",
    foreignDepartment,
    foreign,
  );
  await account(foreign, "Foreign HR active", "hr");
  const leaveType = await M.LeaveType.create({
    company: company._id,
    name: "Summary leave fixture",
    quota: 10,
  });
  const foreignLeaveType = await M.LeaveType.create({
    company: foreign._id,
    name: "Foreign summary leave fixture",
    quota: 10,
  });
  await M.Leave.create({
    company: company._id,
    employee: onLeave.person._id,
    type: leaveType._id,
    start: "2026-10-25",
    end: "2026-10-25",
    days: ["2026-10-25"],
    status: "approved",
  });
  await M.Leave.create({
    company: company._id,
    employee: present.person._id,
    type: leaveType._id,
    start: "2026-10-27",
    end: "2026-10-27",
    days: ["2026-10-27"],
    status: "pending",
  });
  await M.Leave.create({
    company: foreign._id,
    employee: foreignPerson.person._id,
    type: foreignLeaveType._id,
    start: "2026-10-27",
    end: "2026-10-27",
    days: ["2026-10-27"],
    status: "pending",
  });
  await M.Attendance.create({
    company: company._id,
    employee: present.person._id,
    date: "2026-10-25",
    checkIn: new Date("2026-10-24T22:00:00.000Z"),
    status: "missing_checkout",
    late: true,
    verificationMethod: "web",
    verification: { method: "web" },
  });
  const now = new Date("2026-10-24T22:30:00.000Z");
  const get = (user, filters = {}) =>
    withCompany(user.company, () => dashboard(user, filters, { now }));

  await t.test(
    "Admin sees complete current-company counts despite historical department filters",
    async () => {
      const result = await get(admin, {
        start: "2026-10-01",
        end: "2026-10-10",
        department: String(department._id),
      });
      assert.equal(result.filters.end, "2026-10-10");
      assert.equal(result.companySummary.date, "2026-10-25");
      assert.equal(result.companySummary.totalEmployees, 5);
      assert.equal(result.companySummary.activeEmployees, 3);
      assert.equal(result.companySummary.totalDepartments, 2);
      assert.equal(result.companySummary.totalHrUsers, 2);
      assert.equal(result.companySummary.activeHrUsers, 1);
      assert.equal(result.companySummary.presentEmployees, 1);
      assert.equal(result.companySummary.absentEmployees, 1);
      assert.equal(result.companySummary.onLeaveEmployees, 1);
      assert.equal(result.companySummary.lateEmployees, 1);
      assert.equal(result.companySummary.pendingLeaveRequests, 1);
      assert.equal(result.companySummary.todayAttendance.length, 3);
      assert.equal(
        result.companySummary.todayAttendance.every(
          (row) => row.date === "2026-10-25",
        ),
        true,
      );
      assert.equal(
        JSON.stringify(result.companySummary).includes("Summary Foreign"),
        false,
      );
      const saved = result.companySummary.todayAttendance.find(
        (row) => String(row.employee._id) === String(present.person._id),
      );
      assert.equal(saved.checkIn.toISOString(), "2026-10-24T22:00:00.000Z");
      assert.equal(saved.verificationMethod, "web");
    },
  );
  await t.test("authorized HR sees the same real company summary", async () => {
    const result = await get(hr);
    assert.equal(result.companySummary.totalEmployees, 5);
    assert.equal(result.companySummary.absentEmployees, 1);
    assert.equal(result.companySummary.pendingLeaveRequests, 1);
  });
  await t.test(
    "employee dashboards omit staff counters and peer attendance/salaries",
    async () => {
      const result = await get(present.user);
      assert.equal(result.companySummary, undefined);
      assert.equal(result.headcount, undefined);
      assert.equal(result.averageSalary, undefined);
      assert.equal(result.departmentAttendance, undefined);
      assert.equal(JSON.stringify(result).includes("Summary Absent"), false);
      assert.equal(result.presentToday, 1);
    },
  );
});
