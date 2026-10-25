const crypto = require("node:crypto");
const M = require("../models");
const C = require("./context");
const ApiError = require("../utils/ApiError");
const { withCompany } = require("./companyContext");
const COOKIE = "hcm_kiosk";
const PAIR_LIFETIME = 10 * 60000;
const DEVICE_LIFETIME = 7 * 86400000;
const GRANT_LIFETIME = 15 * 60000;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const token = () => crypto.randomBytes(32).toString("hex");
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/api/kiosk",
  maxAge: DEVICE_LIFETIME,
});
const deviceView = (row) => ({
  _id: row._id,
  id: row._id,
  label: row.label,
  state: row.state,
  office: row.office,
  pairingExpiresAt: row.pairingExpiresAt,
  pairedAt: row.pairedAt,
  credentialExpiresAt: row.credentialExpiresAt,
  revokedAt: row.revokedAt,
  createdAt: row.createdAt,
});
function equalHash(left, right) {
  return (
    /^[a-f\d]{64}$/i.test(left || "") &&
    /^[a-f\d]{64}$/i.test(right || "") &&
    crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}
async function adminActor(user, session) {
  if (user?.role !== "admin" || !user.company)
    throw new ApiError(
      403,
      "Only the company Admin can manage attendance kiosks.",
    );
  const actor = await M.User.findOneAndUpdate(
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
  if (!actor)
    throw new ApiError(
      401,
      "Your administrator session changed. Sign in again.",
    );
}
async function audit(session, user, action, entity, details) {
  await C.audit(session, user, action, entity, null, details);
}
async function listDevices(user) {
  if (user?.role !== "admin")
    throw new ApiError(403, "Only Admin can list attendance kiosks.");
  return (
    await M.KioskDevice.find({ company: user.company })
      .sort({ createdAt: -1 })
      .lean()
  ).map(deviceView);
}
async function createDevice(user, label) {
  const pairingToken = token(),
    expiresAt = new Date(Date.now() + PAIR_LIFETIME);
  const row = await C.transaction(async (session) => {
    await adminActor(user, session);
    const company = await M.Company.findOne({ _id: user.company })
      .session(session)
      .lean();
    if (
      !company ||
      !Number.isFinite(company.latitude) ||
      !Number.isFinite(company.longitude)
    )
      throw new ApiError(
        422,
        "Configure the company office latitude and longitude before pairing an attendance kiosk.",
      );
    const [device] = await M.KioskDevice.create(
      [
        {
          company: user.company,
          label,
          createdBy: user._id,
          office: { latitude: company.latitude, longitude: company.longitude },
          pairingTokenHash: hash(pairingToken),
          pairingExpiresAt: expiresAt,
        },
      ],
      { session },
    );
    await audit(session, user, "kiosk_device_created", "KioskDevice", {
      _id: device._id,
      label,
      office: device.office,
      pairingExpiresAt: expiresAt,
    });
    return device;
  });
  return { device: deviceView(row), pairingToken, expiresAt };
}
async function revokeDevice(user, id) {
  await C.transaction(async (session) => {
    await adminActor(user, session);
    const row = await M.KioskDevice.findOneAndUpdate(
      { _id: id, company: user.company },
      {
        state: "revoked",
        revokedAt: new Date(),
        $inc: { tokenVersion: 1 },
        $unset: { credentialHash: 1, pairingTokenHash: 1 },
      },
      { session, returnDocument: "after" },
    );
    if (!row) throw new ApiError(404, "Kiosk device not found.");
    await M.KioskChallenge.updateMany(
      {
        company: user.company,
        device: row._id,
        state: { $in: ["created", "verifying"] },
      },
      {
        state: "failed",
        failureCode: "device_revoked",
        consumedAt: new Date(),
      },
      { session },
    );
    await audit(session, user, "kiosk_device_revoked", "KioskDevice", {
      _id: row._id,
      label: row.label,
    });
  });
  return { revoked: true };
}
async function pairDevice(pairingToken, res) {
  const pairingTokenHash = hash(pairingToken),
    now = new Date();
  const credential = token(),
    credentialExpiresAt = new Date(Date.now() + DEVICE_LIFETIME);
  const device = await M.KioskDevice.findOneAndUpdate(
    { pairingTokenHash, state: "pending", pairingExpiresAt: { $gt: now } },
    {
      state: "paired",
      credentialHash: hash(credential),
      credentialExpiresAt,
      pairedAt: now,
      $inc: { tokenVersion: 1 },
      $unset: { pairingTokenHash: 1 },
    },
    { returnDocument: "after" },
  ).lean();
  if (!device)
    throw new ApiError(
      422,
      "This kiosk pairing code is invalid, expired or already used. Ask Admin for a new code.",
    );
  const company = await M.Company.findOne({ _id: device.company })
    .select("name")
    .lean();
  if (!company) throw new ApiError(403, "This kiosk company is unavailable.");
  res.cookie(
    COOKIE,
    `${device._id}.${device.tokenVersion}.${credential}`,
    cookieOptions(),
  );
  await withCompany(device.company, () =>
    audit(
      null,
      { company: device.company },
      "kiosk_device_paired",
      "KioskDevice",
      { _id: device._id, label: device.label },
    ),
  );
  return {
    paired: true,
    device: deviceView(device),
    companyName: company.name,
  };
}
async function deviceFromRequest(req, { required = true } = {}) {
  const match = /^([a-f\d]{24})\.(\d{1,10})\.([a-f\d]{64})$/i.exec(
    req.cookies?.[COOKIE] || "",
  );
  let row;
  if (match)
    row = await M.KioskDevice.findOne({
      _id: match[1],
      tokenVersion: Number(match[2]),
      state: "paired",
      credentialExpiresAt: { $gt: new Date() },
    })
      .select("+credentialHash")
      .lean();
  if (!row || !equalHash(row.credentialHash, hash(match[3]))) {
    if (!required) return null;
    throw new ApiError(
      401,
      "Pair this kiosk with a company Admin code before scanning.",
    );
  }
  const company = await M.Company.findOne({ _id: row.company })
    .select("name")
    .lean();
  if (!company) {
    if (!required) return null;
    throw new ApiError(401, "This kiosk company is unavailable.");
  }
  return {
    _id: row._id,
    company: row.company,
    companyName: company.name,
    label: row.label,
    office: row.office,
    state: row.state,
    tokenVersion: row.tokenVersion,
    credentialExpiresAt: row.credentialExpiresAt,
  };
}
async function lockDevice(device, session) {
  const row = await M.KioskDevice.findOneAndUpdate(
    {
      _id: device._id,
      company: device.company,
      state: "paired",
      tokenVersion: device.tokenVersion,
      credentialExpiresAt: { $gt: new Date() },
    },
    { $inc: { __v: 1 } },
    { session, returnDocument: "after" },
  );
  if (!row)
    throw new ApiError(
      401,
      "This kiosk pairing expired or was revoked. Ask Admin to pair it again.",
    );
  return row;
}
async function unpairDevice(device, res) {
  if (device)
    await withCompany(device.company, () =>
      C.transaction(async (session) => {
        const row = await M.KioskDevice.findOneAndUpdate(
          {
            _id: device._id,
            company: device.company,
            tokenVersion: device.tokenVersion,
            state: "paired",
          },
          {
            state: "revoked",
            revokedAt: new Date(),
            $inc: { tokenVersion: 1 },
            $unset: { credentialHash: 1, pairingTokenHash: 1 },
          },
          { session, returnDocument: "after" },
        );
        if (row) {
          await M.KioskChallenge.updateMany(
            {
              company: device.company,
              device: device._id,
              state: { $in: ["created", "verifying"] },
            },
            {
              state: "failed",
              failureCode: "device_unpaired",
              consumedAt: new Date(),
            },
            { session },
          );
          await audit(
            session,
            { company: device.company },
            "kiosk_device_unpaired",
            "KioskDevice",
            { _id: device._id, label: device.label },
          );
        }
      }),
    );
  res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
  return { paired: false };
}
async function createEnrollmentGrant(user, employeeId) {
  const code = token(),
    expiresAt = new Date(Date.now() + GRANT_LIFETIME);
  const employee = await C.transaction(async (session) => {
    await adminActor(user, session);
    const person = await M.Employee.findOne({
      _id: employeeId,
      company: user.company,
      status: { $ne: "exited" },
    })
      .select("+photo")
      .session(session);
    if (!person?.photo?.length || !person.photoUpdatedAt)
      throw new ApiError(
        422,
        "Upload a current profile photo for an active employee before issuing enrollment access.",
      );
    const account = await M.User.findOne({
      _id: person.user,
      company: user.company,
      employee: person._id,
      active: true,
    }).session(session);
    if (!account)
      throw new ApiError(422, "An active linked employee account is required.");
    await M.KioskEnrollmentGrant.updateMany(
      {
        company: user.company,
        employee: person._id,
        state: { $in: ["issued", "verifying"] },
      },
      { state: "revoked", failureCode: "replaced_by_admin" },
      { session },
    );
    const [grant] = await M.KioskEnrollmentGrant.create(
      [
        {
          company: user.company,
          employee: person._id,
          user: account._id,
          issuedBy: user._id,
          codeHash: hash(code),
          userTokenVersion: account.tokenVersion,
          photoUpdatedAt: person.photoUpdatedAt,
          expiresAt,
        },
      ],
      { session },
    );
    await audit(
      session,
      user,
      "kiosk_enrollment_grant_issued",
      "KioskEnrollmentGrant",
      { _id: grant._id, employee: person._id, expiresAt },
    );
    return { _id: person._id, name: person.name, code: person.code };
  });
  return { code, expiresAt, employee };
}
async function assertFailureBudget(device) {
  const failed = await M.KioskChallenge.countDocuments({
    company: device.company,
    device: device._id,
    state: "failed",
    createdAt: { $gte: new Date(Date.now() - 60000) },
  });
  if (failed >= 5)
    throw new ApiError(
      429,
      "Too many failed scans. Wait one minute before trying again.",
    );
}
async function createChallenge(device, purpose) {
  await lockDevice(device);
  await assertFailureBudget(device);
  const row = await M.KioskChallenge.create({
    company: device.company,
    device: device._id,
    purpose,
    expiresAt: new Date(Date.now() + 2 * 60000),
  });
  return {
    challengeId: row._id,
    purpose,
    expiresAt: row.expiresAt,
    capture: { samples: 3, maxWidth: 640, maxImageBytes: 250000 },
  };
}
async function claimChallenge(device, id, purpose, session) {
  const row = await M.KioskChallenge.findOneAndUpdate(
    {
      _id: id,
      company: device.company,
      device: device._id,
      purpose,
      state: "created",
      expiresAt: { $gt: new Date() },
    },
    { state: "verifying", $inc: { attempts: 1 } },
    { session, returnDocument: "after" },
  );
  if (!row)
    throw new ApiError(
      409,
      "This camera challenge expired, was already used or belongs to another kiosk. Start a new scan.",
    );
  return row;
}
async function consumeChallenge(device, challenge, session) {
  await lockDevice(device, session);
  const result = await M.KioskChallenge.updateOne(
    {
      _id: challenge._id || challenge,
      company: device.company,
      device: device._id,
      state: "verifying",
      expiresAt: { $gt: new Date() },
    },
    { state: "completed", consumedAt: new Date() },
    { session },
  );
  if (result.modifiedCount !== 1)
    throw new ApiError(
      409,
      "The camera challenge expired or was already consumed.",
    );
}
async function failChallenge(device, challenge, reason = "scan_rejected") {
  await M.KioskChallenge.updateOne(
    {
      _id: challenge._id || challenge,
      company: device.company,
      device: device._id,
      state: "verifying",
    },
    { state: "failed", failureCode: reason, consumedAt: new Date() },
  );
}
async function claimEnrollmentGrant(device, code, session) {
  const row = await M.KioskEnrollmentGrant.findOneAndUpdate(
    {
      company: device.company,
      codeHash: hash(code),
      state: "issued",
      expiresAt: { $gt: new Date() },
      attempts: { $lt: 3 },
      $or: [{ device: device._id }, { device: null }],
    },
    {
      state: "verifying",
      device: device._id,
      claimedAt: new Date(),
      $inc: { attempts: 1 },
    },
    { session, returnDocument: "after" },
  );
  if (!row)
    throw new ApiError(
      422,
      "This enrollment code is invalid, expired, already used or belongs to another kiosk. Ask Admin for access.",
    );
  return row;
}
async function consumeEnrollmentGrant(device, grant, session) {
  const result = await M.KioskEnrollmentGrant.updateOne(
    {
      _id: grant._id || grant,
      company: device.company,
      device: device._id,
      state: "verifying",
      expiresAt: { $gt: new Date() },
    },
    { state: "consumed", consumedAt: new Date() },
    { session },
  );
  if (result.modifiedCount !== 1)
    throw new ApiError(
      409,
      "This enrollment access expired or was already used.",
    );
}
async function failEnrollmentGrant(device, grant, reason = "capture_rejected") {
  const row = await M.KioskEnrollmentGrant.findOne({
    _id: grant._id || grant,
    company: device.company,
    device: device._id,
    state: "verifying",
  }).lean();
  if (!row) return;
  await M.KioskEnrollmentGrant.updateOne(
    {
      _id: row._id,
      company: device.company,
      device: device._id,
      state: "verifying",
      attempts: row.attempts,
    },
    {
      state:
        row.attempts < 3 && row.expiresAt > new Date() ? "issued" : "failed",
      failureCode: reason,
    },
  );
}
module.exports = {
  COOKIE,
  deviceView,
  listDevices,
  createDevice,
  revokeDevice,
  pairDevice,
  deviceFromRequest,
  unpairDevice,
  lockDevice,
  createEnrollmentGrant,
  createChallenge,
  claimChallenge,
  consumeChallenge,
  failChallenge,
  claimEnrollmentGrant,
  consumeEnrollmentGrant,
  failEnrollmentGrant,
  assertFailureBudget,
};
