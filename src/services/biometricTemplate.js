const crypto = require("node:crypto");
const ApiError = require("../utils/ApiError");
const faceProvider = require("./localFaceProvider");

function readEncryptionKey() {
  const raw = process.env.BIOMETRIC_TEMPLATE_KEY?.trim() || "";
  if (
    !/^[A-Za-z\d+/]{43}=$/.test(raw) ||
    Buffer.from(raw, "base64").length !== 32
  ) {
    const error = new ApiError(503, "Biometric encryption is not configured.");
    error.code = "BIOMETRIC_NOT_CONFIGURED";
    throw error;
  }
  return Buffer.from(raw, "base64");
}
const templateContext = (company, employee) =>
  Buffer.from(`${company}:${employee}:${faceProvider.PROVIDER}:template-v1`);
function isNormalizedEmbedding(vector) {
  return (
    Array.isArray(vector) &&
    vector.length === 128 &&
    vector.every(Number.isFinite) &&
    Math.abs(Math.hypot(...vector) - 1) < 0.01
  );
}
function protectTemplate(template, company, employee) {
  const key = readEncryptionKey(),
    iv = crypto.randomBytes(12);
  let plaintext;
  try {
    plaintext = Buffer.from(JSON.stringify(template));
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(templateContext(company, employee));
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
  const key = readEncryptionKey();
  let plaintext;
  try {
    if (!protectedTemplate) throw Error("Missing template");
    if (
      protectedTemplate.keyVersion !==
      (process.env.BIOMETRIC_TEMPLATE_KEY_ID || "v1")
    ) {
      const error = new ApiError(
        503,
        "The original biometric key version is required to read existing enrollments.",
      );
      error.code = "BIOMETRIC_KEY_VERSION_MISMATCH";
      throw error;
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(protectedTemplate.iv, "base64"),
    );
    decipher.setAAD(templateContext(company, employee));
    decipher.setAuthTag(Buffer.from(protectedTemplate.tag, "base64"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(protectedTemplate.ciphertext, "base64")),
      decipher.final(),
    ]);
    const template = JSON.parse(plaintext.toString("utf8"));
    if (
      template.provider !== faceProvider.PROVIDER ||
      typeof template.modelVersion !== "string" ||
      !isNormalizedEmbedding(template.embedding)
    )
      throw Error("Invalid template");
    return template;
  } catch (cause) {
    if (cause.code === "BIOMETRIC_KEY_VERSION_MISMATCH") throw cause;
    const error = new ApiError(
      503,
      "An existing face enrollment cannot be read. Restore the original biometric encryption key.",
    );
    error.code = "BIOMETRIC_TEMPLATE_UNREADABLE";
    throw error;
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
module.exports = {
  readEncryptionKey,
  isNormalizedEmbedding,
  protectTemplate,
  revealTemplate,
};
