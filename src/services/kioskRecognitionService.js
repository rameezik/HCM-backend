const models = require("../models");
const context = require("./context");
const ApiError = require("../utils/ApiError");
const terminalAccess = require("./kioskAccessService");
const faceProvider = require("./localFaceProvider");
const {
  CONSENT_VERSION: PRIVATE_CONSENT_VERSION,
} = require("./biometricService");
const {
  readEncryptionKey,
  protectTemplate,
  revealTemplate,
} = require("./biometricTemplate");
const { samplesMatch, averageEmbedding } = require("./faceEmbeddings");
const { writeAttendance, geofence } = require("./attendanceWriter");

const CONSENT_VERSION = "2026-10-25-kiosk-v1";
const NOTICE =
  "I consent to matching my live camera samples against my existing employee profile photo and storing an encrypted local face template for identification at my company's attendance terminals. YuNet and SFace run on the company's own server; no cloud biometric API is used. Camera images are processed transiently, not saved. My existing profile photo remains subject to the employee photo policy. This system does not provide robust liveness, camera provenance or protection against photographs, replay or injected video. I can delete enrollment through my account or ask Admin to delete it, and use authorized manual attendance without biometric consent. Enrollment expires under the company's retention policy; backups have a separate operator-managed retention schedule.";
const sameDate = (left, right) =>
  Boolean(
    left && right && new Date(left).getTime() === new Date(right).getTime(),
  );
const personView = (person) => ({ name: person.name, code: person.code });

