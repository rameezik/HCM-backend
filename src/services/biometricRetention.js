const M = require("../models");
const { withCompany } = require("./companyContext");
function startBiometricRetention() {
  let running = false;
  async function sweep() {
    if (running) return;
    running = true;
    try {
      const companies = await M.Company.find().select("_id").lean();
      for (const company of companies) {
        await withCompany(company._id, () =>
          require("./biometricService").cleanupCompany(company._id),
        );
      }
    } catch (error) {
      // Keep retry state in MongoDB; never log protected references or provider payloads.
      console.error(
        "Biometric retention sweep pending:",
        error.name,
        error.status || error.code || "unavailable",
      );
    } finally {
      running = false;
    }
  }
  const timer = setInterval(sweep, 15 * 60000);
  timer.unref();
  void sweep();
  return () => clearInterval(timer);
}
module.exports = { startBiometricRetention };
