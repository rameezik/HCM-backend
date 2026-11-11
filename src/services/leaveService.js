const models = require("../models");
const { requireEmployee } = require("./context");
const { today } = require("./rules");
async function balances(user, year = today().slice(0, 4), session) {
  const employee = requireEmployee(user);
  const types = await models.LeaveType.find()
    .session(session || null)
    .lean();
  const leaves = await models.Leave.find({
    employee,
    status: { $in: ["approved", "pending"] },
    start: { $lte: `${year}-12-31` },
    end: { $gte: `${year}-01-01` },
  })
    .session(session || null)
    .lean();
  return types.map((leaveType) => {
    const used = leaves
      .filter(
        (leave) =>
          String(leave.type) === String(leaveType._id) &&
          leave.status === "approved",
      )
      .reduce(
        (totalDays, leave) =>
          totalDays + leave.days.filter((date) => date.startsWith(year)).length,
        0,
      );
    const pending = leaves
      .filter(
        (leave) =>
          String(leave.type) === String(leaveType._id) &&
          leave.status === "pending",
      )
      .reduce(
        (totalDays, leave) =>
          totalDays + leave.days.filter((date) => date.startsWith(year)).length,
        0,
      );
    return {
      ...leaveType,
      used,
      pending,
      remaining: leaveType.unpaid
        ? null
        : Math.max(0, leaveType.quota - used - pending),
    };
  });
}
module.exports = { balances };