function configuration(config = faceProvider.configuration()) {
  const missing = [...config.missing];
  try {
    readEncryptionKey().fill(0);
  } catch {
    missing.push("BIOMETRIC_TEMPLATE_KEY");
  }
  const threshold = Number(process.env.KIOSK_MATCH_THRESHOLD?.trim() || 0.55);
  const margin = Number(process.env.KIOSK_MATCH_MARGIN?.trim() || 0.08);
  const cooldownSeconds = Number(
    process.env.KIOSK_SCAN_COOLDOWN_SECONDS?.trim() || 30,
  );
  if (!Number.isFinite(threshold) || threshold < 0.55 || threshold > 0.99)
    missing.push("KIOSK_MATCH_THRESHOLD");
  if (!Number.isFinite(margin) || margin < 0.05 || margin > 0.5)
    missing.push("KIOSK_MATCH_MARGIN");
  if (
    !Number.isInteger(cooldownSeconds) ||
    cooldownSeconds < 5 ||
    cooldownSeconds > 300
  )
    missing.push("KIOSK_SCAN_COOLDOWN_SECONDS");
  return {
    ...config,
    configured: missing.length === 0,
    missing,
    threshold,
    margin,
    cooldownSeconds,
  };
}
async function readiness() {
  return configuration(await faceProvider.readiness());
}
function requireConfiguration() {
  const config = configuration();
  if (!config.configured) {
    const error = new ApiError(
      503,
      "Face attendance is not configured. Admin must install the YuNet/SFace models and Python runtime, and configure BIOMETRIC_TEMPLATE_KEY. Ordinary portal attendance remains available.",
    );
    error.code = "BIOMETRIC_NOT_CONFIGURED";
    throw error;
  }
  return config;
}
async function status(device) {
  const config = await readiness();
  const company = await models.Company.findOne({ _id: device.company })
    .select("latitude longitude radius")
    .lean();
  let officeConfigured = true;
  try {
    if (!company) throw new Error("Company unavailable");
    geofence(
      {
        latitude: device.office?.latitude,
        longitude: device.office?.longitude,
        accuracy: 0,
      },
      company,
    );
  } catch {
    officeConfigured = false;
  }
  const registeredEmployees = (await findEligibleEmployees(device)).length;
  return {
    paired: true,
    companyName: device.companyName,
    deviceLabel: device.label,
    configured: config.configured && officeConfigured,
    officeConfigured,
    registeredEmployees,
    missingConfiguration: [
      ...config.missing,
      ...(officeConfigured ? [] : ["OFFICE_LOCATION"]),
    ],
    unavailableReason: !officeConfigured
      ? "The office location changed. Ask Admin to reconnect this terminal."
      : !config.configured
        ? "Face attendance is not configured. Ask Admin to check the recognition service."
        : "",
    setupIssues: officeConfigured
      ? []
      : [
          {
            code: "OFFICE_LOCATION",
            message:
              "The office location changed. Ask Admin to update settings and reconnect this terminal.",
          },
        ],
    consent: {
      version: CONSENT_VERSION,
      notice: NOTICE,
      retentionDays: config.retentionDays,
    },
    capture: { samples: 3, maxWidth: 640, maxImageBytes: 250000 },
    liveness: {
      supported: false,
      notice:
        "Identity matching does not prove physical presence or prevent photograph/video replay.",
    },
  };
}
function buildEnrollmentEmbedding(embeddings, threshold) {
  if (embeddings.length !== 3) {
    throw new ApiError(422, "Three usable camera samples are required.");
  }
  if (!samplesMatch(embeddings, threshold)) {
    throw new ApiError(
      422,
      "The camera samples do not show one consistent identity. Retry with one face and good lighting.",
    );
  }
  const embedding = averageEmbedding(embeddings);
  if (!embedding) throw new ApiError(422, "The face samples are not usable.");
  return embedding;
}
async function audit(device, action, details, session, user) {
  return context.audit(
    session,
    user || { company: device.company },
    action,
    "KioskDevice",
    null,
    { _id: device._id, ...details },
  );
}
async function recordFailure(device, challenge, error, grant) {
  const reason =
    error.status === 422
      ? "identity_rejected"
      : error.status === 429
        ? "rate_limited"
        : "operation_failed";
  await terminalAccess.failChallenge(device, challenge, reason);
  if (grant) await terminalAccess.failEnrollmentGrant(device, grant, reason);
  await audit(device, "kiosk_scan_failed", {
    challengeId: challenge._id,
    purpose: challenge.purpose,
    reason,
  });
}
function clearCameraEmbeddings(extracted) {
  extracted?.embeddings?.forEach((vector) => vector.fill(0));
}
async function findGrantedEmployee(device, grant, session) {
  const person = await models.Employee.findOne({
    _id: grant.employee,
    company: device.company,
    user: grant.user,
    status: { $ne: "exited" },
  })
    .select("+photo")
    .session(session || null);
  const user = await models.User.findOne({
    _id: grant.user,
    company: device.company,
    employee: grant.employee,
    active: true,
    tokenVersion: grant.userTokenVersion,
  }).session(session || null);
  if (
    !person?.photo?.length ||
    !user ||
    !sameDate(person.photoUpdatedAt, grant.photoUpdatedAt)
  )
    throw new ApiError(
      422,
      "The employee photo or account changed. Ask Admin for new enrollment terminalAccess.",
    );
  return { person, user };
}
async function lockGrantedEmployee(device, grant, session) {
  // Serialize public enrollment within the company before checking duplicates.
  const company = await models.Company.findOneAndUpdate(
    { _id: device.company },
    { $inc: { __v: 1 } },
    { session, returnDocument: "after" },
  );
  if (!company) throw new ApiError(403, "This company is unavailable.");
  await terminalAccess.lockDevice(device, session);
  const { person: current, user } = await findGrantedEmployee(
    device,
    grant,
    session,
  );
  const locked = await models.Employee.updateOne(
    {
      _id: current._id,
      company: device.company,
      photoUpdatedAt: grant.photoUpdatedAt,
    },
    { $inc: { __v: 1 } },
    { session },
  );
  if (locked.matchedCount !== 1)
    throw new ApiError(
      409,
      "The employee photo changed. Retry with new enrollment terminalAccess.",
    );
  const activeUser = await models.User.updateOne(
    {
      _id: user._id,
      company: device.company,
      active: true,
      tokenVersion: grant.userTokenVersion,
    },
    { $inc: { __v: 1 } },
    { session },
  );
  if (activeUser.matchedCount !== 1)
    throw new ApiError(403, "This employee account changed.");
  return { company, current, user };
}

