const models = require("../models");
const context = require("./context");
const ApiError = require("../utils/ApiError");
const faceProvider = require("./localFaceProvider");
const {
  CONSENT_VERSION: PRIVATE_CONSENT_VERSION,
} = require("./biometricService");
const { protectTemplate, revealTemplate } = require("./biometricTemplate");
const terminalRecognition = require("./kioskRecognitionService");

const CONSENT_VERSION = "2026-11-11-terminal-photo-v1";
const CONSENT_NOTICE =
  "Confirm that the employee has agreed to face attendance using their saved profile photo. The photo will be processed on this company's server to create an encrypted face template. Attendance Terminal compares camera samples with approved employee templates. No camera samples are saved. The employee can withdraw consent and use manual attendance. Face matching does not reliably detect photographs or video replay.";

const sameDate = (left, right) =>
  Boolean(
    left && right && new Date(left).getTime() === new Date(right).getTime(),
  );

async function lockAdmin(user, session) {
  if (user.role !== "admin" || !user.company)
    throw new ApiError(403, "Only Admin can manage face attendance.");
  const actor = await models.User.findOneAndUpdate(
    {
      _id: user._id,
      company: user.company,
      role: "admin",
      active: true,
      tokenVersion: user.tokenVersion,
    },
    { $inc: { __v: 1 } },
    { session, returnDocument: "after" },
  );
  if (!actor) throw new ApiError(401, "Your session changed. Sign in again.");
}

async function employeeAccount(user, employeeId, session) {
  const employee = await models.Employee.findOne({
    _id: employeeId,
    company: user.company,
    status: { $ne: "exited" },
  })
    .select("+photo")
    .session(session || null);
  if (!employee) throw new ApiError(404, "Active employee not found.");
  const account = await models.User.findOne({
    _id: employee.user,
    employee: employee._id,
    company: user.company,
    active: true,
  }).session(session || null);
  if (!account)
    throw new ApiError(422, "The employee needs an active linked account.");
  if (!employee.photo?.length || !employee.photoUpdatedAt)
    throw new ApiError(422, "Add an employee profile photo first.");
  return { employee, account };
}

function enrollmentState(employee, account, enrollment) {
  if (!employee.photoUpdatedAt) return "photo_required";
  if (!account?.active || employee.status === "exited")
    return "account_inactive";
  if (!enrollment?.kioskEnabled) return "not_enabled";
  if (
    enrollment.status !== "active" ||
    enrollment.provider !== faceProvider.PROVIDER
  )
    return "not_enabled";
  if (enrollment.expiresAt <= new Date()) return "expired";
  if (!sameDate(enrollment.kioskPhotoUpdatedAt, employee.photoUpdatedAt))
    return "photo_changed";
  if (
    enrollment.modelVersion !== faceProvider.MODEL_VERSION ||
    enrollment.kioskConsentVersion !== terminalRecognition.CONSENT_VERSION
  )
    return "not_enabled";
  return "ready";
}

