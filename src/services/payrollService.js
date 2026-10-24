const M = require("../models");
const { settings } = require("./context");
const { workingDays, calculatePay, attendanceStatus } = require("./rules");
async function generate(month, session) {
  const start = `${month}-01`;
  const end = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0)
    .toISOString()
    .slice(0, 10);
  const { company, holidays } = await settings(session);
  const allDays = workingDays(start, end, company, holidays);
  const employees = await M.Employee.find({
    joinDate: { $lte: end },
    $or: [
      { exitDate: { $exists: false } },
      { exitDate: null },
      { exitDate: "" },
      { exitDate: { $gte: start } },
    ],
  })
    .session(session)
    .lean();
  const slips = [];
  for (const e of employees) {
    const days = allDays.filter(
      (d) => d >= e.joinDate && (!e.exitDate || d <= e.exitDate),
    );
    const attendance = await M.Attendance.find({
      employee: e._id,
      date: { $gte: start, $lte: end },
    })
      .session(session)
      .lean();
    const leaves = await M.Leave.find({
      employee: e._id,
      status: "approved",
      start: { $lte: end },
      end: { $gte: start },
    })
      .session(session)
      .lean();
    let absent = 0,
      unpaid = 0,
      halfDays = 0;
    for (const day of days) {
      const row = attendance.find((r) => r.date === day);
      const leave = leaves.find((l) => l.days.includes(day));
      if (row) {
        if (row.status === "half_day") halfDays++;
      } else if (leave) {
        if (leave.unpaid) unpaid++;
      } else absent++;
    }
    slips.push({
      employee: e._id,
      user: e.user,
      name: e.name,
      code: e.code,
      department: e.department,
      designation: e.designation,
      ...calculatePay(
        e.basic,
        allDays.length,
        days.length,
        absent,
        unpaid,
        halfDays,
      ),
    });
  }
  return slips;
}
module.exports = { generate };
