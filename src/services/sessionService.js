const jwt = require("jsonwebtoken");

const serializeUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  employee: user.employee,
  company: user.company,
  active: user.active,
  mustChangePassword: Boolean(
    user.mustChangePassword && user.passwordChangeEnforced,
  ),
  passwordChangeRecommended: Boolean(user.mustChangePassword),
  passwordChangeEnforced: Boolean(user.passwordChangeEnforced),
});
const sessionCookieOptions = () => ({
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 8 * 3600000,
});
function sendSession(res, user) {
  const token = jwt.sign(
    {
      sub: String(user._id),
      version: user.tokenVersion,
      company: user.company ? String(user.company) : undefined,
    },
    process.env.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "8h" },
  );
  res
    .cookie("hcm_session", token, sessionCookieOptions())
    .json(serializeUser(user));
}

module.exports = { serializeUser, sessionCookieOptions, sendSession };
