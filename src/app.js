const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { rateLimit } = require("express-rate-limit");
const errorHandler = require("./middleware/errorHandler");
const { trustProxy, frontendOrigins } = require("./config/httpConfiguration");
const app = express();
app.disable("x-powered-by");
// Trust only explicitly known reverse proxies when deriving HTTPS for face capture.
app.set("trust proxy", trustProxy());
app.use(helmet());
const origins = frontendOrigins();
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
app.use(errorHandler);
module.exports = app;
