const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const root = path.resolve(__dirname, "..");
const file = path.join(root, ".env");
if (process.env.NODE_ENV === "production") {
  throw new Error(
    "Set deployment secrets in the hosting environment; local key generation is for development only.",
  );
}
let contents = fs.existsSync(file)
  ? fs.readFileSync(file, "utf8")
  : fs.readFileSync(path.join(root, ".env.example"), "utf8");
const values = dotenv.parse(contents);
if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length < 32) {
  throw new Error(
    "The injected JWT_SECRET is too short; update or unset it before running setup:env. No files changed.",
  );
}
let changed = false;
if (!values.JWT_SECRET || values.JWT_SECRET.trim().length < 32) {
  const replacement = `JWT_SECRET=${crypto.randomBytes(48).toString("hex")}`;
  if (/^\s*(?:export\s+)?JWT_SECRET\s*=/m.test(contents))
    contents = contents.replace(
      /^\s*(?:export\s+)?JWT_SECRET\s*=.*$/m,
      replacement,
    );
  else contents += `\n${replacement}\n`;
  changed = true;
  console.log(
    "Local backend configuration saved with a securely generated signing key. The key was not printed.",
  );
} else {
  console.log("Existing backend JWT signing key is valid and was preserved.");
}
const validTemplateKey = (value) =>
  /^[A-Za-z\d+/]{43}=$/.test(value || "") &&
  Buffer.from(value, "base64").length === 32;
if (
  process.env.BIOMETRIC_TEMPLATE_KEY &&
  !validTemplateKey(process.env.BIOMETRIC_TEMPLATE_KEY)
) {
  throw new Error(
    "The injected BIOMETRIC_TEMPLATE_KEY is invalid. Update or unset it; no files changed.",
  );
}
if (
  !process.env.BIOMETRIC_TEMPLATE_KEY &&
  !values.BIOMETRIC_TEMPLATE_KEY?.trim()
) {
  const replacement = `BIOMETRIC_TEMPLATE_KEY=${crypto.randomBytes(32).toString("base64")}`;
  if (/^\s*(?:export\s+)?BIOMETRIC_TEMPLATE_KEY\s*=/m.test(contents))
    contents = contents.replace(
      /^\s*(?:export\s+)?BIOMETRIC_TEMPLATE_KEY\s*=.*$/m,
      replacement,
    );
  else contents += `\n${replacement}\n`;
  changed = true;
  console.log(
    "Created a local biometric encryption key without printing it. Preserve it for existing enrollments.",
  );
} else if (
  !process.env.BIOMETRIC_TEMPLATE_KEY &&
  !validTemplateKey(values.BIOMETRIC_TEMPLATE_KEY)
) {
  throw new Error(
    "The existing BIOMETRIC_TEMPLATE_KEY is invalid; preserve the file and configure the correct key. No files changed.",
  );
}
if (changed) {
  fs.writeFileSync(file, contents, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