async function rejectDuplicateCameraEnrollment(
  device,
  current,
  embedding,
  threshold,
  session,
) {
  const rows = await models.BiometricEnrollment.find({
    company: device.company,
    employee: { $ne: current._id },
    provider: faceProvider.PROVIDER,
    status: "active",
    expiresAt: { $gt: new Date() },
  })
    .select("+protectedTemplate")
    .session(session);
  for (const row of rows) {
    const template = revealTemplate(
      row.protectedTemplate,
      device.company,
      row.employee,
    );
    try {
      if (
        template.modelVersion === faceProvider.MODEL_VERSION &&
        faceProvider.compare(template.embedding, embedding) >= threshold
      )
        throw new ApiError(
          409,
          "This face is already enrolled for another employee in this company. Contact Admin.",
        );
    } finally {
      template.embedding.fill(0);
    }
  }
}

async function saveCameraTemplate(
  device,
  current,
  company,
  embedding,
  config,
  session,
) {
  const previous = await models.BiometricEnrollment.findOne({
    company: device.company,
    employee: current._id,
  }).session(session);
  if (
    previous &&
    (previous.provider !== faceProvider.PROVIDER ||
      previous.status !== "active")
  )
    throw new ApiError(
      409,
      "Delete the previous enrollment before enrolling again.",
    );
  const now = new Date();
  const days = Math.min(
    config.retentionDays,
    Math.max(1, Math.min(365, company.biometricRetentionDays || 365)),
  );
  const expiresAt = new Date(now.getTime() + days * 86400000);
  const enrollmentValues = {
    provider: faceProvider.PROVIDER,
    modelVersion: faceProvider.MODEL_VERSION,
    status: "active",
    protectedTemplate: protectTemplate(
      {
        provider: faceProvider.PROVIDER,
        modelVersion: faceProvider.MODEL_VERSION,
        embedding,
      },
      device.company,
      current._id,
    ),
    consentAt: now,
    consentVersion: PRIVATE_CONSENT_VERSION,
    enrolledAt: now,
    expiresAt,
    kioskEnabled: true,
    kioskConsentAt: now,
    kioskConsentVersion: CONSENT_VERSION,
    kioskPhotoUpdatedAt: current.photoUpdatedAt,
    terminalEnrollmentSource: "camera",
  };
  // The company plugin intersects query predicates. Avoid upsert inference on
  // repeated company equality clauses; persist ownership explicitly on create.
  const row = previous
    ? await models.BiometricEnrollment.findOneAndUpdate(
        {
          _id: previous._id,
          company: device.company,
          employee: current._id,
        },
        {
          $set: enrollmentValues,
          $unset: {
            terminalConsentVersion: 1,
            terminalConsentRecordedBy: 1,
          },
        },
        { session, returnDocument: "after", runValidators: true },
      )
    : (
        await models.BiometricEnrollment.create(
          [
            {
              company: device.company,
              employee: current._id,
              ...enrollmentValues,
            },
          ],
          { session },
        )
      )[0];
  return { row, expiresAt };
}

