const { z } = require("zod");
const rules = require("../../services/rules");

const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid record ID");
const text = z.string().trim().min(1).max(200);
const date = z.string().refine(rules.isoDate, "Use a valid YYYY-MM-DD date");
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const password = z.string().min(12).max(128);

module.exports = { id, text, date, email, password };
