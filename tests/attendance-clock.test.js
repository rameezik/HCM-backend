const { test } = require("node:test");
const assert = require("node:assert/strict");
const { businessDate, geofence } = require("../src/services/attendanceWriter");
const { attendanceStatus } = require("../src/services/rules");
test("company timezones and overnight shifts use the starting business date", () => {
  const policy = {
    timezone: "Asia/Karachi",
    officeStart: "22:00",
    officeEnd: "06:00",
    graceMinutes: 15,
    halfDayHours: 5,
    maxShiftHours: 20,
  };
  assert.equal(
    businessDate(new Date("2026-10-25T00:00:00Z"), policy),
    "2026-10-24",
  );
  const result = attendanceStatus(
    "2026-10-24T17:16:00Z",
    "2026-10-25T01:00:00Z",
    { ...policy, businessDate: "2026-10-24" },
  );
  assert.equal(result.status, "late");
  assert.ok(result.hours > 7);
  assert.throws(
    () =>
      attendanceStatus("2026-10-24T00:00:00Z", "2026-10-25T01:00:00Z", policy),
    /duration/,
  );
});
test("DST hours derive from real timestamps rather than wall clock labels", () => {
  const policy = {
    timezone: "America/New_York",
    officeStart: "22:00",
    officeEnd: "06:00",
    graceMinutes: 15,
    halfDayHours: 5,
    maxShiftHours: 20,
    businessDate: "2026-10-31",
  };
  assert.equal(
    attendanceStatus("2026-11-01T02:00:00Z", "2026-11-01T11:00:00Z", policy)
      .hours,
    9,
  );
});
test("office geofence rejects poor GPS and locations outside the actual radius", () => {
  const policy = { latitude: 24.8607, longitude: 67.0011, radius: 150 };
  assert.equal(
    geofence({ latitude: 24.8607, longitude: 67.0011, accuracy: 12 }, policy)
      .distanceMeters,
    0,
  );
  assert.throws(
    () =>
      geofence(
        { latitude: 24.8607, longitude: 67.0011, accuracy: 101 },
        policy,
      ),
    /accurate/,
  );
  assert.throws(
    () => geofence({ latitude: 25, longitude: 68, accuracy: 12 }, policy),
    /outside/,
  );
  assert.throws(() => geofence({}, {}), /configure/);
});
