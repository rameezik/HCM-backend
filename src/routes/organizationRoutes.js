const express = require("express");
const { z } = require("zod");
const models = require("../models");
const ApiError = require("../utils/ApiError");
const context = require("../services/context");
const { roles } = require("../middleware/authMiddleware");
const { id, text, date } = require("./schemas/common");
const { asyncHandler, parseInput, requireRecord } = require("../utils/http");
const companySchema = require("./schemas/company");
const router = express.Router();

router.get(
  "/company",
  roles("admin", "hr"),
  asyncHandler(async (req, res) =>
    res.json((await context.settings()).company),
  ),
);
router.put(
  "/company",
  roles("admin"),
  asyncHandler(async (req, res) => {
    const body = parseInput(companySchema, req.body);
    const doc = await context.transaction(async (session) => {
      const before = await models.Company.findOne().session(session).lean();
      const after = await models.Company.findOneAndUpdate({}, body, {
        returnDocument: "after",
        session,
        runValidators: true,
      });
      await context.audit(
        session,
        req.user,
        "update",
        "Company",
        before,
        after,
      );
      return after;
    });
    res.json(doc);
  }),
);
const catalogs = {
  departments: [models.Department, z.object({ name: text }).strict()],
  designations: [models.Designation, z.object({ name: text }).strict()],
  "leave-types": [
    models.LeaveType,
    z
      .object({
        name: text,
        quota: z.number().int().min(0).max(366),
        unpaid: z.boolean(),
      })
      .strict(),
  ],
  holidays: [models.Holiday, z.object({ name: text, date }).strict()],
};
for (const [path, [Model, schema]] of Object.entries(catalogs)) {
  const managers = ["departments", "designations"].includes(path)
    ? ["admin", "hr"]
    : ["admin"];
  router.get(
    `/${path}`,
    ...(path === "leave-types" ? [] : [roles("admin", "hr")]),
    asyncHandler(async (req, res) => {
      const rows = await Model.find().sort({ name: 1 }).lean();
      if (path !== "departments") return res.json(rows);
      const counts = await models.Employee.aggregate([
        { $group: { _id: "$department", employeeCount: { $sum: 1 } } },
      ]);
      const byId = new Map(
        counts.map((row) => [String(row._id), row.employeeCount]),
      );
      res.json(
        rows.map((row) => ({
          ...row,
          employeeCount: byId.get(String(row._id)) || 0,
        })),
      );
    }),
  );
  router.post(
    `/${path}`,
    roles(...managers),
    asyncHandler(async (req, res) => {
      const body = parseInput(schema, req.body);
      const doc = await context.transaction(async (session) => {
        const [after] = await Model.create([body], { session });
        await context.audit(
          session,
          req.user,
          "create",
          Model.modelName,
          null,
          after,
        );
        return after;
      });
      res.status(201).json(doc);
    }),
  );
  router.put(
    `/${path}/:id`,
    roles(...managers),
    asyncHandler(async (req, res) => {
      const body = parseInput(schema, req.body);
      id.parse(req.params.id);
      const doc = await context.transaction(async (session) => {
        const before = requireRecord(
          await Model.findById(req.params.id).session(session).lean(),
        );
        const after = await Model.findByIdAndUpdate(req.params.id, body, {
          returnDocument: "after",
          session,
          runValidators: true,
        });
        await context.audit(
          session,
          req.user,
          "update",
          Model.modelName,
          before,
          after,
        );
        return after;
      });
      res.json(doc);
    }),
  );
  if (["departments", "designations"].includes(path))
    router.delete(
      `/${path}/:id`,
      roles(...managers),
      asyncHandler(async (req, res) => {
        id.parse(req.params.id);
        const field = path === "departments" ? "department" : "designation";
        await context.transaction(async (session) => {
          const before = requireRecord(
            await Model.findById(req.params.id).session(session).lean(),
          );
          if (
            (await models.Employee.exists({ [field]: before._id }).session(
              session,
            )) ||
            (await models.Payroll.exists({
              [`slips.${field}`]: before._id,
            }).session(session))
          )
            throw new ApiError(
              409,
              `This ${field} is referenced by employee or payroll records and cannot be removed.`,
            );
          await Model.deleteOne({ _id: before._id }, { session });
          await context.audit(
            session,
            req.user,
            "delete",
            Model.modelName,
            before,
            null,
          );
        });
        res.json({ deleted: true });
      }),
    );
}

module.exports = router;
