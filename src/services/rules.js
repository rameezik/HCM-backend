const ApiError = require("../utils/ApiError");
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
  const [h, m] = rules.officeStart.split(":").map(Number);
  const time = new Date(checkIn);
  const late =
    time.getUTCHours() * 60 + time.getUTCMinutes() >
    h * 60 + m + rules.graceMinutes;
  const hours = checkOut ? (new Date(checkOut) - time) / 3600000 : 0;
  if (hours < 0 || hours > 24)
    throw new ApiError(422, "Check-out must follow check-in within 24 hours.");
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
