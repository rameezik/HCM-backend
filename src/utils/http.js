const ApiError = require("./ApiError");

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const parseInput = (schema, body) => schema.parse(body);
const requireRecord = (doc) => {
  if (!doc) throw new ApiError(404, "Record not found.");
  return doc;
};

module.exports = { asyncHandler, parseInput, requireRecord };
