const models = require("../models");
const context = require("./context");
const ApiError = require("../utils/ApiError");
const faceProvider = require("./localFaceProvider");
const {
  readEncryptionKey,
  isNormalizedEmbedding,
  protectTemplate,
  revealTemplate,
} = require("./biometricTemplate");
const { samplesMatch, averageEmbedding } = require("./faceEmbeddings");
const CONSENT_VERSION = "2026-10-25-local-v1";
const NOTICE =
  "With your explicit consent, three camera samples are sent to your company’s own server for local YuNet detection, landmark alignment and SFace identity matching. No cloud biometric service or external API is used. The encrypted facial embedding is stored with your company and employee account; raw images are processed transiently and are not saved by the application. This system does not provide robust liveness or presentation-attack detection: a replay, photograph or injected camera stream may defeat it. Enrollment expires under the retention policy and can be deleted at any time. Database backups follow the operator’s separate retention schedule. Web attendance and HR corrections remain available without biometric consent.";
const ownFilter = (user) => ({
  company: user.company,
  employee: user.employee,
});
function requirePerson(user) {
  if (!user.company || !user.employee)
    throw new ApiError(
      422,
      "A company-linked employee profile is required for facial attendance.",
    );
  return ownFilter(user);
}
async function log(session, user, action, details) {
  await models.AuditLog.create(
    [
      {
        company: user.company,
        actor: user._id,
        action,
        entity: "BiometricEnrollment",
        entityId: String(details.enrollmentId || details.challengeId || ""),
        before: null,
        after: details,
      },
    ],
    { session },
  );
}
function enrollmentView(row) {
  return row
    ? {
        enrolled:
          row.provider === faceProvider.PROVIDER &&
          row.status === "active" &&
          row.expiresAt > new Date() &&
          row.consentVersion === CONSENT_VERSION,
        status:
          row.provider === faceProvider.PROVIDER
            ? row.status
            : "legacy-enrollment-requires-cleanup",
        provider: row.provider,
        enrolledAt: row.enrolledAt,
        expiresAt: row.expiresAt,
        consentVersion: row.consentVersion,
      }
    : { enrolled: false, status: "not-enrolled" };
}
async function retentionDaysFor(user) {
  const company = await models.Company.findOne({ _id: user.company })
    .select("biometricRetentionDays")
    .lean();
  if (!company) throw new ApiError(403, "Company policy is unavailable.");
  return Math.min(
    faceProvider.configuration().retentionDays,
    Math.max(1, Math.min(365, company.biometricRetentionDays || 365)),
  );
}
function requireConfiguration() {
  const config = faceProvider.requireConfiguration();
  readEncryptionKey().fill(0);
  return config;
}
async function status(user) {
  const config = await faceProvider.readiness();
  const missing = [...(config.missing || [])];
  try {
    readEncryptionKey().fill(0);
  } catch {
    missing.push("BIOMETRIC_TEMPLATE_KEY");
  }
  const linked = Boolean(user.company && user.employee),
    configured = linked && config.configured && missing.length === 0;
  const enrollment = linked
    ? await models.BiometricEnrollment.findOne(ownFilter(user)).lean()
    : null;
  const office = user.company
    ? await models.Company.findOne({ _id: user.company })
        .select("latitude longitude radius")
        .lean()
    : null;
  const officeConfigured = Boolean(
    office &&
      Number.isFinite(office.latitude) &&
      Number.isFinite(office.longitude) &&
      Number.isFinite(office.radius) &&
      office.radius > 0,
  );
  const attendance = linked
    ? await models.Attendance.findOne(ownFilter(user))
        .sort({ checkIn: -1 })
        .select("date checkIn checkOut status hours verificationMethod")
        .lean()
    : null;
  return {
    configured,
    provider: faceProvider.PROVIDER,
    modelVersion: config.modelVersion,
    officeConfigured,
    missingConfiguration: [...new Set(missing)],
    attendance,
    liveness: {
      supported: false,
      notice:
        "Local identity matching does not provide robust liveness or replay protection.",
    },
    enrollment: enrollmentView(enrollment),
    consent: {
      version: CONSENT_VERSION,
      notice: NOTICE,
      retentionDays: linked
        ? await retentionDaysFor(user)
        : config.retentionDays,
    },
    integrationStatus: configured
      ? "local-inference-ready"
      : "configuration-required",
    ...(!configured
      ? {
          unavailableReason: linked
            ? process.env.NODE_ENV === "production"
              ? "Your company’s face attendance service needs setup. Ask your administrator to install the local recognition runtime and models and configure the backend biometric encryption key. Manual attendance remains available."
              : "Local face verification is unavailable. Install the local models/runtime with npm run setup:face and configure the biometric encryption key with npm run setup:env. Ordinary web attendance remains available."
            : "A linked employee profile is required.",
        }
      : {}),
  };
}
async function createChallenge(user, body) {
  const filter = requirePerson(user);
  requireConfiguration();
  const employee = await models.Employee.findOne({
    _id: user.employee,
    company: user.company,
  }).lean();
  if (!employee || employee.status === "exited")
    throw new ApiError(
      403,
      "Facial attendance is unavailable for this employee.",
    );
  if (
    (await models.BiometricChallenge.countDocuments({
      ...filter,
      state: "failed",
      createdAt: { $gte: new Date(Date.now() - 15 * 60000) },
    })) >= 5
  )
    throw new ApiError(
      429,
      "Too many unsuccessful verifications. Try again after 15 minutes or use ordinary attendance.",
    );
  const enrollment = await models.BiometricEnrollment.findOne(filter).lean();
  if (body.purpose === "enroll") {
    if (body.consent !== true || body.consentVersion !== CONSENT_VERSION)
      throw new ApiError(
        422,
        "Read and explicitly accept the current biometric consent notice.",
      );
    if (enrollment)
      throw new ApiError(
        409,
        "Delete the existing enrollment before enrolling again. Legacy cloud enrollments require administrator cleanup.",
      );
  } else if (!enrollmentView(enrollment).enrolled)
    throw new ApiError(
      422,
      "A current local face enrollment and consent are required.",
    );
  const challenge = await models.BiometricChallenge.create({
    ...filter,
    user: user._id,
    purpose: body.purpose,
    provider: faceProvider.PROVIDER,
    consentVersion: body.purpose === "enroll" ? CONSENT_VERSION : undefined,
    consentAt: body.purpose === "enroll" ? new Date() : undefined,
    expiresAt: new Date(Date.now() + 2 * 60000),
    state: "created",
    attempts: 0,
  });
  await log(null, user, "biometric_challenge_created", {
    challengeId: challenge._id,
    purpose: body.purpose,
    provider: faceProvider.PROVIDER,
  });
  return {
    challengeId: challenge._id,
    expiresAt: challenge.expiresAt,
    provider: faceProvider.PROVIDER,
    capture: { samples: 3, maxWidth: 640, maxImageBytes: 250000 },
    livenessSupported: false,
  };
}
async function claim(user, id, purpose) {
  const now = new Date();
  await models.BiometricChallenge.updateMany(
    {
      company: user.company,
      purpose: "enroll",
      state: "verifying",
      expiresAt: { $lte: now },
    },
    { state: "failed", failureCode: "expired" },
  );
  let challenge;
  try {
    challenge = await models.BiometricChallenge.findOneAndUpdate(
      {
        _id: id,
        ...requirePerson(user),
        user: user._id,
        provider: faceProvider.PROVIDER,
        purpose,
        state: "created",
        expiresAt: { $gt: now },
        attempts: { $lt: 3 },
      },
      { state: "verifying", $inc: { attempts: 1 } },
      { returnDocument: "after" },
    );
  } catch (error) {
    if (error.code === 11000)
      throw new ApiError(
        409,
        "Another company enrollment is processing. Retry shortly.",
      );
    throw error;
  }
  if (!challenge)
    throw new ApiError(
      409,
      "This camera challenge is expired, already used or belongs to another account. Start a new capture.",
    );
  return challenge;
}
async function recordFailure(challenge, user, error) {
  await models.BiometricChallenge.updateOne(
    { _id: challenge._id, ...ownFilter(user), state: "verifying" },
    {
      state: "failed",
      consumedAt: new Date(),
      failureCode:
        error.status === 422 ? "verification_rejected" : "operation_failed",
    },
  );
  await log(null, user, "biometric_verification_failed", {
    challengeId: challenge._id,
    purpose: challenge.purpose,
    reason:
      error.status === 422 ? "verification_rejected" : "operation_unavailable",
  });
}
async function consume(challenge, user, session) {
  const result = await models.BiometricChallenge.updateOne(
    {
      _id: challenge._id,
      ...ownFilter(user),
      user: user._id,
      provider: faceProvider.PROVIDER,
      state: "verifying",
      expiresAt: { $gt: new Date() },
    },
    { state: "completed", consumedAt: new Date() },
    { session },
  );
  if (result.modifiedCount !== 1)
    throw new ApiError(
      409,
      "The camera challenge was withdrawn, used or expired. Start a new capture.",
    );
}
async function lockAccount(user, session) {
  const account = await models.User.findOneAndUpdate(
    {
      _id: user._id,
      company: user.company,
      active: true,
      employee: user.employee,
    },
    { $inc: { __v: 1 } },
    { returnDocument: "after", session },
  );
  if (!account)
    throw new ApiError(403, "This employee account is no longer active.");
}
function buildEnrollmentEmbedding(embeddings) {
  if (
    embeddings.length !== 3 ||
    embeddings.some((embedding) => !isNormalizedEmbedding(embedding))
  ) {
    throw new ApiError(422, "Three usable face samples are required.");
  }
  const threshold = faceProvider.configuration().similarityThreshold;
  if (!samplesMatch(embeddings, threshold)) {
    throw new ApiError(
      422,
      "The capture samples do not match one identity. Retry with one face and good lighting.",
    );
  }
  const embedding = averageEmbedding(embeddings);
  if (!embedding) {
    throw new ApiError(422, "The captured face samples are not consistent.");
  }
  return embedding;
}
async function rejectDuplicateEnrollment(user, modelVersion, embedding) {
  // The partial unique challenge index serializes company enrollment checks.
  const rows = models.BiometricEnrollment.find({
    company: user.company,
    provider: faceProvider.PROVIDER,
    status: "active",
    expiresAt: { $gt: new Date() },
  })
    .select("+protectedTemplate")
    .cursor();
  for await (const other of rows) {
    const template = revealTemplate(
      other.protectedTemplate,
      user.company,
      other.employee,
    );
    try {
      if (
        template.modelVersion === modelVersion &&
        faceProvider.compare(template.embedding, embedding) >=
          faceProvider.configuration().similarityThreshold
      )
        throw new ApiError(
          409,
          "This face is already enrolled in this company. Contact Admin.",
        );
    } finally {
      template.embedding.fill(0);
    }
  }
}

