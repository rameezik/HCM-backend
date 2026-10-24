const jwt = require("jsonwebtoken");
const M = require("../models");
const ApiError = require("../utils/ApiError");
const { withCompany } = require("../services/companyContext");
async function auth(req, res, next) {
  try {
    const token =
      req.cookies.hcm_session ||
      req.headers.authorization?.replace(/^Bearer /, "");
    if (!token) throw new ApiError(401, "Sign in to continue.");
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
      });
    } catch {
      throw new ApiError(401, "Your session expired. Sign in again.");
    }
    const user = await M.User.findById(payload.sub);
    if (!user || !user.active || user.tokenVersion !== payload.version)
      throw new ApiError(401, "Your session is no longer active.");
    if (!user.company) {
      const companies = await M.Company.find().limit(2).select("_id").lean();
      if (companies.length !== 1)
        throw new ApiError(
          403,
          "This account requires an explicit company assignment.",
        );
      user.company = companies[0]._id;
      await user.save();
    }
    if (payload.company && String(user.company) !== payload.company)
      throw new ApiError(
        401,
        "Your company assignment changed. Sign in again.",
      );
    req.user = user;
    if (
      user.mustChangePassword &&
      !["/auth/me", "/auth/password", "/auth/logout"].includes(req.path)
    )
      throw new ApiError(403, "Change your temporary password first.");
    withCompany(user.company, () => next());
  } catch (error) {
    next(error);
  }
}
const roles =
  (...allowed) =>
  (req, res, next) =>
    allowed.includes(req.user.role)
      ? next()
      : next(new ApiError(403, "This action is not allowed for your role."));
module.exports = { auth, roles };
