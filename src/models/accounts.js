const { createModel, reference } = require("./schema");

const User = createModel("User", {
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ["admin", "hr", "employee"], required: true },
  active: { type: Boolean, default: true },
  mustChangePassword: { type: Boolean, default: true },
  passwordChangeEnforced: { type: Boolean, default: false },
  tokenVersion: { type: Number, default: 0 },
  employee: reference("Employee", false),
});

const PasswordResetToken = createModel("PasswordResetToken", {
  user: { ...reference("User"), unique: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  userTokenVersion: { type: Number, required: true },
  deliveredAt: Date,
  expiresAt: { type: Date, required: true, expires: 0 },
});

module.exports = { User, PasswordResetToken };