async function completeEnrollment(user, challengeId, samples) {
  const filter = requirePerson(user);
  requireConfiguration();
  const challenge = await claim(user, challengeId, "enroll");
  let extracted, embedding;
  try {
    if (challenge.consentVersion !== CONSENT_VERSION || !challenge.consentAt)
      throw new ApiError(422, "Fresh explicit consent is required.");
    extracted = await faceProvider.extractSamples(samples);
    embedding = buildEnrollmentEmbedding(extracted.embeddings);
    await rejectDuplicateEnrollment(user, extracted.modelVersion, embedding);
    const result = await context.transaction(async (session) => {
      await lockAccount(user, session);
      const person = await models.Employee.findOneAndUpdate(
        {
          _id: user.employee,
          company: user.company,
          status: { $ne: "exited" },
        },
        { $inc: { __v: 1 } },
        { returnDocument: "after", session },
      );
      if (!person)
        throw new ApiError(403, "This employee is no longer active.");
      if (await models.BiometricEnrollment.exists(filter).session(session))
        throw new ApiError(409, "An enrollment already exists.");
      await consume(challenge, user, session);
      const [row] = await models.BiometricEnrollment.create(
        [
          {
            ...filter,
            provider: faceProvider.PROVIDER,
            status: "active",
            // Private enrollment never opts a newly captured template into a public kiosk.
            kioskEnabled: false,
            kioskConsentAt: undefined,
            kioskConsentVersion: undefined,
            kioskPhotoUpdatedAt: undefined,
            modelVersion: extracted.modelVersion,
            protectedTemplate: protectTemplate(
              {
                provider: faceProvider.PROVIDER,
                modelVersion: extracted.modelVersion,
                embedding,
              },
              user.company,
              user.employee,
            ),
            consentAt: challenge.consentAt,
            consentVersion: CONSENT_VERSION,
            enrolledAt: new Date(),
            expiresAt: new Date(
              Date.now() + (await retentionDaysFor(user)) * 86400000,
            ),
          },
        ],
        { session },
      );
      await log(session, user, "biometric_enrolled", {
        enrollmentId: row._id,
        employee: user.employee,
        provider: faceProvider.PROVIDER,
        modelVersion: extracted.modelVersion,
        consentAt: row.consentAt,
        consentVersion: CONSENT_VERSION,
        expiresAt: row.expiresAt,
      });
      return enrollmentView(row);
    });
    return {
      enrollment: result,
      message:
        "Face enrollment saved after local server identity processing. Robust liveness detection is not available.",
    };
  } catch (error) {
    await recordFailure(challenge, user, error);
    throw error;
  } finally {
    embedding?.fill(0);
    extracted?.embeddings.forEach((e) => e.fill(0));
  }
}
async function completeAttendance(
  user,
  challengeId,
  action,
  location,
  writeAttendance,
  samples,
) {
  const filter = requirePerson(user);
  requireConfiguration();
  const challenge = await claim(user, challengeId, action);
  let extracted, template;
  try {
    const enrollment = await models.BiometricEnrollment.findOne({
      ...filter,
      provider: faceProvider.PROVIDER,
      status: "active",
      consentVersion: CONSENT_VERSION,
      expiresAt: { $gt: new Date() },
    }).select("+protectedTemplate");
    if (!enrollment)
      throw new ApiError(
        422,
        "Your local face enrollment is no longer active.",
      );
    template = revealTemplate(
      enrollment.protectedTemplate,
      user.company,
      user.employee,
    );
    extracted = await faceProvider.extractSamples(samples);
    buildEnrollmentEmbedding(extracted.embeddings).fill(0);
    if (template.modelVersion !== extracted.modelVersion)
      throw new ApiError(
        422,
        "The recognition model changed. Delete and renew your enrollment.",
      );
    const similarity = Math.min(
      ...extracted.embeddings.map((e) =>
        faceProvider.compare(template.embedding, e),
      ),
    );
    if (similarity < faceProvider.configuration().similarityThreshold)
      throw new ApiError(
        422,
        "The captured face does not match your enrollment. No attendance was recorded.",
      );
    return await context.transaction(async (session) => {
      await lockAccount(user, session);
      const active = await models.BiometricEnrollment.findOneAndUpdate(
        {
          _id: enrollment._id,
          ...filter,
          provider: faceProvider.PROVIDER,
          status: "active",
          expiresAt: { $gt: new Date() },
        },
        { lastVerifiedAt: new Date(), $inc: { __v: 1 } },
        { returnDocument: "after", session },
      );
      if (!active)
        throw new ApiError(
          422,
          "Enrollment was withdrawn or expired before verification completed.",
        );
      await consume(challenge, user, session);
      return writeAttendance(user, action, {
        session,
        location,
        verification: {
          method: "face",
          provider: faceProvider.PROVIDER,
          modelVersion: extracted.modelVersion,
          challengeId: challenge._id,
          similarity,
          similarityMetric: "cosine",
          livenessVerified: false,
        },
      });
    });
  } catch (error) {
    await recordFailure(challenge, user, error);
    throw error;
  } finally {
    template?.embedding.fill(0);
    extracted?.embeddings.forEach((e) => e.fill(0));
  }
}
async function removeEnrollment(user, employeeId = user.employee) {
  if (
    !user.company ||
    !employeeId ||
    (String(employeeId) !== String(user.employee) &&
      !["admin", "hr"].includes(user.role))
  )
    throw new ApiError(403, "You cannot remove this enrollment.");
  const filter = { company: user.company, employee: employeeId };
  return context.transaction(async (session) => {
    const row = await models.BiometricEnrollment.findOneAndUpdate(
      filter,
      { status: "deleting", deleteRequestedAt: new Date(), $inc: { __v: 1 } },
      { returnDocument: "after", session },
    );
    await models.BiometricChallenge.updateMany(
      { ...filter, state: { $in: ["created", "verifying"] } },
      {
        state: "failed",
        failureCode: "consent_withdrawn",
        consumedAt: new Date(),
      },
      { session },
    );
    if (!row)
      return {
        deleted: true,
        status: "not-enrolled",
        message: "No biometric enrollment remains.",
      };
    await log(session, user, "biometric_deletion_requested", {
      enrollmentId: row._id,
      employee: employeeId,
    });
    if (row.provider !== faceProvider.PROVIDER) {
      await models.BiometricEnrollment.updateOne(
        { _id: row._id, ...filter },
        { status: "delete_failed" },
        { session },
      );
      return {
        deleted: false,
        status: "legacy-cleanup-required",
        message:
          "Recognition is disabled. This legacy cloud enrollment cannot be deleted by the local engine. Admin must confirm deletion at the former provider; its encrypted cleanup reference is preserved.",
      };
    }
    await models.BiometricEnrollment.deleteOne(
      { _id: row._id, ...filter },
      { session },
    );
    await log(session, user, "biometric_deleted", {
      enrollmentId: row._id,
      employee: employeeId,
    });
    return {
      deleted: true,
      status: "not-enrolled",
      message:
        "The encrypted local face template was deleted. Operator-managed backups follow their separate retention policy.",
    };
  });
}
async function cleanupCompany(companyId) {
  const exited = await models.Employee.find({
    company: companyId,
    status: "exited",
  })
    .select("_id")
    .lean();
  const inactive = await models.User.find({
    company: companyId,
    active: false,
    employee: { $ne: null },
  })
    .select("employee")
    .lean();
  const rows = await models.BiometricEnrollment.find({
    company: companyId,
    provider: faceProvider.PROVIDER,
    $or: [
      {
        employee: {
          $in: [
            ...exited.map((e) => e._id),
            ...inactive.map((u) => u.employee),
          ],
        },
      },
      { expiresAt: { $lte: new Date() } },
      { status: { $in: ["deleting", "delete_failed", "provisioning"] } },
    ],
  })
    .select("employee")
    .limit(100)
    .lean();
  for (const row of rows)
    await removeEnrollment({ company: companyId, role: "admin" }, row.employee);
  return { processed: rows.length, pending: 0 };
}
module.exports = {
  status,
  createChallenge,
  completeEnrollment,
  completeAttendance,
  removeEnrollment,
  cleanupCompany,
  CONSENT_VERSION,
  protectTemplate,
  revealTemplate,
};
