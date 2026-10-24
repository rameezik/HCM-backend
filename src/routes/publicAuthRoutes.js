const crypto = require("node:crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");
const M = require("../models");
const C = require("../services/context");
const { withCompany } = require("../services/companyContext");
const recovery = require("../services/authRecoveryService");
const text = z.string().trim().min(1).max(200);
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const password = z.string().min(12).max(128);
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const limiter = (limit) =>
  rateLimit({
    windowMs: 15 * 60000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { message: "Too many account requests. Try again in 15 minutes." },
  });

module.exports = function publicAuthRouter({ companySchema, signIn }) {
  const router = express.Router();
  router.post(
    "/register",
    limiter(20),
    wrap(async (req, res) => {
      const body = z
        .object({ company: companySchema, name: text, email, password })
        .strict()
        .parse(req.body);
      const passwordHash = await bcrypt.hash(body.password, 12);
      const user = await C.transaction(async (session) => {
        // The original first-run setup keeps its legacy singleton. Public signup
        // needs a distinct key so every company owns an independent account.
        const [company] = await M.Company.create(
          [{ ...body.company, singleton: crypto.randomUUID() }],
          { session },
        );
        return withCompany(company._id, async () => {
          const [admin] = await M.User.create(
            [
              {
                name: body.name,
                email: body.email,
                passwordHash,
                role: "admin",
                mustChangePassword: false,
              },
            ],
            { session },
          );
          await M.LeaveType.create(
            [
              { name: "Annual", quota: 14 },
              { name: "Sick", quota: 8 },
              { name: "Casual", quota: 10 },
              { name: "Unpaid", quota: 0, unpaid: true },
            ],
            { session, ordered: true },
          );
          await C.audit(
            session,
            admin,
            "company_registered",
            "Company",
            null,
            company,
          );
          return admin;
        });
      });
      signIn(res.status(201), user);
    }),
  );
  router.post(
    "/forgot-password",
    limiter(10),
    wrap(async (req, res) => {
      const body = z.object({ email }).strict().parse(req.body);
      res.status(202).json(await recovery.requestReset(body.email));
    }),
  );
  router.post(
    "/reset-password",
    limiter(20),
    wrap(async (req, res) => {
      const body = z
        .object({ token: z.string().regex(/^[a-f\d]{64}$/i), password })
        .strict()
        .parse(req.body);
      signIn(res, await recovery.completeReset(body.token, body.password));
    }),
  );
  return router;
};
