const express = require("express");
const { z } = require("zod");
const models = require("../models");
const ApiError = require("../utils/ApiError");
const context = require("../services/context");
const { roles } = require("../middleware/authMiddleware");
const { id, text, email, password } = require("./schemas/common");
const { asyncHandler, parseInput, requireRecord } = require("../utils/http");
const bcrypt = require("bcryptjs");
const { serializeUser } = require("../services/sessionService");
const {
  lockAdminManagement,
  guardAccountChange,
} = require("../services/accountManagementService");
const router = express.Router();

router.get(
  "/users",
  roles("admin"),
  asyncHandler(async (req, res) =>
    res.json(
      (await models.User.find().sort({ createdAt: -1 })).map(serializeUser),
    ),
  ),
);
router.post(
  "/users",
  roles("admin"),
  asyncHandler(async (req, res) => {
    const body = parseInput(
      z
        .object({
          name: text,
          email,
          password,
          employee: id.optional(),
          role: z.enum(["admin", "hr", "employee"]).default("hr"),
          active: z.boolean().default(true),
          requirePasswordChange: z.boolean().default(false),
        })
        .strict(),
      req.body,
    );
    const doc = await context.transaction(async (session) => {
      await lockAdminManagement(req.user, session);
      if (body.role === "employee" && !body.employee)
        throw new ApiError(
          422,
          "Create a new employee and linked login through Employees.",
        );
      if (body.employee) {
        const employee = requireRecord(
          await models.Employee.findById(body.employee).session(session),
        );
        const existing = await models.User.findById(employee.user).session(
          session,
        );
        if (existing?.role !== "employee")
          throw new ApiError(
            422,
            "Employee is already linked to a staff login.",
          );
        await guardAccountChange(req.user, existing, body, session);
      }
      let after;
      if (body.employee) {
        const employee = await models.Employee.findById(body.employee).session(
          session,
        );
        after = await models.User.findByIdAndUpdate(
          employee.user,
          {
            name: body.name,
            email: body.email,
            role: body.role,
            active: body.active,
            passwordHash: await bcrypt.hash(body.password, 12),
            mustChangePassword: true,
            passwordChangeEnforced: body.requirePasswordChange,
            $inc: { tokenVersion: 1 },
          },
          { returnDocument: "after", session },
        );
        await models.Employee.updateOne(
          { _id: employee._id },
          { name: body.name, email: body.email },
          { session },
        );
      } else
        [after] = await models.User.create(
          [
            {
              name: body.name,
              email: body.email,
              passwordHash: await bcrypt.hash(body.password, 12),
              role: body.role,
              active: body.active,
              passwordChangeEnforced: body.requirePasswordChange,
            },
          ],
          { session },
        );
      await context.audit(
        session,
        req.user,
        body.role === "hr" ? "create_hr" : "create_account",
        "User",
        null,
        serializeUser(after),
      );
      return serializeUser(after);
    });
    res.status(201).json(doc);
  }),
);
router.patch(
  "/users/:id",
  roles("admin"),
  asyncHandler(async (req, res) => {
    id.parse(req.params.id);
    const body = parseInput(
      z
        .object({
          active: z.boolean().optional(),
          password: password.optional(),
          role: z.enum(["admin", "hr", "employee"]).optional(),
          requirePasswordChange: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    const doc = await context.transaction(async (session) => {
      await lockAdminManagement(req.user, session);
      const user = requireRecord(
        await models.User.findById(req.params.id).session(session),
      );
      await guardAccountChange(req.user, user, body, session);
      const before = serializeUser(user);
      if (body.active !== undefined) user.active = body.active;
      if (body.role !== undefined) user.role = body.role;
      if (body.password) {
        user.passwordHash = await bcrypt.hash(body.password, 12);
        user.mustChangePassword = true;
        user.passwordChangeEnforced = body.requirePasswordChange ?? false;
      } else if (body.requirePasswordChange !== undefined) {
        user.passwordChangeEnforced = body.requirePasswordChange;
        if (body.requirePasswordChange) user.mustChangePassword = true;
      }
      user.tokenVersion++;
      await user.save({ session });
      if (body.active === false && user.employee)
        await models.BiometricEnrollment.updateOne(
          { employee: user.employee },
          { $set: { status: "deleting", deleteRequestedAt: new Date() } },
          { session },
        );
      await context.audit(
        session,
        req.user,
        "update_login",
        "User",
        before,
        serializeUser(user),
      );
      return serializeUser(user);
    });
    res.json(doc);
  }),
);

module.exports = router;
