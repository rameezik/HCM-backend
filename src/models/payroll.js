const { Schema, createModel, reference } = require("./schema");

const Payroll = createModel("Payroll", {
  month: { type: String, required: true },
  status: { type: String, enum: ["draft", "finalized"], default: "draft" },
  slips: [
    new Schema(
      {
        employee: reference("Employee"),
        user: reference("User"),
        name: String,
        code: String,
        department: reference("Department"),
        designation: reference("Designation"),
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
  createdBy: reference("User"),
  finalizedBy: reference("User", false),
  finalizedAt: Date,
});

module.exports = { Payroll };
