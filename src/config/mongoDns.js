const dns = require("node:dns");
const { isIP } = require("node:net");

function configureMongoDns(env = process.env, resolver = dns) {
  const value = env.MONGODB_DNS_SERVERS?.trim();
  if (!value) return;
  const servers = value.split(",").map((server) => server.trim());
  if (servers.some((server) => !isIP(server))) {
    throw new Error(
      "MONGODB_DNS_SERVERS must contain comma-separated IP addresses.",
    );
  }
  resolver.setServers(servers);
}

module.exports = configureMongoDns;
