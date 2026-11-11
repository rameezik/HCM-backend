const path = require("node:path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  quiet: true,
});

async function check() {
  const runtimeOnly = process.argv.includes("--runtime-only");
  const service = runtimeOnly
    ? require("../src/services/localFaceProvider")
    : require("../src/services/kioskRecognitionService");
  const result = await service.readiness();
  console.log(
    JSON.stringify(
      {
        configured: result.configured,
        missingConfiguration: result.missing,
        pythonExecutable: result.pythonPath,
        modelDirectory: result.modelDir,
        runtime: result.runtime,
      },
      null,
      2,
    ),
  );
  if (!result.configured) process.exitCode = 1;
}

check().catch(() => {
  console.error(
    "Face attendance readiness check failed. No secret values were printed.",
  );
  process.exitCode = 1;
});