async function completeEnrollment(device, body) {
  const config = requireConfiguration();
  if (body.consent !== true || body.consentVersion !== CONSENT_VERSION)
    throw new ApiError(
      422,
      "Read and accept the current biometric consent notice before enrollment.",
    );
  const challenge = await terminalAccess.claimChallenge(
    device,
    body.challengeId,
    "enroll",
  );
  let grant, extracted, portrait, embedding;
  try {
    grant = await terminalAccess.claimEnrollmentGrant(
      device,
      body.enrollmentCode,
    );
    const { person } = await findGrantedEmployee(device, grant);
    extracted = await faceProvider.extractSamples(body.samples);
    embedding = buildEnrollmentEmbedding(
      extracted.embeddings,
      config.threshold,
    );
    portrait = await faceProvider.extractSamples([
      person.photo.toString("base64"),
    ]);
    if (
      extracted.embeddings.some(
        (v) =>
          faceProvider.compare(v, portrait.embeddings[0]) < config.threshold,
      )
    )
      throw new ApiError(
        422,
        "The live face does not match this employee's saved profile photo. Ask Admin to check the photo or use manual attendance.",
      );
    return await context.transaction(async (session) => {
      const { company, current, user } = await lockGrantedEmployee(
        device,
        grant,
        session,
      );
      await rejectDuplicateCameraEnrollment(
        device,
        current,
        embedding,
        config.threshold,
        session,
      );
      const { row, expiresAt } = await saveCameraTemplate(
        device,
        current,
        company,
        embedding,
        config,
        session,
      );
      await terminalAccess.consumeEnrollmentGrant(device, grant, session);
      await terminalAccess.consumeChallenge(device, challenge, session);
      await audit(
        device,
        "kiosk_employee_enrolled",
        {
          employee: current._id,
          enrollmentId: row._id,
          consentVersion: CONSENT_VERSION,
          expiresAt,
        },
        session,
        user,
      );
      return {
        enrollment: { enrolled: true, kioskEnabled: true, expiresAt },
        employee: personView(current),
        message: "Face attendance enabled. You can scan without signing in.",
      };
    });
  } catch (error) {
    await recordFailure(device, challenge, error, grant);
    throw error;
  } finally {
    clearCameraEmbeddings(extracted);
    clearCameraEmbeddings(portrait);
    embedding?.fill(0);
  }
}
async function findEligibleEmployees(device) {
  const rows = await models.BiometricEnrollment.find({
    company: device.company,
    provider: faceProvider.PROVIDER,
    modelVersion: faceProvider.MODEL_VERSION,
    status: "active",
    expiresAt: { $gt: new Date() },
    consentVersion: PRIVATE_CONSENT_VERSION,
    kioskEnabled: true,
    kioskConsentVersion: CONSENT_VERSION,
  })
    .select("+protectedTemplate")
    .limit(1501)
    .lean();
  if (rows.length > 1500)
    throw new ApiError(
      503,
      "This company has more face records than the terminal can process. Contact Admin or use manual attendance.",
    );
  const ids = rows.map((row) => row.employee);
  const people = await models.Employee.find({
    company: device.company,
    _id: { $in: ids },
    status: { $ne: "exited" },
  }).lean();
  const users = await models.User.find({
    company: device.company,
    employee: { $in: ids },
    active: true,
  }).lean();
  const peopleById = new Map(people.map((p) => [String(p._id), p]));
  const usersByEmployee = new Map(users.map((u) => [String(u.employee), u]));
  return rows.flatMap((row) => {
    const person = peopleById.get(String(row.employee)),
      user = usersByEmployee.get(String(row.employee));
    return person &&
      user &&
      String(person.user) === String(user._id) &&
      sameDate(row.kioskPhotoUpdatedAt, person.photoUpdatedAt)
      ? [{ row, person, user }]
      : [];
  });
}
async function matchEmployees(device, embeddings) {
  const matches = [];
  for (const candidate of await findEligibleEmployees(device)) {
    const template = revealTemplate(
      candidate.row.protectedTemplate,
      device.company,
      candidate.row.employee,
    );
    try {
      if (template.modelVersion !== faceProvider.MODEL_VERSION) continue;
      matches.push({
        ...candidate,
        score: Math.min(
          ...embeddings.map((v) => faceProvider.compare(v, template.embedding)),
        ),
      });
    } finally {
      template.embedding.fill(0);
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return matches;
}

async function lockMatchedAccount(device, best, session) {
  const user = await models.User.findOneAndUpdate(
    {
      _id: best.user._id,
      company: device.company,
      employee: best.person._id,
      active: true,
      tokenVersion: best.user.tokenVersion,
    },
    { $inc: { __v: 1 } },
    { session, returnDocument: "after" },
  );
  if (!user)
    throw new ApiError(
      403,
      "This employee account changed. Scan again or contact Admin.",
    );
  return user;
}

async function lockMatchedEnrollment(device, best, session) {
  const enrollment = await models.BiometricEnrollment.updateOne(
    {
      _id: best.row._id,
      company: device.company,
      employee: best.person._id,
      status: "active",
      kioskEnabled: true,
      kioskConsentVersion: CONSENT_VERSION,
      modelVersion: faceProvider.MODEL_VERSION,
      kioskPhotoUpdatedAt: best.person.photoUpdatedAt,
      updatedAt: best.row.updatedAt,
      expiresAt: { $gt: new Date() },
    },
    { $set: { lastVerifiedAt: new Date() }, $inc: { __v: 1 } },
    { session },
  );
  if (enrollment.matchedCount !== 1)
    throw new ApiError(
      409,
      "This face enrollment changed or was deleted. Start a new scan.",
    );
}

async function claimEmployeeScan(device, best, user, cooldownSeconds, session) {
  const now = new Date();
  const person = await models.Employee.findOneAndUpdate(
    {
      _id: best.person._id,
      company: device.company,
      user: user._id,
      status: { $ne: "exited" },
      photoUpdatedAt: best.row.kioskPhotoUpdatedAt,
      $or: [
        {
          kioskLastAttendanceAt: {
            $lte: new Date(now.getTime() - cooldownSeconds * 1000),
          },
        },
        { kioskLastAttendanceAt: null },
      ],
    },
    { $set: { kioskLastAttendanceAt: now } },
    { session, returnDocument: "after" },
  );
  if (!person)
    throw new ApiError(
      429,
      `Please wait ${cooldownSeconds} seconds between attendance scans. If your profile photo changed, ask Admin to enroll again.`,
    );
  return person;
}

async function completeAttendance(device, body) {
  const config = requireConfiguration();
  const challenge = await terminalAccess.claimChallenge(
    device,
    body.challengeId,
    body.action,
  );
  let extracted, embedding;
  try {
    extracted = await faceProvider.extractSamples(body.samples);
    embedding = buildEnrollmentEmbedding(
      extracted.embeddings,
      config.threshold,
    );
    const matches = await matchEmployees(device, extracted.embeddings);
    const best = matches[0];
    if (
      !best ||
      best.score < config.threshold ||
      (matches[1] && best.score - matches[1].score < config.margin)
    ) {
      await terminalAccess.failChallenge(
        device,
        challenge,
        "unregistered_profile",
      );
      await audit(device, "kiosk_face_unregistered", {
        challengeId: challenge._id,
        purpose: challenge.purpose,
      });
      return {
        matched: false,
        code: "UNREGISTERED_PROFILE",
        message: "Record not found",
      };
    }
    return await context.transaction(async (session) => {
      await terminalAccess.lockDevice(device, session);
      const user = await lockMatchedAccount(device, best, session);
      await lockMatchedEnrollment(device, best, session);
      const person = await claimEmployeeScan(
        device,
        best,
        user,
        config.cooldownSeconds,
        session,
      );
      const row = await writeAttendance(user, body.action, {
        session,
        kioskDevice: device,
        verification: {
          method: "face",
          provider: faceProvider.PROVIDER,
          modelVersion: faceProvider.MODEL_VERSION,
          challengeId: challenge._id,
          kioskDevice: device._id,
          similarity: best.score,
          similarityMetric: "cosine",
          livenessVerified: false,
          locationSource: "paired-kiosk",
        },
        location: {
          latitude: device.office?.latitude,
          longitude: device.office?.longitude,
          accuracy: 0,
        },
      });
      await terminalAccess.consumeChallenge(device, challenge, session);
      await audit(
        device,
        "kiosk_attendance_recorded",
        {
          employee: person._id,
          attendanceId: row._id,
          attendanceAction: body.action,
          challengeId: challenge._id,
        },
        session,
        user,
      );
      return {
        matched: true,
        action: body.action,
        employee: personView(person),
        attendance: {
          date: row.date,
          checkIn: row.checkIn,
          checkOut: row.checkOut,
          hours: row.hours,
          status: row.status,
          verificationMethod: row.verificationMethod,
        },
        cooldownSeconds: config.cooldownSeconds,
        message:
          body.action === "check-in"
            ? "Attendance check-in recorded."
            : "Attendance check-out recorded.",
      };
    });
  } catch (error) {
    await recordFailure(device, challenge, error);
    throw error;
  } finally {
    clearCameraEmbeddings(extracted);
    embedding?.fill(0);
  }
}
module.exports = {
  status,
  completeEnrollment,
  completeAttendance,
  CONSENT_VERSION,
  configuration,
  readiness,
  requireConfiguration,
};
