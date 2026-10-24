const M = require("../models");
const mongoose = require("mongoose");
const ApiError = require("../utils/ApiError");
const { board } = require("./attendanceService");
const { businessDate } = require("./attendanceWriter");
const { balances } = require("./leaveService");
const { employeeScope, range, settings } = require("./context");
const { round } = require("./rules");
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
  const selected = await M.Employee.find(filter).select("_id").lean();
  const ids = selected.map((e) => e._id);
  const records = await board(
    user,
    {
      start,
      end,
      department: query.department,
    },
    undefined,
    { now },
  );
  const count = (status) => records.filter((r) => r.status === status).length;
  const onLeave = count("on_leave"),
    absent = count("absent"),
    late = records.filter((r) => r.late).length;
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
  const [headcount] = await M.Employee.aggregate([
    {
      $match: snapshotFilter,
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        averageGross: { $avg: { $multiply: ["$basic", 1.5] } },
      },
    },
  ]);
  const byDepartment = await M.Employee.aggregate([
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
  const byDesignation = await M.Employee.aggregate([
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
  const gender = await M.Employee.aggregate([
    { $match: snapshotFilter },
    { $group: { _id: "$gender", count: { $sum: 1 } } },
  ]);
  const tenure = await M.Employee.aggregate([
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
  const payroll = await M.Payroll.aggregate([
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
  const approvedLeaves = await M.Leave.find({
    employee: { $in: ids },
    status: "approved",
    start: { $lte: end },
    end: { $gte: start },
  })
    .populate("type")
    .lean();
  const leaveMap = new Map();
  for (const l of approvedLeaves) {
    const name = l.type?.name || "Unknown type";
    const employee = await M.Employee.findById(l.employee)
      .populate("department", "name")
      .lean();
    const department = employee?.department?.name || "Unassigned";
    const key = `${name}:${department}`;
    const entry = leaveMap.get(key) || {
      name,
      department,
      approvedDays: 0,
      quota: l.type?.unpaid ? null : l.type?.quota || 0,
    };
    entry.approvedDays += l.days.filter((d) => d >= start && d <= end).length;
    leaveMap.set(key, entry);
  }
  const departmentCounts = new Map(byDepartment.map((d) => [d.name, d.count]));
  const leaveUtilization = [...leaveMap.values()].map((l) => ({
    ...l,
    utilization:
      l.quota && departmentCounts.get(l.department)
        ? round(
            (l.approvedDays / (l.quota * departmentCounts.get(l.department))) *
              100,
          )
        : null,
  }));
  const lateMap = new Map(),
    trendMap = new Map(),
    departmentMap = new Map();
  for (const r of records) {
    if (r.late) {
      const old = lateMap.get(String(r.employee._id)) || {
        name: r.employee.name,
        code: r.employee.code,
        count: 0,
      };
      old.count++;
      lateMap.set(String(r.employee._id), old);
    }
    const trend = trendMap.get(r.date) || {
      date: r.date,
      present: 0,
      late: 0,
      absent: 0,
      onLeave: 0,
    };
    if (["present", "late", "missing_checkout", "half_day"].includes(r.status))
      trend.present += r.status === "half_day" ? 0.5 : 1;
    if (r.late) trend.late++;
    if (r.status === "absent") trend.absent++;
    if (r.status === "on_leave") trend.onLeave++;
    trendMap.set(r.date, trend);
    const name = r.employee.department?.name || "Unassigned";
    const dep = departmentMap.get(name) || {
      name,
      expectedDays: 0,
      absent: 0,
      late: 0,
      presentOrLate: 0,
      leaveDays: 0,
    };
    dep.expectedDays++;
    if (r.status === "absent") dep.absent++;
    if (r.late) dep.late++;
    if (["present", "late"].includes(r.status)) dep.presentOrLate++;
    if (r.status === "on_leave") dep.leaveDays++;
    departmentMap.set(name, dep);
  }
  const startCount = await M.Employee.countDocuments({
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
  const exits = await M.Employee.countDocuments({
    ...filter,
    exitDate: { $gte: start, $lte: end },
  });
  const yearStart = `${end.slice(0, 4)}-01-01`;
  const ytdFilter = {
    ...employeeScope(user),
    ...departmentFilter,
  };
  const ytdStartCount = await M.Employee.countDocuments({
    ...ytdFilter,
    joinDate: { $lte: yearStart },
    $or: [
      { exitDate: { $exists: false } },
      { exitDate: null },
      { exitDate: "" },
      { exitDate: { $gte: yearStart } },
    ],
  });
  const ytdExits = await M.Employee.countDocuments({
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
      : (await M.Leave.countDocuments({
          employee: { $in: ids },
          status: "pending",
        })) +
        (await M.Correction.countDocuments({
          employee: { $in: ids },
          status: "pending",
        }));
  const todayRows = await board(
    user,
    {
      start: asOf,
      end: asOf,
      department: query.department,
    },
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
    presentToday: todayRows.filter((r) =>
      ["present", "late", "half_day", "missing_checkout"].includes(r.status),
    ).length,
    onLeaveToday: todayRows.filter((r) => r.status === "on_leave").length,
    lateToday: todayRows.filter((r) => r.late).length,
    payrollGross: round(payroll.reduce((n, p) => n + p.gross, 0)),
    payrollNet: round(payroll.reduce((n, p) => n + p.net, 0)),
    payroll,
    byDepartment,
    byDesignation,
    gender,
    tenure,
    leaveUtilization,
    trend: [...trendMap.values()],
    departmentAttendance: [...departmentMap.values()].map((d) => ({
      ...d,
      absenteeism: round((d.absent / d.expectedDays) * 100),
      latePercent: d.presentOrLate
        ? round((d.late / d.presentOrLate) * 100)
        : 0,
    })),
    topLateComers: [...lateMap.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
  if (user.employee) {
    result.leaveBalance = await balances(user);
    const weekStart = new Date(`${asOf}T00:00:00.000Z`);
    weekStart.setUTCDate(
      weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7),
    );
    const hours = await M.Attendance.aggregate([
      {
        $match: {
          employee: user.employee,
          date: { $gte: weekStart.toISOString().slice(0, 10), $lte: asOf },
        },
      },
      { $group: { _id: null, hours: { $sum: "$hours" } } },
    ]);
    result.weeklyHours = round(hours[0]?.hours || 0);
    const last = await M.Payroll.findOne({
      status: "finalized",
      "slips.employee": user.employee,
    })
      .sort({ month: -1 })
      .lean();
    result.lastPayslip = last
      ? {
          month: last.month,
          net: last.slips.find(
            (s) => String(s.employee) === String(user.employee),
          )?.net,
        }
      : null;
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
