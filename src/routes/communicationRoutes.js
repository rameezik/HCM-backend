const express = require("express");
const { z } = require("zod");
const models = require("../models");
const context = require("../services/context");
const { roles } = require("../middleware/authMiddleware");
const { id, text } = require("./schemas/common");
const { asyncHandler, requireRecord } = require("../utils/http");
const router = express.Router();

router.get(
  "/announcements",
  asyncHandler(async (req, res) =>
    res.json(
      await models.Announcement.find()
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
  asyncHandler(async (req, res) => {
    const body = z
      .object({ title: text, body: z.string().trim().min(1).max(5000) })
      .strict()
      .parse(req.body);
    const doc = await context.transaction(async (session) => {
      const [after] = await models.Announcement.create(
        [{ ...body, actor: req.user._id }],
        { session },
      );
      await context.audit(
        session,
        req.user,
        "post",
        "Announcement",
        null,
        after,
      );
      return after;
    });
    res.status(201).json(doc);
  }),
);
router.get(
  "/notifications",
  asyncHandler(async (req, res) =>
    res.json(
      await models.Notification.find({ recipient: req.user._id })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ),
  ),
);
router.patch(
  "/notifications/:id",
  asyncHandler(async (req, res) => {
    id.parse(req.params.id);
    res.json(
      requireRecord(
        await models.Notification.findOneAndUpdate(
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
  asyncHandler(async (req, res) =>
    res.json(
      await models.AuditLog.find()
        .populate("actor", "name role")
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
    ),
  ),
);

module.exports = router;
