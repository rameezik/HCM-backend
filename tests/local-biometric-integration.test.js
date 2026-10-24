const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const M = require('../src/models');
const service = require('../src/services/biometricService');
const provider = require('../src/services/localFaceProvider');

// These are documented public-domain photographs used only in an isolated test
// database. They exercise actual inference, not live-camera provenance or PAD.
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/local-face', name)).toString('base64');
const matching = [fixture('astronaut.jpg'), fixture('astronaut-transformed-1.jpg'), fixture('astronaut-transformed-2.jpg')];
const different = [fixture('grace_hopper.jpg'), fixture('grace_hopper-transformed-1.jpg'), fixture('grace_hopper-transformed-2.jpg')];
const location = { latitude: 24.8607, longitude: 67.0011, accuracy: 10 };
const environmentNames = ['JWT_SECRET', 'NODE_ENV', 'AI_API_KEY', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'BIOMETRIC_AWS_REGION', 'BIOMETRIC_COGNITO_IDENTITY_POOL_ID', 'BIOMETRIC_TEMPLATE_KEY', 'BIOMETRIC_MODEL_DIR'];
const originalEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));

function restoreEnvironment() {
  for (const name of environmentNames) {
    if (originalEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnvironment[name];
  }
}

test('real local SFace inference drives isolated encrypted enrollment and attendance APIs without cloud credentials', { timeout: 180000 }, async t => {
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');
  process.env.NODE_ENV = 'test';
  for (const name of ['AI_API_KEY', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'BIOMETRIC_AWS_REGION', 'BIOMETRIC_COGNITO_IDENTITY_POOL_ID']) delete process.env[name];
  t.after(restoreEnvironment);
  assert.equal(provider.configuration().configured, true, 'Run bash scripts/setup-local-face.sh before the genuine local-inference suite.');
  const dbName = `hcm_test_local_face_${process.pid}_${Date.now()}`;
  await mongoose.connect(process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/?replicaSet=hcm', { dbName, serverSelectionTimeoutMS: 10000 });
  t.after(async () => {
    assert.match(mongoose.connection.name, /^hcm_test_local_face_/);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await Promise.all(Object.values(M).map(model => model.init()));
  const server = require('../src/app').listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const company = await M.Company.create({ singleton: `local-face-a-${process.pid}`, name: 'Isolated local-inference fixture A', weekend: [], latitude: location.latitude, longitude: location.longitude, radius: 150 });
  const foreignCompany = await M.Company.create({ singleton: `local-face-b-${process.pid}`, name: 'Isolated local-inference fixture B', weekend: [], latitude: location.latitude, longitude: location.longitude, radius: 150 });
  async function account(companyDoc, suffix, role = 'employee') {
    const department = await M.Department.create({ company: companyDoc._id, name: `Fixture department ${suffix}` });
    const designation = await M.Designation.create({ company: companyDoc._id, name: `Fixture role ${suffix}` });
    const employeeId = new mongoose.Types.ObjectId();
    const user = await M.User.create({ company: companyDoc._id, employee: employeeId, name: `Isolated fixture ${suffix}`, email: `local-${suffix}@example.test`, role, passwordHash: crypto.randomBytes(48).toString('hex'), mustChangePassword: false });
    await M.Employee.create({ _id: employeeId, company: companyDoc._id, user: user._id, name: user.name, code: `LOCAL-${suffix}`, email: user.email, department: department._id, designation: designation._id, joinDate: '2020-01-01', basic: 100000 });
    return user;
  }
  const employee = await account(company, 'owner');
  const foreignEmployee = await account(foreignCompany, 'foreign');
  const manualEmployee = await account(company, 'manual');
  const foreignAdmin = await M.User.create({ company: foreignCompany._id, name: 'Isolated foreign Admin', email: 'local-foreign-admin@example.test', role: 'admin', passwordHash: crypto.randomBytes(48).toString('hex'), mustChangePassword: false });
  function token(user) { return jwt.sign({ sub: String(user._id), company: String(user.company), version: user.tokenVersion }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }); }
  async function request(user, endpoint, method = 'GET', body, expected = 200) {
    const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    // Do not dump image samples, biometric vectors, tokens or encryption material.
    assert.equal(response.status, expected, `${method} ${endpoint}: ${result.message || response.statusText}`);
    return result;
  }
  const challenge = (user, purpose) => request(user, '/biometrics/challenges', 'POST', purpose === 'enroll' ? { purpose, consent: true, consentVersion: service.CONSENT_VERSION } : { purpose }, 201);
  const submitAttendance = (user, session, action, samples = matching, expected = 200) => request(user, '/biometrics/attendance', 'POST', { challengeId: session.challengeId, action, location, samples }, expected);

  await t.test('missing model files fail closed while the non-biometric core remains available', async () => {
    const previous = process.env.BIOMETRIC_MODEL_DIR;
    process.env.BIOMETRIC_MODEL_DIR = path.join(__dirname, 'fixtures/definitely-no-models');
    try {
      const status = await request(employee, '/biometrics/status');
      assert.equal(status.configured, false);
      assert.match(status.unavailableReason, /model|configuration|local/i);
      await request(employee, '/biometrics/challenges', 'POST', { purpose: 'enroll', consent: true, consentVersion: service.CONSENT_VERSION }, 503);
      assert.equal(await M.BiometricChallenge.countDocuments(), 0);
      await request(manualEmployee, '/attendance/check-in', 'POST', {});
      const checkedOut = await request(manualEmployee, '/attendance/check-out', 'POST', {});
      assert.equal(checkedOut.verificationMethod, 'web');
      assert.ok(checkedOut.checkOut);
      const actual = await request(manualEmployee, '/attendance/analytics');
      assert.equal(actual.today.own.recorded, true);
      assert.equal(actual.today.own.verificationMethod, 'web');
      assert.equal((await request(manualEmployee, '/ai/status')).configured, false);
    } finally {
      if (previous === undefined) delete process.env.BIOMETRIC_MODEL_DIR;
      else process.env.BIOMETRIC_MODEL_DIR = previous;
    }
  });

  await t.test('actual local detection rejects blank and multiple-face diagnostic frames', async () => {
    await assert.rejects(provider.extractSamples([fixture('no-face.jpg')]), { status: 422 });
    await assert.rejects(provider.extractSamples([fixture('two-faces.jpg')]), { status: 422 });
  });

  await t.test('protected APIs require authentication, employee authorization and explicit consent', async () => {
    await request(null, '/biometrics/status', 'GET', undefined, 401);
    await request(foreignAdmin, '/biometrics/challenges', 'POST', { purpose: 'enroll', consent: true, consentVersion: service.CONSENT_VERSION }, 403);
    await request(employee, '/biometrics/challenges', 'POST', { purpose: 'enroll' }, 422);
    await request(employee, '/biometrics/attendance', 'POST', { challengeId: String(new mongoose.Types.ObjectId()), action: 'check-in', samples: matching, verified: true }, 422);
    assert.equal(await M.BiometricEnrollment.countDocuments(), 0);
  });

  let enrollmentSession;
  await t.test('production HTTPS enforcement also protects biometric status and deletion', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await request(employee, '/biometrics/status', 'GET', undefined, 400);
      await request(employee, '/biometrics/enrollment', 'DELETE', undefined, 400);
      assert.equal(await M.BiometricEnrollment.countDocuments(), 0);
    } finally { process.env.NODE_ENV = previous; }
  });
  await t.test('actual local detection, alignment and embedding inference enroll an encrypted template', async () => {
    const status = await request(employee, '/biometrics/status');
    assert.equal(status.configured, true);
    assert.equal(status.provider, 'local-opencv-sface');
    assert.match(status.consent.notice, /local/i);
    enrollmentSession = await challenge(employee, 'enroll');
    const enrolled = await request(employee, '/biometrics/enrollment', 'POST', { challengeId: enrollmentSession.challengeId, samples: matching }, 201);
    assert.equal(enrolled.enrollment.enrolled, true);
    assert.equal((await request(employee, '/biometrics/status')).enrollment.enrolled, true);
    const ordinary = await M.BiometricEnrollment.findOne({ company: employee.company, employee: employee.employee }).lean();
    assert.equal(ordinary.protectedTemplate, undefined);
    const stored = await M.BiometricEnrollment.findOne({ company: employee.company, employee: employee.employee }).select('+protectedTemplate').lean();
    assert.ok(stored.protectedTemplate?.ciphertext);
    assert.equal(JSON.stringify(stored).includes(matching[0].slice(0, 120)), false);
    assert.equal(JSON.stringify(enrolled).includes('embedding'), false);
    assert.equal(await M.Attendance.countDocuments({ employee: employee.employee }), 0);
  });

  await t.test('a consumed enrollment challenge cannot be replayed', async () => {
    await request(employee, '/biometrics/enrollment', 'POST', { challengeId: enrollmentSession.challengeId, samples: matching }, 409);
    await request(employee, '/biometrics/challenges', 'POST', { purpose: 'enroll', consent: true, consentVersion: service.CONSENT_VERSION }, 409);
    assert.equal(await M.BiometricEnrollment.countDocuments({ employee: employee.employee }), 1);
  });

  await t.test('a real different-person image is rejected and account-bound challenges cannot be stolen', async () => {
    const session = await challenge(employee, 'check-in');
    await submitAttendance(foreignEmployee, session, 'check-in', matching, 409);
    await submitAttendance(employee, session, 'check-in', different, 422);
    assert.equal(await M.Attendance.countDocuments({ employee: employee.employee }), 0);
  });

  await t.test('a real matching embedding records check-in and updates actual MongoDB analytics', async () => {
    const session = await challenge(employee, 'check-in');
    const record = await submitAttendance(employee, session, 'check-in');
    assert.equal(record.verificationMethod, 'face');
    assert.equal(record.verification.provider, 'local-opencv-sface');
    assert.ok(record.checkIn);
    assert.equal(record.verification.livenessConfidence, undefined);
    assert.equal(record.verification.livenessVerified, false);
    const actual = await request(employee, '/attendance/analytics');
    assert.equal(actual.today.own.recorded, true);
    assert.equal(actual.today.own.verificationMethod, 'face');
    const foreign = await request(foreignEmployee, '/attendance/analytics');
    assert.equal(foreign.today.own.recorded, false);
    assert.equal(await M.Attendance.countDocuments({ employee: employee.employee }), 1);
  });

  await t.test('fresh real inference cannot bypass duplicate check-in prevention', async () => {
    const session = await challenge(employee, 'check-in');
    await submitAttendance(employee, session, 'check-in', matching, 409);
    assert.equal(await M.Attendance.countDocuments({ employee: employee.employee }), 1);
  });

  await t.test('a real local match saves check-out and elapsed working time', async () => {
    const session = await challenge(employee, 'check-out');
    const record = await submitAttendance(employee, session, 'check-out');
    assert.ok(record.checkOut);
    assert.equal(record.checkOutVerification.provider, 'local-opencv-sface');
    assert.equal(record.hours, (new Date(record.checkOut) - new Date(record.checkIn)) / 3600000);
    const actual = await request(employee, '/attendance/analytics');
    assert.ok(actual.today.own.checkOut);
    assert.equal(await M.Attendance.countDocuments({ employee: employee.employee }), 1);
  });

  await t.test('company-scoped enrollment and deletion cannot expose or delete a foreign template', async () => {
    const session = await challenge(foreignEmployee, 'enroll');
    const enrolled = await request(foreignEmployee, '/biometrics/enrollment', 'POST', { challengeId: session.challengeId, samples: matching }, 201);
    assert.equal(enrolled.enrollment.enrolled, true);
    const foreignRemoval = await request(foreignAdmin, `/biometrics/enrollment/${employee.employee}`, 'DELETE');
    assert.equal(foreignRemoval.deleted, true); // Only the foreign company's empty scope was touched.
    await request(employee, `/biometrics/enrollment/${foreignEmployee.employee}`, 'DELETE', undefined, 403);
    assert.equal((await request(employee, '/biometrics/status')).enrollment.enrolled, true);
    assert.equal((await request(foreignEmployee, '/biometrics/status')).enrollment.enrolled, true);
  });

  await t.test('withdrawal deletes the local encrypted template and permits genuine re-enrollment', async () => {
    const removed = await request(employee, '/biometrics/enrollment', 'DELETE');
    assert.equal(removed.deleted, true);
    assert.equal(await M.BiometricEnrollment.countDocuments({ company: employee.company, employee: employee.employee }), 0);
    assert.equal((await request(foreignEmployee, '/biometrics/status')).enrollment.enrolled, true);
    const session = await challenge(employee, 'enroll');
    const result = await request(employee, '/biometrics/enrollment', 'POST', { challengeId: session.challengeId, samples: matching }, 201);
    assert.equal(result.enrollment.enrolled, true);
    assert.ok(await M.AuditLog.exists({ company: employee.company, actor: employee._id, action: 'biometric_enrolled' }));
    const auditText = JSON.stringify(await M.AuditLog.find({ company: employee.company }).lean());
    assert.equal(auditText.includes(matching[0].slice(0, 120)), false);
    assert.equal(auditText.includes('\"embedding\":'), false);
    const publicStatus = JSON.stringify(await request(employee, '/biometrics/status'));
    assert.equal(publicStatus.includes('ciphertext'), false);
    assert.equal(publicStatus.includes('protectedTemplate'), false);
  });
});
