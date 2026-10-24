const mongoose = require("mongoose");
const { Schema } = mongoose;
const ref = (name, required = true) => ({
  type: Schema.Types.ObjectId,
  ref: name,
  required,
});
const model = (name, fields, indexes = []) => {
  const schema = new Schema(fields, { timestamps: true, strict: "throw" });
  for (const [keys, options] of indexes) schema.index(keys, options);
  return mongoose.model(name, schema, name === "AiLog" ? "ai_logs" : undefined);
};
const User = model("User", {
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ["admin", "hr", "employee"], required: true },
  active: { type: Boolean, default: true },
  mustChangePassword: { type: Boolean, default: true },
  tokenVersion: { type: Number, default: 0 },
  employee: ref("Employee", false),
});
const Company = model("Company", {
  singleton: { type: String, default: "company", unique: true },
  name: { type: String, required: true },
  officeStart: { type: String, default: "09:00" },
  graceMinutes: { type: Number, default: 15 },
  halfDayHours: { type: Number, default: 5 },
  weekend: { type: [Number], default: [0, 6] },
  latitude: Number,
  longitude: Number,
  radius: { type: Number, default: 150 },
  timezone: { type: String, default: "UTC" },
});
const Department = model("Department", {
  name: { type: String, required: true, unique: true },
});
const Designation = model("Designation", {
  name: { type: String, required: true, unique: true },
});
const LeaveType = model("LeaveType", {
  name: { type: String, required: true, unique: true },
  quota: { type: Number, default: 0 },
  unpaid: { type: Boolean, default: false },
});
const Holiday = model("Holiday", {
  name: { type: String, required: true },
  date: { type: String, required: true, unique: true },
});
const Employee = model("Employee", {
  user: ref("User"),
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  department: ref("Department"),
  designation: ref("Designation"),
  joinDate: { type: String, required: true },
  exitDate: String,
  status: {
    type: String,
    enum: ["active", "probation", "exited"],
    default: "active",
  },
  gender: { type: String, default: "unspecified" },
  basic: { type: Number, required: true, min: 0 },
  phone: String,
  address: String,
});
const Attendance = model(
  "Attendance",
  {
    employee: ref("Employee"),
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
  },
  [[{ employee: 1, date: 1 }, { unique: true }]],
);
const Correction = model("Correction", {
  employee: ref("Employee"),
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
  decidedBy: ref("User", false),
});
const Leave = model("Leave", {
  employee: ref("Employee"),
  type: ref("LeaveType"),
  start: String,
  end: String,
  days: [String],
  reason: String,
  quotaSnapshot: Number,
  unpaid: Boolean,
  status: {
    type: String,
    enum: ["pending", "approved", "rejected", "cancelled"],
    default: "pending",
  },
  comment: String,
  decidedBy: ref("User", false),
});
const Payroll = model("Payroll", {
  month: { type: String, required: true, unique: true },
  status: { type: String, enum: ["draft", "finalized"], default: "draft" },
  slips: [
    new Schema(
      {
        employee: ref("Employee"),
        user: ref("User"),
        name: String,
        code: String,
        department: ref("Department"),
        designation: ref("Designation"),
        basic: Number,
        hra: Number,
        medical: Number,
        gross: Number,
        workingDays: Number,
        eligibleDays: Number,
        absent: Number,
        unpaid: Number,
        halfDays: Number,
        deduction: Number,
        tax: Number,
        net: Number,
      },
      { _id: false },
    ),
  ],
  createdBy: ref("User"),
  finalizedBy: ref("User", false),
  finalizedAt: Date,
});
const Announcement = model("Announcement", {
  title: String,
  body: String,
  actor: ref("User"),
});
const Notification = model("Notification", {
  recipient: ref("User"),
  message: String,
  read: { type: Boolean, default: false },
});
const AuditLog = model("AuditLog", {
  actor: ref("User", false),
  action: String,
  entity: String,
  entityId: String,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
});
const AiLog = model("AiLog", {
  actor: ref("User"),
  mode: String,
  status: String,
  tools: [String],
  error: String,
});
module.exports = {
  User,
  Company,
  Department,
  Designation,
  LeaveType,
  Holiday,
  Employee,
  Attendance,
  Correction,
  Leave,
  Payroll,
  Announcement,
  Notification,
  AuditLog,
  AiLog,
};
