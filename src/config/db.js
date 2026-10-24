const mongoose = require("mongoose");
const models = require("../models");
module.exports = async function connect() {
  if (!process.env.MONGODB_URI)
    throw new Error(
      "MONGODB_URI is required; use a MongoDB replica set for atomic workflows.",
    );
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  await require("../services/migrateCompany")();
  await Promise.all(Object.values(models).map((model) => model.init()));
  await require("../services/migrateTenantIndexes")();
};
