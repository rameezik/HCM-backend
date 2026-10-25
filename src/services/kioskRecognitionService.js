const M = require("../models");
const C = require("./context");
const ApiError = require("../utils/ApiError");
const access = require("./kioskAccessService");
const provider = require("./localFaceProvider");
const biometrics = require("./biometricService");
const { writeAttendance } = require("./attendanceWriter");

const CONSENT_VERSION = "2026-10-25-kiosk-v1";
const NOTICE = "I consent to matching my live camera samples against my existing employee profile photo and storing an encrypted local face template for identification at my company's shared attendance kiosks. YuNet and SFace run on the company's own server; no cloud biometric API is used. Camera images are processed transiently, not saved. My existing profile photo remains subject to the employee photo policy. This system does not provide robust liveness, camera provenance or protection against photographs, replay or injected video. I can delete enrollment through my account or ask Admin to delete it, and use authorized manual attendance without biometric consent. Enrollment expires under the company's retention policy; backups have a separate operator-managed retention schedule.";
const sameDate = (a, b) => Boolean(a && b && new Date(a).getTime() === new Date(b).getTime());
const personView = (person) => ({ name: person.name, code: person.code });

function configuration() {
  const config = provider.configuration();
  const missing = [...config.missing];
  const key = process.env.BIOMETRIC_TEMPLATE_KEY || "";
  if (!/^[A-Za-z\d+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32)
    missing.push("BIOMETRIC_TEMPLATE_KEY");
  const threshold = Number(process.env.KIOSK_MATCH_THRESHOLD ?? 0.55);
  const margin = Number(process.env.KIOSK_MATCH_MARGIN ?? 0.08);
  const cooldownSeconds = Number(process.env.KIOSK_SCAN_COOLDOWN_SECONDS ?? 30);
  if (!Number.isFinite(threshold) || threshold < 0.55 || threshold > 0.99) missing.push("KIOSK_MATCH_THRESHOLD");
  if (!Number.isFinite(margin) || margin < 0.05 || margin > 0.5) missing.push("KIOSK_MATCH_MARGIN");
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 5 || cooldownSeconds > 300) missing.push("KIOSK_SCAN_COOLDOWN_SECONDS");
  return { ...config, configured: missing.length === 0, missing, threshold, margin, cooldownSeconds };
}
function requireConfiguration() {
  const config = configuration();
  if (!config.configured) {
    const error = new ApiError(503, "Local kiosk recognition is not configured. Admin must install the YuNet/SFace models and Python runtime, and configure BIOMETRIC_TEMPLATE_KEY. Ordinary portal attendance remains available.");
    error.code = "BIOMETRIC_NOT_CONFIGURED";
    throw error;
  }
  return config;
}
async function status(device) {
  const config = configuration();
  return {
    paired: true, companyName: device.companyName, deviceLabel: device.label,
    configured: config.configured, missingConfiguration: config.missing,
    consent: { version: CONSENT_VERSION, notice: NOTICE, retentionDays: config.retentionDays },
    capture: { samples: 3, maxWidth: 640, maxImageBytes: 250000 },
    liveness: { supported: false, notice: "Identity matching does not prove physical presence or prevent photograph/video replay." },
  };
}
function meanEmbedding(vectors, threshold) {
  if (vectors.length !== 3) throw new ApiError(422, "Three usable camera samples are required.");
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
      if (provider.compare(vectors[i], vectors[j]) < threshold)
        throw new ApiError(422, "The camera samples do not show one consistent identity. Retry with one face and good lighting.");
  const mean = vectors[0].map((_, i) => vectors.reduce((sum, v) => sum + v[i], 0) / 3);
  const norm = Math.hypot(...mean);
  if (norm < 0.001) throw new ApiError(422, "The face samples are not usable.");
  return mean.map((v) => v / norm);
}
async function audit(device, action, details, session, user) {
  return C.audit(session, user || { company: device.company }, action, "KioskDevice", null, { _id: device._id, ...details });
}
async function recordFailure(device, challenge, error, grant) {
  const reason = error.status === 422 ? "identity_rejected" : error.status === 429 ? "rate_limited" : "operation_failed";
  await access.failChallenge(device, challenge, reason);
  if (grant) await access.failEnrollmentGrant(device, grant, reason);
  await audit(device, "kiosk_scan_failed", { challengeId: challenge._id, purpose: challenge.purpose, reason });
}
function wipe(extracted) {
  extracted?.embeddings?.forEach((vector) => vector.fill(0));
}
async function grantPerson(device, grant, session) {
  const person = await M.Employee.findOne({ _id: grant.employee, company: device.company, user: grant.user, status: { $ne: "exited" } })
    .select("+photo").session(session || null);
  const user = await M.User.findOne({ _id: grant.user, company: device.company, employee: grant.employee, active: true, tokenVersion: grant.userTokenVersion })
    .session(session || null);
  if (!person?.photo?.length || !user || !sameDate(person.photoUpdatedAt, grant.photoUpdatedAt))
    throw new ApiError(422, "The employee photo or account changed. Ask Admin for new enrollment access.");
  return { person, user };
}
async function completeEnrollment(device, body) {
  const config = requireConfiguration();
  if (body.consent !== true || body.consentVersion !== CONSENT_VERSION)
    throw new ApiError(422, "Read and accept the current biometric consent notice before enrollment.");
  const challenge = await access.claimChallenge(device, body.challengeId, "enroll");
  let grant, extracted, portrait, embedding;
  try {
    grant = await access.claimEnrollmentGrant(device, body.enrollmentCode);
    const { person } = await grantPerson(device, grant);
    extracted = await provider.extractSamples(body.samples);
    embedding = meanEmbedding(extracted.embeddings, config.threshold);
    portrait = await provider.extractSamples([person.photo.toString("base64")]);
    if (extracted.embeddings.some((v) => provider.compare(v, portrait.embeddings[0]) < config.threshold))
      throw new ApiError(422, "The live face does not match this employee's saved profile photo. Ask Admin to check the photo or use manual attendance.");
    return await C.transaction(async (session) => {
      // Serialize public enrollment within the company before checking duplicates.
      const company = await M.Company.findOneAndUpdate({ _id: device.company }, { $inc: { __v: 1 } }, { session, returnDocument: "after" });
      if (!company) throw new ApiError(403, "This company is unavailable.");
      await access.lockDevice(device, session);
      const { person: current, user } = await grantPerson(device, grant, session);
      const locked = await M.Employee.updateOne({ _id: current._id, company: device.company, photoUpdatedAt: grant.photoUpdatedAt }, { $inc: { __v: 1 } }, { session });
      if (locked.matchedCount !== 1) throw new ApiError(409, "The employee photo changed. Retry with new enrollment access.");
      const activeUser = await M.User.updateOne({ _id: user._id, company: device.company, active: true, tokenVersion: grant.userTokenVersion }, { $inc: { __v: 1 } }, { session });
      if (activeUser.matchedCount !== 1) throw new ApiError(403, "This employee account changed.");
      const rows = await M.BiometricEnrollment.find({ company: device.company, employee: { $ne: current._id }, provider: provider.PROVIDER, status: "active", expiresAt: { $gt: new Date() } })
        .select("+protectedTemplate").session(session);
      for (const row of rows) {
        const template = biometrics.revealTemplate(row.protectedTemplate, device.company, row.employee);
        try {
          if (template.modelVersion === provider.MODEL_VERSION && provider.compare(template.embedding, embedding) >= config.threshold)
            throw new ApiError(409, "This face is already enrolled for another employee in this company. Contact Admin.");
        } finally { template.embedding.fill(0); }
      }
      const previous = await M.BiometricEnrollment.findOne({ company: device.company, employee: current._id }).session(session);
      if (previous && (previous.provider !== provider.PROVIDER || previous.status !== "active"))
        throw new ApiError(409, "Delete the previous enrollment before enrolling again.");
      const now = new Date();
      const days = Math.min(config.retentionDays, Math.max(1, Math.min(365, company.biometricRetentionDays || 365)));
      const expiresAt = new Date(now.getTime() + days * 86400000);
      const enrollmentValues = {
          provider: provider.PROVIDER, modelVersion: provider.MODEL_VERSION, status: "active",
          protectedTemplate: biometrics.protectTemplate({ provider: provider.PROVIDER, modelVersion: provider.MODEL_VERSION, embedding }, device.company, current._id),
          consentAt: now, consentVersion: biometrics.CONSENT_VERSION, enrolledAt: now, expiresAt,
          kioskEnabled: true, kioskConsentAt: now, kioskConsentVersion: CONSENT_VERSION, kioskPhotoUpdatedAt: current.photoUpdatedAt,
      };
      // The company plugin intersects query predicates. Avoid upsert inference on
      // repeated company equality clauses; persist ownership explicitly on create.
      const row = previous
        ? await M.BiometricEnrollment.findOneAndUpdate({ _id: previous._id, company: device.company, employee: current._id }, { $set: enrollmentValues }, { session, returnDocument: "after", runValidators: true })
        : (await M.BiometricEnrollment.create([{ company: device.company, employee: current._id, ...enrollmentValues }], { session }))[0];
      await access.consumeEnrollmentGrant(device, grant, session);
      await access.consumeChallenge(device, challenge, session);
      await audit(device, "kiosk_employee_enrolled", { employee: current._id, enrollmentId: row._id, consentVersion: CONSENT_VERSION, expiresAt }, session, user);
      return { enrollment: { enrolled: true, kioskEnabled: true, expiresAt }, employee: personView(current), message: "Face enrollment completed. You can now scan for attendance without signing in." };
    });
  } catch (error) {
    await recordFailure(device, challenge, error, grant);
    throw error;
  } finally { wipe(extracted); wipe(portrait); embedding?.fill(0); }
}
async function candidates(device) {
  const rows = await M.BiometricEnrollment.find({ company: device.company, provider: provider.PROVIDER, modelVersion: provider.MODEL_VERSION, status: "active", expiresAt: { $gt: new Date() }, consentVersion: biometrics.CONSENT_VERSION, kioskEnabled: true, kioskConsentVersion: CONSENT_VERSION })
    .select("+protectedTemplate").limit(1501).lean();
  if (rows.length > 1500) throw new ApiError(503, "This company's kiosk gallery exceeds the local service capacity. Contact Admin or use manual attendance.");
  const ids = rows.map((row) => row.employee);
  const people = await M.Employee.find({ company: device.company, _id: { $in: ids }, status: { $ne: "exited" } }).lean();
  const users = await M.User.find({ company: device.company, employee: { $in: ids }, active: true }).lean();
  const peopleById = new Map(people.map((p) => [String(p._id), p]));
  const usersByEmployee = new Map(users.map((u) => [String(u.employee), u]));
  return rows.flatMap((row) => {
    const person = peopleById.get(String(row.employee)), user = usersByEmployee.get(String(row.employee));
    return person && user && String(person.user) === String(user._id) && sameDate(row.kioskPhotoUpdatedAt, person.photoUpdatedAt)
      ? [{ row, person, user }] : [];
  });
}
async function completeAttendance(device, body) {
  const config = requireConfiguration();
  const challenge = await access.claimChallenge(device, body.challengeId, body.action);
  let extracted, embedding;
  try {
    extracted = await provider.extractSamples(body.samples);
    embedding = meanEmbedding(extracted.embeddings, config.threshold);
    const matches = [];
    for (const candidate of await candidates(device)) {
      const template = biometrics.revealTemplate(candidate.row.protectedTemplate, device.company, candidate.row.employee);
      try {
        if (template.modelVersion !== provider.MODEL_VERSION) continue;
        matches.push({ ...candidate, score: Math.min(...extracted.embeddings.map((v) => provider.compare(v, template.embedding))) });
      } finally { template.embedding.fill(0); }
    }
    matches.sort((a, b) => b.score - a.score);
    const best = matches[0];
    if (!best || best.score < config.threshold || (matches[1] && best.score - matches[1].score < config.margin)) {
      await access.failChallenge(device, challenge, "unregistered_profile");
      await audit(device, "kiosk_face_unregistered", { challengeId: challenge._id, purpose: challenge.purpose });
      return { matched: false, code: "UNREGISTERED_PROFILE", message: "Unregistered profile" };
    }
    return await C.transaction(async (session) => {
      await access.lockDevice(device, session);
      const user = await M.User.findOneAndUpdate({ _id: best.user._id, company: device.company, employee: best.person._id, active: true, tokenVersion: best.user.tokenVersion }, { $inc: { __v: 1 } }, { session, returnDocument: "after" });
      if (!user) throw new ApiError(403, "This employee account changed. Scan again or contact Admin.");
      const enrollment = await M.BiometricEnrollment.updateOne({ _id: best.row._id, company: device.company, employee: best.person._id, status: "active", kioskEnabled: true, kioskConsentVersion: CONSENT_VERSION, modelVersion: provider.MODEL_VERSION, kioskPhotoUpdatedAt: best.person.photoUpdatedAt, updatedAt: best.row.updatedAt, expiresAt: { $gt: new Date() } }, { $set: { lastVerifiedAt: new Date() }, $inc: { __v: 1 } }, { session });
      if (enrollment.matchedCount !== 1) throw new ApiError(409, "This face enrollment changed or was deleted. Start a new scan.");
      const now = new Date();
      const person = await M.Employee.findOneAndUpdate({ _id: best.person._id, company: device.company, user: user._id, status: { $ne: "exited" }, photoUpdatedAt: best.row.kioskPhotoUpdatedAt, $or: [{ kioskLastAttendanceAt: { $lte: new Date(now.getTime() - config.cooldownSeconds * 1000) } }, { kioskLastAttendanceAt: null }] }, { $set: { kioskLastAttendanceAt: now } }, { session, returnDocument: "after" });
      if (!person) throw new ApiError(429, `Please wait ${config.cooldownSeconds} seconds between attendance scans. If your profile photo changed, ask Admin to enroll again.`);
      const row = await writeAttendance(user, body.action, {
        session, kioskDevice: device,
        verification: { method: "face", provider: provider.PROVIDER, modelVersion: provider.MODEL_VERSION, challengeId: challenge._id, kioskDevice: device._id, similarity: best.score, similarityMetric: "cosine", livenessVerified: false, locationSource: "paired-kiosk" },
        location: { latitude: device.office?.latitude, longitude: device.office?.longitude, accuracy: 0 },
      });
      await access.consumeChallenge(device, challenge, session);
      await audit(device, "kiosk_attendance_recorded", { employee: person._id, attendanceId: row._id, attendanceAction: body.action, challengeId: challenge._id }, session, user);
      return { matched: true, action: body.action, employee: personView(person), attendance: { date: row.date, checkIn: row.checkIn, checkOut: row.checkOut, hours: row.hours, status: row.status, verificationMethod: row.verificationMethod }, cooldownSeconds: config.cooldownSeconds, message: body.action === "check-in" ? "Attendance check-in recorded." : "Attendance check-out recorded." };
    });
  } catch (error) {
    await recordFailure(device, challenge, error);
    throw error;
  } finally { wipe(extracted); embedding?.fill(0); }
}
module.exports = { status, completeEnrollment, completeAttendance, CONSENT_VERSION };
