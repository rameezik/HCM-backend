const M = require("../models");
const { workingDays, today, attendanceStatus } = require("./rules");
const { settings, range, employeeScope } = require("./context");
async function board(user, query = {}, session) {
  const { start, end } = range(query);
  const { company, holidays } = await settings(session);
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
  const result = [];
  for (const employee of employees) {
    for (const date of workingDays(start, end, company, holidays)) {
      if (
        date < employee.joinDate ||
        (employee.exitDate && date > employee.exitDate) ||
        date > today()
      )
        continue;
      const row = byKey.get(`${employee._id}:${date}`);
      const leave = leaves.find(
        (l) =>
          String(l.employee) === String(employee._id) && l.days.includes(date),
      );
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
