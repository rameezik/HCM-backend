const express = require("express");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");
const ApiError = require("../utils/ApiError");
const service = require("../services/kioskAccessService");
const enrollment = require("../services/terminalEnrollmentService");
const router = express.Router();
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid record ID");
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!req.user?.company || req.user.role !== "admin")
    return next(
      new ApiError(403, "Only Admin can manage attendance terminals."),
    );
  if (process.env.NODE_ENV === "production" && !req.secure)
    return next(
      new ApiError(400, "Attendance Terminal settings require HTTPS."),
    );
  next();
});
router.use(
  rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    keyGenerator: (req) => `${req.user.company}:${req.user._id}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { message: "Too many settings changes. Try again later." },
  }),
);
router.get(
  "/employees",
  wrap(async (req, res) => {
    const query = z
      .object({
        search: z.string().trim().max(100).default(""),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(req.query);
    res.json(await enrollment.listEmployees(req.user, query));
  }),
);
router.post(
  "/employees/:id/enrollment",
  wrap(async (req, res) => {
    id.parse(req.params.id);
    const body = z
      .object({ consent: z.literal(true), consentVersion: z.string().max(100) })
      .strict()
      .parse(req.body);
    res.json(await enrollment.enable(req.user, req.params.id, body));
  }),
);
router.delete(
  "/employees/:id/enrollment",
  wrap(async (req, res) => {
    id.parse(req.params.id);
    res.json(await enrollment.disable(req.user, req.params.id));
  }),
);
router.get(
  "/devices",
  wrap(async (req, res) => res.json(await service.listDevices(req.user))),
);
router.post(
  "/devices",
  wrap(async (req, res) => {
    const body = z
      .object({
        label: z.string().trim().min(1).max(80),
        reusable: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json(
        await service.createDevice(req.user, body.label, {
          reusable: body.reusable,
        }),
      );
  }),
);
router.delete(
  "/devices/:id",
  wrap(async (req, res) => {
    id.parse(req.params.id);
    res.json(await service.revokeDevice(req.user, req.params.id));
  }),
);
router.post(
  "/enrollment-grants",
  wrap(async (req, res) => {
    const body = z.object({ employee: id }).strict().parse(req.body);
    res
      .status(201)
      .json(await service.createEnrollmentGrant(req.user, body.employee));
  }),
);
module.exports = router;
