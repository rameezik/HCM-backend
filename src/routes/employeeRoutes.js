const express = require("express");
const { z } = require("zod");
const models = require("../models");
const ApiError = require("../utils/ApiError");
const context = require("../services/context");
const { roles } = require("../middleware/authMiddleware");
const { id, text, date, email, password } = require("./schemas/common");
const { asyncHandler, parseInput, requireRecord } = require("../utils/http");
const bcrypt = require("bcryptjs");
const { parse } = require("csv-parse/sync");
const { serializeUser } = require("../services/sessionService");
const {
  lockAdminManagement,
  guardAccountChange,
  employeeView,
  accountProjection,
} = require("../services/accountManagementService");
const router = express.Router();

const employeeSchema = z
  .object({
    name: text,
    email,
    code: text,
    department: id,
    designation: id,
    joinDate: date,
    exitDate: date.optional(),
    status: z.enum(["active", "probation", "exited"]).default("active"),
    gender: z
      .enum(["female", "male", "other", "unspecified"])
      .default("unspecified"),
    basic: z.number().positive().max(100000000),
    phone: z.string().max(40).optional(),
    address: z.string().max(1000).optional(),
  })
  .strict();
async function employeeReferences(body, session) {
  // Assignments and safe deletion lock the same catalog document. A catalog
  // cannot disappear between validation and committing an employee assignment.
  for (const [Model, value] of [
    [models.Department, body.department],
    [models.Designation, body.designation],
  ])
    requireRecord(
      session
        ? await Model.findOneAndUpdate(
            { _id: value },
            { $inc: { __v: 1 } },
            { session, returnDocument: "after" },
          )
        : await Model.findById(value),
    );
  if (body.exitDate && body.exitDate < body.joinDate)
    throw new ApiError(422, "Exit date precedes joining date.");
  if (body.status === "exited" && !body.exitDate)
    throw new ApiError(422, "Exit date is required for an exited employee.");
}
async function createEmployee(
  body,
  temporaryPassword,
  actor,
  session,
  role = "employee",
  requirePasswordChange = false,
) {
  if (actor.role !== "admin" && role !== "employee")
    throw new ApiError(403, "Only Admin can assign HR or Admin roles.");
  await lockAdminManagement(actor, session);
  await employeeReferences(body, session);
  const [user] = await models.User.create(
    [
      {
        name: body.name,
        email: body.email,
        passwordHash: await bcrypt.hash(temporaryPassword, 12),
        role,
        active: body.status !== "exited",
        passwordChangeEnforced: requirePasswordChange,
      },
    ],
    { session },
  );
  const [employee] = await models.Employee.create(
    [{ ...body, user: user._id }],
    {
      session,
    },
  );
  user.employee = employee._id;
  await user.save({ session });
  await context.audit(session, actor, "register", "Employee", null, employee);
  return employee;
}
router.get(
  "/employees",
  asyncHandler(async (req, res) => {
    const query = parseInput(
      z.object({
        search: z.string().max(100).optional(),
        department: id.optional(),
        status: z.enum(["active", "probation", "exited"]).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
      req.query,
    );
    const filter = context.employeeScope(req.user);
    if (query.department) filter.department = query.department;
    if (query.status) filter.status = query.status;
    if (query.search) {
      const term = query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = ["name", "code", "email"].map((field) => ({
        [field]: { $regex: term, $options: "i" },
      }));
    }
    const total = await models.Employee.countDocuments(filter);
    const items = await models.Employee.find(filter)
      .populate("department designation")
      .populate("user", accountProjection)
      .sort({ name: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean();
    res.json({
      items,
      total,
      page: query.page,
      pages: Math.ceil(total / query.limit),
    });
  }),
);
router.post(
  "/employees",
  roles("admin", "hr"),
  asyncHandler(async (req, res) => {
    const {
      password: temporaryPassword,
      role: requestedRole = "employee",
      requirePasswordChange = false,
      ...raw
    } = req.body;
    password.parse(temporaryPassword);
    z.boolean().parse(requirePasswordChange);
    const role = z.enum(["admin", "hr", "employee"]).parse(requestedRole);
    if (req.user.role !== "admin" && role !== "employee")
      throw new ApiError(403, "Only Admin can assign HR or Admin roles.");
    const body = employeeSchema.parse(raw);
    const doc = await context.transaction((session) =>
      createEmployee(
        body,
        temporaryPassword,
        req.user,
        session,
        role,
        requirePasswordChange,
      ),
    );
    res.status(201).json(await employeeView(doc._id));
  }),
);
router.get(
  "/employees/export",
  roles("admin", "hr"),
  asyncHandler(async (req, res) => {
    const employees = await models.Employee.find().lean();
    const keys = [
      "code",
      "name",
      "email",
      "department",
      "designation",
      "joinDate",
      "exitDate",
      "status",
      "gender",
      "basic",
      "phone",
      "address",
    ];
    // Prefix formula-bearing cells so spreadsheets cannot execute employee-supplied text.
    const escapeCell = (value) => {
      let escaped = String(value ?? "");
      if (/^[=+@\-\t\r]/.test(escaped)) escaped = `'${escaped}`;
      return `"${escaped.replace(/"/g, '""')}"`;
    };
    res
      .attachment("employees.csv")
      .type("text/csv")
      .send(
        [
          keys.join(","),
          ...employees.map((employee) =>
            keys.map((key) => escapeCell(employee[key])).join(","),
          ),
        ].join("\r\n"),
      );
  }),
);
router.post(
  "/employees/import",
  roles("admin", "hr"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        csv: z.string().min(1).max(500000),
        dryRun: z.boolean(),
        password: password.optional(),
        requirePasswordChange: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    let rows;
    try {
      rows = parse(body.csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });
    } catch {
      throw new ApiError(422, "Invalid CSV format.");
    }
    if (rows.length > 500)
      throw new ApiError(422, "Import at most 500 employees at a time.");
    const errors = [],
      parsed = [],
      codes = new Set(),
      emails = new Set();
    for (let i = 0; i < rows.length; i++) {
      const result = employeeSchema.safeParse({
        ...rows[i],
        basic: Number(rows[i].basic),
        ...(rows[i].exitDate ? {} : { exitDate: undefined }),
      });
      if (!result.success) {
        for (const issue of result.error.issues)
          errors.push({
            row: i + 2,
            field: issue.path.join("."),
            reason: issue.message,
          });
        continue;
      }
      const row = result.data;
      if (
        codes.has(row.code) ||
        (await models.Employee.exists({ code: row.code }))
      )
        errors.push({
          row: i + 2,
          field: "code",
          reason: "Duplicate employee code",
        });
      if (
        emails.has(row.email) ||
        (await models.User.exists({ email: row.email }))
      )
        errors.push({ row: i + 2, field: "email", reason: "Duplicate email" });
      codes.add(row.code);
      emails.add(row.email);
      for (const [key, Model] of [
        ["department", models.Department],
        ["designation", models.Designation],
      ])
        if (!(await Model.exists({ _id: row[key] })))
          errors.push({ row: i + 2, field: key, reason: `Unknown ${key} ID` });
      if (row.exitDate && row.exitDate < row.joinDate)
        errors.push({
          row: i + 2,
          field: "exitDate",
          reason: "Exit precedes joining date",
        });
      parsed.push(row);
    }
    if (body.dryRun || errors.length)
      return res.status(errors.length && !body.dryRun ? 422 : 200).json({
        rows: rows.length,
        valid: rows.length - new Set(errors.map((e) => e.row)).size,
        errors,
      });
    password.parse(body.password);
    await context.transaction(async (session) => {
      for (const row of parsed)
        await createEmployee(
          row,
          body.password,
          req.user,
          session,
          "employee",
          body.requirePasswordChange,
        );
    });
    res.status(201).json({ imported: parsed.length, errors: [] });
  }),
);
router.get(
  "/employees/:id",
  asyncHandler(async (req, res) => {
    id.parse(req.params.id);
    const employee = requireRecord(
      await models.Employee.findOne({
        $and: [{ _id: req.params.id }, context.employeeScope(req.user)],
      })
        .populate("department designation")
        .populate("user", accountProjection)
        .lean(),
    );
    const attendance = await models.Attendance.find({ employee: employee._id })
      .sort({ date: -1 })
      .limit(60)
      .lean();
    const leaves = await models.Leave.find({ employee: employee._id })
      .populate("type")
      .sort({ createdAt: -1 })
      .limit(60)
      .lean();
    res.json({ employee, attendance, leaves });
  }),
);
router.patch(
  "/employees/:id",
  roles("admin", "hr", "employee"),
  asyncHandler(async (req, res) => {
    id.parse(req.params.id);
    const { role: requestedRole, ...employeeFields } = req.body;
    if (requestedRole !== undefined)
      z.enum(["admin", "hr", "employee"]).parse(requestedRole);
    if (requestedRole !== undefined && req.user.role !== "admin")
      throw new ApiError(
        403,
        "Only Admin can change an employee's account role.",
      );
    const body =
      req.user.role === "employee"
        ? z
            .object({
              phone: z.string().max(40),
              address: z.string().max(1000),
            })
            .strict()
            .parse(req.body)
        : employeeSchema.parse(employeeFields);
    const doc = await context.transaction(async (session) => {
      if (req.user.role === "admin")
        await lockAdminManagement(req.user, session);
      const employee = requireRecord(
        await models.Employee.findOne({
          $and: [{ _id: req.params.id }, context.employeeScope(req.user)],
        }).session(session),
      );
      const login = requireRecord(
        await models.User.findById(employee.user).session(session),
      );
      if (req.user.role === "hr" && login.role !== "employee")
        throw new ApiError(
          403,
          "HR can edit employee accounts only. Admin manages privileged staff profiles.",
        );
      if (req.user.role === "admin")
        await guardAccountChange(
          req.user,
          login,
          {
            ...(requestedRole === undefined ? {} : { role: requestedRole }),
            ...(body.status === "exited" ? { active: false } : {}),
          },
          session,
        );
      const before = employee.toObject();
      if (["admin", "hr"].includes(req.user.role))
        await employeeReferences(body, session);
      Object.assign(employee, body);
      await employee.save({ session });
      if (employee.status === "exited")
        await models.BiometricEnrollment.updateOne(
          { employee: employee._id },
          { $set: { status: "deleting", deleteRequestedAt: new Date() } },
          { session },
        );
      if (["admin", "hr"].includes(req.user.role)) {
        // Session versions also bind reset links sent to the former mailbox.
        const revokeSessions =
          employee.status === "exited" ||
          login.email !== employee.email ||
          (requestedRole !== undefined && requestedRole !== login.role);
        const updatedLogin = await models.User.findOneAndUpdate(
          { _id: employee.user },
          {
            name: employee.name,
            email: employee.email,
            ...(requestedRole === undefined ? {} : { role: requestedRole }),
            ...(employee.status === "exited" ? { active: false } : {}),
            ...(revokeSessions ? { $inc: { tokenVersion: 1 } } : {}),
          },
          { session, returnDocument: "after" },
        );
        await context.audit(
          session,
          req.user,
          "update_login",
          "User",
          serializeUser(login),
          serializeUser(updatedLogin),
        );
      }
      await context.audit(
        session,
        req.user,
        "update",
        "Employee",
        before,
        employee,
      );
      return employee;
    });
    res.json(await employeeView(doc._id));
  }),
);

module.exports = router;
