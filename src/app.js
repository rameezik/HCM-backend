const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { rateLimit } = require("express-rate-limit");
const { ZodError } = require("zod");
const app = express();
app.disable("x-powered-by");
// Trust only explicitly known reverse proxies when deriving HTTPS for face capture.
app.set("trust proxy", process.env.TRUST_PROXY || "loopback");
app.use(helmet());
const origins = (
  process.env.FRONTEND_URL || "http://localhost:3000,http://127.0.0.1:3000"
).split(",");
app.use(
  cors({
    origin: (origin, callback) =>
      callback(null, !origin || origins.includes(origin)),
    credentials: true,
  }),
);
app.use((req, res, next) => {
  // Cookie credentials cannot be used for mutations from an untrusted origin.
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin &&
    !origins.includes(req.headers.origin)
  )
    return res.status(403).json({ message: "Untrusted request origin." });
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.use("/api", require("./routes"));
app.use((req, res) =>
  res.status(404).json({ message: "API endpoint not found." }),
);
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed')
    return res.status(400).json({ message: 'Request body must contain valid JSON.' });
  if (error instanceof ZodError)
    return res
      .status(422)
      .json({
        message: "Check the form fields.",
        details: error.issues.map((i) => ({
          field: i.path.join("."),
          reason: i.message,
        })),
      });
  if (error.code === 11000)
    return res
      .status(409)
      .json({ message: "A record with this unique value already exists." });
  if (
    error.name === "CastError" ||
    error.name === "StrictModeError" ||
    error.name === "ValidationError"
  )
    return res.status(422).json({ message: "Invalid record fields." });
  if (error.message?.includes("Transaction numbers are only allowed"))
    return res
      .status(503)
      .json({
        message:
          "MongoDB must run as a replica set to support atomic workflows.",
      });
  const status = error.status || 500;
  if (status >= 500)
    console.error("API failure:", error.name, error.code || status);
  res
    .status(status)
    .json({
      message:
        status === 500 ? "An unexpected server error occurred." : error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(typeof error.code === "string" && /^(?:AI_|AUTH_|BIOMETRIC_)/.test(error.code) ? {code:error.code} : {}),
    });
});
module.exports = app;
