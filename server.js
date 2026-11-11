const { loadEnvironment } = require("./src/config/environment");
const mongoose = require("mongoose");
const dns = require("node:dns");

// Configure DNS before MongoDB connection
dns.setServers(["8.8.8.8", "1.1.1.1"]);

async function start() {
  // Load environment variables
  loadEnvironment();

  await require("./src/config/db")();

  // Verify MongoDB connection
  const dbState = mongoose.connection.readyState;

  if (dbState !== 1) {
    throw new Error("MongoDB is not connected. Current state: " + dbState);
  }

  // Initialize Express application
  const app = require("./src/app");

  // Start biometric retention service
  const stopRetention =
    require("./src/services/biometricRetention").startBiometricRetention();

  // Server configuration
  const PORT = Number(process.env.PORT || 4000);

  // Start HTTP server
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`HCM API listening on port ${PORT}`);
    require("./src/services/kioskRecognitionService")
      .readiness()
      .then(({ configured, missing, runtime }) => {
        console.log(
          "Face attendance readiness:",
          JSON.stringify({
            configured,
            missingConfiguration: missing,
            runtimeReady: runtime?.ready === true,
          }),
        );
      })
      .catch(() => console.error("Face attendance readiness check failed."));
  });

  // Graceful shutdown
  const stop = () => {
    server.close(async () => {
      stopRetention();

      await mongoose.disconnect();

      console.log("MongoDB disconnected");

      process.exit(0);
    });
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// Start backend
if (require.main === module) {
  start().catch((error) => {
    console.error("Backend startup failed:", error);
    process.exitCode = 1;
  });
}

module.exports = start;
