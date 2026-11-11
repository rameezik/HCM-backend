const { DateTime } = require("luxon");
const models = require("../models");
const ApiError = require("../utils/ApiError");
const context = require("./context");
const attendanceRules = require("./rules");
function businessDate(now, policy) {
  let local = DateTime.fromJSDate(now, { zone: policy.timezone || "UTC" });
  if (!local.isValid)
    throw new ApiError(422, "The company attendance timezone is invalid.");
  const start = policy.officeStart || "09:00",
    end = policy.officeEnd || "17:00";
  if (end <= start && local.toFormat("HH:mm") < end)
    local = local.minus({ days: 1 });
  return local.toISODate();
}
function geofence(location, policy) {
  if (!Number.isFinite(policy.latitude) || !Number.isFinite(policy.longitude))
    throw new ApiError(
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
    throw new ApiError(
      422,
      "Face attendance needs an accurate office location (100m accuracy or better).",
    );
  const radians = (value) => (value * Math.PI) / 180;
  const latitudeDelta = radians(location.latitude - policy.latitude),
    longitudeDelta = radians(location.longitude - policy.longitude);
  const haversineTerm =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(policy.latitude)) *
      Math.cos(radians(location.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  const distance =
    6371000 *
    2 *
    Math.atan2(Math.sqrt(haversineTerm), Math.sqrt(1 - haversineTerm));
  if (distance > policy.radius)
    throw new ApiError(
      422,
      "You are outside the configured office attendance area. Request an HR correction if needed.",
    );
  return {
    distanceMeters: attendanceRules.round(distance),
    accuracyMeters: location.accuracy,
  };
}
async function writeAttendance(
  user,
  action,
  { session, verification = { method: "web" }, location, kioskDevice } = {},
) {
  if (!session)
    throw new ApiError(500, "Attendance requires an atomic transaction.");
  const pairedAdmin =
    user.role === "admin" &&
    kioskDevice?.state === "paired" &&
    String(kioskDevice.company) === String(user.company) &&
    verification.method === "face";
  if (!["employee", "hr"].includes(user.role) && !pairedAdmin)
    throw new ApiError(
      403,
      "Only employee-linked users may record their own attendance.",
    );
  if (!user.company)
    throw new ApiError(403, "A company-scoped account is required.");
  if (!["check-in", "check-out"].includes(action))
    throw new ApiError(422, "Invalid attendance action.");
  const employee = context.requireEmployee(user),
    now = new Date();
  const employeeProfile = await models.Employee.findOneAndUpdate(
    { _id: employee, company: user.company },
    { $inc: { __v: 1 } },
    { session, returnDocument: "after" },
  );
  if (!employeeProfile)
    throw new ApiError(404, "Employee profile not found in your company.");
  const { company, holidays } = await context.settings(session);
  let day = businessDate(now, company);
  const openAttendance = await models.Attendance.findOne({
    employee,
    company: user.company,
    checkOut: null,
  })
    .sort({ checkIn: -1 })
    .session(session);
  const attendanceRecord =
    action === "check-out" && openAttendance
      ? openAttendance
      : await models.Attendance.findOne({
          employee,
          company: user.company,
          date: day,
        }).session(session);
  if (action === "check-out" && openAttendance) day = openAttendance.date;
  if (
    await models.Payroll.exists({
      company: user.company,
      month: day.slice(0, 7),
      status: "finalized",
    }).session(session)
  )
    throw new ApiError(409, "Payroll for this month is finalized.");
  if (
    employeeProfile.joinDate > day ||
    (employeeProfile.exitDate && employeeProfile.exitDate < day)
  )
    throw new ApiError(
      422,
      "Your employment is not active on this shift date.",
    );
  const method = verification.method === "face" ? "face" : "web";
  const office = method === "face" ? geofence(location, company) : undefined;
  const metadata = {
    ...verification,
    method,
    ...(office ? { office } : {}),
    recordedAt: now,
  };
  if (action === "check-in") {
    if (attendanceRecord)
      throw new ApiError(409, "Already checked in for this shift date.");
    if (openAttendance)
      throw new ApiError(
        409,
        "An earlier shift has no checkout. Ask HR to correct it before checking in again.",
      );
    if (!attendanceRules.workingDays(day, day, company, holidays).length)
      throw new ApiError(422, "This shift date is not a working day.");
    if (
      await models.Leave.exists({
        company: user.company,
        employee,
        status: "approved",
        days: day,
      }).session(session)
    )
      throw new ApiError(422, "Cancel approved leave before checking in.");
    const rules = { ...company, businessDate: day };
    const [after] = await models.Attendance.create(
      [
        {
          company: user.company,
          employee,
          date: day,
          checkIn: now,
          rules,
          verificationMethod: method,
          verification: metadata,
          ...attendanceRules.attendanceStatus(now, null, rules),
        },
      ],
      { session },
    );
    await context.audit(session, user, "check_in", "Attendance", null, after);
    return after;
  }
  if (!attendanceRecord) throw new ApiError(422, "Check in first.");
  if (attendanceRecord.checkOut)
    throw new ApiError(409, "Already checked out for this shift.");
  const maximumShiftHours = attendanceRecord.rules?.maxShiftHours || 20;
  if ((now - attendanceRecord.checkIn) / 3600000 > maximumShiftHours)
    throw new ApiError(
      422,
      "This shift exceeds the allowed duration. Request an HR correction.",
    );
  const before = attendanceRecord.toObject();
  attendanceRecord.checkOut = now;
  attendanceRecord.checkOutVerification = metadata;
  Object.assign(
    attendanceRecord,
    attendanceRules.attendanceStatus(
      attendanceRecord.checkIn,
      now,
      attendanceRecord.rules,
    ),
  );
  await attendanceRecord.save({ session });
  await context.audit(
    session,
    user,
    "check_out",
    "Attendance",
    before,
    attendanceRecord,
  );
  return attendanceRecord;
}
module.exports = { writeAttendance, businessDate, geofence };
