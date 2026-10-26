require("dotenv").config();

const dns = require("node:dns");
const mongoose = require("mongoose");
const models = require("../models");

// Configure DNS before connecting to MongoDB
dns.setServers(["8.8.8.8", "1.1.1.1"]);

module.exports = async function connect() {
  if (!process.env.MONGODB_URI) {
    throw new Error(
      "MONGODB_URI is required; use a MongoDB replica set for atomic workflows."
    );
  }

  try {
    console.log("Connecting to MongoDB...");

    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    console.log("MongoDB connected successfully!");

    // Run database migrations
    await require("../services/migrateCompany")();

    // Initialize database models
    await Promise.all(
      Object.values(models).map((model) => model.init())
    );

    // Migrate tenant indexes
    await require("../services/migrateTenantIndexes")();

    console.log("Database initialization completed!");
  } catch (error) {
    console.error("MongoDB connection/initialization failed:", error);
    throw error;
  }
};