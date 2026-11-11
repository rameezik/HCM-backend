const models = require("../models");
const ApiError = require("../utils/ApiError");
const { requireRecord } = require("../utils/http");

const accountProjection =
  "name email role active mustChangePassword passwordChangeEnforced";
async function lockAdminManagement(actor, session) {
  if (actor.role !== "admin") return;
  // Serialize privileged account changes per company, then recheck the actor.
  // This prevents two simultaneous administrators from disabling each other.
  requireRecord(
    await models.Company.findOneAndUpdate(
      { _id: actor.company },
      { $inc: { __v: 1 } },
      { session, returnDocument: "after" },
    ),
  );
  const current = await models.User.findOne({
    _id: actor._id,
    role: "admin",
    active: true,
    tokenVersion: actor.tokenVersion,
  }).session(session);
  if (!current)
    throw new ApiError(
      401,
      "Your administrator session changed. Sign in again.",
    );
}
async function guardAccountChange(actor, target, changes, session) {
  if (String(actor._id) === String(target._id)) {
    if (changes.active === false || (changes.role && changes.role !== "admin"))
      throw new ApiError(
        403,
        "You cannot deactivate or demote your own administrator account.",
      );
    if (changes.password)
      throw new ApiError(
        403,
        "Use your own password change flow for your account.",
      );
  }
  if (
    target.role === "admin" &&
    target.active &&
    (changes.active === false || (changes.role && changes.role !== "admin")) &&
    (await models.User.countDocuments({ role: "admin", active: true }).session(
      session,
    )) <= 1
  )
    throw new ApiError(409, "The company must retain an active administrator.");
  if (changes.role === "employee" && !target.employee)
    throw new ApiError(
      422,
      "An employee login requires a linked employee profile. Create it through Employees.",
    );
  if (
    changes.active === true &&
    target.employee &&
    (await models.Employee.exists({
      _id: target.employee,
      status: "exited",
    }).session(session))
  )
    throw new ApiError(
      422,
      "Update the employee's exited employment status before activating the account.",
    );
}
async function employeeView(employeeId) {
  return models.Employee.findById(employeeId)
    .populate("department designation")
    .populate("user", accountProjection);
}

module.exports = {
  accountProjection,
  lockAdminManagement,
  guardAccountChange,
  employeeView,
};
