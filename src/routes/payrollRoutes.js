const express = require("express");
const { z } = require("zod");
const models = require("../models");
const ApiError = require("../utils/ApiError");
const context = require("../services/context");
const { roles } = require("../middleware/authMiddleware");
const { id } = require("./schemas/common");
const { asyncHandler, requireRecord } = require("../utils/http");
const PDFDocument = require("pdfkit");
const { generate } = require("../services/payrollService");
const router = express.Router();

router.get(
  "/payroll",
  asyncHandler(async (req, res) => {
    const runs = await models.Payroll.find(
      req.user.role === "employee"
        ? { status: "finalized", "slips.employee": req.user.employee || null }
        : {},
    )
      .sort({ month: -1 })
      .lean();
    res.json(
      runs.map((run) =>
        req.user.role === "employee"
          ? {
              ...run,
              slips: run.slips.filter(
                (s) => String(s.employee) === String(req.user.employee),
              ),
            }
          : run,
      ),
    );
  }),
);
router.post(
  "/payroll",
  roles("admin", "hr"),
  asyncHandler(async (req, res) => {
    const { month } = z
      .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })
      .strict()
      .parse(req.body);
    const doc = await context.transaction(async (session) => {
      const before = await models.Payroll.findOne({ month })
        .session(session)
        .lean();
      if (before?.status === "finalized")
        throw new ApiError(409, "Finalized payroll is locked.");
      const slips = await generate(month, session);
      const after = await models.Payroll.findOneAndUpdate(
        { month },
        { slips, createdBy: req.user._id, status: "draft" },
        { upsert: true, returnDocument: "after", session },
      );
      await context.audit(
        session,
        req.user,
        "payroll_draft",
        "Payroll",
        before,
        after,
      );
      return after;
    });
    res.status(201).json(doc);
  }),
);
router.post(
  "/payroll/:id/finalize",
  roles("admin"),
  asyncHandler(async (req, res) => {
    id.parse(req.params.id);
    const doc = await context.transaction(async (session) => {
      const run = requireRecord(
        await models.Payroll.findById(req.params.id).session(session),
      );
      if (run.status !== "draft")
        throw new ApiError(409, "Finalized payroll is locked.");
      await models.Employee.updateMany(
        { _id: { $in: run.slips.map((s) => s.employee) } },
        { $inc: { __v: 1 } },
        { session },
      );
      const refreshed = await generate(run.month, session);
      const comparable = (rows) =>
        rows
          .map((s) =>
            JSON.stringify(
              Object.fromEntries(
                Object.entries(s.toObject ? s.toObject() : s).sort(([a], [b]) =>
                  a.localeCompare(b),
                ),
              ),
            ),
          )
          .sort();
      if (
        JSON.stringify(comparable(run.slips)) !==
        JSON.stringify(comparable(refreshed))
      )
        throw new ApiError(
          409,
          "Payroll inputs changed. Ask HR to regenerate and review the draft.",
        );
      const before = run.toObject();
      run.status = "finalized";
      run.finalizedBy = req.user._id;
      run.finalizedAt = new Date();
      await run.save({ session });
      for (const slip of run.slips)
        await context.notify(
          session,
          slip.user,
          `Your ${run.month} payslip is ready.`,
        );
      await context.audit(
        session,
        req.user,
        "finalize",
        "Payroll",
        before,
        run,
      );
      return run;
    });
    res.json(doc);
  }),
);
router.get(
  "/payroll/:id/payslip/:employee",
  asyncHandler(async (req, res) => {
    id.parse(req.params.id);
    id.parse(req.params.employee);
    if (
      req.user.role === "employee" &&
      String(req.user.employee) !== req.params.employee
    )
      throw new ApiError(403, "You may only download your own payslip.");
    const run = requireRecord(
      await models.Payroll.findById(req.params.id).lean(),
    );
    if (run.status !== "finalized")
      throw new ApiError(409, "Payslips are available after finalization.");
    const slip = requireRecord(
      run.slips.find((s) => String(s.employee) === req.params.employee),
    );
    const company = await models.Company.findOne().lean();
    const pdf = new PDFDocument({ margin: 55 });
    res
      .attachment(
        `payslip-${run.month}-${slip.code.replace(/[^a-z0-9-]/gi, "")}.pdf`,
      )
      .type("application/pdf");
    pdf.pipe(res);
    pdf
      .fontSize(24)
      .text(company.name)
      .moveDown()
      .fontSize(18)
      .text(`Payslip | ${run.month}`)
      .moveDown()
      .fontSize(12)
      .text(`${slip.name} (${slip.code})`)
      .moveDown();
    for (const key of [
      "basic",
      "hra",
      "medical",
      "gross",
      "workingDays",
      "eligibleDays",
      "absent",
      "unpaid",
      "halfDays",
      "deduction",
      "tax",
      "net",
    ])
      pdf.text(
        `${key}: ${slip[key].toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
        { lineGap: 7 },
      );
    pdf
      .moveDown()
      .text("Finalized payroll. Amounts in company currency (PKR).");
    pdf.end();
  }),
);

module.exports = router;