async function listEmployees(user, { search = "", page = 1, limit = 50 } = {}) {
  const filter = { company: user.company, status: { $ne: "exited" } };
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = ["name", "code", "email"].map((field) => ({
      [field]: { $regex: escaped, $options: "i" },
    }));
  }
  const [employees, total] = await Promise.all([
    models.Employee.find(filter)
      .select("name code email user photoUpdatedAt status")
      .sort({ name: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    models.Employee.countDocuments(filter),
  ]);
  const ids = employees.map((employee) => employee._id);
  const [accounts, enrollments] = await Promise.all([
    models.User.find({ company: user.company, employee: { $in: ids } })
      .select("_id employee active")
      .lean(),
    models.BiometricEnrollment.find({
      company: user.company,
      employee: { $in: ids },
    }).lean(),
  ]);
  const accountByEmployee = new Map(
    accounts.map((account) => [String(account.employee), account]),
  );
  const enrollmentByEmployee = new Map(
    enrollments.map((enrollment) => [String(enrollment.employee), enrollment]),
  );
  const readiness = await terminalRecognition.readiness();
  return {
    employees: employees.map((employee) => {
      const account = accountByEmployee.get(String(employee._id));
      const enrollment = enrollmentByEmployee.get(String(employee._id));
      const state = enrollmentState(
        employee,
        account && String(account._id) === String(employee.user)
          ? account
          : null,
        enrollment,
      );
      return {
        _id: employee._id,
        name: employee.name,
        code: employee.code,
        email: employee.email,
        photoUpdatedAt: employee.photoUpdatedAt,
        faceAttendance: {
          enabled: state === "ready",
          state,
          expiresAt: enrollment?.expiresAt || null,
        },
      };
    }),
    total,
    page,
    pages: Math.ceil(total / limit),
    configured: readiness.configured,
    missingConfiguration: readiness.missing,
    runtime: readiness.runtime,
    consent: { version: CONSENT_VERSION, notice: CONSENT_NOTICE },
  };
}

async function lockPhotoEnrollment(user, employeeId, snapshot, session) {
  await lockAdmin(user, session);
  const company = await models.Company.findOneAndUpdate(
    { _id: user.company },
    { $inc: { __v: 1 } },
    { session, returnDocument: "after" },
  );
  const { employee, account } = await employeeAccount(
    user,
    employeeId,
    session,
  );
  if (
    !sameDate(snapshot.employee.photoUpdatedAt, employee.photoUpdatedAt) ||
    snapshot.account.tokenVersion !== account.tokenVersion
  )
    throw new ApiError(
      409,
      "The employee photo or account changed. Try again.",
    );
  await models.Employee.updateOne(
    {
      _id: employee._id,
      company: user.company,
      photoUpdatedAt: employee.photoUpdatedAt,
    },
    { $inc: { __v: 1 } },
    { session },
  );
  await models.User.updateOne(
    {
      _id: account._id,
      company: user.company,
      active: true,
      tokenVersion: account.tokenVersion,
    },
    { $inc: { __v: 1 } },
    { session },
  );
  return { company, employee };
}

async function rejectDuplicatePhoto(
  user,
  employee,
  embedding,
  threshold,
  session,
) {
  const others = await models.BiometricEnrollment.find({
    company: user.company,
    employee: { $ne: employee._id },
    provider: faceProvider.PROVIDER,
    status: "active",
    expiresAt: { $gt: new Date() },
  })
    .select("+protectedTemplate")
    .session(session);
  for (const other of others) {
    const template = revealTemplate(
      other.protectedTemplate,
      user.company,
      other.employee,
    );
    try {
      if (
        template.modelVersion === faceProvider.MODEL_VERSION &&
        faceProvider.compare(template.embedding, embedding) >= threshold
      )
        throw new ApiError(
          409,
          "This face is already registered to another employee. Check the profile photos.",
        );
    } finally {
      template.embedding.fill(0);
    }
  }
}

async function savePhotoTemplate(
  user,
  employee,
  company,
  embedding,
  config,
  session,
) {
  const existing = await models.BiometricEnrollment.findOne({
    company: user.company,
    employee: employee._id,
  }).session(session);
  if (
    existing &&
    (existing.provider !== faceProvider.PROVIDER ||
      existing.status !== "active")
  )
    throw new ApiError(
      409,
      "Delete the previous face enrollment before enabling attendance.",
    );
  const now = new Date();
  const days = Math.min(
    config.retentionDays,
    Math.max(1, Math.min(365, company.biometricRetentionDays || 365)),
  );
  const expiresAt = new Date(now.getTime() + days * 86400000);
  const values = {
    provider: faceProvider.PROVIDER,
    modelVersion: faceProvider.MODEL_VERSION,
    status: "active",
    protectedTemplate: protectTemplate(
      {
        provider: faceProvider.PROVIDER,
        modelVersion: faceProvider.MODEL_VERSION,
        embedding,
      },
      user.company,
      employee._id,
    ),
    consentAt: now,
    consentVersion: PRIVATE_CONSENT_VERSION,
    enrolledAt: now,
    expiresAt,
    kioskEnabled: true,
    kioskConsentAt: now,
    kioskConsentVersion: terminalRecognition.CONSENT_VERSION,
    kioskPhotoUpdatedAt: employee.photoUpdatedAt,
    terminalEnrollmentSource: "profile-photo",
    terminalConsentVersion: CONSENT_VERSION,
    terminalConsentRecordedBy: user._id,
  };
  const enrollment = existing
    ? await models.BiometricEnrollment.findOneAndUpdate(
        { _id: existing._id, company: user.company },
        { $set: values },
        { session, returnDocument: "after", runValidators: true },
      )
    : (
        await models.BiometricEnrollment.create(
          [{ company: user.company, employee: employee._id, ...values }],
          { session },
        )
      )[0];
  return { enrollment, expiresAt };
}

async function enable(user, employeeId, consent) {
  if (consent.consent !== true || consent.consentVersion !== CONSENT_VERSION)
    throw new ApiError(
      422,
      "Confirm the employee's current permission before enabling face attendance.",
    );
  const config = terminalRecognition.requireConfiguration();
  const snapshot = await employeeAccount(user, employeeId);
  const extracted = await faceProvider.extractSamples([
    snapshot.employee.photo.toString("base64"),
  ]);
  const embedding = extracted.embeddings[0];
  try {
    return await context.transaction(async (session) => {
      const { company, employee } = await lockPhotoEnrollment(
        user,
        employeeId,
        snapshot,
        session,
      );
      await rejectDuplicatePhoto(
        user,
        employee,
        embedding,
        config.threshold,
        session,
      );
      const { enrollment, expiresAt } = await savePhotoTemplate(
        user,
        employee,
        company,
        embedding,
        config,
        session,
      );
      await models.KioskEnrollmentGrant.updateMany(
        {
          company: user.company,
          employee: employee._id,
          state: { $in: ["issued", "verifying"] },
        },
        { state: "revoked", failureCode: "profile_photo_enabled" },
        { session },
      );
      await context.audit(
        session,
        user,
        "terminal_face_enabled",
        "BiometricEnrollment",
        null,
        {
          _id: enrollment._id,
          employee: employee._id,
          photoUpdatedAt: employee.photoUpdatedAt,
          consentVersion: CONSENT_VERSION,
          consentRecordedBy: user._id,
          expiresAt,
        },
      );
      return {
        employee: {
          _id: employee._id,
          name: employee.name,
          code: employee.code,
        },
        faceAttendance: { enabled: true, state: "ready", expiresAt },
        message: "Face attendance enabled.",
      };
    });
  } finally {
    embedding.fill(0);
  }
}

async function disable(user, employeeId) {
  return context.transaction(async (session) => {
    await lockAdmin(user, session);
    const employee = await models.Employee.findOne({
      _id: employeeId,
      company: user.company,
    }).session(session);
    if (!employee) throw new ApiError(404, "Employee not found.");
    const enrollment = await models.BiometricEnrollment.findOne({
      company: user.company,
      employee: employeeId,
    }).session(session);
    if (enrollment?.terminalEnrollmentSource === "profile-photo") {
      await models.BiometricEnrollment.deleteOne(
        { _id: enrollment._id, company: user.company },
        { session },
      );
    } else if (enrollment) {
      await models.BiometricEnrollment.updateOne(
        { _id: enrollment._id, company: user.company },
        {
          $set: { kioskEnabled: false },
          $unset: {
            kioskConsentAt: 1,
            kioskConsentVersion: 1,
            kioskPhotoUpdatedAt: 1,
            terminalConsentVersion: 1,
            terminalConsentRecordedBy: 1,
          },
        },
        { session },
      );
    }
    await models.KioskEnrollmentGrant.updateMany(
      {
        company: user.company,
        employee: employee._id,
        state: { $in: ["issued", "verifying"] },
      },
      { state: "revoked", failureCode: "consent_withdrawn" },
      { session },
    );
    await context.audit(
      session,
      user,
      "terminal_face_disabled",
      "BiometricEnrollment",
      null,
      { _id: enrollment?._id, employee: employee._id },
    );
    return {
      faceAttendance: { enabled: false, state: "not_enabled", expiresAt: null },
      message: "Face attendance disabled.",
    };
  });
}

module.exports = {
  listEmployees,
  enable,
  disable,
  CONSENT_VERSION,
  CONSENT_NOTICE,
};
