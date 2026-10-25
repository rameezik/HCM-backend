const express = require("express");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");
const ApiError = require("../utils/ApiError");
const access = require("../services/kioskAccessService");
const { withCompany } = require("../services/companyContext");
const router = express.Router();
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid camera challenge");
const code = z
  .string()
  .regex(/^[a-f\d]{64}$/i, "Use the full access code supplied by Admin");
const samples = z
  .array(
    z
      .string()
      .min(100)
      .max(333360)
      .regex(/^(?:data:image\/jpeg;base64,)?[A-Za-z\d+/]+={0,2}$/),
  )
  .length(3);
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (process.env.NODE_ENV === "production" && !req.secure)
    return next(
      new ApiError(
        400,
        "Attendance kiosks require HTTPS through the configured trusted proxy.",
      ),
    );
  next();
});
const pairLimit = rateLimit({
  windowMs: 15 * 60000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    message:
      "Too many pairing attempts. Wait 15 minutes or ask Admin for help.",
  },
});
const deviceLimit = rateLimit({
  windowMs: 60000,
  limit: 90,
  keyGenerator: (req) => String(req.kioskDevice._id),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "This kiosk is scanning too quickly. Wait one minute." },
});
router.get(
  "/status",
  wrap(async (req, res) => {
    const device = await access.deviceFromRequest(req, { required: false });
    if (!device) return res.json({ paired: false });
    res.json(
      await withCompany(device.company, () =>
        require("../services/kioskRecognitionService").status(device),
      ),
    );
  }),
);
router.post(
  "/pair",
  pairLimit,
  wrap(async (req, res) => {
    const body = z.object({ pairingToken: code }).strict().parse(req.body);
    res.json(await access.pairDevice(body.pairingToken, res));
  }),
);
router.post(
  "/unpair",
  wrap(async (req, res) => {
    const device = await access.deviceFromRequest(req, { required: false });
    res.json(await access.unpairDevice(device, res));
  }),
);
router.use(async (req, res, next) => {
  try {
    req.kioskDevice = await access.deviceFromRequest(req);
    withCompany(req.kioskDevice.company, next);
  } catch (error) {
    next(error);
  }
});
router.use(deviceLimit);
router.post(
  "/challenges",
  wrap(async (req, res) => {
    const body = z
      .object({ purpose: z.enum(["enroll", "check-in", "check-out"]) })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json(await access.createChallenge(req.kioskDevice, body.purpose));
  }),
);
router.post(
  "/enroll",
  wrap(async (req, res) => {
    const body = z
      .object({
        challengeId: id,
        enrollmentCode: code,
        consent: z.literal(true),
        consentVersion: z.string().min(1).max(100),
        samples,
      })
      .strict()
      .parse(req.body);
    await access.assertFailureBudget(req.kioskDevice);
    res.json(
      await require("../services/kioskRecognitionService").completeEnrollment(
        req.kioskDevice,
        body,
      ),
    );
  }),
);
router.post(
  "/attendance",
  wrap(async (req, res) => {
    const body = z
      .object({
        challengeId: id,
        action: z.enum(["check-in", "check-out"]),
        samples,
      })
      .strict()
      .parse(req.body);
    await access.assertFailureBudget(req.kioskDevice);
    res.json(
      await require("../services/kioskRecognitionService").completeAttendance(
        req.kioskDevice,
        body,
      ),
    );
  }),
);
module.exports = router;
