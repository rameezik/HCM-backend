const express = require("express");
const { z } = require("zod");
const models = require("../models");
const ApiError = require("../utils/ApiError");
const context = require("../services/context");
const { password } = require("./schemas/common");
const { asyncHandler, parseInput } = require("../utils/http");
const bcrypt = require("bcryptjs");
const {
  sendSession,
  serializeUser,
  sessionCookieOptions,
} = require("../services/sessionService");
const router = express.Router();

router.get("/auth/me", (req, res) => res.json(serializeUser(req.user)));
router.post(
  "/auth/logout",
  asyncHandler(async (req, res) => {
    await context.transaction(async (session) => {
      await models.User.updateOne(
        { _id: req.user._id },
        { $inc: { tokenVersion: 1 } },
        { session },
      );
      await context.audit(
        session,
        req.user,
        "logout",
        "User",
        serializeUser(req.user),
        null,
      );
    });
    res
      .clearCookie("hcm_session", {
        ...sessionCookieOptions(),
        maxAge: undefined,
      })
      .json({ message: "Signed out." });
  }),
);
router.post(
  "/auth/password",
  asyncHandler(async (req, res) => {
    const body = parseInput(
      z
        .object({ currentPassword: z.string().min(1).max(128), password })
        .strict(),
      req.body,
    );
    const user = await models.User.findById(req.user._id).select(
      "+passwordHash",
    );
    if (!(await bcrypt.compare(body.currentPassword, user.passwordHash)))
      throw new ApiError(422, "Current password is incorrect.");
    if (body.currentPassword === body.password)
      throw new ApiError(422, "Choose a different password.");
    await context.transaction(async (session) => {
      const before = serializeUser(user);
      user.passwordHash = await bcrypt.hash(body.password, 12);
      user.mustChangePassword = false;
      user.passwordChangeEnforced = false;
      user.tokenVersion++;
      await user.save({ session });
      await context.audit(
        session,
        user,
        "password_change",
        "User",
        before,
        serializeUser(user),
      );
    });
    sendSession(res, user);
  }),
);

module.exports = router;
