const M = require("../models");
// The original app supported exactly one company. Never guess ownership if more exist.
module.exports = async function migrateCompany() {
  const companies = await M.Company.find().limit(2).select("_id").lean();
  if (companies.length !== 1) return;
  const company = companies[0]._id;
  for (const [name, Model] of Object.entries(M)) {
    if (name === "Company" || name.startsWith("Biometric")) continue;
    await Model.updateMany(
      { $or: [{ company: { $exists: false } }, { company: null }] },
      { $set: { company } },
    );
  }
};
