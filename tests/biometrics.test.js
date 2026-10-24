const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const M = require("../src/models");
const service = require("../src/services/biometricService");
const provider = require("../src/services/localFaceProvider");
const names = [
  "BIOMETRIC_MODEL_DIR", "BIOMETRIC_PYTHON_PATH", "BIOMETRIC_TEMPLATE_KEY",
  "BIOMETRIC_TEMPLATE_KEY_ID", "BIOMETRIC_RETENTION_DAYS", "BIOMETRIC_MATCH_THRESHOLD",
];
const originals = Object.fromEntries(names.map((name) => [name, process.env[name]]));
function clearConfiguration() { for (const name of names) delete process.env[name]; }
function staticTestConfiguration() {
  clearConfiguration();
  process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString("base64");
}
function restoreConfiguration() {
  for (const name of names) {
    if (originals[name] === undefined) delete process.env[name];
    else process.env[name] = originals[name];
  }
}
// Deterministic vectors test encryption and storage only. They are never used to
// claim that a person was recognized; actual-model tests live in another file.
const templateFixture = () => ({ provider: provider.PROVIDER, modelVersion: provider.MODEL_VERSION,
  embedding: Array.from({ length: 128 }, (_, index) => index === 0 ? 1 : 0) });

test("AES-GCM local templates authenticate ciphertext, company, employee and key version", () => {
  staticTestConfiguration();
  try {
    const company = new mongoose.Types.ObjectId(), employee = new mongoose.Types.ObjectId();
    const template = templateFixture();
    const protectedTemplate = service.protectTemplate(template, company, employee);
    assert.ok(!JSON.stringify(protectedTemplate).includes('"embedding"'));
    assert.deepEqual(service.revealTemplate(protectedTemplate, company, employee), template);
    assert.throws(() => service.revealTemplate(protectedTemplate, new mongoose.Types.ObjectId(), employee), { status: 503 });
    assert.throws(() => service.revealTemplate(protectedTemplate, company, new mongoose.Types.ObjectId()), { status: 503 });
    assert.throws(() => service.revealTemplate({ ...protectedTemplate, tag: crypto.randomBytes(16).toString("base64") }, company, employee), { status: 503 });
    assert.throws(() => service.revealTemplate({ ...protectedTemplate, keyVersion: "unavailable-version" }, company, employee), { status: 503 });
    const malformed = service.protectTemplate({ ...template, embedding: [1] }, company, employee);
    assert.throws(() => service.revealTemplate(malformed, company, employee), { status: 503 });
    process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString("base64");
    assert.throws(() => service.revealTemplate(protectedTemplate, company, employee), { status: 503 });
  } finally { restoreConfiguration(); }
});

