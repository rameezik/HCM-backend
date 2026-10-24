const M = require("../models");
const { requireEmployee } = require("./context");
const { today } = require("./rules");
async function balances(user, year = today().slice(0, 4), session) {
  const employee = requireEmployee(user);
  const types = await M.LeaveType.find()
    .session(session || null)
    .lean();
  const leaves = await M.Leave.find({
    employee,
    status: { $in: ["approved", "pending"] },
    start: { $lte: `${year}-12-31` },
    end: { $gte: `${year}-01-01` },
  })
    .session(session || null)
    .lean();
  return types.map((t) => {
    const used = leaves
      .filter(
        (l) => String(l.type) === String(t._id) && l.status === "approved",
      )
      .reduce((n, l) => n + l.days.filter((d) => d.startsWith(year)).length, 0);
    const pending = leaves
      .filter((l) => String(l.type) === String(t._id) && l.status === "pending")
      .reduce((n, l) => n + l.days.filter((d) => d.startsWith(year)).length, 0);
    return {
      ...t,
      used,
      pending,
      remaining: t.unpaid ? null : Math.max(0, t.quota - used - pending),
    };
  });
}
module.exports = { balances };
