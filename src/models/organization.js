const { createModel, reference } = require("./schema");

const Company = createModel("Company", {
  singleton: { type: String, default: "company", unique: true },
  name: { type: String, required: true },
  officeStart: { type: String, default: "09:00" },
  officeEnd: { type: String, default: "17:00" },
  maxShiftHours: { type: Number, default: 20 },
  biometricRetentionDays: { type: Number, default: 365 },
  graceMinutes: { type: Number, default: 15 },
  halfDayHours: { type: Number, default: 5 },
  weekend: { type: [Number], default: [0, 6] },
  latitude: Number,
  longitude: Number,
  radius: { type: Number, default: 150 },
  timezone: { type: String, default: "UTC" },
});

const Department = createModel("Department", {
  name: { type: String, required: true },
});

const Designation = createModel("Designation", {
  name: { type: String, required: true },
});

const Holiday = createModel("Holiday", {
  name: { type: String, required: true },
  date: { type: String, required: true },
});

module.exports = { Company, Department, Designation, Holiday };
