const mongoose = require("mongoose");
const M = require("../models");
const ApiError = require("../utils/ApiError");
const { today, workingDays } = require("./rules");
async function transaction(work) {
  return mongoose.connection.transaction(async (session) => work(session));
}
async function audit(session, actor, action, entity, before, after) {
  const clean = (value) =>
    value == null
      ? null
      : JSON.parse(
          JSON.stringify(value, (k, v) =>
            /password|tokenVersion/i.test(k) ? undefined : v,
          ),
        );
  await M.AuditLog.create(
    [
      {
        actor: actor?._id,
        action,
        entity,
        entityId: String(after?._id || before?._id || ""),
        before: clean(before),
        after: clean(after),
      },
    ],
    { session },
  );
}
async function notify(session, recipient, message) {
  await M.Notification.create([{ recipient, message }], { session });
}
const scope = (user) =>
  user.role === "employee" ? { employee: user.employee || null } : {};
const employeeScope = (user) =>
  user.role === "employee" ? { _id: user.employee || null } : {};
function requireEmployee(user) {
  if (!user.employee)
    throw new ApiError(
      422,
      "This login needs a linked employee profile for self-service.",
    );
  return user.employee;
}
async function settings(session) {
  const company = await M.Company.findOne()
    .session(session || null)
    .lean();
  if (!company) throw new ApiError(409, "Complete first-run setup.");
  const holidays = await M.Holiday.find()
    .session(session || null)
    .lean();
  return { company, holidays };
}
function range(query = {}) {
  const end = query.end || today();
  const start = query.start || `${end.slice(0, 7)}-01`;
  workingDays(start, end, { weekend: [] }, []);
  return { start, end };
}
module.exports = {
  transaction,
  audit,
  notify,
  scope,
  employeeScope,
  requireEmployee,
  settings,
  range,
};
