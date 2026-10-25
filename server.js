const { loadEnvironment } = require("./src/config/environment");
const mongoose = require("mongoose");
const dns = require("node:dns");

async function start() {
  loadEnvironment();

  // Local development DNS fix
  if (process.env.NODE_ENV !== "production") {
    dns.setServers(["10.1.1.1"]);
  }

  console.log("Connecting to MongoDB...");

  await require("./src/config/db")();

  console.log("MongoDB connected successfully");

  const app = require("./src/app");

  const stopRetention =
    require("./src/services/biometricRetention").startBiometricRetention();

  const PORT = Number(process.env.PORT || 4000);

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`HCM API listening on port ${PORT}`);
  });

  const stop = () => {
    server.close(async () => {
      stopRetention();
      await mongoose.disconnect();
      process.exit(0);
    });
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Backend startup failed:", error);
    process.exitCode = 1;
  });
}

module.exports = start;