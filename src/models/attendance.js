const { Schema, createModel, reference } = require("./schema");

const Attendance = createModel(
  "Attendance",
  {
    employee: reference("Employee"),
    date: { type: String, required: true },
    checkIn: Date,
    checkOut: Date,
    late: Boolean,
    status: {
      type: String,
      enum: ["present", "late", "half_day", "missing_checkout"],
      required: true,
    },
    hours: { type: Number, default: 0 },
    rules: Schema.Types.Mixed,
    verificationMethod: {
      type: String,
      enum: ["web", "face", "hr-correction"],
      default: "web",
    },
    verification: Schema.Types.Mixed,
    checkOutVerification: Schema.Types.Mixed,
  },
  [[{ company: 1, employee: 1, date: 1 }, { unique: true }]],
);

const Correction = createModel("Correction", {
  employee: reference("Employee"),
  date: String,
  checkIn: Date,
  checkOut: Date,
  reason: String,
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  comment: String,
  decidedBy: reference("User", false),
});

module.exports = { Attendance, Correction };
