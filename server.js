const { loadEnvironment } = require("./src/config/environment");
async function start() {
  loadEnvironment();
  await require("./src/config/db")();
  const app = require("./src/app");
  const stopRetention =
    require("./src/services/biometricRetention").startBiometricRetention();
  const server = app.listen(Number(process.env.PORT || 4000), "0.0.0.0", () =>
    console.log(`HCM API listening on port ${process.env.PORT || 4000}`),
  );
  const stop = () =>
    server.close(async () => {
      stopRetention();
      await require("mongoose").disconnect();
      process.exit(0);
    });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
if (require.main === module)
  start().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = start;
