require("dotenv").config({ quiet: true });
async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
    throw new Error("JWT_SECRET must contain at least 32 random characters.");
  await require("./src/config/db")();
  const app = require("./src/app");
  const server = app.listen(Number(process.env.PORT || 4000), "0.0.0.0", () =>
    console.log(`HCM API listening on port ${process.env.PORT || 4000}`),
  );
  const stop = () =>
    server.close(async () => {
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
