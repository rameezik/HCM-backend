const path = require("node:path");
const dotenv = require("dotenv");
const backendEnvPath = path.resolve(__dirname, "../../.env");
function loadEnvironment({
  filePath = backendEnvPath,
  env = process.env,
} = {}) {
  dotenv.config({ path: filePath, processEnv: env, quiet: true });
  if (!env.JWT_SECRET || env.JWT_SECRET.trim().length < 32) {
    throw new Error(
      "JWT_SECRET must contain at least 32 random characters. " +
        "For local development, run npm run setup:env in HCM-backend. " +
        "For a deployment, set JWT_SECRET securely in the backend hosting environment. " +
        "The backend reads its own HCM-backend/.env regardless of the launch directory.",
    );
  }
  return env;
}
module.exports = { loadEnvironment, backendEnvPath };