test("local biometric APIs fail closed, protect templates and enforce company-owned deletion", async (t) => {
  clearConfiguration();
  const previousJwt = process.env.JWT_SECRET;
  process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
  const dbName = `hcm_test_biometrics_${process.pid}_${Date.now()}`;
  await mongoose.connect(process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=hcm", { dbName, serverSelectionTimeoutMS: 10000 });
  await Promise.all(Object.values(M).map((Model) => Model.init()));
  const server = require("../src/app").listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    restoreConfiguration();
    if (previousJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwt;
  });
  const company = await M.Company.create({ singleton: "biometric-one", name: "Biometric isolation test company" });
  const otherCompany = await M.Company.create({ singleton: "biometric-two", name: "Other isolation test company" });
  const employeeId = new mongoose.Types.ObjectId(), otherEmployeeId = new mongoose.Types.ObjectId();
  const user = await M.User.create({ company: company._id, name: "Biometric employee fixture", email: "biometric@example.test", role: "employee", employee: employeeId,
    passwordHash: crypto.randomBytes(48).toString("hex"), mustChangePassword: false });
  const admin = await M.User.create({ company: otherCompany._id, name: "Other company admin fixture", email: "other-biometric@example.test", role: "admin",
    passwordHash: crypto.randomBytes(48).toString("hex"), mustChangePassword: false });
  const department = await M.Department.create({ company: company._id, name: "Biometric testing department" });
  const designation = await M.Designation.create({ company: company._id, name: "Biometric testing role" });
  await M.Employee.create({ _id: employeeId, company: company._id, user: user._id, code: "BIOTEST1", name: user.name, email: user.email,
    department: department._id, designation: designation._id, joinDate: "2020-01-01", basic: 100000 });
  const token = (account) => jwt.sign({ sub: String(account._id), version: account.tokenVersion, company: String(account.company) }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
  async function request(account, endpoint, method = "GET", body, expected = 200) {
    const response = await fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${token(account)}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const output = await response.json();
    assert.equal(response.status, expected, `${method} ${endpoint}: ${JSON.stringify(output)}`);
    return output;
  }
  async function createLocalEnrollment(overrides = {}) {
    return M.BiometricEnrollment.create({ company: company._id, employee: employeeId, provider: provider.PROVIDER, status: "active", modelVersion: provider.MODEL_VERSION,
      protectedTemplate: service.protectTemplate(templateFixture(), company._id, employeeId), consentAt: new Date(), consentVersion: service.CONSENT_VERSION,
      enrolledAt: new Date(), expiresAt: new Date(Date.now() + 86400000), ...overrides });
  }

  await t.test("missing model files return a configuration error and cannot create attendance", async () => {
    staticTestConfiguration();
    process.env.BIOMETRIC_MODEL_DIR = path.join("/tmp", `hcm-nonexistent-models-${crypto.randomUUID()}`);
    try {
      const status = await request(user, "/biometrics/status");
      assert.equal(status.configured, false);
      assert.equal(status.enrollment.enrolled, false);
      assert.equal(status.provider, provider.PROVIDER);
      assert.equal(status.integrationStatus, "configuration-required");
      assert.equal(status.liveness.supported, false);
      assert.match(status.unavailableReason, /local models\/runtime|local models|local.*model/i);
      await request(user, "/biometrics/challenges", "POST", { purpose: "enroll", consent: true, consentVersion: service.CONSENT_VERSION }, 503);
      assert.equal(await M.Attendance.countDocuments(), 0);
      assert.equal(await M.BiometricChallenge.countDocuments(), 0);
    } finally { clearConfiguration(); }
  });
  await t.test("client success flags, descriptors and unstructured image uploads cannot approve attendance", async () => {
    await request(user, "/biometrics/attendance", "POST", { challengeId: String(new mongoose.Types.ObjectId()), action: "check-in", verified: true }, 422);
    await request(user, "/biometrics/enrollment", "POST", { challengeId: String(new mongoose.Types.ObjectId()), embedding: templateFixture().embedding }, 422);
    await request(user, "/biometrics/enrollment", "POST", { challengeId: String(new mongoose.Types.ObjectId()), image: "not-an-authorized-camera-sample" }, 422);
    await request(admin, "/biometrics/challenges", "POST", { purpose: "enroll", consent: true, consentVersion: service.CONSENT_VERSION }, 403);
    assert.equal(await M.Attendance.countDocuments(), 0);
  });
  let enrollment;
  await t.test("fresh explicit consent and existing-enrollment checks run before local inference", async () => {
    staticTestConfiguration();
    assert.equal(provider.configuration().configured, true, "Install the real local models/runtime with npm run setup:face before running this suite");
    await request(user, "/biometrics/challenges", "POST", { purpose: "enroll" }, 422);
    await request(user, "/biometrics/challenges", "POST", { purpose: "enroll", consent: true, consentVersion: "obsolete-consent" }, 422);
    enrollment = await createLocalEnrollment();
    await request(user, "/biometrics/challenges", "POST", { purpose: "enroll", consent: true, consentVersion: service.CONSENT_VERSION }, 409);
    const status = await request(user, "/biometrics/status");
    assert.equal(status.enrollment.enrolled, true);
    assert.equal(status.configured, true);
    assert.equal(status.liveness.supported, false);
    for (const secret of ["protectedTemplate", "ciphertext", '"embedding"']) assert.ok(!JSON.stringify(status).includes(secret));
    const ordinary = await request(user, "/employees");
    assert.ok(!JSON.stringify(ordinary).includes("protectedTemplate"));
    assert.ok(!JSON.stringify(ordinary).includes("ciphertext"));
    const plainRow = await M.BiometricEnrollment.findById(enrollment._id).lean();
    assert.equal(plainRow.protectedTemplate, undefined);
    clearConfiguration();
  });
  await t.test("cross-company and employee-authorized deletion cannot remove another employee's enrollment", async () => {
    await request(user, `/biometrics/enrollment/${otherEmployeeId}`, "DELETE", undefined, 403);
    await request(admin, `/biometrics/enrollment/${employeeId}`, "DELETE");
    assert.ok(await M.BiometricEnrollment.exists({ _id: enrollment._id, company: company._id }));
    assert.equal((await request(admin, "/biometrics/status")).enrollment.enrolled, false);
  });
  await t.test("withdrawal deletes encrypted local templates without a decryption key and invalidates pending challenges", async () => {
    await M.BiometricChallenge.create([
      { company: company._id, employee: employeeId, user: user._id, provider: provider.PROVIDER, purpose: "check-in", state: "created", expiresAt: new Date(Date.now() + 60000) },
      { company: company._id, employee: employeeId, user: user._id, provider: provider.PROVIDER, purpose: "check-out", state: "verifying", expiresAt: new Date(Date.now() + 60000) },
    ]);
    assert.equal(process.env.BIOMETRIC_TEMPLATE_KEY, undefined);
    const result = await request(user, "/biometrics/enrollment", "DELETE");
    assert.equal(result.deleted, true);
    assert.equal(result.status, "not-enrolled");
    assert.equal(await M.BiometricEnrollment.findById(enrollment._id).select("+protectedTemplate"), null);
    assert.equal((await request(user, "/biometrics/status")).enrollment.enrolled, false);
    assert.equal(await M.BiometricChallenge.countDocuments({ employee: employeeId, state: { $in: ["created", "verifying"] } }), 0);
    assert.equal(await M.BiometricChallenge.countDocuments({ employee: employeeId, state: "failed", failureCode: "consent_withdrawn" }), 2);
    const audit = await M.AuditLog.find({ company: company._id }).lean();
    assert.ok(audit.some((entry) => entry.action === "biometric_deletion_requested"));
    assert.ok(audit.some((entry) => entry.action === "biometric_deleted"));
    assert.ok(!JSON.stringify(audit).includes("protectedTemplate"));
    assert.ok(!JSON.stringify(audit).includes("ciphertext"));
    assert.equal(await M.Attendance.countDocuments(), 0);
  });
  await t.test("retention notice uses the stricter company policy and server cap", async () => {
    await M.Company.updateOne({ _id: company._id }, { biometricRetentionDays: 30 });
    process.env.BIOMETRIC_RETENTION_DAYS = "60";
    assert.equal((await request(user, "/biometrics/status")).consent.retentionDays, 30);
    process.env.BIOMETRIC_RETENTION_DAYS = "10";
    assert.equal((await request(user, "/biometrics/status")).consent.retentionDays, 10);
    clearConfiguration();
  });
  await t.test("retention sweep deletes expired local templates without keys and preserves other-company data", async () => {
    staticTestConfiguration();
    const expired = await createLocalEnrollment({ expiresAt: new Date(Date.now() - 10000) });
    const other = await M.BiometricEnrollment.create({ company: otherCompany._id, employee: otherEmployeeId, provider: provider.PROVIDER, status: "active", modelVersion: provider.MODEL_VERSION,
      protectedTemplate: service.protectTemplate(templateFixture(), otherCompany._id, otherEmployeeId), consentAt: new Date(), consentVersion: service.CONSENT_VERSION,
      enrolledAt: new Date(), expiresAt: new Date(Date.now() - 10000) });
    clearConfiguration();
    assert.equal((await service.cleanupCompany(company._id)).processed, 1);
    assert.equal(await M.BiometricEnrollment.findById(expired._id), null);
    assert.ok(await M.BiometricEnrollment.exists({ _id: other._id }));
  });
  await t.test("legacy cloud enrollment is disabled and retains opaque cleanup metadata without claiming provider deletion", async () => {
    const protectedReference = { ciphertext: crypto.randomBytes(64).toString("base64"), iv: crypto.randomBytes(12).toString("base64"), tag: crypto.randomBytes(16).toString("base64"), keyVersion: "legacy-fixture" };
    const legacy = await M.BiometricEnrollment.create({ company: company._id, employee: employeeId, provider: "aws-rekognition", status: "active", protectedReference,
      consentAt: new Date(), consentVersion: "legacy-consent", enrolledAt: new Date(), expiresAt: new Date(Date.now() + 86400000) });
    const status = await request(user, "/biometrics/status");
    assert.equal(status.enrollment.enrolled, false);
    assert.equal(status.enrollment.status, "legacy-enrollment-requires-cleanup");
    assert.ok(!JSON.stringify(status).includes("ciphertext"));
    const result = await request(user, "/biometrics/enrollment", "DELETE", undefined, 202);
    assert.equal(result.deleted, false);
    assert.equal(result.status, "legacy-cleanup-required");
    const stored = await M.BiometricEnrollment.findById(legacy._id).select("+protectedReference");
    assert.equal(stored.status, "delete_failed");
    assert.equal(stored.protectedReference.ciphertext, protectedReference.ciphertext);
    assert.equal(await M.Attendance.countDocuments(), 0);
  });
});
