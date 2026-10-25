const express = require("express");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");
const ApiError = require("../utils/ApiError");
const photo = require("../services/employeePhotoService");
const router = express.Router();
const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid employee ID");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const limit = rateLimit({
  windowMs: 15 * 60000,
  limit: 20,
  keyGenerator: (req) => `${req.user.company}:${req.user._id}`,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    message: "Photo update limit reached. Try again after 15 minutes.",
  },
});
router.use("/employees/:id/photo", (req, res, next) => {
  if (
    !req.user?.company ||
    !["admin", "hr", "employee"].includes(req.user.role)
  )
    return next(
      new ApiError(
        401,
        "Sign in with a company account to access employee photos.",
      ),
    );
  next();
});
router.get(
  "/employees/:id/photo",
  wrap(async (req, res) => {
    id.parse(req.params.id);
    const bytes = await photo.readPhoto(req.user, req.params.id);
    res
      .set({
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": 'inline; filename="employee-photo.jpg"',
      })
      .type("image/jpeg")
      .send(bytes);
  }),
);
router.post(
  "/employees/:id/photo",
  limit,
  wrap(async (req, res) => {
    id.parse(req.params.id);
    const body = z
      .object({ image: z.string().min(50).max(photo.MAX_ENCODED_CHARACTERS) })
      .strict()
      .parse(req.body);
    res.json(await photo.savePhoto(req.user, req.params.id, body.image));
  }),
);
router.delete(
  "/employees/:id/photo",
  limit,
  wrap(async (req, res) => {
    id.parse(req.params.id);
    res.json(await photo.deletePhoto(req.user, req.params.id));
  }),
);
module.exports = router;
