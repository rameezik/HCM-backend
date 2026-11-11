const { z } = require("zod");
const { text } = require("./common");

const companySchema = z
  .object({
    name: text,
    officeStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("09:00"),
    officeEnd: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("17:00"),
    maxShiftHours: z.number().min(1).max(24).default(20),
    biometricRetentionDays: z.number().int().min(1).max(365).default(365),
    graceMinutes: z.number().int().min(0).max(180).default(15),
    halfDayHours: z.number().min(1).max(12).default(5),
    weekend: z.array(z.number().int().min(0).max(6)).max(6).default([0, 6]),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    radius: z.number().positive().max(10000).default(150),
    timezone: z
      .string()
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid IANA timezone")
      .default("UTC"),
  })
  .strict();

module.exports = companySchema;
