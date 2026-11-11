const models = require("../models");
const mongoose = require("mongoose");
const ApiError = require("../utils/ApiError");
const { board } = require("./attendanceService");
const { businessDate } = require("./attendanceWriter");
const { balances } = require("./leaveService");
const { employeeScope, range, settings } = require("./context");
const { round } = require("./rules");
async function summarizeLeaveUsage(approvedLeaves, byDepartment, start, end) {
  const leaveMap = new Map();
  for (const leave of approvedLeaves) {
    const name = leave.type?.name || "Unknown type";
    const employee = await models.Employee.findById(leave.employee)
      .populate("department", "name")
      .lean();
    const department = employee?.department?.name || "Unassigned";
    const key = `${name}:${department}`;
    const entry = leaveMap.get(key) || {
      name,
      department,
      approvedDays: 0,
      quota: leave.type?.unpaid ? null : leave.type?.quota || 0,
    };
    entry.approvedDays += leave.days.filter(
      (date) => date >= start && date <= end,
    ).length;
    leaveMap.set(key, entry);
  }
  const departmentCounts = new Map(
    byDepartment.map((department) => [department.name, department.count]),
  );
  const leaveUtilization = [...leaveMap.values()].map((leave) => ({
    ...leave,
    utilization:
      leave.quota && departmentCounts.get(leave.department)
        ? round(
            (leave.approvedDays /
              (leave.quota * departmentCounts.get(leave.department))) *
              100,
          )
        : null,
  }));
  return leaveUtilization;
}
function summarizeAttendanceRows(records) {
  const lateMap = new Map(),
    trendMap = new Map(),
    departmentMap = new Map();
  for (const record of records) {
    if (record.late) {
      const old = lateMap.get(String(record.employee._id)) || {
        name: record.employee.name,
        code: record.employee.code,
        count: 0,
      };
      old.count++;
      lateMap.set(String(record.employee._id), old);
    }
    const trend = trendMap.get(record.date) || {
      date: record.date,
      present: 0,
      late: 0,
      absent: 0,
      onLeave: 0,
    };
    if (
      ["present", "late", "missing_checkout", "half_day"].includes(
        record.status,
      )
    )
      trend.present += record.status === "half_day" ? 0.5 : 1;
    if (record.late) trend.late++;
    if (record.status === "absent") trend.absent++;
    if (record.status === "on_leave") trend.onLeave++;
    trendMap.set(record.date, trend);
    const name = record.employee.department?.name || "Unassigned";
    const dep = departmentMap.get(name) || {
      name,
      expectedDays: 0,
      absent: 0,
      late: 0,
      presentOrLate: 0,
      leaveDays: 0,
    };
    dep.expectedDays++;
    if (record.status === "absent") dep.absent++;
    if (record.late) dep.late++;
    if (["present", "late"].includes(record.status)) dep.presentOrLate++;
    if (record.status === "on_leave") dep.leaveDays++;
    departmentMap.set(name, dep);
  }
  return { lateMap, trendMap, departmentMap };
}
async function loadCompanySummary(user, company, asOf, now, query, todayRows) {
  // These operational counters describe the current company, independently
  // of the historical reporting range/department filters above.
  const companyFilter = { company: company._id };
  const [
    totalEmployees,
    activeEmployees,
    totalDepartments,
    totalHrUsers,
    activeHrUsers,
    pendingLeaveRequests,
    currentRows,
  ] = await Promise.all([
    models.Employee.countDocuments(companyFilter),
    models.Employee.countDocuments({
      ...companyFilter,
      joinDate: { $lte: asOf },
      $or: [
        { exitDate: { $exists: false } },
        { exitDate: "" },
        { exitDate: null },
        { exitDate: { $gt: asOf } },
      ],
    }),
    models.Department.countDocuments(companyFilter),
    models.User.countDocuments({ ...companyFilter, role: "hr" }),
    models.User.countDocuments({ ...companyFilter, role: "hr", active: true }),
    models.Leave.countDocuments({ ...companyFilter, status: "pending" }),
    query.department
      ? board(user, { start: asOf, end: asOf }, undefined, { now })
      : Promise.resolve(todayRows),
  ]);
  return {
    date: asOf,
    totalEmployees,
    activeEmployees,
    totalDepartments,
    totalHrUsers,
    activeHrUsers,
    presentEmployees: currentRows.filter((row) =>
      ["present", "late", "half_day", "missing_checkout"].includes(row.status),
    ).length,
    absentEmployees: currentRows.filter((row) => row.status === "absent")
      .length,
    onLeaveEmployees: currentRows.filter((row) => row.status === "on_leave")
      .length,
    lateEmployees: currentRows.filter((row) => row.late).length,
    pendingLeaveRequests,
    todayAttendance: currentRows.map((row) => ({
      employee: row.employee,
      date: row.date,
      status: row.status,
      checkIn: row.checkIn || null,
      checkOut: row.checkOut || null,
      hours: row.hours,
      late: row.late,
      verificationMethod: row.verificationMethod || null,
    })),
  };
}
async function loadEmployeeSummary(user, asOf) {
  const leaveBalance = await balances(user);
  const weekStart = new Date(`${asOf}T00:00:00.000Z`);
  weekStart.setUTCDate(
    weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7),
  );
  const hours = await models.Attendance.aggregate([
    {
      $match: {
        employee: user.employee,
        date: { $gte: weekStart.toISOString().slice(0, 10), $lte: asOf },
      },
    },
    { $group: { _id: null, hours: { $sum: "$hours" } } },
  ]);
  const weeklyHours = round(hours[0]?.hours || 0);
  const last = await models.Payroll.findOne({
    status: "finalized",
    "slips.employee": user.employee,
  })
    .sort({ month: -1 })
    .lean();
  const lastPayslip = last
    ? {
        month: last.month,
        net: last.slips.find(
          (slip) => String(slip.employee) === String(user.employee),
        )?.net,
      }
    : null;
  return { leaveBalance, weeklyHours, lastPayslip };
}
async function dashboard(user, query = {}, options = {}) {
  const { company } = await settings();
  const now = options.now ? new Date(options.now) : new Date();
  const asOf = businessDate(now, company);
  const { start, end } = range({ ...query, end: query.end || asOf });
  const filter = { ...employeeScope(user), joinDate: { $lte: end } };
  const departmentFilter = {};
  if (query.department) {
    if (!mongoose.isValidObjectId(query.department))
      throw new ApiError(422, "Department must be a valid record ID.");
    // Mongoose casts find() filters, but never casts aggregation $match values.
    departmentFilter.department = new mongoose.Types.ObjectId(
      String(query.department),
    );
    Object.assign(filter, departmentFilter);
  }
  const selected = await models.Employee.find(filter).select("_id").lean();
  const ids = selected.map((employee) => employee._id);
  const records = await board(
    user,
    { start, end, department: query.department },
    undefined,
    { now },
  );
  const count = (status) =>
    records.filter((record) => record.status === status).length;
  const onLeave = count("on_leave"),
    absent = count("absent"),
    late = records.filter((record) => record.late).length;
  const denominator = records.length - onLeave;
  const weighted =
    count("present") +
    count("late") +
    count("missing_checkout") +
    0.5 * count("half_day");
  const snapshotFilter = {
    ...filter,
    $or: [
      { exitDate: { $exists: false } },
      { exitDate: "" },
      { exitDate: null },
      { exitDate: { $gt: end } },
    ],
  };
  const [headcount] = await models.Employee.aggregate([
    { $match: snapshotFilter },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        averageGross: { $avg: { $multiply: ["$basic", 1.5] } },
      },
    },
  ]);
  const byDepartment = await models.Employee.aggregate([
    { $match: snapshotFilter },
    {
      $group: {
        _id: "$department",
        count: { $sum: 1 },
        averageSalary: { $avg: { $multiply: ["$basic", 1.5] } },
      },
    },
    {
      $lookup: {
        from: "departments",
        localField: "_id",
        foreignField: "_id",
        pipeline: [{ $match: { company: company._id } }],
        as: "department",
      },
    },
    {
      $project: {
        count: 1,
        averageSalary: 1,
        name: { $arrayElemAt: ["$department.name", 0] },
      },
    },
  ]);
  const byDesignation = await models.Employee.aggregate([
    { $match: snapshotFilter },
    {
      $group: {
        _id: "$designation",
        averageSalary: { $avg: { $multiply: ["$basic", 1.5] } },
        count: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: "designations",
        localField: "_id",
        foreignField: "_id",
        pipeline: [{ $match: { company: company._id } }],
        as: "designation",
      },
    },
    {
      $project: {
        count: 1,
        averageSalary: 1,
        name: { $arrayElemAt: ["$designation.name", 0] },
      },
    },
  ]);
  const gender = await models.Employee.aggregate([
    { $match: snapshotFilter },
    { $group: { _id: "$gender", count: { $sum: 1 } } },
  ]);
  const tenure = await models.Employee.aggregate([
    { $match: snapshotFilter },
    {
      $project: {
        years: {
          $divide: [
            {
              $subtract: [
                new Date(end),
                { $dateFromString: { dateString: "$joinDate" } },
              ],
            },
            31557600000,
          ],
        },
      },
    },
    {
      $bucket: {
        groupBy: "$years",
        boundaries: [0, 1, 3, 5, 10, 1000],
        default: "other",
        output: { count: { $sum: 1 } },
      },
    },
  ]);
  const payroll = await models.Payroll.aggregate([
    {
      $match: {
        month: { $gte: start.slice(0, 7), $lte: end.slice(0, 7) },
        status: "finalized",
      },
    },
    { $unwind: "$slips" },
    { $match: { "slips.employee": { $in: ids } } },
    {
      $group: {
        _id: { month: "$month", department: "$slips.department" },
        gross: { $sum: "$slips.gross" },
        net: { $sum: "$slips.net" },
      },
    },
  ]);
  const approvedLeaves = await models.Leave.find({
    employee: { $in: ids },
    status: "approved",
    start: { $lte: end },
    end: { $gte: start },
  })
    .populate("type")
    .lean();
  const leaveUtilization = await summarizeLeaveUsage(
    approvedLeaves,
    byDepartment,
    start,
    end,
  );
  const { lateMap, trendMap, departmentMap } = summarizeAttendanceRows(records);
  const startCount = await models.Employee.countDocuments({
    ...employeeScope(user),
    ...departmentFilter,
    joinDate: { $lte: start },
    $or: [
      { exitDate: { $exists: false } },
      { exitDate: null },
      { exitDate: "" },
      { exitDate: { $gte: start } },
    ],
  });
  const exits = await models.Employee.countDocuments({
    ...filter,
    exitDate: { $gte: start, $lte: end },
  });
  const yearStart = `${end.slice(0, 4)}-01-01`;
  const ytdFilter = { ...employeeScope(user), ...departmentFilter };
  const ytdStartCount = await models.Employee.countDocuments({
    ...ytdFilter,
    joinDate: { $lte: yearStart },
    $or: [
      { exitDate: { $exists: false } },
      { exitDate: null },
      { exitDate: "" },
      { exitDate: { $gte: yearStart } },
    ],
  });
  const ytdExits = await models.Employee.countDocuments({
    ...ytdFilter,
    exitDate: { $gte: yearStart, $lte: end },
  });
  const attritionYTD =
    ytdStartCount + (headcount?.total || 0)
      ? round(
          (ytdExits / ((ytdStartCount + (headcount?.total || 0)) / 2)) * 100,
        )
      : 0;
  const pending =
    user.role === "employee"
      ? 0
      : (await models.Leave.countDocuments({
          employee: { $in: ids },
          status: "pending",
        })) +
        (await models.Correction.countDocuments({
          employee: { $in: ids },
          status: "pending",
        }));
  const todayRows = await board(
    user,
    { start: asOf, end: asOf, department: query.department },
    undefined,
    { now },
  );
  const result = {
    filters: { start, end, department: query.department || null },
    attritionYTD,
    headcount: headcount?.total || 0,
    averageSalary: round(headcount?.averageGross || 0),
    attrition:
      startCount + (headcount?.total || 0)
        ? round((exits / ((startCount + (headcount?.total || 0)) / 2)) * 100)
        : 0,
    attendanceRate: denominator ? round((weighted / denominator) * 100) : 0,
    latePercent:
      count("present") + count("late")
        ? round((100 * count("late")) / (count("present") + count("late")))
        : 0,
    absenteeism: records.length ? round((absent / records.length) * 100) : 0,
    absent,
    lateCount: late,
    onLeave,
    pendingApprovals: pending,
    presentToday: todayRows.filter((record) =>
      ["present", "late", "half_day", "missing_checkout"].includes(
        record.status,
      ),
    ).length,
    onLeaveToday: todayRows.filter((record) => record.status === "on_leave")
      .length,
    lateToday: todayRows.filter((record) => record.late).length,
    payrollGross: round(
      payroll.reduce((total, payrollRow) => total + payrollRow.gross, 0),
    ),
    payrollNet: round(
      payroll.reduce((total, payrollRow) => total + payrollRow.net, 0),
    ),
    payroll,
    byDepartment,
    byDesignation,
    gender,
    tenure,
    leaveUtilization,
    trend: [...trendMap.values()],
    departmentAttendance: [...departmentMap.values()].map((department) => ({
      ...department,
      absenteeism: round((department.absent / department.expectedDays) * 100),
      latePercent: department.presentOrLate
        ? round((department.late / department.presentOrLate) * 100)
        : 0,
    })),
    topLateComers: [...lateMap.values()]
      .sort((left, right) => right.count - left.count)
      .slice(0, 5),
  };
  if (["admin", "hr"].includes(user.role)) {
    result.companySummary = await loadCompanySummary(
      user,
      company,
      asOf,
      now,
      query,
      todayRows,
    );
  }
  if (user.employee) {
    Object.assign(result, await loadEmployeeSummary(user, asOf));
  }
  if (user.role === "employee") {
    // Self-service never receives company-wide grouping or other salary data.
    for (const key of [
      "byDepartment",
      "byDesignation",
      "gender",
      "tenure",
      "payroll",
      "averageSalary",
      "attrition",
      "attritionYTD",
      "headcount",
      "departmentAttendance",
      "topLateComers",
    ])
      delete result[key];
  }
  return result;
}
module.exports = { dashboard };
