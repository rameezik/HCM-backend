const models = require("../models");
const { settings } = require("./context");
const { workingDays, calculatePay, attendanceStatus } = require("./rules");
async function generate(month, session) {
  const start = `${month}-01`;
  const end = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0)
    .toISOString()
    .slice(0, 10);
  const { company, holidays } = await settings(session);
  const allDays = workingDays(start, end, company, holidays);
  const employees = await models.Employee.find({
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
  for (const employee of employees) {
    const days = allDays.filter(
      (date) =>
        date >= employee.joinDate &&
        (!employee.exitDate || date <= employee.exitDate),
    );
    const attendance = await models.Attendance.find({
      employee: employee._id,
      date: { $gte: start, $lte: end },
    })
      .session(session)
      .lean();
    const leaves = await models.Leave.find({
      employee: employee._id,
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
      const row = attendance.find((record) => record.date === day);
      const leave = leaves.find((leave) => leave.days.includes(day));
      if (row) {
        if (row.status === "half_day") halfDays++;
      } else if (leave) {
        if (leave.unpaid) unpaid++;
      } else absent++;
    }
    slips.push({
      employee: employee._id,
      user: employee.user,
      name: employee.name,
      code: employee.code,
      department: employee.department,
      designation: employee.designation,
      ...calculatePay(
        employee.basic,
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
