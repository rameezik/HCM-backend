const express = require("express");
const { z } = require("zod");
const models = require("../models");
const ApiError = require("../utils/ApiError");
const context = require("../services/context");
const { roles } = require("../middleware/authMiddleware");
const { id, text, date } = require("./schemas/common");
const { asyncHandler, requireRecord } = require("../utils/http");
const rules = require("../services/rules");
const { balances } = require("../services/leaveService");
const router = express.Router();

router.get(
  "/leave/balance",
  roles("hr", "employee"),
  asyncHandler(async (req, res) =>
    res.json(
      await balances(
        req.user,
        z
          .string()
          .regex(/^\d{4}$/)
          .parse(req.query.year || rules.today().slice(0, 4)),
      ),
    ),
  ),
);
router.get(
  "/leave",
  asyncHandler(async (req, res) =>
    res.json(
      await models.Leave.find(context.scope(req.user))
        .populate("employee", "name code department")
        .populate("type")
        .sort({ createdAt: -1 })
        .limit(500)
        .lean(),
    ),
  ),
);
router.post(
  "/leave",
  roles("hr", "employee"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ type: id, start: date, end: date, reason: text })
      .strict()
      .parse(req.body);
    if (body.start.slice(0, 4) !== body.end.slice(0, 4))
      throw new ApiError(
        422,
        "Submit separate requests for each calendar year.",
      );
    const employee = context.requireEmployee(req.user);
    const doc = await context.transaction(async (session) => {
      // Writing the employee serializes competing balance reservations under Mongo transactions.
      const person = requireRecord(
        await models.Employee.findByIdAndUpdate(
          employee,
          { $inc: { __v: 1 } },
          { session, returnDocument: "after" },
        ),
      );
      if (
        body.start < person.joinDate ||
        (person.exitDate && body.end > person.exitDate)
      )
        throw new ApiError(422, "Leave must fall within employment dates.");
      const type = requireRecord(
        await models.LeaveType.findById(body.type).session(session),
      );
      const { company, holidays } = await context.settings(session);
      const days = rules.workingDays(body.start, body.end, company, holidays);
      if (!days.length)
        throw new ApiError(422, "This range contains no working days.");
      if (
        await models.Leave.exists({
          employee,
          status: { $in: ["pending", "approved"] },
          days: { $in: days },
        }).session(session)
      )
        throw new ApiError(422, "This request overlaps existing leave.");
      const balance = (
        await balances(req.user, body.start.slice(0, 4), session)
      ).find((b) => String(b._id) === body.type);
      if (!type.unpaid && days.length > balance.remaining)
        throw new ApiError(422, "Insufficient leave balance.");
      if (
        await models.Payroll.exists({
          month: { $gte: body.start.slice(0, 7), $lte: body.end.slice(0, 7) },
          status: "finalized",
        }).session(session)
      )
        throw new ApiError(
          409,
          "This range intersects a finalized payroll month.",
        );
      const [after] = await models.Leave.create(
        [
          {
            ...body,
            employee,
            days,
            unpaid: type.unpaid,
            quotaSnapshot: type.quota,
          },
        ],
        { session },
      );
      await context.audit(
        session,
        req.user,
        "apply_leave",
        "Leave",
        null,
        after,
      );
      return after;
    });
    res.status(201).json(doc);
  }),
);
router.patch(
  "/leave/:id",
  roles("admin", "hr", "employee"),
  asyncHandler(async (req, res) => {
    id.parse(req.params.id);
    const body = z
      .object({
        status: z.enum(["approved", "rejected", "cancelled"]),
        comment: text,
      })
      .strict()
      .parse(req.body);
    const doc = await context.transaction(async (session) => {
      const leave = requireRecord(
        await models.Leave.findById(req.params.id).session(session),
      );
      const own = String(leave.employee) === String(req.user.employee);
      if (
        body.status === "cancelled"
          ? !own
          : !["admin", "hr"].includes(req.user.role) || own
      )
        throw new ApiError(403, "You cannot make this leave decision.");
      if (
        body.status === "cancelled"
          ? !["pending", "approved"].includes(leave.status)
          : leave.status !== "pending"
      )
        throw new ApiError(409, "Leave already decided.");
      if (
        await models.Payroll.exists({
          month: { $gte: leave.start.slice(0, 7), $lte: leave.end.slice(0, 7) },
          status: "finalized",
        }).session(session)
      )
        throw new ApiError(409, "Payroll for this leave is finalized.");
      await models.Employee.updateOne(
        { _id: leave.employee },
        { $inc: { __v: 1 } },
        { session },
      );
      if (
        body.status === "approved" &&
        (await models.Attendance.exists({
          employee: leave.employee,
          date: { $in: leave.days },
        }).session(session))
      )
        throw new ApiError(422, "Leave conflicts with recorded attendance.");
      const before = leave.toObject();
      Object.assign(leave, body, { decidedBy: req.user._id });
      await leave.save({ session });
      const employee = await models.Employee.findById(leave.employee).session(
        session,
      );
      await context.notify(
        session,
        employee.user,
        `Leave ${body.status}: ${body.comment}`,
      );
      await context.audit(
        session,
        req.user,
        "decide_leave",
        "Leave",
        before,
        leave,
      );
      return leave;
    });
    res.json(doc);
  }),
);

module.exports = router;
