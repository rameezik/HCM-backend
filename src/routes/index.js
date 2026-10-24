const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");
const { parse } = require("csv-parse/sync");
const PDFDocument = require("pdfkit");
const M = require("../models");
const E = require("../utils/ApiError");
const { auth, roles } = require("../middleware/authMiddleware");
const C = require("../services/context");
const R = require("../services/rules");
const { board } = require("../services/attendanceService");
const { balances } = require("../services/leaveService");
const { generate } = require("../services/payrollService");
const { dashboard } = require("../services/dashboardService");
const router = express.Router();
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid record ID");
const text = z.string().trim().min(1).max(200);
const date = z.string().refine(R.isoDate, "Use a valid YYYY-MM-DD date");
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const password = z.string().min(12).max(128);
const validate = (schema, body) => schema.parse(body);
const requireDoc = (doc) => {
  if (!doc) throw new E(404, "Record not found.");
  return doc;
};
const userView = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  employee: user.employee,
  active: user.active,
  mustChangePassword: user.mustChangePassword,
});
const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 8 * 3600000,
});
function signIn(res, user) {
  const token = jwt.sign(
    { sub: String(user._id), version: user.tokenVersion },
    process.env.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "8h" },
  );
  res.cookie("hcm_session", token, cookieOptions()).json(userView(user));
}
const loginLimit = rateLimit({
  windowMs: 15 * 60000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const companySchema = z
  .object({
    name: text,
    officeStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("09:00"),
    graceMinutes: z.number().int().min(0).max(180).default(15),
    halfDayHours: z.number().min(1).max(12).default(5),
    weekend: z.array(z.number().int().min(0).max(6)).max(6).default([0, 6]),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    radius: z.number().positive().max(10000).default(150),
    timezone: z.literal("UTC").default("UTC"),
  })
  .strict();
router.get(
  "/health",
  wrap(async (req, res) => {
    await M.Company.db.db.admin().ping();
    res.json({ status: "ok", database: "connected" });
  }),
);
router.get(
  "/setup",
  wrap(async (req, res) =>
    res.json({ required: !(await M.Company.exists({})) }),
  ),
);
router.post(
  "/setup",
  loginLimit,
  wrap(async (req, res) => {
    const body = validate(
      z
        .object({ company: companySchema, name: text, email, password })
        .strict(),
      req.body,
    );
    await C.transaction(async (session) => {
      if (await M.Company.exists({}).session(session))
        throw new E(409, "Company is already initialized.");
      const [company] = await M.Company.create([body.company], { session });
      const [admin] = await M.User.create(
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
      await M.LeaveType.create(
        [
          { name: "Annual", quota: 14 },
          { name: "Sick", quota: 8 },
          { name: "Casual", quota: 10 },
          { name: "Unpaid", quota: 0, unpaid: true },
        ],
        { session, ordered: true },
      );
      await C.audit(session, admin, "setup", "Company", null, company);
    });
    res.status(201).json({ message: "Company initialized. Sign in as Admin." });
  }),
);
router.post(
  "/auth/login",
  loginLimit,
  wrap(async (req, res) => {
    const body = validate(
      z.object({ email, password: z.string().min(1).max(128) }).strict(),
      req.body,
    );
    const user = await M.User.findOne({ email: body.email }).select(
      "+passwordHash",
    );
    if (
      !user ||
      !user.active ||
      !(await bcrypt.compare(body.password, user.passwordHash))
    )
      throw new E(401, "Invalid email or password.");
    await C.transaction((session) =>
      C.audit(session, user, "login", "User", null, userView(user)),
    );
    signIn(res, user);
  }),
);
router.use(auth);
router.get("/auth/me", (req, res) => res.json(userView(req.user)));
router.post(
  "/auth/logout",
  wrap(async (req, res) => {
    await C.transaction(async (session) => {
      await M.User.updateOne(
        { _id: req.user._id },
        { $inc: { tokenVersion: 1 } },
        { session },
      );
      await C.audit(
        session,
        req.user,
        "logout",
        "User",
        userView(req.user),
        null,
      );
    });
    res
      .clearCookie("hcm_session", { ...cookieOptions(), maxAge: undefined })
      .json({ message: "Signed out." });
  }),
);
router.post(
  "/auth/password",
  wrap(async (req, res) => {
    const body = validate(
      z
        .object({ currentPassword: z.string().min(1).max(128), password })
        .strict(),
      req.body,
    );
    const user = await M.User.findById(req.user._id).select("+passwordHash");
    if (!(await bcrypt.compare(body.currentPassword, user.passwordHash)))
      throw new E(422, "Current password is incorrect.");
    if (body.currentPassword === body.password)
      throw new E(422, "Choose a different password.");
    await C.transaction(async (session) => {
      const before = userView(user);
      user.passwordHash = await bcrypt.hash(body.password, 12);
      user.mustChangePassword = false;
      user.tokenVersion++;
      await user.save({ session });
      await C.audit(
        session,
        user,
        "password_change",
        "User",
        before,
        userView(user),
      );
    });
    signIn(res, user);
  }),
);
router.get(
  "/company",
  roles("admin", "hr"),
  wrap(async (req, res) => res.json((await C.settings()).company)),
);
router.put(
  "/company",
  roles("admin"),
  wrap(async (req, res) => {
    const body = validate(companySchema, req.body);
    const doc = await C.transaction(async (session) => {
      const before = await M.Company.findOne().session(session).lean();
      const after = await M.Company.findOneAndUpdate({}, body, {
        returnDocument: "after",
        session,
        runValidators: true,
      });
      await C.audit(session, req.user, "update", "Company", before, after);
      return after;
    });
    res.json(doc);
  }),
);
const catalogs = {
  departments: [M.Department, z.object({ name: text }).strict()],
  designations: [M.Designation, z.object({ name: text }).strict()],
  "leave-types": [
    M.LeaveType,
    z
      .object({
        name: text,
        quota: z.number().int().min(0).max(366),
        unpaid: z.boolean(),
      })
      .strict(),
  ],
  holidays: [M.Holiday, z.object({ name: text, date }).strict()],
};
for (const [path, [Model, schema]] of Object.entries(catalogs)) {
  router.get(
    `/${path}`,
    ...(path === "leave-types" ? [] : [roles("admin", "hr")]),
    wrap(async (req, res) =>
      res.json(await Model.find().sort({ name: 1 }).lean()),
    ),
  );
  router.post(
    `/${path}`,
    roles("admin"),
    wrap(async (req, res) => {
      const body = validate(schema, req.body);
      const doc = await C.transaction(async (session) => {
        const [after] = await Model.create([body], { session });
        await C.audit(
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
    roles("admin"),
    wrap(async (req, res) => {
      const body = validate(schema, req.body);
      id.parse(req.params.id);
      const doc = await C.transaction(async (session) => {
        const before = requireDoc(
          await Model.findById(req.params.id).session(session).lean(),
        );
        const after = await Model.findByIdAndUpdate(req.params.id, body, {
          returnDocument: "after",
          session,
          runValidators: true,
        });
        await C.audit(
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
}
router.get(
  "/users",
  roles("admin"),
  wrap(async (req, res) =>
    res.json((await M.User.find().sort({ createdAt: -1 })).map(userView)),
  ),
);
router.post(
  "/users",
  roles("admin"),
  wrap(async (req, res) => {
    const body = validate(
      z
        .object({ name: text, email, password, employee: id.optional() })
        .strict(),
      req.body,
    );
    const doc = await C.transaction(async (session) => {
      if (body.employee) {
        const emp = requireDoc(
          await M.Employee.findById(body.employee).session(session),
        );
        const existing = await M.User.findById(emp.user).session(session);
        if (existing?.role !== "employee")
          throw new E(422, "Employee is already linked to a staff login.");
      }
      let after;
      if (body.employee) {
        const emp = await M.Employee.findById(body.employee).session(session);
        after = await M.User.findByIdAndUpdate(
          emp.user,
          {
            name: body.name,
            email: body.email,
            role: "hr",
            passwordHash: await bcrypt.hash(body.password, 12),
            mustChangePassword: true,
            $inc: { tokenVersion: 1 },
          },
          { returnDocument: "after", session },
        );
      } else
        [after] = await M.User.create(
          [
            {
              name: body.name,
              email: body.email,
              passwordHash: await bcrypt.hash(body.password, 12),
              role: "hr",
            },
          ],
          { session },
        );
      await C.audit(
        session,
        req.user,
        "create_hr",
        "User",
        null,
        userView(after),
      );
      return userView(after);
    });
    res.status(201).json(doc);
  }),
);
router.patch(
  "/users/:id",
  roles("admin"),
  wrap(async (req, res) => {
    id.parse(req.params.id);
    const body = validate(
      z
        .object({
          active: z.boolean().optional(),
          password: password.optional(),
        })
        .strict(),
      req.body,
    );
    const doc = await C.transaction(async (session) => {
      const user = requireDoc(
        await M.User.findById(req.params.id).session(session),
      );
      if (user.role === "admin")
        throw new E(
          403,
          "Use your own password change flow for the Admin account.",
        );
      const before = userView(user);
      if (body.active !== undefined) user.active = body.active;
      if (body.password) {
        user.passwordHash = await bcrypt.hash(body.password, 12);
        user.mustChangePassword = true;
      }
      user.tokenVersion++;
      await user.save({ session });
      await C.audit(
        session,
        req.user,
        "update_login",
        "User",
        before,
        userView(user),
      );
      return userView(user);
    });
    res.json(doc);
  }),
);
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
  requireDoc(
    await M.Department.findById(body.department).session(session || null),
  );
  requireDoc(
    await M.Designation.findById(body.designation).session(session || null),
  );
  if (body.exitDate && body.exitDate < body.joinDate)
    throw new E(422, "Exit date precedes joining date.");
  if (body.status === "exited" && !body.exitDate)
    throw new E(422, "Exit date is required for an exited employee.");
}
async function createEmployee(body, temporaryPassword, actor, session) {
  await employeeReferences(body, session);
  const [user] = await M.User.create(
    [
      {
        name: body.name,
        email: body.email,
        passwordHash: await bcrypt.hash(temporaryPassword, 12),
        role: "employee",
      },
    ],
    { session },
  );
  const [employee] = await M.Employee.create([{ ...body, user: user._id }], {
    session,
  });
  user.employee = employee._id;
  await user.save({ session });
  await C.audit(session, actor, "register", "Employee", null, employee);
  return employee;
}
router.get(
  "/employees",
  wrap(async (req, res) => {
    const q = validate(
      z.object({
        search: z.string().max(100).optional(),
        department: id.optional(),
        status: z.enum(["active", "probation", "exited"]).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
      req.query,
    );
    const filter = C.employeeScope(req.user);
    if (q.department) filter.department = q.department;
    if (q.status) filter.status = q.status;
    if (q.search) {
      const term = q.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = ["name", "code", "email"].map((k) => ({
        [k]: { $regex: term, $options: "i" },
      }));
    }
    const total = await M.Employee.countDocuments(filter);
    const items = await M.Employee.find(filter)
      .populate("department designation")
      .sort({ name: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean();
    res.json({ items, total, page: q.page, pages: Math.ceil(total / q.limit) });
  }),
);
router.post(
  "/employees",
  roles("hr"),
  wrap(async (req, res) => {
    const { password: temporaryPassword, ...raw } = req.body;
    password.parse(temporaryPassword);
    const body = employeeSchema.parse(raw);
    const doc = await C.transaction((session) =>
      createEmployee(body, temporaryPassword, req.user, session),
    );
    res.status(201).json(doc);
  }),
);
router.get(
  "/employees/export",
  roles("hr"),
  wrap(async (req, res) => {
    const employees = await M.Employee.find().lean();
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
    const cell = (v) => {
      let s = String(v ?? "");
      if (/^[=+@\-\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    res
      .attachment("employees.csv")
      .type("text/csv")
      .send(
        [
          keys.join(","),
          ...employees.map((e) => keys.map((k) => cell(e[k])).join(",")),
        ].join("\r\n"),
      );
  }),
);
router.post(
  "/employees/import",
  roles("hr"),
  wrap(async (req, res) => {
    const body = z
      .object({
        csv: z.string().min(1).max(500000),
        dryRun: z.boolean(),
        password: password.optional(),
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
      throw new E(422, "Invalid CSV format.");
    }
    if (rows.length > 500)
      throw new E(422, "Import at most 500 employees at a time.");
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
      if (codes.has(row.code) || (await M.Employee.exists({ code: row.code })))
        errors.push({
          row: i + 2,
          field: "code",
          reason: "Duplicate employee code",
        });
      if (emails.has(row.email) || (await M.User.exists({ email: row.email })))
        errors.push({ row: i + 2, field: "email", reason: "Duplicate email" });
      codes.add(row.code);
      emails.add(row.email);
      for (const [key, Model] of [
        ["department", M.Department],
        ["designation", M.Designation],
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
    await C.transaction(async (session) => {
      for (const row of parsed)
        await createEmployee(row, body.password, req.user, session);
    });
    res.status(201).json({ imported: parsed.length, errors: [] });
  }),
);
router.get(
  "/employees/:id",
  wrap(async (req, res) => {
    id.parse(req.params.id);
    const employee = requireDoc(
      await M.Employee.findOne({
        $and: [{ _id: req.params.id }, C.employeeScope(req.user)],
      })
        .populate("department designation")
        .lean(),
    );
    const attendance = await M.Attendance.find({ employee: employee._id })
      .sort({ date: -1 })
      .limit(60)
      .lean();
    const leaves = await M.Leave.find({ employee: employee._id })
      .populate("type")
      .sort({ createdAt: -1 })
      .limit(60)
      .lean();
    res.json({ employee, attendance, leaves });
  }),
);
router.patch(
  "/employees/:id",
  roles("hr", "employee"),
  wrap(async (req, res) => {
    id.parse(req.params.id);
    const body =
      req.user.role === "employee"
        ? z
            .object({
              phone: z.string().max(40),
              address: z.string().max(1000),
            })
            .strict()
            .parse(req.body)
        : employeeSchema.parse(req.body);
    const doc = await C.transaction(async (session) => {
      const employee = requireDoc(
        await M.Employee.findOne({
          $and: [{ _id: req.params.id }, C.employeeScope(req.user)],
        }).session(session),
      );
      const before = employee.toObject();
      if (req.user.role === "hr") await employeeReferences(body, session);
      Object.assign(employee, body);
      await employee.save({ session });
      if (req.user.role === "hr")
        await M.User.updateOne(
          { _id: employee.user },
          {
            name: employee.name,
            email: employee.email,
            ...(employee.status === "exited"
              ? { active: false, $inc: { tokenVersion: 1 } }
              : {}),
          },
          { session },
        );
      await C.audit(session, req.user, "update", "Employee", before, employee);
      return employee;
    });
    res.json(doc);
  }),
);
router.get(
  "/attendance",
  wrap(async (req, res) => res.json(await board(req.user, req.query))),
);
for (const action of ["check-in", "check-out"])
  router.post(
    `/attendance/${action}`,
    roles("hr", "employee"),
    wrap(async (req, res) => {
      const employee = C.requireEmployee(req.user),
        now = new Date(),
        day = R.today();
      const record = await C.transaction(async (session) => {
        const person = requireDoc(
          await M.Employee.findByIdAndUpdate(
            employee,
            { $inc: { __v: 1 } },
            { returnDocument: "after", session },
          ),
        );
        if (
          await M.Payroll.exists({
            month: day.slice(0, 7),
            status: "finalized",
          }).session(session)
        )
          throw new E(409, "Payroll for this month is finalized.");
        if (person.joinDate > day || (person.exitDate && person.exitDate < day))
          throw new E(422, "Your employment is not active today.");
        const { company, holidays } = await C.settings(session);
        if (!R.workingDays(day, day, company, holidays).length)
          throw new E(422, "Today is not a working day.");
        const existing = await M.Attendance.findOne({
          employee,
          date: day,
        }).session(session);
        if (action === "check-in") {
          if (existing) throw new E(409, "Already checked in today.");
          if (
            await M.Leave.exists({
              employee,
              status: "approved",
              days: day,
            }).session(session)
          )
            throw new E(422, "Cancel approved leave before checking in.");
          const [after] = await M.Attendance.create(
            [
              {
                employee,
                date: day,
                checkIn: now,
                rules: company,
                ...R.attendanceStatus(now, null, company),
              },
            ],
            { session },
          );
          await C.audit(
            session,
            req.user,
            "check_in",
            "Attendance",
            null,
            after,
          );
          return after;
        }
        if (!existing) throw new E(422, "Check in first.");
        if (existing.checkOut) throw new E(409, "Already checked out today.");
        const before = existing.toObject();
        existing.checkOut = now;
        Object.assign(
          existing,
          R.attendanceStatus(existing.checkIn, now, existing.rules),
        );
        await existing.save({ session });
        await C.audit(
          session,
          req.user,
          "check_out",
          "Attendance",
          before,
          existing,
        );
        return existing;
      });
      res.json(record);
    }),
  );
router.get(
  "/corrections",
  wrap(async (req, res) =>
    res.json(
      await M.Correction.find(C.scope(req.user))
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
  wrap(async (req, res) => {
    const body = z
      .object({
        date,
        checkIn: z.string().datetime(),
        checkOut: z.string().datetime(),
        reason: text,
      })
      .strict()
      .parse(req.body);
    if (
      body.date > R.today() ||
      !body.checkIn.startsWith(body.date) ||
      !body.checkOut.startsWith(body.date)
    )
      throw new E(
        422,
        "Correction times must belong to a past or current date.",
      );
    const employee = C.requireEmployee(req.user);
    const doc = await C.transaction(async (session) => {
      const { company, holidays } = await C.settings(session);
      R.attendanceStatus(body.checkIn, body.checkOut, company);
      const person = requireDoc(
        await M.Employee.findById(employee).session(session),
      );
      if (
        body.date < person.joinDate ||
        (person.exitDate && body.date > person.exitDate)
      )
        throw new E(422, "Correction must fall within employment dates.");
      if (!R.workingDays(body.date, body.date, company, holidays).length)
        throw new E(422, "Choose a working day.");
      if (
        await M.Correction.exists({
          employee,
          date: body.date,
          status: "pending",
        }).session(session)
      )
        throw new E(409, "A correction for this date is already pending.");
      const [after] = await M.Correction.create([{ ...body, employee }], {
        session,
      });
      await C.audit(
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
  roles("hr"),
  wrap(async (req, res) => {
    id.parse(req.params.id);
    const body = z
      .object({ status: z.enum(["approved", "rejected"]), comment: text })
      .strict()
      .parse(req.body);
    const doc = await C.transaction(async (session) => {
      const correction = requireDoc(
        await M.Correction.findById(req.params.id).session(session),
      );
      if (String(correction.employee) === String(req.user.employee))
        throw new E(403, "You cannot approve your own correction.");
      if (correction.status !== "pending")
        throw new E(409, "Correction already decided.");
      const before = correction.toObject();
      await M.Employee.updateOne(
        { _id: correction.employee },
        { $inc: { __v: 1 } },
        { session },
      );
      if (body.status === "approved") {
        const month = correction.date.slice(0, 7);
        if (
          await M.Payroll.exists({ month, status: "finalized" }).session(
            session,
          )
        )
          throw new E(409, "The payroll month is finalized.");
        if (
          await M.Leave.exists({
            employee: correction.employee,
            days: correction.date,
            status: "approved",
          }).session(session)
        )
          throw new E(422, "This date has approved leave.");
        const old = await M.Attendance.findOne({
          employee: correction.employee,
          date: correction.date,
        }).session(session);
        const rules = old?.rules || (await C.settings(session)).company;
        const after = await M.Attendance.findOneAndUpdate(
          { employee: correction.employee, date: correction.date },
          {
            checkIn: correction.checkIn,
            checkOut: correction.checkOut,
            rules,
            ...R.attendanceStatus(
              correction.checkIn,
              correction.checkOut,
              rules,
            ),
          },
          { upsert: true, returnDocument: "after", session },
        );
        await C.audit(
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
      const employee = await M.Employee.findById(correction.employee).session(
        session,
      );
      await C.notify(
        session,
        employee.user,
        `Attendance correction ${body.status}: ${body.comment}`,
      );
      await C.audit(
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
router.get(
  "/leave/balance",
  roles("hr", "employee"),
  wrap(async (req, res) =>
    res.json(
      await balances(
        req.user,
        z
          .string()
          .regex(/^\d{4}$/)
          .parse(req.query.year || R.today().slice(0, 4)),
      ),
    ),
  ),
);
router.get(
  "/leave",
  wrap(async (req, res) =>
    res.json(
      await M.Leave.find(C.scope(req.user))
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
  wrap(async (req, res) => {
    const body = z
      .object({ type: id, start: date, end: date, reason: text })
      .strict()
      .parse(req.body);
    if (body.start.slice(0, 4) !== body.end.slice(0, 4))
      throw new E(422, "Submit separate requests for each calendar year.");
    const employee = C.requireEmployee(req.user);
    const doc = await C.transaction(async (session) => {
      // Writing the employee serializes competing balance reservations under Mongo transactions.
      const person = requireDoc(
        await M.Employee.findByIdAndUpdate(
          employee,
          { $inc: { __v: 1 } },
          { session, returnDocument: "after" },
        ),
      );
      if (
        body.start < person.joinDate ||
        (person.exitDate && body.end > person.exitDate)
      )
        throw new E(422, "Leave must fall within employment dates.");
      const type = requireDoc(
        await M.LeaveType.findById(body.type).session(session),
      );
      const { company, holidays } = await C.settings(session);
      const days = R.workingDays(body.start, body.end, company, holidays);
      if (!days.length)
        throw new E(422, "This range contains no working days.");
      if (
        await M.Leave.exists({
          employee,
          status: { $in: ["pending", "approved"] },
          days: { $in: days },
        }).session(session)
      )
        throw new E(422, "This request overlaps existing leave.");
      const balance = (
        await balances(req.user, body.start.slice(0, 4), session)
      ).find((b) => String(b._id) === body.type);
      if (!type.unpaid && days.length > balance.remaining)
        throw new E(422, "Insufficient leave balance.");
      if (
        await M.Payroll.exists({
          month: { $gte: body.start.slice(0, 7), $lte: body.end.slice(0, 7) },
          status: "finalized",
        }).session(session)
      )
        throw new E(409, "This range intersects a finalized payroll month.");
      const [after] = await M.Leave.create(
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
      await C.audit(session, req.user, "apply_leave", "Leave", null, after);
      return after;
    });
    res.status(201).json(doc);
  }),
);
router.patch(
  "/leave/:id",
  roles("hr", "employee"),
  wrap(async (req, res) => {
    id.parse(req.params.id);
    const body = z
      .object({
        status: z.enum(["approved", "rejected", "cancelled"]),
        comment: text,
      })
      .strict()
      .parse(req.body);
    const doc = await C.transaction(async (session) => {
      const leave = requireDoc(
        await M.Leave.findById(req.params.id).session(session),
      );
      const own = String(leave.employee) === String(req.user.employee);
      if (body.status === "cancelled" ? !own : req.user.role !== "hr" || own)
        throw new E(403, "You cannot make this leave decision.");
      if (
        body.status === "cancelled"
          ? !["pending", "approved"].includes(leave.status)
          : leave.status !== "pending"
      )
        throw new E(409, "Leave already decided.");
      if (
        await M.Payroll.exists({
          month: { $gte: leave.start.slice(0, 7), $lte: leave.end.slice(0, 7) },
          status: "finalized",
        }).session(session)
      )
        throw new E(409, "Payroll for this leave is finalized.");
      await M.Employee.updateOne(
        { _id: leave.employee },
        { $inc: { __v: 1 } },
        { session },
      );
      if (
        body.status === "approved" &&
        (await M.Attendance.exists({
          employee: leave.employee,
          date: { $in: leave.days },
        }).session(session))
      )
        throw new E(422, "Leave conflicts with recorded attendance.");
      const before = leave.toObject();
      Object.assign(leave, body, { decidedBy: req.user._id });
      await leave.save({ session });
      const employee = await M.Employee.findById(leave.employee).session(
        session,
      );
      await C.notify(
        session,
        employee.user,
        `Leave ${body.status}: ${body.comment}`,
      );
      await C.audit(session, req.user, "decide_leave", "Leave", before, leave);
      return leave;
    });
    res.json(doc);
  }),
);
router.get(
  "/payroll",
  wrap(async (req, res) => {
    const runs = await M.Payroll.find(
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
  roles("hr"),
  wrap(async (req, res) => {
    const { month } = z
      .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })
      .strict()
      .parse(req.body);
    const doc = await C.transaction(async (session) => {
      const before = await M.Payroll.findOne({ month }).session(session).lean();
      if (before?.status === "finalized")
        throw new E(409, "Finalized payroll is locked.");
      const slips = await generate(month, session);
      const after = await M.Payroll.findOneAndUpdate(
        { month },
        { slips, createdBy: req.user._id, status: "draft" },
        { upsert: true, returnDocument: "after", session },
      );
      await C.audit(
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
  wrap(async (req, res) => {
    id.parse(req.params.id);
    const doc = await C.transaction(async (session) => {
      const run = requireDoc(
        await M.Payroll.findById(req.params.id).session(session),
      );
      if (run.status !== "draft")
        throw new E(409, "Finalized payroll is locked.");
      await M.Employee.updateMany(
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
        throw new E(
          409,
          "Payroll inputs changed. Ask HR to regenerate and review the draft.",
        );
      const before = run.toObject();
      run.status = "finalized";
      run.finalizedBy = req.user._id;
      run.finalizedAt = new Date();
      await run.save({ session });
      for (const slip of run.slips)
        await C.notify(
          session,
          slip.user,
          `Your ${run.month} payslip is ready.`,
        );
      await C.audit(session, req.user, "finalize", "Payroll", before, run);
      return run;
    });
    res.json(doc);
  }),
);
router.get(
  "/payroll/:id/payslip/:employee",
  wrap(async (req, res) => {
    id.parse(req.params.id);
    id.parse(req.params.employee);
    if (
      req.user.role === "employee" &&
      String(req.user.employee) !== req.params.employee
    )
      throw new E(403, "You may only download your own payslip.");
    const run = requireDoc(await M.Payroll.findById(req.params.id).lean());
    if (run.status !== "finalized")
      throw new E(409, "Payslips are available after finalization.");
    const slip = requireDoc(
      run.slips.find((s) => String(s.employee) === req.params.employee),
    );
    const company = await M.Company.findOne().lean();
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
router.get(
  "/dashboard",
  wrap(async (req, res) => res.json(await dashboard(req.user, req.query))),
);
router.get(
  "/announcements",
  wrap(async (req, res) =>
    res.json(
      await M.Announcement.find()
        .populate("actor", "name")
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ),
  ),
);
router.post(
  "/announcements",
  roles("admin", "hr"),
  wrap(async (req, res) => {
    const body = z
      .object({ title: text, body: z.string().trim().min(1).max(5000) })
      .strict()
      .parse(req.body);
    const doc = await C.transaction(async (session) => {
      const [after] = await M.Announcement.create(
        [{ ...body, actor: req.user._id }],
        { session },
      );
      await C.audit(session, req.user, "post", "Announcement", null, after);
      return after;
    });
    res.status(201).json(doc);
  }),
);
router.get(
  "/notifications",
  wrap(async (req, res) =>
    res.json(
      await M.Notification.find({ recipient: req.user._id })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ),
  ),
);
router.patch(
  "/notifications/:id",
  wrap(async (req, res) => {
    id.parse(req.params.id);
    res.json(
      requireDoc(
        await M.Notification.findOneAndUpdate(
          { _id: req.params.id, recipient: req.user._id },
          { read: true },
          { returnDocument: "after" },
        ),
      ),
    );
  }),
);
router.get(
  "/audit",
  roles("admin"),
  wrap(async (req, res) =>
    res.json(
      await M.AuditLog.find()
        .populate("actor", "name role")
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
    ),
  ),
);
router.use("/ai", require("./aiRoutes"));
module.exports = router;
