const express = require("express");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");
const ApiError = require("../utils/ApiError");
const service = require("../services/biometricService");
const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid verification ID");
const samples = z
  .array(
    z
      .string()
      .min(100)
      .max(333360)
      .regex(
        /^(?:data:image\/jpeg;base64,)?[A-Za-z\d+/]+={0,2}$/,
        "Only bounded JPEG camera samples are supported",
      ),
  )
  .length(3);
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
module.exports = function createBiometricRouter({ writeAttendance }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (process.env.NODE_ENV === "production" && !req.secure)
      return next(
        new ApiError(
          400,
          "Biometric APIs require HTTPS through the configured trusted proxy.",
        ),
      );
    if (!req.user?.company)
      return next(
        new ApiError(
          403,
          "A company-linked authenticated account is required.",
        ),
      );
    next();
  });
  router.get(
    "/status",
    wrap(async (req, res) => res.json(await service.status(req.user))),
  );
  router.delete(
    "/enrollment",
    wrap(async (req, res) => {
      const result = await service.removeEnrollment(req.user);
      res.status(result.deleted ? 200 : 202).json(result);
    }),
  );
  router.delete(
    "/enrollment/:employee",
    wrap(async (req, res) => {
      id.parse(req.params.employee);
      const result = await service.removeEnrollment(
        req.user,
        req.params.employee,
      );
      res.status(result.deleted ? 200 : 202).json(result);
    }),
  );
  router.use((req, res, next) => {
    if (!["employee", "hr"].includes(req.user.role))
      return next(
        new ApiError(
          403,
          "Facial self-service attendance is available to employees and HR with an employee profile.",
        ),
      );
    next();
  });
  router.use(
    rateLimit({
      windowMs: 15 * 60000,
      limit: 20,
      keyGenerator: (req) => `${req.user.company}:${req.user._id}`,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        message:
          "Face verification limit reached. Use the authorized web attendance option or contact HR.",
      },
    }),
  );
  router.post(
    "/challenges",
    wrap(async (req, res) => {
      const body = z
        .object({
          purpose: z.enum(["enroll", "check-in", "check-out"]),
          consent: z.literal(true).optional(),
          consentVersion: z.string().max(100).optional(),
        })
        .strict()
        .parse(req.body);
      res.status(201).json(await service.createChallenge(req.user, body));
    }),
  );
  router.post(
    "/enrollment",
    wrap(async (req, res) => {
      const body = z
        .object({ challengeId: id, samples })
        .strict()
        .parse(req.body);
      res
        .status(201)
        .json(
          await service.completeEnrollment(
            req.user,
            body.challengeId,
            body.samples,
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
          location: z
            .object({
              latitude: z.number().min(-90).max(90),
              longitude: z.number().min(-180).max(180),
              accuracy: z.number().min(0).max(100),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(req.body);
      if (typeof writeAttendance !== "function")
        throw new ApiError(503, "Attendance verification is not integrated.");
      res.json(
        await service.completeAttendance(
          req.user,
          body.challengeId,
          body.action,
          body.location,
          writeAttendance,
          body.samples,
        ),
      );
    }),
  );
  return router;
};
