const router = require("express").Router();
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");
const { run } = require("../services/aiService");
router.get('/status',(req,res)=>{
  const configured=Boolean(process.env.AI_API_KEY?.trim());
  res.set('Cache-Control','no-store').json({configured,features:{chat:configured,summary:configured,smartLeave:configured},...(!configured?{code:'AI_NOT_CONFIGURED',message:'AI features are disabled. Configure AI_API_KEY on the backend to enable them. Authentication and all regular HR workflows remain available.'}:{})});
});
router.use(
  rateLimit({
    windowMs: 3600000,
    limit: 20,
    keyGenerator: (req) => String(req.user._id),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      message: "AI limit reached. Try again later or use the regular forms.",
    },
  }),
);
router.post("/chat", async (req, res, next) => {
  try {
    const body = z
      .object({
        mode: z.enum(["chat", "summary", "smart-leave"]).default("chat"),
        message: z.string().min(1).max(4000).default("Summarize"),
        filters: z
          .object({
            start: z.string().optional(),
            end: z.string().optional(),
            department: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(req.body);
    res.json(await run(req.user, body));
  } catch (error) {
    next(error);
  }
});
module.exports = router;
