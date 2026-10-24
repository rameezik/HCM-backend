const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const M = require("../src/models");
const { analytics } = require("../src/services/attendanceAnalyticsService");

const oid = () => new mongoose.Types.ObjectId();
const now = new Date("2026-10-30T18:00:00.000Z");
const period = { start: "2026-10-26", end: "2026-10-30" };

test("attendance analytics uses real company-scoped MongoDB aggregates", async (t) => {
  const dbName = `hcm_test_analytics_${process.pid}_${Date.now()}`;
  await mongoose.connect(
    process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=hcm",
    { dbName, serverSelectionTimeoutMS: 10000 },
  );
  t.after(async () => {
    assert.match(mongoose.connection.name, /^hcm_test_analytics_/);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await Promise.all(Object.values(M).map((model) => model.init()));
  const companyA = oid(),
    companyB = oid(),
    companyEmpty = oid(),
    companyNight = oid();
  const engineering = oid(),
    support = oid(),
    foreignDepartment = oid(),
    nightDepartment = oid();
  const designation = oid(),
    foreignDesignation = oid(),
    nightDesignation = oid();
  const aliceId = oid(),
    bobId = oid(),
    carolId = oid(),
    futureId = oid(),
    foreignId = oid(),
    nightId = oid();
  const aliceUser = oid(),
    bobUser = oid(),
    carolUser = oid(),
    futureUser = oid(),
    foreignUser = oid(),
    nightUser = oid();
  const admin = { _id: oid(), role: "admin", company: companyA };
  const hr = { _id: oid(), role: "hr", company: companyA };
  const alice = {
    _id: aliceUser,
    employee: aliceId,
    role: "employee",
    company: companyA,
  };
  const fixturePasswordHash = await bcrypt.hash(
    crypto.randomBytes(24).toString("base64url"),
    12,
  );
  const rawUser = (id, employee, company, name) => ({
    _id: id,
    employee,
    company,
    name,
    email: `${id}@example.test`,
    role: "employee",
    active: true,
    passwordHash: fixturePasswordHash,
  });
  await M.Company.collection.insertMany([
    {
      _id: companyA,
      singleton: `analytics-${companyA}`,
      name: "Analytics fixture A",
      timezone: "UTC",
      officeStart: "09:00",
      officeEnd: "17:00",
      maxShiftHours: 20,
      weekend: [0, 6],
    },
    {
      _id: companyB,
      singleton: `analytics-${companyB}`,
      name: "Analytics fixture B",
      timezone: "UTC",
      officeStart: "09:00",
      officeEnd: "17:00",
      maxShiftHours: 20,
      weekend: [0, 6],
    },
    {
      _id: companyEmpty,
      singleton: `analytics-${companyEmpty}`,
      name: "Empty analytics fixture",
      timezone: "UTC",
      weekend: [0, 6],
    },
    {
      _id: companyNight,
      singleton: `analytics-${companyNight}`,
      name: "Night analytics fixture",
      timezone: "Asia/Karachi",
      officeStart: "22:00",
      officeEnd: "06:00",
      maxShiftHours: 12,
      weekend: [],
    },
  ]);
  await M.Department.collection.insertMany([
    { _id: engineering, company: companyA, name: "Engineering fixture A" },
    { _id: support, company: companyA, name: "Support fixture A" },
    {
      _id: foreignDepartment,
      company: companyB,
      name: "Foreign department fixture",
    },
    {
      _id: nightDepartment,
      company: companyNight,
      name: "Night fixture department",
    },
  ]);
  await M.Designation.collection.insertMany([
    { _id: designation, company: companyA, name: "Engineer fixture A" },
    { _id: foreignDesignation, company: companyB, name: "Engineer fixture B" },
    {
      _id: nightDesignation,
      company: companyNight,
      name: "Night fixture designation",
    },
  ]);
  await M.User.collection.insertMany([
    rawUser(aliceUser, aliceId, companyA, "Alice fixture"),
    rawUser(bobUser, bobId, companyA, "Bob fixture"),
    rawUser(carolUser, carolId, companyA, "Carol fixture"),
    rawUser(futureUser, futureId, companyA, "Future fixture"),
    rawUser(foreignUser, foreignId, companyB, "Foreign fixture"),
    rawUser(nightUser, nightId, companyNight, "Night fixture"),
  ]);
  const employee = (
    id,
    user,
    company,
    department,
    name,
    joinDate,
    extra = {},
  ) => ({
    _id: id,
    user,
    company,
    department,
    designation: company.equals(companyB)
      ? foreignDesignation
      : company.equals(companyNight)
        ? nightDesignation
        : designation,
    name,
    email: `${user}@example.test`,
    code: String(id),
    basic: 100000,
    joinDate,
    status: "active",
    ...extra,
  });
  await M.Employee.collection.insertMany([
    employee(
      aliceId,
      aliceUser,
      companyA,
      engineering,
      "Alice fixture",
      "2026-10-01",
    ),
    employee(
      bobId,
      bobUser,
      companyA,
      engineering,
      "Bob fixture",
      "2026-10-28",
    ),
    employee(
      carolId,
      carolUser,
      companyA,
      support,
      "Carol fixture",
      "2026-10-01",
      { exitDate: "2026-10-28", status: "exited" },
    ),
    employee(
      futureId,
      futureUser,
      companyA,
      engineering,
      "Future fixture",
      "2026-11-01",
    ),
    employee(
      foreignId,
      foreignUser,
      companyB,
      foreignDepartment,
      "Foreign fixture",
      "2026-10-01",
    ),
    employee(
      nightId,
      nightUser,
      companyNight,
      nightDepartment,
      "Night fixture",
      "2026-10-24",
    ),
  ]);
  await M.Holiday.collection.insertOne({
    company: companyA,
    date: "2026-10-27",
    name: "Calendar fixture holiday",
  });
  const row = (employee, company, date, status, from, until, late = false) => ({
    employee,
    company,
    date,
    status,
    checkIn: new Date(`${date}T${from}:00.000Z`),
    ...(until ? { checkOut: new Date(`${date}T${until}:00.000Z`) } : {}),
    late,
    hours: 999,
    verificationMethod: "web",
    verification: { method: "web" },
  });
  await M.Attendance.collection.insertMany([
    row(aliceId, companyA, "2026-10-26", "present", "09:00", "17:00"),
    row(aliceId, companyA, "2026-10-28", "late", "09:30", "17:30", true),
    row(aliceId, companyA, "2026-10-29", "half_day", "09:00", "13:00"),
    row(
      aliceId,
      companyA,
      "2026-10-30",
      "missing_checkout",
      "10:00",
      null,
      true,
    ),
    row(bobId, companyA, "2026-10-28", "present", "09:00", "17:00"),
    row(carolId, companyA, "2026-10-26", "present", "09:00", "17:00"),
    row(foreignId, companyB, "2026-10-26", "present", "09:00", "17:00"),
    // A deliberately inconsistent foreign-company reference must never join A's employee.
    row(aliceId, companyB, "2026-10-27", "present", "09:00", "17:00"),
    {
      employee: nightId,
      company: companyNight,
      date: "2026-10-24",
      status: "missing_checkout",
      checkIn: new Date("2026-10-24T17:00:00.000Z"),
      late: false,
      hours: 999,
      verificationMethod: "face",
      verification: { method: "face" },
    },
  ]);
  await M.Leave.collection.insertMany([
    {
      company: companyA,
      employee: bobId,
      type: oid(),
      start: "2026-10-29",
      end: "2026-10-29",
      days: ["2026-10-29"],
      status: "approved",
      unpaid: false,
      reason: "Approved leave fixture",
    },
    {
      company: companyA,
      employee: bobId,
      type: oid(),
      start: "2026-10-30",
      end: "2026-10-30",
      days: ["2026-10-30"],
      status: "pending",
      unpaid: false,
      reason: "Pending must not remove absence",
    },
    {
      company: companyB,
      employee: aliceId,
      type: oid(),
      start: "2026-10-30",
      end: "2026-10-30",
      days: ["2026-10-30"],
      status: "approved",
      unpaid: true,
      reason: "Foreign leave must not join",
    },
  ]);
  await t.test(
    "rates, status bars and working hours derive from actual attendance and employment",
    async () => {
      const report = await analytics(admin, period, { now });
      assert.equal(report.summary.totalEmployees, 2);
      assert.equal(report.summary.expectedDays, 9);
      assert.equal(report.summary.recordedDays, 6);
      assert.equal(report.summary.attended, 6);
      assert.equal(report.summary.present, 4);
      assert.equal(report.summary.late, 2);
      assert.equal(report.summary.absent, 2);
      assert.equal(report.summary.onLeave, 1);
      assert.equal(report.summary.halfDay, 1);
      assert.equal(report.summary.missingCheckout, 1);
      assert.equal(report.summary.workedHours, 44);
      assert.equal(report.summary.attendanceRate, 68.75);
      assert.equal(report.historyTotal, 9);
      assert.equal(report.weekly.length, 1);
      assert.equal(report.weekly[0].weekStart, "2026-10-26");
      assert.equal(
        report.weekly[0].present +
          report.weekly[0].late +
          report.weekly[0].absent +
          report.weekly[0].onLeave,
        9,
      );
      assert.deepEqual(
        report.monthly.map((r) => [r.date, r.attendanceRate]),
        [
          ["2026-10-26", 100],
          ["2026-10-28", 66.67],
          ["2026-10-29", 50],
          ["2026-10-30", 50],
        ],
      );
      assert.equal(
        report.distribution.reduce((sum, item) => sum + item.count, 0),
        9,
      );
      assert.equal(report.today.date, "2026-10-30");
      assert.equal(report.today.totals.totalEmployees, 2);
      assert.equal(report.today.totals.attended, 1);
      assert.equal(report.today.totals.absent, 1);
      assert.equal(report.today.totals.attendanceRate, 50);
      assert.ok(!JSON.stringify(report).includes('"basic"'));
    },
  );
  await t.test(
    "company-scoped department facets and filters cannot join foreign records",
    async () => {
      const report = await analytics(hr, period, { now });
      assert.deepEqual(
        report.departments.map((d) => [d.name, d.attendanceRate]),
        [
          ["Engineering fixture A", 75],
          ["Support fixture A", 50],
        ],
      );
      assert.ok(!JSON.stringify(report).includes("Foreign"));
      assert.ok(
        report.departmentOptions.every((d) => !d._id.equals(foreignDepartment)),
      );
      const department = await analytics(
        hr,
        { ...period, department: String(support) },
        { now },
      );
      assert.equal(department.historyTotal, 2);
      assert.ok(
        department.history.every(
          (r) => String(r.employee.department._id) === String(support),
        ),
      );
      const foreign = await analytics(
        hr,
        { ...period, department: String(foreignDepartment) },
        { now },
      );
      assert.equal(foreign.summary.recordedDays, 0);
      assert.equal(foreign.historyTotal, 0);
    },
  );
  await t.test(
    "headcount end-date snapshot excludes leavers while retaining their final working day",
    async () => {
      const report = await analytics(
        admin,
        { start: "2026-10-26", end: "2026-10-28" },
        { now },
      );
      assert.equal(report.summary.totalEmployees, 2);
      assert.equal(report.historyTotal, 5);
      assert.equal(report.summary.attendanceRate, 80);
      assert.ok(
        report.history.some(
          (row) =>
            String(row.employee._id) === String(carolId) &&
            row.date === "2026-10-28",
        ),
      );
    },
  );
  await t.test(
    "Employee analytics, calendar, options and paging stay inside self scope",
    async () => {
      const report = await analytics(
        alice,
        { ...period, page: 2, limit: 2 },
        { now },
      );
      assert.equal(report.summary.attendanceRate, 87.5);
      assert.equal(report.historyTotal, 4);
      assert.equal(report.history.length, 2);
      assert.equal(report.calendar.length, 4);
      assert.ok(
        report.history.every((r) => String(r.employee._id) === String(aliceId)),
      );
      assert.ok(
        report.calendar.every(
          (r) => String(r.employee._id) === String(aliceId),
        ),
      );
      assert.deepEqual(report.departments, []);
      assert.deepEqual(report.departmentOptions, []);
      assert.deepEqual(report.employees, []);
      assert.equal(report.today.own.status, "missing_checkout");
      assert.equal(report.today.own.hours, 8);
      assert.equal(report.today.own.verificationMethod, "web");
      await assert.rejects(
        () => analytics(alice, { ...period, employee: String(bobId) }, { now }),
        (error) => error.status === 403,
      );
      await assert.rejects(
        () =>
          analytics(
            alice,
            { ...period, department: String(engineering) },
            { now },
          ),
        (error) => error.status === 403,
      );
      const wrongCompany = await analytics(
        { ...alice, company: companyB },
        period,
        { now },
      );
      assert.equal(wrongCompany.historyTotal, 0);
      assert.equal(wrongCompany.summary.totalEmployees, 0);
    },
  );
  await t.test(
    "no records produces real empty arrays and validation rejects invalid reporting ranges",
    async () => {
      const report = await analytics(
        { ...admin, company: companyEmpty },
        period,
        { now },
      );
      assert.equal(report.empty, true);
      assert.equal(report.summary.totalEmployees, 0);
      assert.equal(report.summary.attendanceRate, 0);
      assert.deepEqual(report.history, []);
      assert.deepEqual(report.weekly, []);
      assert.deepEqual(report.monthly, []);
      assert.deepEqual(report.distribution, []);
      await assert.rejects(
        () => analytics({ role: "admin" }, period, { now }),
        (error) => error.status === 403,
      );
      await assert.rejects(() =>
        analytics(admin, { start: "2026-02-30", end: "2026-03-01" }, { now }),
      );
      await assert.rejects(
        () =>
          analytics(admin, { start: "2025-01-01", end: "2026-10-30" }, { now }),
        (error) => error.status === 422,
      );
      await assert.rejects(() =>
        analytics(admin, { ...period, employee: "invalid" }, { now }),
      );
    },
  );
  await t.test(
    "company-local overnight records retain shift date and use real UTC elapsed time",
    async () => {
      const employeeUser = {
        _id: nightUser,
        employee: nightId,
        company: companyNight,
        role: "employee",
      };
      const report = await analytics(
        employeeUser,
        {},
        { now: new Date("2026-10-24T22:00:00.000Z") },
      );
      assert.equal(report.filters.timezone, "Asia/Karachi");
      assert.equal(report.today.calendarDate, "2026-10-25");
      assert.equal(report.today.date, "2026-10-24");
      assert.equal(report.today.own.date, "2026-10-24");
      assert.equal(report.today.own.hours, 5);
      assert.equal(report.today.own.verificationMethod, "face");
      await M.Attendance.collection.updateOne(
        { employee: nightId, company: companyNight, date: "2026-10-24" },
        {
          $set: {
            checkOut: new Date("2026-10-25T01:00:00.000Z"),
            status: "present",
            checkOutVerification: { method: "face" },
          },
        },
      );
      const closed = await analytics(
        employeeUser,
        { start: "2026-10-24", end: "2026-10-24" },
        { now: new Date("2026-10-25T02:00:00.000Z") },
      );
      assert.equal(closed.summary.workedHours, 8);
      assert.equal(closed.history[0].hours, 8);
      assert.equal(closed.history[0].checkOutMethod, "face");
      assert.equal(closed.today.calendarDate, "2026-10-25");
      assert.equal(closed.today.date, "2026-10-25");
    },
  );
  await t.test(
    "daylight-saving transitions preserve actual elapsed shift hours",
    async () => {
      await M.Company.collection.updateOne(
        { _id: companyNight },
        { $set: { timezone: "America/New_York" } },
      );
      await M.Attendance.collection.insertOne({
        employee: nightId,
        company: companyNight,
        date: "2026-10-31",
        status: "late",
        checkIn: new Date("2026-11-01T03:00:00.000Z"),
        checkOut: new Date("2026-11-01T10:00:00.000Z"),
        late: true,
        hours: 999,
        verificationMethod: "web",
        verification: { method: "web" },
      });
      const report = await analytics(
        {
          _id: nightUser,
          employee: nightId,
          company: companyNight,
          role: "employee",
        },
        { start: "2026-10-31", end: "2026-10-31" },
        { now: new Date("2026-11-01T11:00:00.000Z") },
      );
      assert.equal(report.filters.timezone, "America/New_York");
      assert.equal(report.history[0].date, "2026-10-31");
      assert.equal(report.history[0].hours, 7);
      assert.equal(report.summary.workedHours, 7);
      assert.equal(report.summary.attendanceRate, 100);
    },
  );
  await t.test(
    "persisted attendance survives changed calendar policy and no future activity is reported",
    async () => {
      await M.Attendance.collection.insertMany([
        row(aliceId, companyA, "2026-10-27", "present", "09:00", "17:00"),
        row(aliceId, companyA, "2026-11-02", "present", "09:00", "17:00"),
      ]);
      const report = await analytics(
        admin,
        { start: "2026-10-26", end: "2026-11-03" },
        { now },
      );
      assert.equal(report.summary.expectedDays, 10);
      assert.equal(report.summary.recordedDays, 7);
      assert.equal(report.summary.attendanceRate, 72.22);
      assert.ok(
        report.history.some((r) => r.date === "2026-10-27" && r.recorded),
      );
      assert.ok(report.history.every((r) => r.date <= "2026-10-30"));
      assert.equal(report.summary.totalEmployees, 2);
      const stale = await analytics(
        alice,
        { start: "2026-10-30", end: "2026-10-30" },
        { now: new Date("2026-10-31T18:00:00.000Z") },
      );
      assert.equal(stale.history[0].hours, 0);
    },
  );
});
