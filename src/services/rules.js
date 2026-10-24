const ApiError = require("../utils/ApiError");
const { DateTime } = require("luxon");
const isoDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const today = () => new Date().toISOString().slice(0, 10);
function dates(start, end) {
  if (!isoDate(start) || !isoDate(end) || start > end)
    throw new ApiError(422, "Use an ordered pair of valid ISO dates.");
  if ((Date.parse(end) - Date.parse(start)) / 86400000 > 1095)
    throw new ApiError(422, "Choose a range of at most three years.");
  const result = [];
  for (
    let d = new Date(start);
    d <= new Date(end);
    d.setUTCDate(d.getUTCDate() + 1)
  )
    result.push(d.toISOString().slice(0, 10));
  return result;
}
function workingDays(start, end, company, holidays) {
  const holidaySet = new Set(holidays.map((h) => h.date || h));
  return dates(start, end).filter(
    (d) =>
      !company.weekend.includes(new Date(d).getUTCDay()) && !holidaySet.has(d),
  );
}
function attendanceStatus(checkIn, checkOut, rules) {
  const time = DateTime.fromJSDate(new Date(checkIn), {
    zone: rules.timezone || "UTC",
  });
  let day = rules.businessDate || time.toISODate();
  if (
    !rules.businessDate &&
    (rules.officeEnd || "17:00") <= rules.officeStart &&
    time.toFormat("HH:mm") < rules.officeEnd
  )
    day = time.minus({ days: 1 }).toISODate();
  const scheduled = DateTime.fromISO(`${day}T${rules.officeStart}`, {
    zone: rules.timezone || "UTC",
  }).plus({ minutes: rules.graceMinutes });
  if (!time.isValid || !scheduled.isValid)
    throw new ApiError(422, "Invalid attendance time or timezone.");
  const late = time.toMillis() > scheduled.toMillis();
  const hours = checkOut
    ? (new Date(checkOut) - new Date(checkIn)) / 3600000
    : 0;
  if (hours < 0 || hours > (rules.maxShiftHours || 24))
    throw new ApiError(
      422,
      "Check-out must follow check-in within the maximum shift duration.",
    );
  return {
    late,
    hours,
    status: !checkOut
      ? "missing_checkout"
      : hours < rules.halfDayHours
        ? "half_day"
        : late
          ? "late"
          : "present",
  };
}
function monthlyTax(gross) {
  const annual = gross * 12;
  const tax =
    annual <= 600000
      ? 0
      : annual <= 1200000
        ? (annual - 600000) * 0.05
        : annual <= 2400000
          ? 30000 + (annual - 1200000) * 0.15
          : annual <= 3600000
            ? 210000 + (annual - 2400000) * 0.25
            : 510000 + (annual - 3600000) * 0.35;
  return tax / 12;
}
const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function calculatePay(basic, working, eligible, absent, unpaid, halfDays) {
  if (working <= 0) throw new ApiError(422, "This month has no working days.");
  const gross = basic * 1.5;
  const deduction =
    (gross / working) * (working - eligible + absent + unpaid + halfDays * 0.5);
  const payable = Math.max(0, gross - deduction);
  const tax = Math.min(payable, (monthlyTax(gross) * eligible) / working);
  return {
    basic,
    hra: round(basic * 0.4),
    medical: round(basic * 0.1),
    gross: round(gross),
    workingDays: working,
    eligibleDays: eligible,
    absent,
    unpaid,
    halfDays,
    deduction: round(deduction),
    tax: round(tax),
    net: round(payable - tax),
  };
}
module.exports = {
  isoDate,
  today,
  dates,
  workingDays,
  attendanceStatus,
  monthlyTax,
  calculatePay,
  round,
};
