const { Schema, createModel, reference } = require("./schema");

const protectedReference = new Schema(
  { ciphertext: String, iv: String, tag: String, keyVersion: String },
  { _id: false },
);

const BiometricEnrollment = createModel(
  "BiometricEnrollment",
  {
    employee: reference("Employee"),
    provider: { type: String, default: "local-opencv-sface" },
    status: {
      type: String,
      enum: ["active", "provisioning", "deleting", "delete_failed"],
      default: "active",
    },
    protectedReference: { type: protectedReference, select: false },
    protectedTemplate: { type: protectedReference, select: false },
    modelVersion: String,
    consentAt: Date,
    consentVersion: String,
    enrolledAt: Date,
    expiresAt: { type: Date, index: true },
    lastVerifiedAt: Date,
    deleteRequestedAt: Date,
    kioskEnabled: { type: Boolean, default: false },
    kioskConsentAt: Date,
    kioskConsentVersion: String,
    kioskPhotoUpdatedAt: Date,
    terminalEnrollmentSource: {
      type: String,
      enum: ["profile-photo", "camera"],
    },
    terminalConsentVersion: String,
    terminalConsentRecordedBy: reference("User", false),
  },
  [[{ company: 1, employee: 1 }, { unique: true }]],
);

const BiometricChallenge = createModel(
  "BiometricChallenge",
  {
    employee: reference("Employee"),
    user: reference("User"),
    purpose: {
      type: String,
      enum: ["enroll", "check-in", "check-out"],
      required: true,
    },
    providerSessionId: { type: String, select: false },
    provider: String,
    consentVersion: String,
    consentAt: Date,
    expiresAt: Date,
    state: {
      type: String,
      enum: ["created", "verifying", "completed", "failed"],
      default: "created",
    },
    attempts: { type: Number, default: 0 },
    consumedAt: Date,
    failureCode: String,
  },
  [
    [{ company: 1, employee: 1, createdAt: -1 }, {}],
    [{ expiresAt: 1 }, { expireAfterSeconds: 86400 }],
    [
      { company: 1, purpose: 1, state: 1 },
      {
        unique: true,
        partialFilterExpression: { purpose: "enroll", state: "verifying" },
      },
    ],
  ],
);

module.exports = { BiometricEnrollment, BiometricChallenge };
