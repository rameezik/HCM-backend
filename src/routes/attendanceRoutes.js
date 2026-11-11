const express = require("express");
const { z } = require("zod");
const models = require("../models");
const ApiError = require("../utils/ApiError");
const context = require("../services/context");
const { roles } = require("../middleware/authMiddleware");
const { id, text, date } = require("./schemas/common");
const { asyncHandler, requireRecord } = require("../utils/http");
const attendanceRules = require("../services/rules");
const { board } = require("../services/attendanceService");
const router = express.Router();

router.get(
  "/attendance",
  asyncHandler(async (req, res) => res.json(await board(req.user, req.query))),
);
const { writeAttendance } = require("../services/attendanceWriter");
router.get(
  "/attendance/analytics",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(
      await require("../services/attendanceAnalyticsService").analytics(
        req.user,
        req.query,
      ),
    );
  }),
);
for (const action of ["check-in", "check-out"])
  router.post(
    `/attendance/${action}`,
    roles("hr", "employee"),
    asyncHandler(async (req, res) => {
      z.object({})
        .strict()
        .parse(req.body || {});
      const record = await context.transaction((session) =>
        writeAttendance(req.user, action, {
          session,
          verification: { method: "web" },
        }),
      );
      res.json(record);
    }),
  );
router.get(
  "/corrections",
  asyncHandler(async (req, res) =>
    res.json(
      await models.Correction.find(context.scope(req.user))
        .populate("employee", "name code")
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
    ),
  ),
);
router.post(
  "/corrections",
  roles("employee"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        date,
        checkIn: z.string().datetime(),
        checkOut: z.string().datetime(),
        reason: text,
      })
      .strict()
      .parse(req.body);
    const employee = context.requireEmployee(req.user);
    const doc = await context.transaction(async (session) => {
      const { company, holidays } = await context.settings(session);
      const clock = require("../services/attendanceWriter");
      if (
        body.date > clock.businessDate(new Date(), company) ||
        clock.businessDate(new Date(body.checkIn), company) !== body.date ||
        Date.parse(body.checkOut) > Date.now()
      )
        throw new ApiError(
          422,
          "Correction times must belong to a completed company shift and cannot be in the future.",
        );
      attendanceRules.attendanceStatus(body.checkIn, body.checkOut, {
        ...company,
        businessDate: body.date,
      });
      const person = requireRecord(
        await models.Employee.findById(employee).session(session),
      );
      if (
        body.date < person.joinDate ||
        (person.exitDate && body.date > person.exitDate)
      )
        throw new ApiError(
          422,
          "Correction must fall within employment dates.",
        );
      if (
        !attendanceRules.workingDays(body.date, body.date, company, holidays)
          .length
      )
        throw new ApiError(422, "Choose a working day.");
      if (
        await models.Correction.exists({
          employee,
          date: body.date,
          status: "pending",
        }).session(session)
      )
        throw new ApiError(
          409,
          "A correction for this date is already pending.",
        );
      const [after] = await models.Correction.create([{ ...body, employee }], {
        session,
      });
      await context.audit(
        session,
        req.user,
        "request_correction",
        "Correction",
        null,
        after,
      );
      return after;
    });
    res.status(201).json(doc);
  }),
);
router.patch(
  "/corrections/:id",
  roles("admin", "hr"),
  asyncHandler(async (req, res) => {
    id.parse(req.params.id);
    const body = z
      .object({ status: z.enum(["approved", "rejected"]), comment: text })
      .strict()
      .parse(req.body);
    const doc = await context.transaction(async (session) => {
      const correction = requireRecord(
        await models.Correction.findById(req.params.id).session(session),
      );
      if (String(correction.employee) === String(req.user.employee))
        throw new ApiError(403, "You cannot approve your own correction.");
      if (correction.status !== "pending")
        throw new ApiError(409, "Correction already decided.");
      const before = correction.toObject();
      await models.Employee.updateOne(
        { _id: correction.employee },
        { $inc: { __v: 1 } },
        { session },
      );
      if (body.status === "approved") {
        const month = correction.date.slice(0, 7);
        if (
          await models.Payroll.exists({ month, status: "finalized" }).session(
            session,
          )
        )
          throw new ApiError(409, "The payroll month is finalized.");
        if (
          await models.Leave.exists({
            employee: correction.employee,
            days: correction.date,
            status: "approved",
          }).session(session)
        )
          throw new ApiError(422, "This date has approved leave.");
        const old = await models.Attendance.findOne({
          employee: correction.employee,
          date: correction.date,
        }).session(session);
        const rules = old?.rules || (await context.settings(session)).company;
        const after = await models.Attendance.findOneAndUpdate(
          { employee: correction.employee, date: correction.date },
          {
            checkIn: correction.checkIn,
            checkOut: correction.checkOut,
            rules,
            verificationMethod: "hr-correction",
            ...attendanceRules.attendanceStatus(
              correction.checkIn,
              correction.checkOut,
              rules,
            ),
          },
          { upsert: true, returnDocument: "after", session },
        );
        await context.audit(
          session,
          req.user,
          "correct_attendance",
          "Attendance",
          old,
          after,
        );
      }
      Object.assign(correction, body, { decidedBy: req.user._id });
      await correction.save({ session });
      const employee = await models.Employee.findById(
        correction.employee,
      ).session(session);
      await context.notify(
        session,
        employee.user,
        `Attendance correction ${body.status}: ${body.comment}`,
      );
      await context.audit(
        session,
        req.user,
        "decide_correction",
        "Correction",
        before,
        correction,
      );
      return correction;
    });
    res.json(doc);
  }),
);

module.exports = router;
