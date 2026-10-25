const { DateTime } = require("luxon");
const M = require("../models");
const E = require("../utils/ApiError");
const C = require("./context");
const R = require("./rules");
function businessDate(now, policy) {
  let local = DateTime.fromJSDate(now, { zone: policy.timezone || "UTC" });
  if (!local.isValid)
    throw new E(422, "The company attendance timezone is invalid.");
  const start = policy.officeStart || "09:00",
    end = policy.officeEnd || "17:00";
  if (end <= start && local.toFormat("HH:mm") < end)
    local = local.minus({ days: 1 });
  return local.toISODate();
}
function geofence(location, policy) {
  if (!Number.isFinite(policy.latitude) || !Number.isFinite(policy.longitude))
    throw new E(
      409,
      "Admin must configure the office location before face attendance.",
    );
  if (
    !location ||
    !Number.isFinite(location.latitude) ||
    !Number.isFinite(location.longitude) ||
    !Number.isFinite(location.accuracy) ||
    Math.abs(location.latitude) > 90 ||
    Math.abs(location.longitude) > 180 ||
    location.accuracy < 0 ||
    location.accuracy > 100
  )
    throw new E(
      422,
      "Face attendance needs an accurate office location (100m accuracy or better).",
    );
  const radians = (value) => (value * Math.PI) / 180;
  const dlat = radians(location.latitude - policy.latitude),
    dlon = radians(location.longitude - policy.longitude);
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(radians(policy.latitude)) *
      Math.cos(radians(location.latitude)) *
      Math.sin(dlon / 2) ** 2;
  const distance = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  if (distance > policy.radius)
    throw new E(
      422,
      "You are outside the configured office attendance area. Request an HR correction if needed.",
    );
  return {
    distanceMeters: R.round(distance),
    accuracyMeters: location.accuracy,
  };
}
async function writeAttendance(
  user,
  action,
  { session, verification = { method: "web" }, location, kioskDevice } = {},
) {
  if (!session) throw new E(500, "Attendance requires an atomic transaction.");
  const pairedAdmin = user.role === "admin" && kioskDevice?.state === "paired" &&
    String(kioskDevice.company) === String(user.company) && verification.method === "face";
  if (!["employee", "hr"].includes(user.role) && !pairedAdmin)
    throw new E(
      403,
      "Only employee-linked users may record their own attendance.",
    );
  if (!user.company) throw new E(403, "A company-scoped account is required.");
  if (!["check-in", "check-out"].includes(action))
    throw new E(422, "Invalid attendance action.");
  const employee = C.requireEmployee(user),
    now = new Date();
  const person = await M.Employee.findOneAndUpdate(
    { _id: employee, company: user.company },
    { $inc: { __v: 1 } },
    { session, returnDocument: "after" },
  );
  if (!person) throw new E(404, "Employee profile not found in your company.");
  const { company, holidays } = await C.settings(session);
  let day = businessDate(now, company);
  const open = await M.Attendance.findOne({
    employee,
    company: user.company,
    checkOut: null,
  })
    .sort({ checkIn: -1 })
    .session(session);
  const existing =
    action === "check-out" && open
      ? open
      : await M.Attendance.findOne({
          employee,
          company: user.company,
          date: day,
        }).session(session);
  if (action === "check-out" && open) day = open.date;
  if (
    await M.Payroll.exists({
      company: user.company,
      month: day.slice(0, 7),
      status: "finalized",
    }).session(session)
  )
    throw new E(409, "Payroll for this month is finalized.");
  if (person.joinDate > day || (person.exitDate && person.exitDate < day))
    throw new E(422, "Your employment is not active on this shift date.");
  const method = verification.method === "face" ? "face" : "web";
  const office = method === "face" ? geofence(location, company) : undefined;
  const metadata = {
    ...verification,
    method,
    ...(office ? { office } : {}),
    recordedAt: now,
  };
  if (action === "check-in") {
    if (existing) throw new E(409, "Already checked in for this shift date.");
    if (open)
      throw new E(
        409,
        "An earlier shift has no checkout. Ask HR to correct it before checking in again.",
      );
    if (!R.workingDays(day, day, company, holidays).length)
      throw new E(422, "This shift date is not a working day.");
    if (
      await M.Leave.exists({
        company: user.company,
        employee,
        status: "approved",
        days: day,
      }).session(session)
    )
      throw new E(422, "Cancel approved leave before checking in.");
    const rules = { ...company, businessDate: day };
    const [after] = await M.Attendance.create(
      [
        {
          company: user.company,
          employee,
          date: day,
          checkIn: now,
          rules,
          verificationMethod: method,
          verification: metadata,
          ...R.attendanceStatus(now, null, rules),
        },
      ],
      { session },
    );
    await C.audit(session, user, "check_in", "Attendance", null, after);
    return after;
  }
  if (!existing) throw new E(422, "Check in first.");
  if (existing.checkOut)
    throw new E(409, "Already checked out for this shift.");
  const max = existing.rules?.maxShiftHours || 20;
  if ((now - existing.checkIn) / 3600000 > max)
    throw new E(
      422,
      "This shift exceeds the allowed duration. Request an HR correction.",
    );
  const before = existing.toObject();
  existing.checkOut = now;
  existing.checkOutVerification = metadata;
  Object.assign(
    existing,
    R.attendanceStatus(existing.checkIn, now, existing.rules),
  );
  await existing.save({ session });
  await C.audit(session, user, "check_out", "Attendance", before, existing);
  return existing;
}
module.exports = { writeAttendance, businessDate, geofence };
