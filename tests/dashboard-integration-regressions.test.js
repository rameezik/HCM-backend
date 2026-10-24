const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const M = require("../src/models");
const { withCompany } = require("../src/services/companyContext");
const { board } = require("../src/services/attendanceService");
const { dashboard } = require("../src/services/dashboardService");

test("dashboard and attendance board retain real tenant-scoped records across filters and policy clocks", async (t) => {
  const dbName = `hcm_test_dashboard_regression_${process.pid}_${Date.now()}`;
  await mongoose.connect(
    process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=hcm",
    { dbName, serverSelectionTimeoutMS: 10000 },
  );
  t.after(async () => {
    assert.match(mongoose.connection.name, /^hcm_test_dashboard_regression_/);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await Promise.all(Object.values(M).map((model) => model.init()));
  const company = await M.Company.create({
    singleton: `dashboard-a-${process.pid}`,
    name: "Isolated dashboard fixture A",
    timezone: "UTC",
    weekend: [0, 6],
  });
  const foreign = await M.Company.create({
    singleton: `dashboard-b-${process.pid}`,
    name: "Isolated dashboard fixture B",
  });
  const local = await M.Company.create({
    singleton: `dashboard-local-${process.pid}`,
    name: "Isolated local-date fixture",
    timezone: "Asia/Karachi",
    weekend: [],
  });
  const night = await M.Company.create({
    singleton: `dashboard-night-${process.pid}`,
    name: "Isolated overnight fixture",
    timezone: "Asia/Karachi",
    officeStart: "22:00",
    officeEnd: "06:00",
    weekend: [],
  });
  const engineering = await M.Department.create({
    company: company._id,
    name: "Engineering fixture A",
  });
  const support = await M.Department.create({
    company: company._id,
    name: "Support fixture A",
  });
  const foreignDepartment = await M.Department.create({
    company: foreign._id,
    name: "Confidential foreign department",
  });
  const designation = await M.Designation.create({
    company: company._id,
    name: "Fixture role A",
  });
  const foreignDesignation = await M.Designation.create({
    company: foreign._id,
    name: "Confidential foreign designation",
  });
  async function person(tenant, code, department, role, basic = 100000) {
    return M.Employee.create({
      company: tenant._id,
      user: new mongoose.Types.ObjectId(),
      code,
      name: `Isolated ${code}`,
      email: `${code.toLowerCase()}@example.test`,
      department: department._id,
      designation: role._id,
      joinDate: "2026-10-01",
      basic,
    });
  }
  const alice = await person(company, "DASH-A", engineering, designation);
  const bob = await person(company, "DASH-B", support, designation, 200000);
  await person(
    foreign,
    "DASH-FOREIGN",
    foreignDepartment,
    foreignDesignation,
    900000,
  );
  // A malformed legacy relation must not make an aggregation expose foreign labels.
  await person(company, "DASH-LEGACY", foreignDepartment, foreignDesignation);
  const localDepartment = await M.Department.create({
    company: local._id,
    name: "Local-date fixture department",
  });
  const localDesignation = await M.Designation.create({
    company: local._id,
    name: "Local-date fixture role",
  });
  const localEmployee = await person(
    local,
    "DASH-LOCAL",
    localDepartment,
    localDesignation,
  );
  const nightDepartment = await M.Department.create({
    company: night._id,
    name: "Night fixture department",
  });
  const nightDesignation = await M.Designation.create({
    company: night._id,
    name: "Night fixture role",
  });
  const nightEmployee = await person(
    night,
    "DASH-NIGHT",
    nightDepartment,
    nightDesignation,
  );
  const admin = (tenant) => ({
    _id: new mongoose.Types.ObjectId(),
    role: "admin",
    company: tenant._id,
  });
  const self = (tenant, employee) => ({
    _id: employee.user,
    role: "employee",
    company: tenant._id,
    employee: employee._id,
  });
  const scoped = (tenant, work) => withCompany(tenant._id, work);
  const now = new Date("2026-10-26T12:00:00.000Z");
  await M.Holiday.create({
    company: company._id,
    date: "2026-10-23",
    name: "Later calendar change fixture",
  });
  for (const date of ["2026-10-23", "2026-10-24", "2026-10-27"])
    await M.Attendance.create({
      company: company._id,
      employee: alice._id,
      date,
      checkIn: new Date(`${date}T09:00:00.000Z`),
      checkOut: new Date(`${date}T17:00:00.000Z`),
      hours: 8,
      late: false,
      status: "present",
      verificationMethod: "web",
    });
  const leaveType = await M.LeaveType.create({
    company: company._id,
    name: "Isolated leave fixture",
    quota: 10,
  });
  await M.Leave.create({
    company: company._id,
    employee: bob._id,
    type: leaveType._id,
    start: "2026-10-23",
    end: "2026-10-23",
    days: ["2026-10-23"],
    status: "approved",
    unpaid: false,
  });

  await t.test(
    "department query strings are cast before headcount and salary aggregation",
    async () => {
      const result = await scoped(company, () =>
        dashboard(
          admin(company),
          {
            start: "2026-10-23",
            end: "2026-10-26",
            department: String(engineering._id),
          },
          { now },
        ),
      );
      assert.equal(result.headcount, 1);
      assert.equal(result.averageSalary, 150000);
      assert.equal(result.byDepartment.length, 1);
      assert.equal(result.byDepartment[0].name, engineering.name);
      assert.equal(result.byDepartment[0].count, result.headcount);
      await assert.rejects(
        scoped(company, () =>
          dashboard(
            admin(company),
            { department: "invalid-record-id" },
            { now },
          ),
        ),
        { status: 422 },
      );
    },
  );

  await t.test(
    "saved holiday/weekend attendance stays visible without invented nonworking-day absences",
    async () => {
      const rows = await scoped(company, () =>
        board(
          admin(company),
          { start: "2026-10-23", end: "2026-10-27" },
          undefined,
          { now },
        ),
      );
      const own = rows.filter(
        (row) => String(row.employee._id) === String(alice._id),
      );
      assert.deepEqual(
        own.map((row) => [row.date, row.status]),
        [
          ["2026-10-23", "present"],
          ["2026-10-24", "present"],
          ["2026-10-26", "absent"],
        ],
      );
      const peer = rows.filter(
        (row) => String(row.employee._id) === String(bob._id),
      );
      assert.deepEqual(
        peer.map((row) => [row.date, row.status]),
        [
          ["2026-10-23", "on_leave"],
          ["2026-10-26", "absent"],
        ],
      );
      assert.equal(
        rows.some((row) => row.date === "2026-10-27"),
        false,
      );
      const result = await scoped(company, () =>
        dashboard(
          admin(company),
          {
            start: "2026-10-23",
            end: "2026-10-26",
            department: String(engineering._id),
          },
          { now },
        ),
      );
      assert.equal(
        result.trend.find((row) => row.date === "2026-10-24").present,
        1,
      );
    },
  );

  await t.test(
    "aggregate labels and self-service rows remain in company and employee scope",
    async () => {
      const result = await scoped(company, () =>
        dashboard(
          admin(company),
          { start: "2026-10-23", end: "2026-10-26" },
          { now },
        ),
      );
      assert.equal(
        JSON.stringify(result).includes("Confidential foreign"),
        false,
      );
      const rows = await scoped(company, () =>
        board(
          self(company, alice),
          { start: "2026-10-23", end: "2026-10-26" },
          undefined,
          { now },
        ),
      );
      assert.ok(rows.length > 0);
      assert.equal(
        rows.every((row) => String(row.employee._id) === String(alice._id)),
        true,
      );
    },
  );

  await t.test(
    "local dates ahead of UTC appear on the board and dashboard today",
    async () => {
      const localNow = new Date("2026-10-24T22:30:00.000Z");
      await M.Attendance.create({
        company: local._id,
        employee: localEmployee._id,
        date: "2026-10-25",
        checkIn: new Date("2026-10-24T22:00:00.000Z"),
        hours: 0,
        status: "missing_checkout",
        late: false,
      });
      const rows = await scoped(local, () =>
        board(admin(local), {}, undefined, { now: localNow }),
      );
      assert.equal(
        rows.find((row) => row.date === "2026-10-25").status,
        "missing_checkout",
      );
      const result = await scoped(local, () =>
        dashboard(admin(local), {}, { now: localNow }),
      );
      assert.equal(result.filters.end, "2026-10-25");
      assert.equal(result.presentToday, 1);
    },
  );

  await t.test(
    "overnight dashboards use the starting shift date and correct weekly-hours cutoff",
    async () => {
      const nightNow = new Date("2026-10-25T00:30:00.000Z");
      await M.Attendance.create({
        company: night._id,
        employee: nightEmployee._id,
        date: "2026-10-24",
        checkIn: new Date("2026-10-24T17:00:00.000Z"),
        checkOut: new Date("2026-10-25T00:00:00.000Z"),
        hours: 7,
        status: "present",
        late: false,
      });
      await M.Attendance.create({
        company: night._id,
        employee: nightEmployee._id,
        date: "2026-10-25",
        checkIn: new Date("2026-10-25T17:00:00.000Z"),
        checkOut: new Date("2026-10-26T00:00:00.000Z"),
        hours: 7,
        status: "present",
        late: false,
      });
      const rows = await scoped(night, () =>
        board(
          self(night, nightEmployee),
          { start: "2026-10-24", end: "2026-10-25" },
          undefined,
          { now: nightNow },
        ),
      );
      assert.deepEqual(
        rows.map((row) => row.date),
        ["2026-10-24"],
      );
      const result = await scoped(night, () =>
        dashboard(self(night, nightEmployee), {}, { now: nightNow }),
      );
      assert.equal(result.filters.end, "2026-10-24");
      assert.equal(result.presentToday, 1);
      assert.equal(result.weeklyHours, 7);
      assert.equal(result.headcount, undefined);
    },
  );

  await t.test(
    "lateness percentages retain fractional precision from real attendance counts",
    async () => {
      const days = [
        "2026-10-01",
        "2026-10-02",
        "2026-10-05",
        "2026-10-06",
        "2026-10-07",
        "2026-10-08",
      ];
      for (const [index, date] of days.entries())
        await M.Attendance.create({
          company: company._id,
          employee: alice._id,
          date,
          checkIn: new Date(`${date}T09:00:00.000Z`),
          checkOut: new Date(`${date}T17:00:00.000Z`),
          hours: 8,
          late: index === 0,
          status: index === 0 ? "late" : "present",
        });
      const result = await scoped(company, () =>
        dashboard(
          admin(company),
          {
            start: days[0],
            end: days.at(-1),
            department: String(engineering._id),
          },
          { now },
        ),
      );
      assert.equal(result.lateCount, 1);
      assert.equal(result.latePercent, 16.67);
    },
  );

  await t.test(
    "all workforce groupings share the headcount end-date snapshot without hiding attendance history",
    async () => {
      const former = await person(
        company,
        "DASH-FORMER",
        engineering,
        designation,
        300000,
      );
      const futureLeaver = await person(
        company,
        "DASH-FUTURE-LEAVER",
        engineering,
        designation,
        200000,
      );
      const futureJoiner = await person(
        company,
        "DASH-FUTURE-JOINER",
        engineering,
        designation,
        900000,
      );
      const ending = await person(
        company,
        "DASH-ENDING",
        engineering,
        designation,
        400000,
      );
      await M.Employee.updateOne(
        { _id: former._id },
        { status: "exited", exitDate: "2026-10-20" },
      );
      await M.Employee.updateOne(
        { _id: futureLeaver._id },
        { status: "exited", exitDate: "2026-10-31" },
      );
      await M.Employee.updateOne(
        { _id: futureJoiner._id },
        { joinDate: "2026-10-27" },
      );
      await M.Employee.updateOne(
        { _id: ending._id },
        { exitDate: "2026-10-26" },
      );
      await M.Attendance.create({
        company: company._id,
        employee: former._id,
        date: "2026-10-19",
        checkIn: new Date("2026-10-19T09:00:00.000Z"),
        checkOut: new Date("2026-10-19T17:00:00.000Z"),
        status: "present",
        late: false,
        hours: 8,
      });
      const before = await scoped(company, () =>
        dashboard(
          admin(company),
          {
            start: "2026-10-19",
            end: "2026-10-26",
            department: String(engineering._id),
          },
          { now },
        ),
      );
      assert.equal(before.headcount, 2);
      assert.equal(before.averageSalary, 225000);
      assert.equal(before.byDepartment[0].count, 2);
      assert.equal(before.byDepartment[0].averageSalary, before.averageSalary);
      assert.equal(
        before.byDesignation.reduce((sum, row) => sum + row.count, 0),
        before.headcount,
      );
      assert.equal(
        before.gender.reduce((sum, row) => sum + row.count, 0),
        before.headcount,
      );
      assert.equal(
        before.tenure.reduce((sum, row) => sum + row.count, 0),
        before.headcount,
      );
      const historicalRows = await scoped(company, () =>
        board(
          admin(company),
          {
            start: "2026-10-19",
            end: "2026-10-26",
            department: String(engineering._id),
          },
          undefined,
          { now },
        ),
      );
      assert.equal(
        historicalRows.find(
          (row) =>
            String(row.employee._id) === String(former._id) &&
            row.date === "2026-10-19",
        ).status,
        "present",
      );
      const after = await scoped(company, () =>
        dashboard(
          admin(company),
          {
            start: "2026-10-19",
            end: "2026-11-02",
            department: String(engineering._id),
          },
          { now: new Date("2026-11-02T12:00:00.000Z") },
        ),
      );
      assert.equal(after.headcount, 2);
      assert.equal(after.averageSalary, 750000);
      assert.equal(after.byDepartment[0].count, after.headcount);
      assert.equal(after.byDepartment[0].averageSalary, after.averageSalary);
      assert.equal(
        after.byDesignation.reduce((sum, row) => sum + row.count, 0),
        after.headcount,
      );
      assert.equal(
        after.gender.reduce((sum, row) => sum + row.count, 0),
        after.headcount,
      );
      assert.equal(
        after.tenure.reduce((sum, row) => sum + row.count, 0),
        after.headcount,
      );
    },
  );
});
