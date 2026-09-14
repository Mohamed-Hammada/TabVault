export function globToRegex(glob) {
  if (!glob || typeof glob !== "string") return /^$/;

  let pattern = glob.trim();
  const wildcardPrefixMatch = pattern.match(/^(\*|[a-z]+):\/\/(\*\.)(.*)$/i);
  if (wildcardPrefixMatch) {
    const scheme = wildcardPrefixMatch[1] === "*" ? ".*" : wildcardPrefixMatch[1];
    const rest = wildcardPrefixMatch[3];
    const escapedRest = rest.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${scheme}:\\/\\/(?:.*\\.)?${escapedRest}$`, "i");
  }

  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
                        .replace(/\*/g, ".*")
                        .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Safely extracts lowercase hostname from a URL or raw host string.
 *
 * @param {string} input
 * @returns {string}
 */
export function extractHostname(input) {
  if (!input || typeof input !== "string") return "";
  const trimmed = input.trim().toLowerCase();
  try {
    const urlWithScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
    const parsed = new URL(urlWithScheme);
    return (parsed.hostname || "").toLowerCase();
  } catch (_) {
    // Fallback manual parsing
    const withoutScheme = trimmed.replace(/^[a-z]+:\/\//i, "");
    const hostOnly = withoutScheme.split("/")[0].split(":")[0];
    return hostOnly;
  }
}

/**
 * Checks whether childHost is identical to or a subdomain of parentHost.
 *
 * @param {string} childHost
 * @param {string} parentHost
 * @returns {boolean}
 */
export function isSubdomainOf(childHost, parentHost) {
  if (!childHost || !parentHost) return false;
  const c = childHost.toLowerCase();
  const p = parentHost.toLowerCase().replace(/^\*\./, "").replace(/^\./, "");
  return c === p || c.endsWith("." + p);
}

/**
 * Matches a URL or host string against a domain pattern.
 * Supports:
 * - Exact hostname: "github.com"
 * - Subdomain wildcard: "*.github.com" or ".github.com"
 * - Multi-level subdomains: "sub.domain.example.com"
 * - Full URL globs: "https://*.github.com/*" or "*://youtube.com/watch*"
 * - RegExp instances: /^https:\/\/(www\.)?youtube\.com\/watch/i
 *
 * @param {string} url
 * @param {string|RegExp} pattern
 * @returns {boolean}
 */
export function matchDomainPattern(url, pattern) {
  if (!url || !pattern) return false;

  if (pattern instanceof RegExp) {
    return pattern.test(url) || pattern.test(extractHostname(url));
  }

  const patternStr = String(pattern).trim().toLowerCase();
  if (!patternStr) return false;

  // URL-level glob pattern
  if (patternStr.includes("://") || patternStr.includes("/")) {
    return globToRegex(patternStr).test(url);
  }

  const host = extractHostname(url);
  if (!host) return false;

  // Wildcard pattern "*.example.com"
  if (patternStr.startsWith("*.")) {
    const root = patternStr.slice(2);
    return isSubdomainOf(host, root);
  }

  // Leading dot pattern ".example.com"
  if (patternStr.startsWith(".")) {
    const root = patternStr.slice(1);
    return isSubdomainOf(host, root);
  }

  // Standard domain match: matches host itself and any subdomains
  return isSubdomainOf(host, patternStr);
}

/**
 * Checks whether a URL matches any pattern in an array of domain patterns.
 *
 * @param {string} url
 * @param {Array<string|RegExp>} patterns
 * @returns {boolean}
 */
export function matchesAnyPattern(url, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some(pattern => matchDomainPattern(url, pattern));
}
