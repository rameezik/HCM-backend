const { ZodError } = require("zod");

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (error.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({ message: "Request body must contain valid JSON." });
  }

  if (error instanceof ZodError) {
    return res.status(422).json({
      message: "Check the form fields.",
      details: error.issues.map((issue) => ({
        field: issue.path.join("."),
        reason: issue.message,
      })),
    });
  }

  if (error.code === 11000) {
    return res
      .status(409)
      .json({ message: "A record with this unique value already exists." });
  }

  const invalidRecordErrors = [
    "CastError",
    "StrictModeError",
    "ValidationError",
  ];
  if (invalidRecordErrors.includes(error.name)) {
    return res.status(422).json({ message: "Invalid record fields." });
  }

  if (error.message?.includes("Transaction numbers are only allowed")) {
    return res.status(503).json({
      message: "MongoDB must run as a replica set to support atomic workflows.",
    });
  }

  const status = error.status || 500;
  if (status >= 500)
    console.error("API failure:", error.name, error.code || status);

  const response = {
    message:
      status === 500 ? "An unexpected server error occurred." : error.message,
  };
  if (error.details) response.details = error.details;
  if (
    typeof error.code === "string" &&
    /^(?:AI_|AUTH_|BIOMETRIC_)/.test(error.code)
  ) {
    response.code = error.code;
  }
  res.status(status).json(response);
}

module.exports = errorHandler;
