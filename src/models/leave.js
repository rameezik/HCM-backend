const { createModel, reference } = require("./schema");

const LeaveType = createModel("LeaveType", {
  name: { type: String, required: true },
  quota: { type: Number, default: 0 },
  unpaid: { type: Boolean, default: false },
});

const Leave = createModel("Leave", {
  employee: reference("Employee"),
  type: reference("LeaveType"),
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
  decidedBy: reference("User", false),
});

module.exports = { LeaveType, Leave };
