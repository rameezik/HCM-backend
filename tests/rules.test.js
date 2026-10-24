const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  isoDate,
  dates,
  workingDays,
  attendanceStatus,
  monthlyTax,
  calculatePay,
} = require("../src/services/rules");
const policy = {
  weekend: [0, 6],
  officeStart: "09:00",
  graceMinutes: 15,
  halfDayHours: 5,
};
test("ISO date validation rejects overflow and ranges are inclusive", () => {
  assert.equal(isoDate("2026-02-30"), false);
  assert.equal(isoDate("2028-02-29"), true);
  assert.deepEqual(dates("2026-10-01", "2026-10-02"), [
    "2026-10-01",
    "2026-10-02",
  ]);
  assert.throws(() => dates("2026-10-02", "2026-10-01"));
});
test("leave counts weekdays and excludes holidays", () => {
  assert.deepEqual(
    workingDays("2026-10-23", "2026-10-27", policy, ["2026-10-26"]),
    ["2026-10-23", "2026-10-27"],
  );
});
test("attendance grace threshold, half-day and missing checkout", () => {
  assert.equal(
    attendanceStatus("2026-10-26T09:15:00Z", "2026-10-26T17:00:00Z", policy)
      .status,
    "present",
  );
  assert.equal(
    attendanceStatus("2026-10-26T09:16:00Z", "2026-10-26T17:00:00Z", policy)
      .status,
    "late",
  );
  assert.equal(
    attendanceStatus("2026-10-26T09:00:00Z", "2026-10-26T13:59:00Z", policy)
      .status,
    "half_day",
  );
  assert.equal(
    attendanceStatus("2026-10-26T09:00:00Z", null, policy).status,
    "missing_checkout",
  );
  assert.throws(() =>
    attendanceStatus("2026-10-26T10:00:00Z", "2026-10-26T09:00:00Z", policy),
  );
});
for (const [annual, expected] of [
  [0, 0],
  [600000, 0],
  [1200000, 30000],
  [2400000, 210000],
  [3600000, 510000],
  [4800000, 930000],
])
  test(`annual tax slab ${annual}`, () =>
    assert.equal(monthlyTax(annual / 12) * 12, expected));
test("payroll proration, absence, unpaid and half-days without duplicate deduction", () => {
  const pay = calculatePay(100000, 20, 10, 1, 1, 2);
  assert.equal(pay.gross, 150000);
  assert.equal(pay.hra, 40000);
  assert.equal(pay.medical, 10000);
  assert.equal(pay.deduction, 97500);
  assert.equal(pay.tax, 5000);
  assert.equal(pay.net, 47500);
  assert.equal(calculatePay(100000, 20, 20, 20, 0, 0).net, 0);
});
