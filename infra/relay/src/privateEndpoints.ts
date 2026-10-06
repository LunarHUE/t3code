// Private endpoints are HTTPS origins on the cluster's VPN that clients reach
// directly instead of through a managed tunnel.

/** Returns the endpoint for an HTTPS origin, or null for any other URL. */
export function privateEndpointForUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    return null;
  }
  return { httpBaseUrl: parsed.href, wsBaseUrl: `wss://${parsed.host}/ws` };
}

/**
 * Parses a comma-separated list of domains such as `dev.example.com`. Any
 * environment may claim an origin on a subdomain of one of them.
 */
export function parsePrivateEndpointDomains(value: string): ReadonlyArray<string> {
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/^\./u, ""))
    .filter((entry) => entry.length > 0)
    .map((domain) => {
      // Rejects ports, paths, and anything else that is not a bare hostname.
      if (URL.parse(`https://host.${domain}/`)?.hostname !== `host.${domain}`) {
        throw new Error(`Invalid private endpoint domain: ${domain}`);
      }
      return domain;
    });
}

/** Returns the endpoint for `url` when it is an HTTPS origin under an allowed domain. */
export function privateEndpointUnderDomains(url: string, domains: ReadonlyArray<string>) {
  const endpoint = privateEndpointForUrl(url);
  if (endpoint === null) return null;
  const hostname = new URL(endpoint.httpBaseUrl).hostname;
  return domains.some((domain) => hostname.endsWith(`.${domain}`)) ? endpoint : null;
}
