const crypto = require("node:crypto");
const mongoose = require("mongoose");
const M = require("../models");
const C = require("./context");
const ApiError = require("../utils/ApiError");
const provider = require("./localFaceProvider");
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
function encryptionKey() {
  const raw = process.env.BIOMETRIC_TEMPLATE_KEY || "";
  if (
    !/^[A-Za-z\d+/]{43}=$/.test(raw) ||
    Buffer.from(raw, "base64").length !== 32
  )
    throw new ApiError(
      503,
      "Local biometric encryption is not configured. Run npm run setup:env for development or configure BIOMETRIC_TEMPLATE_KEY securely on the backend.",
    );
  return Buffer.from(raw, "base64");
}
const aad = (company, employee) =>
  Buffer.from(`${company}:${employee}:${provider.PROVIDER}:template-v1`);
function validVector(vector) {
  return (
    Array.isArray(vector) &&
    vector.length === 128 &&
    vector.every(Number.isFinite) &&
    Math.abs(Math.hypot(...vector) - 1) < 0.01
  );
}
function protectTemplate(template, company, employee) {
  const key = encryptionKey(),
    iv = crypto.randomBytes(12);
  let plaintext;
  try {
    plaintext = Buffer.from(JSON.stringify(template));
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(company, employee));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      keyVersion: process.env.BIOMETRIC_TEMPLATE_KEY_ID || "v1",
    };
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
function revealTemplate(protectedTemplate, company, employee) {
  const key = encryptionKey();
  let plaintext;
  try {
    if (
      !protectedTemplate ||
      protectedTemplate.keyVersion !==
        (process.env.BIOMETRIC_TEMPLATE_KEY_ID || "v1")
    )
      throw Error("Key version mismatch");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(protectedTemplate.iv, "base64"),
    );
    decipher.setAAD(aad(company, employee));
    decipher.setAuthTag(Buffer.from(protectedTemplate.tag, "base64"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(protectedTemplate.ciphertext, "base64")),
      decipher.final(),
    ]);
    const template = JSON.parse(plaintext.toString("utf8"));
    if (
      template.provider !== provider.PROVIDER ||
      typeof template.modelVersion !== "string" ||
      !validVector(template.embedding)
    )
      throw Error("Invalid template");
    return template;
  } catch {
    throw new ApiError(
      503,
      "Your encrypted face template cannot be read. Contact Admin; preserve the original biometric encryption key.",
    );
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
async function log(session, user, action, details) {
  await M.AuditLog.create(
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
          row.provider === provider.PROVIDER &&
          row.status === "active" &&
          row.expiresAt > new Date() &&
          row.consentVersion === CONSENT_VERSION,
        status:
          row.provider === provider.PROVIDER
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
  const company = await M.Company.findOne({ _id: user.company })
    .select("biometricRetentionDays")
    .lean();
  if (!company) throw new ApiError(403, "Company policy is unavailable.");
  return Math.min(
    provider.configuration().retentionDays,
    Math.max(1, Math.min(365, company.biometricRetentionDays || 365)),
  );
}
function requireConfiguration() {
  const config = provider.requireConfiguration();
  encryptionKey().fill(0);
  return config;
}
async function status(user) {
  const config = provider.configuration();
  const missing = [...(config.missing || [])];
  try {
    encryptionKey().fill(0);
  } catch {
    missing.push("BIOMETRIC_TEMPLATE_KEY");
  }
  const linked = Boolean(user.company && user.employee),
    configured = linked && config.configured && missing.length === 0;
  const enrollment = linked
    ? await M.BiometricEnrollment.findOne(ownFilter(user)).lean()
    : null;
  return {
    configured,
    provider: provider.PROVIDER,
    modelVersion: config.modelVersion,
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
            ? "Local face verification is unavailable. Install the local models/runtime with bash scripts/setup-local-face.sh and configure the biometric encryption key with npm run setup:env. Ordinary web attendance remains available."
            : "A linked employee profile is required.",
        }
      : {}),
  };
}
async function createChallenge(user, body) {
  const filter = requirePerson(user);
  requireConfiguration();
  const employee = await M.Employee.findOne({
    _id: user.employee,
    company: user.company,
  }).lean();
  if (!employee || employee.status === "exited")
    throw new ApiError(
      403,
      "Facial attendance is unavailable for this employee.",
    );
  if (
    (await M.BiometricChallenge.countDocuments({
      ...filter,
      state: "failed",
      createdAt: { $gte: new Date(Date.now() - 15 * 60000) },
    })) >= 5
  )
    throw new ApiError(
      429,
      "Too many unsuccessful verifications. Try again after 15 minutes or use ordinary attendance.",
    );
  const enrollment = await M.BiometricEnrollment.findOne(filter).lean();
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
  const challenge = await M.BiometricChallenge.create({
    ...filter,
    user: user._id,
    purpose: body.purpose,
    provider: provider.PROVIDER,
    consentVersion: body.purpose === "enroll" ? CONSENT_VERSION : undefined,
    consentAt: body.purpose === "enroll" ? new Date() : undefined,
    expiresAt: new Date(Date.now() + 2 * 60000),
    state: "created",
    attempts: 0,
  });
  await log(null, user, "biometric_challenge_created", {
    challengeId: challenge._id,
    purpose: body.purpose,
    provider: provider.PROVIDER,
  });
  return {
    challengeId: challenge._id,
    expiresAt: challenge.expiresAt,
    provider: provider.PROVIDER,
    capture: { samples: 3, maxWidth: 640, maxImageBytes: 250000 },
    livenessSupported: false,
  };
}
async function claim(user, id, purpose) {
  const now = new Date();
  await M.BiometricChallenge.updateMany(
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
    challenge = await M.BiometricChallenge.findOneAndUpdate(
      {
        _id: id,
        ...requirePerson(user),
        user: user._id,
        provider: provider.PROVIDER,
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
  await M.BiometricChallenge.updateOne(
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
  const result = await M.BiometricChallenge.updateOne(
    {
      _id: challenge._id,
      ...ownFilter(user),
      user: user._id,
      provider: provider.PROVIDER,
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
  const account = await M.User.findOneAndUpdate(
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
function meanEmbedding(embeddings) {
  if (embeddings.length !== 3 || embeddings.some((e) => !validVector(e)))
    throw new ApiError(422, "Three usable face samples are required.");
  const threshold = provider.configuration().similarityThreshold;
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
      if (provider.compare(embeddings[i], embeddings[j]) < threshold)
        throw new ApiError(
          422,
          "The capture samples do not match one identity. Retry with one face and good lighting.",
        );
  const mean = embeddings[0].map(
      (_, i) => embeddings.reduce((sum, e) => sum + e[i], 0) / 3,
    ),
    norm = Math.hypot(...mean);
  if (norm < 0.001)
    throw new ApiError(422, "The captured face samples are not consistent.");
  return mean.map((v) => v / norm);
}
async function completeEnrollment(user, challengeId, samples) {
  const filter = requirePerson(user);
  requireConfiguration();
  const challenge = await claim(user, challengeId, "enroll");
  let extracted, embedding;
  try {
    if (challenge.consentVersion !== CONSENT_VERSION || !challenge.consentAt)
      throw new ApiError(422, "Fresh explicit consent is required.");
    extracted = await provider.extractSamples(samples);
    embedding = meanEmbedding(extracted.embeddings);
    // The partial unique challenge index serializes company enrollment checks.
    const rows = M.BiometricEnrollment.find({
      company: user.company,
      provider: provider.PROVIDER,
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
          template.modelVersion === extracted.modelVersion &&
          provider.compare(template.embedding, embedding) >=
            provider.configuration().similarityThreshold
        )
          throw new ApiError(
            409,
            "This face is already enrolled in this company. Contact Admin.",
          );
      } finally {
        template.embedding.fill(0);
      }
    }
    const result = await C.transaction(async (session) => {
      await lockAccount(user, session);
      const person = await M.Employee.findOneAndUpdate(
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
      if (await M.BiometricEnrollment.exists(filter).session(session))
        throw new ApiError(409, "An enrollment already exists.");
      await consume(challenge, user, session);
      const [row] = await M.BiometricEnrollment.create(
        [
          {
            ...filter,
            provider: provider.PROVIDER,
            status: "active",
            modelVersion: extracted.modelVersion,
            protectedTemplate: protectTemplate(
              {
                provider: provider.PROVIDER,
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
        provider: provider.PROVIDER,
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
    const enrollment = await M.BiometricEnrollment.findOne({
      ...filter,
      provider: provider.PROVIDER,
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
    extracted = await provider.extractSamples(samples);
    meanEmbedding(extracted.embeddings).fill(0);
    if (template.modelVersion !== extracted.modelVersion)
      throw new ApiError(
        422,
        "The recognition model changed. Delete and renew your enrollment.",
      );
    const similarity = Math.min(
      ...extracted.embeddings.map((e) =>
        provider.compare(template.embedding, e),
      ),
    );
    if (similarity < provider.configuration().similarityThreshold)
      throw new ApiError(
        422,
        "The captured face does not match your enrollment. No attendance was recorded.",
      );
    return await C.transaction(async (session) => {
      await lockAccount(user, session);
      const active = await M.BiometricEnrollment.findOneAndUpdate(
        {
          _id: enrollment._id,
          ...filter,
          provider: provider.PROVIDER,
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
          provider: provider.PROVIDER,
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
  return C.transaction(async (session) => {
    const row = await M.BiometricEnrollment.findOneAndUpdate(
      filter,
      { status: "deleting", deleteRequestedAt: new Date(), $inc: { __v: 1 } },
      { returnDocument: "after", session },
    );
    await M.BiometricChallenge.updateMany(
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
    if (row.provider !== provider.PROVIDER) {
      await M.BiometricEnrollment.updateOne(
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
    await M.BiometricEnrollment.deleteOne(
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
  const exited = await M.Employee.find({ company: companyId, status: "exited" })
    .select("_id")
    .lean();
  const inactive = await M.User.find({
    company: companyId,
    active: false,
    employee: { $ne: null },
  })
    .select("employee")
    .lean();
  const rows = await M.BiometricEnrollment.find({
    company: companyId,
    provider: provider.PROVIDER,
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
