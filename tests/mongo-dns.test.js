const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const configureMongoDns = require("../src/config/mongoDns");

test("loading the database module preserves the machine's DNS configuration", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require('node:assert/strict');
    const dns = require('node:dns');
    const before = dns.getServers();
    require('./src/config/db');
    assert.deepEqual(dns.getServers(), before);
  `,
    ],
    { cwd: require("node:path").resolve(__dirname, ".."), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("default and blank settings keep the platform resolver", () => {
  const resolver = {
    setServers() {
      assert.fail("DNS was replaced without an explicit setting");
    },
  };
  configureMongoDns({}, resolver);
  configureMongoDns({ MONGODB_DNS_SERVERS: "  " }, resolver);
});

test("operators can explicitly configure IPv4 and IPv6 resolvers", () => {
  let configured;
  configureMongoDns(
    { MONGODB_DNS_SERVERS: " 1.1.1.1, 2606:4700:4700::1111 " },
    {
      setServers(servers) {
        configured = servers;
      },
    },
  );
  assert.deepEqual(configured, ["1.1.1.1", "2606:4700:4700::1111"]);
});

test("invalid resolver settings fail before attempting a database connection", () => {
  const resolver = {
    setServers() {
      assert.fail("Invalid DNS configuration was applied");
    },
  };
  for (const value of ["localhost", "8.8.8.8,", "https://1.1.1.1"]) {
    assert.throws(
      () => configureMongoDns({ MONGODB_DNS_SERVERS: value }, resolver),
      /MONGODB_DNS_SERVERS/,
    );
  }
});
