function trustProxy(value = process.env.TRUST_PROXY) {
  const configured = value?.trim() || "loopback";
  if (configured === "false") return false;
  if (/^\d+$/.test(configured)) {
    const hops = Number(configured);
    if (hops > 10)
      throw new Error(
        "TRUST_PROXY must specify at most 10 trusted ingress hops.",
      );
    return hops;
  }
  if (configured === "true")
    throw new Error(
      "Use an explicit trusted proxy hop count or CIDR for TRUST_PROXY, rather than trusting every proxy.",
    );
  return configured;
}

function frontendOrigins(
  value = process.env.FRONTEND_URL ||
    "http://localhost:3000,http://127.0.0.1:3000",
) {
  const origins = value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error(
          "FRONTEND_URL must contain comma-separated HTTP(S) frontend origins.",
        );
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "FRONTEND_URL must contain HTTP(S) frontend origins without credentials or query parameters.",
        );
      return url.origin;
    });
  if (!origins.length)
    throw new Error("At least one trusted FRONTEND_URL is required.");
  return [...new Set(origins)];
}

module.exports = { trustProxy, frontendOrigins };
