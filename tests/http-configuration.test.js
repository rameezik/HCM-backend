const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
  trustProxy,
  frontendOrigins,
} = require("../src/config/httpConfiguration");

test("environment proxy hop counts become numeric Express trust rules", async (t) => {
  assert.equal(trustProxy("1"), 1);
  assert.equal(trustProxy("0"), 0);
  assert.equal(trustProxy("false"), false);
  assert.equal(trustProxy(""), "loopback");
  assert.throws(() => trustProxy("true"));
  assert.throws(() => trustProxy("100"));
  const app = express();
  app.set("trust proxy", trustProxy("1"));
  assert.equal(app.get("trust proxy fn")("10.1.2.3", 0), true);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  app.get("/secure", (req, res) => res.json({ secure: req.secure }));
  const url = `http://127.0.0.1:${server.address().port}/secure`;
  assert.equal(
    (
      await (
        await fetch(url, { headers: { "X-Forwarded-Proto": "https" } })
      ).json()
    ).secure,
    true,
  );
  app.set("trust proxy", trustProxy("0"));
  assert.equal(
    (
      await (
        await fetch(url, { headers: { "X-Forwarded-Proto": "https" } })
      ).json()
    ).secure,
    false,
  );
});

test("trusted frontend configuration normalizes copied Vercel origins without broadening access", () => {
  assert.deepEqual(
    frontendOrigins(" https://hcm.example.test/ , http://localhost:3000/ "),
    ["https://hcm.example.test", "http://localhost:3000"],
  );
  assert.deepEqual(
    frontendOrigins("https://hcm.example.test,https://hcm.example.test/"),
    ["https://hcm.example.test"],
  );
  assert.throws(() => frontendOrigins("*"));
  assert.throws(() => frontendOrigins("https://user:secret@hcm.example.test"));
  assert.throws(() => frontendOrigins("file:///tmp/frontend"));
});
