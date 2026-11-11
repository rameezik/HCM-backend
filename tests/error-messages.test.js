const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const ApiError = require("../src/utils/ApiError");
const errorHandler = require("../src/middleware/errorHandler");

test("HTTP errors keep status and business rules while hiding server configuration", async (t) => {
  const app = express();
  app.use(express.json());
  app.post("/request", (req, res) => res.json({ received: true }));
  app.get("/failure/:status", (req, res, next) => {
    const error = new ApiError(
      Number(req.params.status),
      "Configure JWT_SECRET and MONGODB_URI on the backend.",
      { private: "server-only" },
    );
    if (req.query.code) error.code = req.query.code;
    next(error);
  });
  app.get("/duplicate", (req, res, next) =>
    next(new ApiError(409, "You have already checked in today.")),
  );
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const status of [500, 502, 503, 504]) {
    const response = await fetch(`${base}/failure/${status}`);
    assert.equal(response.status, status);
    const result = await response.json();
    assert.doesNotMatch(
      JSON.stringify(result),
      /JWT_SECRET|MONGODB_URI|backend|server-only/,
    );
    assert.equal(result.details, undefined);
    assert.ok(result.message);
  }

  for (const code of [
    "AI_NOT_CONFIGURED",
    "AUTH_RECOVERY_NOT_CONFIGURED",
    "BIOMETRIC_NOT_CONFIGURED",
  ]) {
    const response = await fetch(`${base}/failure/503?code=${code}`);
    const result = await response.json();
    assert.equal(response.status, 503);
    assert.equal(result.code, code);
    assert.match(result.message, /unavailable|administrator/);
    assert.doesNotMatch(result.message, /JWT_SECRET|MONGODB_URI/);
  }

  const duplicate = await fetch(`${base}/duplicate`);
  assert.equal(duplicate.status, 409);
  assert.equal(
    (await duplicate.json()).message,
    "You have already checked in today.",
  );

  const invalidRequest = await fetch(`${base}/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{broken",
  });
  assert.equal(invalidRequest.status, 400);
  assert.equal(
    (await invalidRequest.json()).message,
    "Unable to process your request. Please try again.",
  );
});
