const express = require("express");
const { z } = require("zod");
const models = require("../models");
const ApiError = require("../utils/ApiError");
const context = require("../services/context");
const { text, email, password } = require("./schemas/common");
const { asyncHandler, parseInput } = require("../utils/http");
const bcrypt = require("bcryptjs");
const { rateLimit } = require("express-rate-limit");
const companySchema = require("./schemas/company");
const { sendSession, serializeUser } = require("../services/sessionService");
const { withCompany } = require("../services/companyContext");
const loginLimit = rateLimit({
  windowMs: 15 * 60000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    message: "Too many sign-in attempts. Please try again in 15 minutes.",
  },
});
const router = express.Router();

router.get(
  "/health",
  asyncHandler(async (req, res) => {
    await models.Company.db.db.admin().ping();
    res.json({ status: "ok", database: "connected" });
  }),
);
router.get(
  "/setup",
  asyncHandler(async (req, res) =>
    res.json({ required: !(await models.Company.exists({})) }),
  ),
);
router.post(
  "/setup",
  loginLimit,
  asyncHandler(async (req, res) => {
    const body = parseInput(
      z
        .object({ company: companySchema, name: text, email, password })
        .strict(),
      req.body,
    );
    await context.transaction(async (session) => {
      if (await models.Company.exists({}).session(session))
        throw new ApiError(409, "Company is already initialized.");
      const [company] = await models.Company.create([body.company], {
        session,
      });
      await withCompany(company._id, async () => {
        const [admin] = await models.User.create(
          [
            {
              name: body.name,
              email: body.email,
              passwordHash: await bcrypt.hash(body.password, 12),
              role: "admin",
              mustChangePassword: false,
            },
          ],
          { session },
        );
        await models.LeaveType.create(
          [
            { name: "Annual", quota: 14 },
            { name: "Sick", quota: 8 },
            { name: "Casual", quota: 10 },
            { name: "Unpaid", quota: 0, unpaid: true },
          ],
          { session, ordered: true },
        );
        await context.audit(session, admin, "setup", "Company", null, company);
      });
    });
    res.status(201).json({ message: "Company initialized. Sign in as Admin." });
  }),
);
router.post(
  "/auth/login",
  loginLimit,
  asyncHandler(async (req, res) => {
    const body = parseInput(
      z.object({ email, password: z.string().min(1).max(128) }).strict(),
      req.body,
    );
    const user = await models.User.findOne({ email: body.email }).select(
      "+passwordHash",
    );
    if (
      !user ||
      !user.active ||
      !(await bcrypt.compare(body.password, user.passwordHash))
    )
      throw new ApiError(401, "Invalid email or password.");
    await context.transaction((session) =>
      context.audit(session, user, "login", "User", null, serializeUser(user)),
    );
    if (!user.company) {
      const companies = await models.Company.find()
        .limit(2)
        .select("_id")
        .lean();
      if (companies.length !== 1)
        throw new ApiError(403, "This account requires a company assignment.");
      user.company = companies[0]._id;
      await user.save();
    }
    sendSession(res, user);
  }),
);

module.exports = router;
