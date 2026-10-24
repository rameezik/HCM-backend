const M = require("../models");
const { workingDays, attendanceStatus } = require("./rules");
const { settings, range, employeeScope } = require("./context");
const { businessDate } = require("./attendanceWriter");
async function board(user, query = {}, session, options = {}) {
  const { company, holidays } = await settings(session);
  // This internal clock is never accepted from an HTTP query. Use the same
  // company-local shift date as check-in and the detailed analytics endpoint.
  const asOf = businessDate(
    options.now ? new Date(options.now) : new Date(),
    company,
  );
  const { start, end } = range({ ...query, end: query.end || asOf });
  const filter = { ...employeeScope(user), joinDate: { $lte: end } };
  if (query.department) filter.department = query.department;
  const employees = await M.Employee.find(filter)
    .populate("department designation")
    .session(session || null)
    .lean();
  const ids = employees.map((e) => e._id);
  const records = await M.Attendance.find({
    employee: { $in: ids },
    date: { $gte: start, $lte: end },
  })
    .session(session || null)
    .lean();
  const leaves = await M.Leave.find({
    employee: { $in: ids },
    status: "approved",
    start: { $lte: end },
    end: { $gte: start },
  })
    .session(session || null)
    .lean();
  const byKey = new Map(records.map((r) => [`${r.employee}:${r.date}`, r]));
  const recordDatesByEmployee = new Map(),
    leavesByEmployee = new Map();
  for (const record of records) {
    const key = String(record.employee);
    if (!recordDatesByEmployee.has(key)) recordDatesByEmployee.set(key, []);
    recordDatesByEmployee.get(key).push(record.date);
  }
  for (const leave of leaves) {
    const key = String(leave.employee);
    if (!leavesByEmployee.has(key)) leavesByEmployee.set(key, []);
    leavesByEmployee.get(key).push(leave);
  }
  const workingDates = workingDays(start, end, company, holidays);
  const result = [];
  for (const employee of employees) {
    const employeeRecordDates =
      recordDatesByEmployee.get(String(employee._id)) || [];
    const employeeLeaves = leavesByEmployee.get(String(employee._id)) || [];
    // A later holiday/weekend policy change must not erase saved history or an
    // already approved leave day. Only synthesized absences use today's policy.
    const dates = [
      ...new Set([
        ...workingDates,
        ...employeeRecordDates,
        ...employeeLeaves.flatMap((l) =>
          l.days.filter((date) => date >= start && date <= end),
        ),
      ]),
    ].sort();
    for (const date of dates) {
      if (
        date < employee.joinDate ||
        (employee.exitDate && date > employee.exitDate) ||
        date > asOf
      )
        continue;
      const row = byKey.get(`${employee._id}:${date}`);
      const leave = employeeLeaves.find((l) => l.days.includes(date));
      result.push({
        ...(row || {}),
        employee: {
          _id: employee._id,
          name: employee.name,
          code: employee.code,
          department: employee.department,
        },
        date,
        status: row?.status || (leave ? "on_leave" : "absent"),
        unpaid: !row && Boolean(leave?.unpaid),
        hours: row?.hours || 0,
        late: Boolean(row?.late),
      });
    }
  }
  return result;
}
module.exports = { board, attendanceStatus };
