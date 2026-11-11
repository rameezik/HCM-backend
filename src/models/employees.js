const { createModel, reference } = require("./schema");

const Employee = createModel("Employee", {
  user: reference("User"),
  code: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  department: reference("Department"),
  designation: reference("Designation"),
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
  photo: { type: Buffer, select: false },
  photoUpdatedAt: { type: Date, default: null },
  kioskLastAttendanceAt: { type: Date, select: false },
});

module.exports = { Employee };
