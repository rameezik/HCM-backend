const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const M = require("../models");
const C = require("./context");
const ApiError = require("../utils/ApiError");
const { withCompany } = require("./companyContext");

const RESET_LIFETIME_MS = 15 * 60000;
const acceptedMessage =
  "If an active account exists for that email, password-reset instructions will be sent. Check your inbox and spam folder, or contact your company administrator.";
const digest = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

function deliveryConfiguration() {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.SMTP_FROM?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  let appUrl;
  try {
    appUrl = new URL(
      process.env.AUTH_APP_URL ||
        process.env.FRONTEND_URL?.split(",")[0]?.trim() ||
        "http://localhost:3000",
    );
  } catch {
    throw new ApiError(
      503,
      "Password recovery requires a valid backend AUTH_APP_URL.",
    );
  }
  if (
    !host ||
    !/^[A-Za-z\d.-]+$/.test(host) ||
    !from ||
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    Boolean(user) !== Boolean(pass) ||
    !["http:", "https:"].includes(appUrl.protocol) ||
    appUrl.username ||
    appUrl.password ||
    (process.env.NODE_ENV === "production" && appUrl.protocol !== "https:")
  ) {
    const error = new ApiError(
      503,
      "Password recovery email is not configured. Ask your company administrator to reset your password, or configure SMTP_HOST, SMTP_FROM and AUTH_APP_URL on the backend.",
    );
    error.code = "AUTH_RECOVERY_NOT_CONFIGURED";
    throw error;
  }
  return { host, from, port, secure, user, pass, appUrl };
}

function transportFor(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: process.env.NODE_ENV === "production" && !config.secure,
    ...(config.user ? { auth: { user: config.user, pass: config.pass } } : {}),
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { rejectUnauthorized: true },
  });
}

async function requestReset(email) {
  const config = deliveryConfiguration();
  const transport = transportFor(config);
  try {
    // Check delivery availability for known and unknown emails alike. A missing
    // mail configuration never pretends to have delivered a password-reset link.
    await transport.verify();
  } catch {
    throw new ApiError(
      503,
      "Password recovery email delivery is unavailable. Try again later or contact your company administrator.",
    );
  }
  const user = await M.User.findOne({ email, active: true }).lean();
  if (!user?.company) return { message: acceptedMessage };

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = digest(token);
  const expiresAt = new Date(Date.now() + RESET_LIFETIME_MS);
  await withCompany(user.company, () =>
    C.transaction(async (session) => {
      await M.PasswordResetToken.findOneAndUpdate(
        { user: user._id },
        {
          tokenHash,
          expiresAt,
          userTokenVersion: user.tokenVersion,
          deliveredAt: null,
        },
        { upsert: true, returnDocument: "after", runValidators: true, session },
      );
      await C.audit(session, user, "password_reset_requested", "User", null, {
        _id: user._id,
      });
    }),
  );
  const resetUrl = new URL("/reset-password", config.appUrl);
  resetUrl.searchParams.set("token", token);
  try {
    const delivery = await transport.sendMail({
      from: { name: "HCM Lite", address: config.from },
      to: user.email,
      subject: "Reset your HCM Lite password",
      text: `A password reset was requested for your HCM Lite account.\n\nOpen this link within 15 minutes:\n${resetUrl.href}\n\nThis link can be used once. If you did not request it, ignore this message; your current password remains unchanged.\n\nHCM Lite`,
    });
    if (!delivery.accepted?.length) throw new Error("Recipient not accepted");
    await withCompany(user.company, () =>
      M.PasswordResetToken.updateOne(
        { user: user._id, tokenHash },
        { deliveredAt: new Date() },
      ),
    );
  } catch {
    await withCompany(user.company, () =>
      M.PasswordResetToken.deleteOne({ user: user._id, tokenHash }),
    );
    throw new ApiError(
      503,
      "Password recovery email could not be delivered. Try again later or contact your company administrator.",
    );
  }
  return { message: acceptedMessage };
}

async function completeReset(token, password) {
  const tokenHash = digest(token);
  const reset = await M.PasswordResetToken.findOne({
    tokenHash,
    expiresAt: { $gt: new Date() },
    deliveredAt: { $ne: null },
  }).lean();
  const invalid = () =>
    new ApiError(
      422,
      "This password-reset link is invalid or expired. Request a new link.",
    );
  if (!reset?.company) throw invalid();
  // Password hashing happens before the transaction, so slow CPU work does not
  // hold locks. Conditional user/token updates prevent reuse and stale resets.
  const passwordHash = await bcrypt.hash(password, 12);
  return withCompany(reset.company, () =>
    C.transaction(async (session) => {
      const claimed = await M.PasswordResetToken.findOneAndDelete(
        {
          _id: reset._id,
          tokenHash,
          expiresAt: { $gt: new Date() },
          deliveredAt: { $ne: null },
        },
        { session },
      );
      if (!claimed) throw invalid();
      const user = await M.User.findOneAndUpdate(
        { _id: reset.user, active: true, tokenVersion: reset.userTokenVersion },
        {
          passwordHash,
          mustChangePassword: false,
          passwordChangeEnforced: false,
          $inc: { tokenVersion: 1 },
        },
        { returnDocument: "after", session, runValidators: true },
      );
      if (!user) throw invalid();
      await C.audit(session, user, "password_reset_completed", "User", null, {
        _id: user._id,
      });
      return user;
    }),
  );
}

module.exports = { requestReset, completeReset, RESET_LIFETIME_MS };
