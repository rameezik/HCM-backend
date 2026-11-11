const { ZodError } = require("zod");

function publicServerMessage(error, status) {
  const featureMessages = {
    AUTH_RECOVERY_NOT_CONFIGURED:
      "Password recovery is unavailable. Please contact your administrator.",
    AI_NOT_CONFIGURED:
      "AI features are unavailable. Please contact your administrator.",
    BIOMETRIC_NOT_CONFIGURED:
      "Face attendance is unavailable. Please contact your administrator.",
  };
  if (Object.hasOwn(featureMessages, error.code))
    return featureMessages[error.code];
  if (status === 502) return "Connection unavailable. Please try again.";
  if (status === 503)
    return "This service is currently unavailable. Please try again later or contact your administrator.";
  if (status === 504)
    return "The request timed out. Check your changes before trying again.";
  return "Something went wrong. Please try again.";
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (error.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({ message: "Unable to process your request. Please try again." });
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
      message:
        "This service is currently unavailable. Please contact your administrator.",
    });
  }

  const status = error.status || 500;
  if (status >= 500)
    console.error("API failure:", error.name, error.code || status);

  const response = {
    message: status >= 500 ? publicServerMessage(error, status) : error.message,
  };
  if (status < 500 && error.details) response.details = error.details;
  if (
    typeof error.code === "string" &&
    /^(?:AI_|AUTH_|BIOMETRIC_)/.test(error.code)
  ) {
    response.code = error.code;
  }
  res.status(status).json(response);
}

module.exports = errorHandler;
