const { Schema, createModel, reference } = require("./schema");

const KioskDevice = createModel(
  "KioskDevice",
  {
    label: { type: String, required: true },
    reusable: { type: Boolean, default: false },
    state: {
      type: String,
      enum: ["pending", "paired", "revoked"],
      default: "pending",
    },
    office: new Schema({ latitude: Number, longitude: Number }, { _id: false }),
    createdBy: reference("User"),
    tokenVersion: { type: Number, default: 0 },
    pairingTokenHash: { type: String, select: false },
    pairingExpiresAt: Date,
    credentialHash: { type: String, select: false },
    credentialExpiresAt: Date,
    pairedAt: Date,
    revokedAt: Date,
  },
  [[{ pairingTokenHash: 1 }, { unique: true, sparse: true }]],
);

const KioskChallenge = createModel(
  "KioskChallenge",
  {
    device: reference("KioskDevice"),
    purpose: {
      type: String,
      enum: ["enroll", "check-in", "check-out"],
      required: true,
    },
    state: {
      type: String,
      enum: ["created", "verifying", "completed", "failed"],
      default: "created",
    },
    attempts: { type: Number, default: 0 },
    expiresAt: Date,
    consumedAt: Date,
    failureCode: String,
    employee: reference("Employee", false),
  },
  [
    [{ expiresAt: 1 }, { expireAfterSeconds: 86400 }],
    [{ company: 1, device: 1, createdAt: -1 }, {}],
  ],
);

const KioskEnrollmentGrant = createModel(
  "KioskEnrollmentGrant",
  {
    employee: reference("Employee"),
    user: reference("User"),
    issuedBy: reference("User"),
    codeHash: { type: String, required: true, select: false },
    userTokenVersion: { type: Number, required: true },
    photoUpdatedAt: { type: Date, required: true },
    state: {
      type: String,
      enum: ["issued", "verifying", "consumed", "failed", "revoked"],
      default: "issued",
    },
    attempts: { type: Number, default: 0 },
    device: reference("KioskDevice", false),
    claimedAt: Date,
    expiresAt: Date,
    consumedAt: Date,
    failureCode: String,
  },
  [
    [{ codeHash: 1 }, { unique: true }],
    [{ expiresAt: 1 }, { expireAfterSeconds: 86400 }],
  ],
);

module.exports = { KioskDevice, KioskChallenge, KioskEnrollmentGrant };
