const express = require("express");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");
const ApiError = require("../utils/ApiError");
const service = require("../services/kioskAccessService");
const router = express.Router();
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid record ID");
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!req.user?.company || req.user.role !== "admin")
    return next(
      new ApiError(403, "Only company Admin can manage kiosk access."),
    );
  if (process.env.NODE_ENV === "production" && !req.secure)
    return next(
      new ApiError(
        400,
        "Kiosk management requires HTTPS through the configured trusted proxy.",
      ),
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
    message: { message: "Kiosk management limit reached. Try again later." },
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
      .object({ label: z.string().trim().min(1).max(80) })
      .strict()
      .parse(req.body);
    res.status(201).json(await service.createDevice(req.user, body.label));
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
