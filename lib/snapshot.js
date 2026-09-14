/**
 * TabVault Snapshot System
 * Captures comprehensive tab state (URL, title, favicon, scroll, safe forms, preview, context)
 * prior to suspension or on-demand.
 */

import {
  RESTRICTED_URL_SCHEMES,
  DEFAULT_SCREENSHOT_OPTIONS,
  MAX_SCREENSHOT_DATA_LENGTH,
  MAX_SCREENSHOT_BYTE_SIZE,
  enforceScreenshotSizeLimit,
  isCapturableUrl,
  canCaptureTabScreenshot,
  captureTabScreenshot,
  calculateDataUrlByteSize,
  extractDataUrlMimeType,
  storeScreenshotMetadata,
  validateScreenshotMetadata,
  formatScreenshotSummary,
  DEFAULT_COMPRESSION_OPTIONS,
  calculateScaledDimensions,
  blobToDataUrl,
  compressScreenshot
} from "./screenshot.js";
import { sanitizeAdapterState } from "./adapters/capture.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_SNAPSHOT_URL_LENGTH = 2048;
export const MAX_SNAPSHOT_TITLE_LENGTH = 512;
export const MAX_SNAPSHOT_FAVICON_LENGTH = 8192;

/**
 * Extracts canonical/original URL from tab or string, unwrapping suspended tab URLs if present.
 * @param {string|object} input - Tab object or URL string
 * @returns {string} Clean URL
 */
export function extractCanonicalUrl(input) {
  let rawUrl = "";
  if (typeof input === "string") {
    rawUrl = input;
  } else if (input && typeof input === "object") {
    rawUrl = input.url || input.pendingUrl || "";
  }
  rawUrl = (rawUrl || "").trim();
  if (!rawUrl) return "";

  if (rawUrl.includes("suspended/suspended.html#") || rawUrl.includes("suspended/suspended.html?")) {
    try {
      const hashIndex = rawUrl.indexOf("#");
      const queryIndex = rawUrl.indexOf("?");
      let paramStr = "";
      if (hashIndex !== -1) {
        paramStr = rawUrl.slice(hashIndex + 1);
      } else if (queryIndex !== -1) {
        paramStr = rawUrl.slice(queryIndex + 1);
      }
      const params = new URLSearchParams(paramStr);
      const originalUrl = params.get("u") || params.get("url");
      if (originalUrl) {
        return originalUrl.slice(0, MAX_SNAPSHOT_URL_LENGTH);
      }
    } catch {
      // Fallback to rawUrl
    }
  }

  return rawUrl.slice(0, MAX_SNAPSHOT_URL_LENGTH);
}

/**
 * Extracts and sanitizes tab title, unwrapping suspended title parameter or falling back gracefully.
 * @param {string|object} input - Tab object or Title string
 * @param {object} [options]
 * @returns {string} Sanitized title
 */
export function extractTabTitle(input, options = {}) {
  let rawTitle = "";
  let rawUrl = "";
  if (typeof input === "string") {
    rawTitle = input;
  } else if (input && typeof input === "object") {
    rawTitle = input.title || "";
    rawUrl = input.url || input.pendingUrl || "";
  }
  if (options.title) rawTitle = options.title;
  if (options.url) rawUrl = options.url;

  rawTitle = (rawTitle || "").trim();

  // If title is missing or suspended generic placeholder, try extracting encoded title from suspended URL
  if ((!rawTitle || rawTitle === "Tab Suspended" || rawTitle === "Suspended Tab" || rawTitle === "TabVault Suspended") && rawUrl) {
    if (rawUrl.includes("suspended/suspended.html#") || rawUrl.includes("suspended/suspended.html?")) {
      try {
        const hashIndex = rawUrl.indexOf("#");
        const queryIndex = rawUrl.indexOf("?");
        let paramStr = "";
        if (hashIndex !== -1) paramStr = rawUrl.slice(hashIndex + 1);
        else if (queryIndex !== -1) paramStr = rawUrl.slice(queryIndex + 1);
        const params = new URLSearchParams(paramStr);
        const encodedTitle = params.get("t") || params.get("title");
        if (encodedTitle) rawTitle = encodedTitle.trim();
      } catch {
        // Ignore fallback
      }
    }
  }

  // If still empty, attempt fallback from URL hostname or default
  if (!rawTitle && rawUrl) {
    try {
      const parsed = new URL(extractCanonicalUrl(rawUrl));
      rawTitle = parsed.hostname || rawUrl;
    } catch {
      rawTitle = rawUrl;
    }
  }

  if (!rawTitle) {
    rawTitle = "Untitled Tab";
  }

  return rawTitle.slice(0, MAX_SNAPSHOT_TITLE_LENGTH);
}

/**
 * Extracts and sanitizes tab favicon URL, unwrapping suspended favicon parameter if present.
 * @param {string|object} input - Tab object or Favicon URL string
 * @param {object} [options]
 * @returns {string} Sanitized favicon URL
 */
export function extractTabFavicon(input, options = {}) {
  let rawFavicon = "";
  let rawUrl = "";
  if (typeof input === "string") {
    rawFavicon = input;
  } else if (input && typeof input === "object") {
    rawFavicon = input.favIconUrl || input.favicon || "";
    rawUrl = input.url || input.pendingUrl || "";
  }
  if (options.favicon) rawFavicon = options.favicon;
  if (options.favIconUrl) rawFavicon = options.favIconUrl;
  if (options.url) rawUrl = options.url;

  rawFavicon = (rawFavicon || "").trim();

  // If favicon is missing and tab is suspended, try extracting from suspended URL
  if (!rawFavicon && rawUrl) {
    if (rawUrl.includes("suspended/suspended.html#") || rawUrl.includes("suspended/suspended.html?")) {
      try {
        const hashIndex = rawUrl.indexOf("#");
        const queryIndex = rawUrl.indexOf("?");
        let paramStr = "";
        if (hashIndex !== -1) paramStr = rawUrl.slice(hashIndex + 1);
        else if (queryIndex !== -1) paramStr = rawUrl.slice(queryIndex + 1);
        const params = new URLSearchParams(paramStr);
        const encodedFavicon = params.get("f") || params.get("favicon");
        if (encodedFavicon) rawFavicon = encodedFavicon.trim();
      } catch {
        // Ignore fallback
      }
    }
  }

  return rawFavicon.slice(0, MAX_SNAPSHOT_FAVICON_LENGTH);
}

/**
 * Resolves a valid epoch timestamp for the snapshot.
 * @param {object} [options]
 * @param {object} [tab]
 * @returns {number} Epoch timestamp in milliseconds
 */
export function extractSnapshotTimestamp(options = {}, tab = {}) {
  let ts = options.timestamp || options.createdAt;
  if (typeof ts === "number" && !Number.isNaN(ts) && ts > 0) {
    return Math.floor(ts);
  }

  if (typeof ts === "string" && ts.trim()) {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Check if suspended URL has timestamp parameter &at=
  const rawUrl = options.url || (tab && (tab.url || tab.pendingUrl)) || "";
  if (rawUrl && (rawUrl.includes("suspended/suspended.html#") || rawUrl.includes("suspended/suspended.html?"))) {
    try {
      const hashIndex = rawUrl.indexOf("#");
      const queryIndex = rawUrl.indexOf("?");
      let paramStr = "";
      if (hashIndex !== -1) paramStr = rawUrl.slice(hashIndex + 1);
      else if (queryIndex !== -1) paramStr = rawUrl.slice(queryIndex + 1);
      const params = new URLSearchParams(paramStr);
      const at = params.get("at");
      if (at) {
        const parsedAt = parseInt(at, 10);
        if (!Number.isNaN(parsedAt) && parsedAt > 0) {
          return parsedAt;
        }
      }
    } catch {
      // Fallback
    }
  }

  return Date.now();
}

/**
 * Formats a snapshot timestamp into a human-friendly relative or localized time string.
 * @param {number|object} input - Timestamp number or snapshot object
 * @param {number} [now=Date.now()]
 * @returns {string}
 */
export function formatSnapshotTimestamp(input, now = Date.now()) {
  const ts = typeof input === "object" && input !== null ? (input.timestamp || input.createdAt || 0) : Number(input);
  if (!ts || Number.isNaN(ts) || ts <= 0) return "Unknown";

  const diffMs = Math.max(0, now - ts);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 45) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  return new Date(ts).toLocaleDateString();
}

/**
 * Calculates snapshot age metrics and determines if it is recent.
 * @param {number|object} input - Timestamp or snapshot record
 * @param {number} [now=Date.now()]
 * @returns {{ ageMs: number, ageSeconds: number, ageMinutes: number, ageHours: number, ageDays: number, isRecent: boolean }}
 */
export function getSnapshotAge(input, now = Date.now()) {
  const ts = typeof input === "object" && input !== null ? (input.timestamp || input.createdAt || 0) : Number(input);
  const ageMs = (!ts || Number.isNaN(ts) || ts <= 0) ? 0 : Math.max(0, now - ts);
  const ageSeconds = Math.floor(ageMs / 1000);
  const ageMinutes = Math.floor(ageSeconds / 60);
  const ageHours = Math.floor(ageMinutes / 60);
  const ageDays = Math.floor(ageHours / 24);

  return {
    ageMs,
    ageSeconds,
    ageMinutes,
    ageHours,
    ageDays,
    isRecent: ageHours < 1
  };
}

/**
 * Extracts and sanitizes scroll position coordinates and percentages.
 * @param {object} [input]
 * @param {object} [tab]
 * @returns {{x: number, y: number, percentX: number, percentY: number}}
 */
export function extractScrollPosition(input = {}, tab = {}) {
  let x = 0;
  let y = 0;
  let percentX = 0;
  let percentY = 0;

  if (input && typeof input === "object") {
    if (typeof input.x === "number" && !Number.isNaN(input.x)) x = Math.max(0, Math.floor(input.x));
    if (typeof input.y === "number" && !Number.isNaN(input.y)) y = Math.max(0, Math.floor(input.y));
    if (typeof input.percentX === "number" && !Number.isNaN(input.percentX)) percentX = Math.min(100, Math.max(0, input.percentX));
    if (typeof input.percentY === "number" && !Number.isNaN(input.percentY)) percentY = Math.min(100, Math.max(0, input.percentY));
  }

  // Also check if suspended tab URL has scroll parameters &sx= and &sy=
  const rawUrl = (tab && (tab.url || tab.pendingUrl)) || "";
  if (x === 0 && y === 0 && rawUrl && (rawUrl.includes("suspended/suspended.html#") || rawUrl.includes("suspended/suspended.html?"))) {
    try {
      const hashIndex = rawUrl.indexOf("#");
      const queryIndex = rawUrl.indexOf("?");
      let paramStr = "";
      if (hashIndex !== -1) paramStr = rawUrl.slice(hashIndex + 1);
      else if (queryIndex !== -1) paramStr = rawUrl.slice(queryIndex + 1);
      const params = new URLSearchParams(paramStr);
      const sx = params.get("sx");
      const sy = params.get("sy");
      if (sx) x = Math.max(0, parseInt(sx, 10) || 0);
      if (sy) y = Math.max(0, parseInt(sy, 10) || 0);
    } catch {
      // Fallback
    }
  }

  return { x, y, percentX, percentY };
}

/**
 * Reads live scroll position from window/document context.
 * @param {Window} [win]
 * @param {Document} [doc]
 * @returns {{x: number, y: number, percentX: number, percentY: number}}
 */
export function captureWindowScroll(win = typeof window !== "undefined" ? window : null, doc = typeof document !== "undefined" ? document : null) {
  if (!win || !doc) return { x: 0, y: 0, percentX: 0, percentY: 0 };
  const x = Math.max(0, Math.floor(win.scrollX || win.pageXOffset || (doc.documentElement && doc.documentElement.scrollLeft) || (doc.body && doc.body.scrollLeft) || 0));
  const y = Math.max(0, Math.floor(win.scrollY || win.pageYOffset || (doc.documentElement && doc.documentElement.scrollTop) || (doc.body && doc.body.scrollTop) || 0));
  const maxScrollX = Math.max(0, (doc.documentElement ? doc.documentElement.scrollWidth : 0) - (win.innerWidth || 0));
  const maxScrollY = Math.max(0, (doc.documentElement ? doc.documentElement.scrollHeight : 0) - (win.innerHeight || 0));
  const percentX = maxScrollX > 0 ? Math.min(100, Math.max(0, parseFloat(((x / maxScrollX) * 100).toFixed(2)))) : 0;
  const percentY = maxScrollY > 0 ? Math.min(100, Math.max(0, parseFloat(((y / maxScrollY) * 100).toFixed(2)))) : 0;
  return { x, y, percentX, percentY };
}

export const MAX_FORM_FIELD_VALUE_LENGTH = 10000;
export const MAX_FORM_FIELDS_PER_SNAPSHOT = 100;

// Regular expressions to identify sensitive fields
export const SENSITIVE_FIELD_PATTERN = /(password|passwd|pwd|passcode|secret|pin|credit[-_\s]?card|card[-_\s]?(num|number)|cvv|cvc|csc|cc[-_\s]?|expir|cardholder|billing|iban|swift|routing|token|otp|2fa|mfa|auth[-_\s]?(code|token|key)?|verification[-_\s]?code|security[-_\s]?(code|question|answer)|credential|passkey|ssn|social[-_\s]?sec)/i;

// Regular expressions to identify sensitive domains or paths (banking, auth, payments)
export const BANKING_AUTH_URL_PATTERN = new RegExp(
  "(" +
  "login|signin|sign-in|log-in|sign_in|signup|sign-up|register|auth|authenticate|authorization|oauth|sso|saml|passkey|mfa|2fa|webauthn|" +
  "password[-_]?reset|forgot[-_]?password|change[-_]?password|verify[-_]?email|" +
  "identity|idp|keycloak|auth0|okta|duo|pingidentity|" +
  "accounts?\\.google\\.com|login\\.microsoftonline\\.com|appleid\\.apple\\.com|login\\.live\\.com|github\\.com\\/(login|session)|" +
  "bank|banking|ebanking|onlinebanking|netbanking|financial|" +
  "checkout|payment|billing|creditcard|wire[-_]?transfer|" +
  "paypal|stripe\\.com|square\\.com|cash\\.app|venmo|wise\\.com|revolut|" +
  "chase\\.com|bankofamerica\\.com|wellsfargo\\.com|citi\\.com|citibank|capitalone|" +
  "usbank|pnc\\.com|truist|barclays|hsbc|santander|bnpparibas|standardchartered|" +
  "fidelity\\.com|vanguard\\.com|schwab\\.com|morganstanley|robinhood\\.com|etrade|interactivebrokers|" +
  "coinbase|binance|kraken|gemini\\.com|crypto\\.com" +
  ")",
  "i"
);

export const SENSITIVE_URL_PATTERN = BANKING_AUTH_URL_PATTERN;

/**
 * Checks specifically whether a field descriptor or DOM element represents a password field.
 * Password fields must never be saved by default under any circumstances.
 * @param {object} field
 * @returns {boolean}
 */
export function isPasswordField(field) {
  if (!field || typeof field !== "object") return false;
  const type = (field.type || "").toLowerCase();
  if (type === "password") return true;

  const checkStrings = [
    field.name,
    field.id,
    field.autocomplete,
    field.placeholder,
    field.ariaLabel,
    field.className
  ].filter(Boolean);

  const pattern = /(password|passwd|pwd|passcode)/i;
  for (const str of checkStrings) {
    if (pattern.test(str)) return true;
  }
  return false;
}

export const CREDIT_CARD_FIELD_PATTERN = /(credit[-_\s]?card|debit[-_\s]?card|card[-_\s]?(num|number)|cc[-_\s]?(num|number|name|exp)?|cvv|cvc|csc|cid|cardholder|card[-_\s]?holder|expir|exp[-_\s]?(month|year|date)|iban|swift|bic|routing[-_\s]?num)/i;

/**
 * Validates whether a string looks like a payment card number using length and Luhn checksum.
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeCreditCardNumber(value) {
  if (typeof value !== "string") return false;
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return (sum % 10) === 0;
}

/**
 * Checks specifically whether a field descriptor or DOM element represents a credit card or payment field.
 * Credit card fields must never be saved by default under any circumstances.
 * @param {object} field
 * @returns {boolean}
 */
export function isCreditCardField(field) {
  if (!field || typeof field !== "object") return false;

  const autocomplete = (field.autocomplete || "").toLowerCase();
  if (autocomplete.startsWith("cc-")) {
    return true;
  }

  const checkStrings = [
    field.name,
    field.id,
    field.placeholder,
    field.ariaLabel,
    field.className
  ].filter(Boolean);

  for (const str of checkStrings) {
    if (CREDIT_CARD_FIELD_PATTERN.test(str)) return true;
  }

  if (typeof field.value === "string" && looksLikeCreditCardNumber(field.value)) {
    return true;
  }

  return false;
}

export const AUTHENTICATION_FIELD_PATTERN = /(otp|totp|hotp|2fa|mfa|one[-_\s]?time[-_\s]?code|auth[-_\s]?(code|token|key)|verification[-_\s]?(code|pin|number)|security[-_\s]?(code|question|answer|prompt)|secret[-_\s]?(question|answer|key)|access[-_\s]?token|refresh[-_\s]?token|bearer|api[-_\s]?key|private[-_\s]?key|ssh[-_\s]?key|passkey|credential|pin[-_\s]?(code)?|ssn|social[-_\s]?sec)/i;

/**
 * Checks specifically whether a field descriptor or DOM element represents a sensitive authentication field
 * such as 2FA/MFA codes, OTPs, security questions/answers, API keys, private keys, or session tokens.
 * Authentication fields must never be saved by default under any circumstances.
 * @param {object} field
 * @returns {boolean}
 */
export function isAuthenticationField(field) {
  if (!field || typeof field !== "object") return false;

  const autocomplete = (field.autocomplete || "").toLowerCase();
  if (autocomplete === "one-time-code") {
    return true;
  }

  const checkStrings = [
    field.name,
    field.id,
    field.placeholder,
    field.ariaLabel,
    field.className
  ].filter(Boolean);

  for (const str of checkStrings) {
    if (AUTHENTICATION_FIELD_PATTERN.test(str)) return true;
  }

  return false;
}

const customSensitivePatterns = [];

export function registerCustomSensitivePattern(pattern) {
  if (pattern instanceof RegExp) {
    customSensitivePatterns.push(pattern);
  } else if (typeof pattern === "string" && pattern.trim().length > 0) {
    try {
      customSensitivePatterns.push(new RegExp(pattern.trim(), "i"));
    } catch (_) {}
  }
}

export function getCustomSensitivePatterns() {
  return [...customSensitivePatterns];
}

export function clearCustomSensitivePatterns() {
  customSensitivePatterns.length = 0;
}

// Token / API key prefix signatures in values
export const VALUE_SECRET_PATTERN = /^(sk_live_[0-9a-zA-Z]{16,}|ghp_[0-9a-zA-Z]{30,}|xox[baprs]-[0-9a-zA-Z]{10,}|AIza[0-9A-Za-z-_]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;

/**
 * Detailed detection of sensitive form fields with categorization and diagnostics.
 * @param {object} field - Field metadata or DOM element
 * @param {object} [options]
 * @param {Array<string|RegExp>} [options.customPatterns]
 * @returns {{
 *   isSensitive: boolean,
 *   category: string|null,
 *   reason: string|null,
 *   matchedRule: string|null
 * }}
 */
export function detectSensitiveField(field, options = {}) {
  if (!field || typeof field !== "object") {
    return { isSensitive: true, category: "invalid", reason: "Field is null or non-object", matchedRule: "type_guard" };
  }

  // 1. Password detection
  if (isPasswordField(field)) {
    return { isSensitive: true, category: "password", reason: "Field identified as password", matchedRule: "isPasswordField" };
  }

  // 2. Credit card detection
  if (isCreditCardField(field)) {
    return { isSensitive: true, category: "credit_card", reason: "Field identified as credit card or financial instrument", matchedRule: "isCreditCardField" };
  }

  // 3. Authentication / 2FA / API key detection
  if (isAuthenticationField(field)) {
    return { isSensitive: true, category: "authentication", reason: "Field identified as authentication code, token, or key", matchedRule: "isAuthenticationField" };
  }

  // 4. Hidden or file input types
  const type = (field.type || "").toLowerCase();
  if (type === "hidden" || type === "file") {
    return { isSensitive: true, category: "hidden_or_file", reason: `Field type '${type}' is disallowed`, matchedRule: "disallowed_type" };
  }

  // 5. Value-based secrets (e.g. JWTs, live Stripe keys, GitHub tokens)
  if (typeof field.value === "string" && VALUE_SECRET_PATTERN.test(field.value.trim())) {
    return { isSensitive: true, category: "value_secret", reason: "Field value matches secret token / API key signature", matchedRule: "VALUE_SECRET_PATTERN" };
  }

  // 6. Custom patterns provided in options or registered globally
  const activeCustom = [
    ...customSensitivePatterns,
    ...(Array.isArray(options.customPatterns) ? options.customPatterns : [])
  ];

  const checkStrings = [
    field.name,
    field.id,
    field.autocomplete,
    field.placeholder,
    field.ariaLabel,
    field.className
  ].filter(Boolean);

  for (const pat of activeCustom) {
    const reg = pat instanceof RegExp ? pat : new RegExp(String(pat), "i");
    for (const str of checkStrings) {
      if (reg.test(str)) {
        return { isSensitive: true, category: "custom", reason: `Matched custom pattern: ${reg}`, matchedRule: String(reg) };
      }
    }
  }

  // 7. General sensitive pattern
  for (const str of checkStrings) {
    if (SENSITIVE_FIELD_PATTERN.test(str)) {
      return { isSensitive: true, category: "keyword", reason: `Matched sensitive keyword in '${str}'`, matchedRule: "SENSITIVE_FIELD_PATTERN" };
    }
  }

  return { isSensitive: false, category: null, reason: null, matchedRule: null };
}

/**
 * Checks whether a given field descriptor or DOM element represents sensitive data.
 * @param {object} field - Field metadata or element descriptor
 * @param {object} [options]
 * @returns {boolean} True if field is sensitive and must NOT be saved
 */
export function isSensitiveField(field, options = {}) {
  return detectSensitiveField(field, options).isSensitive;
}

const globallyExcludedDomains = new Set();

/**
 * Normalizes a domain name for exclusion matching.
 * Strips scheme, paths, trailing slashes, and leading wildcards.
 * @param {string} domain
 * @returns {string}
 */
export function normalizeExcludedDomain(domain) {
  if (!domain || typeof domain !== "string") return "";
  let clean = domain.trim().toLowerCase();
  clean = clean.replace(/^[a-z]+:\/\//, "");
  clean = clean.split("/")[0].split("?")[0].split("#")[0];
  if (clean.startsWith("*.")) {
    clean = clean.slice(2);
  }
  return clean;
}

export function addExcludedDomain(domain) {
  const norm = normalizeExcludedDomain(domain);
  if (norm) {
    globallyExcludedDomains.add(norm);
    return true;
  }
  return false;
}

export function removeExcludedDomain(domain) {
  const norm = normalizeExcludedDomain(domain);
  if (norm) {
    return globallyExcludedDomains.delete(norm);
  }
  return false;
}

export function getExcludedDomains() {
  return Array.from(globallyExcludedDomains);
}

export function clearExcludedDomains() {
  globallyExcludedDomains.clear();
}

/**
 * Checks whether a given URL's hostname matches any excluded domain.
 * Supports exact hostname matching, wildcard subdomain matching (*.domain.com),
 * and domain suffix matching (sub.domain.com matches domain.com).
 * @param {string} url
 * @param {string[]} [customExclusions]
 * @returns {boolean}
 */
export function isDomainExcluded(url, customExclusions = []) {
  if (!url || typeof url !== "string") return false;

  let hostname = "";
  try {
    if (url.includes("://")) {
      hostname = new URL(url).hostname.toLowerCase();
    } else {
      hostname = url.split("/")[0].split("?")[0].split("#")[0].toLowerCase();
    }
  } catch (_) {
    hostname = url.toLowerCase();
  }

  const allExclusions = new Set([
    ...globallyExcludedDomains,
    ...customExclusions.map(normalizeExcludedDomain).filter(Boolean)
  ]);

  for (const excluded of allExclusions) {
    if (hostname === excluded) return true;
    if (hostname.endsWith(`.${excluded}`)) return true;
  }

  return false;
}

/**
 * Checks whether a URL is considered sensitive (e.g. banking, login, payment).
 * @param {string} url
 * @param {string[]} [customExclusions]
 * @returns {boolean}
 */
export function isSensitiveUrl(url, customExclusions = []) {
  if (!url || typeof url !== "string") return false;

  if (isDomainExcluded(url, customExclusions)) {
    return true;
  }

  for (const exclusion of customExclusions) {
    if (exclusion && url.toLowerCase().includes(exclusion.toLowerCase())) {
      return true;
    }
  }

  return SENSITIVE_URL_PATTERN.test(url);
}

/**
 * Checks whether a URL belongs to a banking or authentication service.
 * Form data from banking and auth websites must never be captured by default.
 * @param {string} url
 * @param {string[]} [customExclusions]
 * @returns {boolean}
 */
export function isBankingOrAuthUrl(url, customExclusions = []) {
  return isSensitiveUrl(url, customExclusions);
}

export const DEFAULT_FORM_SAVING_SETTINGS = Object.freeze({
  enabled: true,
  mode: "safe", // "safe" | "disabled"
  saveTextInputs: true,
  saveTextareas: true,
  saveSelects: true,
  saveCheckboxes: true,
  saveRadios: true,
  saveContentEditable: true,
  allowHtmlContentEditable: false,
  excludedDomains: []
});

let currentFormSavingSettings = { ...DEFAULT_FORM_SAVING_SETTINGS };

/**
 * Returns a copy of the active form-saving settings.
 * @returns {object}
 */
export function getFormSavingSettings() {
  return {
    ...currentFormSavingSettings,
    excludedDomains: [...(currentFormSavingSettings.excludedDomains || [])]
  };
}

/**
 * Updates form-saving settings.
 * @param {object} newSettings
 * @returns {object} Updated settings
 */
export function setFormSavingSettings(newSettings = {}) {
  if (!newSettings || typeof newSettings !== "object") return getFormSavingSettings();

  currentFormSavingSettings = {
    ...currentFormSavingSettings,
    ...newSettings,
    excludedDomains: Array.isArray(newSettings.excludedDomains)
      ? [...newSettings.excludedDomains]
      : currentFormSavingSettings.excludedDomains
  };

  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ formSavingSettings: currentFormSavingSettings });
    }
  } catch (_) {}

  return getFormSavingSettings();
}

/**
 * Resets form-saving settings to factory defaults.
 * @returns {object} Default settings
 */
export function resetFormSavingSettings() {
  currentFormSavingSettings = { ...DEFAULT_FORM_SAVING_SETTINGS };
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ formSavingSettings: currentFormSavingSettings });
    }
  } catch (_) {}
  return getFormSavingSettings();
}

export function isFormSavingEnabled() {
  return Boolean(currentFormSavingSettings.enabled && currentFormSavingSettings.mode !== "disabled");
}

export function setFormSavingEnabled(enabled) {
  return setFormSavingSettings({ enabled: Boolean(enabled) });
}

/**
 * Sanitizes form state data, removing sensitive fields, enforcing size limits,
 * and skipping sensitive domains.
 * @param {Array|object} rawForms
 * @param {string} [url=""]
 * @param {object} [options={}]
 * @returns {Array|null} Array of safe field states or null
 */
export function sanitizeFormData(rawForms, url = "", options = {}) {
  const settings = {
    ...getFormSavingSettings(),
    ...options
  };

  // If user disabled form saving
  if (!settings.enabled || settings.mode === "disabled" || options.saveFormsEnabled === false) {
    return null;
  }

  const activeExclusions = [
    ...(settings.excludedDomains || []),
    ...(options.excludedDomains || [])
  ];

  if (isDomainExcluded(url, activeExclusions)) {
    return null;
  }

  // If URL is sensitive and domain exclusions/banking safety is active
  if (!settings.allowSensitiveUrls && isSensitiveUrl(url, activeExclusions)) {
    return null;
  }

  let entries = [];
  if (Array.isArray(rawForms)) {
    entries = rawForms;
  } else if (rawForms && typeof rawForms === "object" && Array.isArray(rawForms.fields)) {
    entries = rawForms.fields;
  } else {
    return null;
  }

  const safeFields = [];
  for (const entry of entries) {
    if (safeFields.length >= MAX_FORM_FIELDS_PER_SNAPSHOT) break;
    if (!entry || typeof entry !== "object") continue;
    if (isSensitiveField(entry)) continue;

    const safe = {
      type: (entry.type || "text").toLowerCase(),
      selector: typeof entry.selector === "string" ? entry.selector.slice(0, 256) : null,
      name: typeof entry.name === "string" ? entry.name.slice(0, 128) : null,
      id: typeof entry.id === "string" ? entry.id.slice(0, 128) : null,
    };

    if (entry.type === "checkbox" || entry.type === "radio") {
      safe.checked = Boolean(entry.checked);
      if (entry.value) safe.value = String(entry.value).slice(0, 256);
    } else if (entry.type === "select") {
      safe.selectedIndex = typeof entry.selectedIndex === "number" ? entry.selectedIndex : 0;
      safe.value = typeof entry.value === "string" ? entry.value.slice(0, 512) : "";
    } else if (entry.type === "contenteditable") {
      safe.text = typeof entry.text === "string" ? entry.text.slice(0, MAX_FORM_FIELD_VALUE_LENGTH) : "";
    } else {
      safe.value = typeof entry.value === "string" ? entry.value.slice(0, MAX_FORM_FIELD_VALUE_LENGTH) : "";
    }

    safeFields.push(safe);
  }

  return safeFields.length > 0 ? safeFields : null;
}

/**
 * Serializes safe form fields directly from DOM document.
 * @param {Document} doc
 * @param {string} [url=""]
 * @param {object} [options={}]
 * @returns {Array|null}
 */
export function serializeSafeDomForms(doc, url = "", options = {}) {
  if (!doc || !doc.querySelectorAll) return null;

  const settings = {
    ...getFormSavingSettings(),
    ...options
  };

  if (!settings.enabled || settings.mode === "disabled") return null;

  const activeExclusions = [
    ...(settings.excludedDomains || []),
    ...(options.excludedDomains || [])
  ];

  if (isDomainExcluded(url, activeExclusions)) return null;
  if (!settings.allowSensitiveUrls && isSensitiveUrl(url, activeExclusions)) return null;

  const elements = doc.querySelectorAll("input, textarea, select, [contenteditable=''], [contenteditable='true']");
  const rawEntries = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const tag = el.tagName ? el.tagName.toUpperCase() : "";
    const type = (el.type || "").toLowerCase();
    const isEditable = el.isContentEditable || el.getAttribute?.("contenteditable") === "true" || el.getAttribute?.("contenteditable") === "";

    if (tag === "INPUT") {
      if (["password", "hidden", "file", "button", "submit", "reset"].includes(type)) {
        continue;
      }
      if (type === "checkbox" && !settings.saveCheckboxes) continue;
      if (type === "radio" && !settings.saveRadios) continue;
      if (!settings.saveTextInputs && !["checkbox", "radio"].includes(type)) continue;

      rawEntries.push({
        type: type || "text",
        name: el.name || "",
        id: el.id || "",
        value: el.value || "",
        checked: Boolean(el.checked),
        placeholder: el.placeholder || "",
        autocomplete: el.autocomplete || "",
        selector: el.id ? `#${el.id}` : (el.name ? `input[name="${el.name}"]` : `input:nth-of-type(${i + 1})`)
      });
    } else if (tag === "TEXTAREA") {
      if (!settings.saveTextareas) continue;
      rawEntries.push({
        type: "textarea",
        name: el.name || "",
        id: el.id || "",
        value: el.value || "",
        placeholder: el.placeholder || "",
        autocomplete: el.autocomplete || "",
        selector: el.id ? `#${el.id}` : (el.name ? `textarea[name="${el.name}"]` : `textarea:nth-of-type(${i + 1})`)
      });
    } else if (tag === "SELECT") {
      if (!settings.saveSelects) continue;
      rawEntries.push({
        type: "select",
        name: el.name || "",
        id: el.id || "",
        value: el.value || "",
        selectedIndex: el.selectedIndex,
        selector: el.id ? `#${el.id}` : (el.name ? `select[name="${el.name}"]` : `select:nth-of-type(${i + 1})`)
      });
    } else if (isEditable) {
      if (!settings.saveContentEditable) continue;
      rawEntries.push({
        type: "contenteditable",
        id: el.id || "",
        text: el.innerText || el.textContent || "",
        html: settings.allowHtmlContentEditable && el.innerHTML ? el.innerHTML.slice(0, MAX_FORM_FIELD_VALUE_LENGTH) : "",
        selector: el.id ? `#${el.id}` : `[contenteditable]:nth-of-type(${i + 1})`
      });
    }
  }

  return sanitizeFormData(rawEntries, url, settings);
}

export const MAX_SNAPSHOT_SCREENSHOT_LENGTH = 150000;

/**
 * Sanitizes and validates screenshot preview data.
 * @param {string|object} screenshot - Data URL or screenshot object
 * @param {object} [context] - Tab context for fallback generation
 * @returns {object|null}
 */
export function sanitizeScreenshotData(screenshot, context = {}) {
  if (context.enableScreenshots === false) {
    return null;
  }

  const getDomain = () => {
    try {
      return context.url ? new URL(extractCanonicalUrl(context.url)).hostname : "";
    } catch {
      return "";
    }
  };

  if (!screenshot) {
    // Generate fallback visual preview card descriptor
    return {
      isFallback: true,
      title: context.title || "Untitled Tab",
      favicon: context.favicon || "",
      domain: getDomain()
    };
  }

  let dataUrl = "";
  let format = "image/jpeg";
  let width = null;
  let height = null;
  let capturedAt = Date.now();

  if (typeof screenshot === "string") {
    dataUrl = screenshot.trim();
  } else if (typeof screenshot === "object") {
    dataUrl = (screenshot.dataUrl || screenshot.url || "").trim();
    format = screenshot.format || format;
    width = screenshot.width ?? null;
    height = screenshot.height ?? null;
    capturedAt = screenshot.capturedAt || capturedAt;
  }

  if (!dataUrl.startsWith("data:image/")) {
    return {
      isFallback: true,
      title: context.title || "Untitled Tab",
      favicon: context.favicon || "",
      domain: getDomain()
    };
  }

  if (dataUrl.length > MAX_SNAPSHOT_SCREENSHOT_LENGTH) {
    // Too large to store safely in snapshot without quota issues, fallback
    return {
      isFallback: true,
      truncated: true,
      title: context.title || "Untitled Tab",
      favicon: context.favicon || "",
      domain: getDomain()
    };
  }

  return storeScreenshotMetadata(screenshot, context, {
    format,
    width,
    height,
    capturedAt
  });
}

export {
  RESTRICTED_URL_SCHEMES,
  DEFAULT_SCREENSHOT_OPTIONS,
  MAX_SCREENSHOT_DATA_LENGTH,
  MAX_SCREENSHOT_BYTE_SIZE,
  enforceScreenshotSizeLimit,
  isCapturableUrl,
  canCaptureTabScreenshot,
  captureTabScreenshot,
  calculateDataUrlByteSize,
  extractDataUrlMimeType,
  storeScreenshotMetadata,
  validateScreenshotMetadata,
  formatScreenshotSummary,
  DEFAULT_COMPRESSION_OPTIONS,
  calculateScaledDimensions,
  blobToDataUrl,
  compressScreenshot
};

export const VALID_SUSPENSION_REASONS = Object.freeze([
  "manual",
  "idle_timeout",
  "memory_pressure",
  "domain_rule",
  "window_blur",
  "startup_restore",
  "battery_saver",
  "unknown"
]);

/**
 * Normalizes and validates tab suspension reason.
 * @param {string} [reason]
 * @returns {string}
 */
export function sanitizeSuspensionReason(reason) {
  if (typeof reason !== "string") return "manual";
  const trimmed = reason.trim().toLowerCase();
  if (!trimmed) return "manual";

  if (VALID_SUSPENSION_REASONS.includes(trimmed)) {
    return trimmed;
  }

  // Handle prefixed or formatted reasons, e.g. "idle_timeout:30m"
  const prefix = trimmed.split(":")[0];
  if (VALID_SUSPENSION_REASONS.includes(prefix)) {
    return prefix;
  }

  return trimmed.slice(0, 64);
}

/**
 * Captures and sanitizes tab, group, and window context for accurate placement during restoration.
 * @param {object} [tab]
 * @param {object} [options]
 * @returns {object} Context metadata
 */
export function extractTabContext(tab = {}, options = {}) {
  const ctx = options.context || {};
  return {
    tabId: tab.id ?? options.tabId ?? ctx.tabId ?? 0,
    windowId: tab.windowId ?? options.windowId ?? ctx.windowId ?? null,
    groupId: tab.groupId ?? options.groupId ?? ctx.groupId ?? -1,
    groupTitle: options.groupTitle ?? ctx.groupTitle ?? null,
    groupColor: options.groupColor ?? ctx.groupColor ?? null,
    pinned: Boolean(tab.pinned ?? options.pinned ?? ctx.pinned),
    index: typeof tab.index === "number" ? tab.index : (typeof options.index === "number" ? options.index : (typeof ctx.index === "number" ? ctx.index : null)),
    incognito: Boolean(tab.incognito ?? options.incognito ?? ctx.incognito),
    openerTabId: tab.openerTabId ?? options.openerTabId ?? ctx.openerTabId ?? null
  };
}

/**
 * Generates a unique snapshot identifier.
 * @param {number} tabId
 * @param {number} [timestamp]
 * @returns {string}
 */
export function generateSnapshotId(tabId, timestamp = Date.now()) {
  const rand = Math.random().toString(36).substring(2, 9);
  return `snap_${tabId}_${timestamp}_${rand}`;
}

/**
 * Creates a tab snapshot record capturing current tab state prior to suspension.
 * @param {object} [tab] - Chrome Tab object
 * @param {object} [options] - Additional state overrides or captured sub-states
 * @returns {object} Standardized snapshot record
 */
export function createTabSnapshot(tab = {}, options = {}) {
  const now = extractSnapshotTimestamp(options, tab);
  const tabId = tab.id ?? options.tabId ?? 0;
  const canonicalUrl = extractCanonicalUrl(options.url || tab.url || tab.pendingUrl || "");
  const title = extractTabTitle(tab, options);
  const favicon = extractTabFavicon(tab, options);
  const scroll = extractScrollPosition(options.scroll, tab);
  const forms = sanitizeFormData(options.forms, canonicalUrl, options);
  const screenshot = sanitizeScreenshotData(options.screenshot, {
    enableScreenshots: options.enableScreenshots,
    title,
    favicon,
    url: canonicalUrl
  });
  const reason = sanitizeSuspensionReason(options.reason || options.suspensionReason);
  const context = extractTabContext(tab, options);
  const adapter = sanitizeAdapterState(options.adapter ?? options.adapterState);

  const record = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    id: options.id || generateSnapshotId(tabId, now),
    tabId,
    url: canonicalUrl,
    title,
    favicon,
    timestamp: now,
    createdAt: now,
    createdAtIso: new Date(now).toISOString(),
    scroll,
    forms,
    screenshot,
    reason,
    context,
    adapter
  };

  if (options.protectFromPurge !== undefined) {
    record.protectFromPurge = Boolean(options.protectFromPurge);
  }
  if (options.isManual !== undefined) {
    record.isManual = Boolean(options.isManual);
  }
  if (options.label) {
    record.label = String(options.label);
  }
  if (options.note) {
    record.note = String(options.note);
  }

  return record;
}

/**
 * Creates a manual user-initiated snapshot of a tab without suspending it.
 * @param {object} [tab] - Chrome tab object
 * @param {object} [options]
 * @param {string} [options.label] - User label or checkpoint name
 * @param {string} [options.note] - Optional user note
 * @param {boolean} [options.protectFromPurge=true] - Protect manual snapshots from auto-expiration
 * @returns {object} Standardized snapshot record marked as manual
 */
export function createManualTabSnapshot(tab = {}, options = {}) {
  const label = typeof options.label === "string" && options.label.trim()
    ? options.label.trim()
    : "Manual Checkpoint";

  return createTabSnapshot(tab, {
    ...options,
    reason: options.reason || "manual",
    isManual: true,
    label,
    note: options.note ? String(options.note).trim() : undefined,
    protectFromPurge: options.protectFromPurge !== undefined ? Boolean(options.protectFromPurge) : true
  });
}

/**
 * TabVault Snapshot Schema definition and metadata.
 */
export const SNAPSHOT_SCHEMA_FIELDS = Object.freeze([
  "schemaVersion",
  "id",
  "tabId",
  "url",
  "title",
  "favicon",
  "timestamp",
  "createdAt",
  "createdAtIso",
  "scroll",
  "forms",
  "screenshot",
  "reason",
  "context",
  "adapter"
]);

/**
 * Validates whether an object strictly conforms to the TabVault Snapshot Schema.
 * @param {any} snapshot
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSnapshotSchema(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { valid: false, errors: ["Snapshot must be a non-null object"] };
  }

  if (typeof snapshot.schemaVersion !== "number" || snapshot.schemaVersion < 1) {
    errors.push("Invalid or missing schemaVersion");
  }

  if (typeof snapshot.id !== "string" || !snapshot.id.trim()) {
    errors.push("Invalid or missing id");
  }

  if (typeof snapshot.tabId !== "number" || Number.isNaN(snapshot.tabId)) {
    errors.push("Invalid or missing tabId");
  }

  if (typeof snapshot.url !== "string" || !snapshot.url.trim()) {
    errors.push("url must be a non-empty string");
  }

  if (typeof snapshot.timestamp !== "number" || snapshot.timestamp <= 0) {
    errors.push("timestamp must be a positive number");
  }

  if (typeof snapshot.createdAt !== "number" || snapshot.createdAt <= 0) {
    errors.push("createdAt must be a positive number");
  }

  if (!snapshot.scroll || typeof snapshot.scroll !== "object" || typeof snapshot.scroll.x !== "number" || typeof snapshot.scroll.y !== "number") {
    errors.push("scroll must be an object with numeric x and y");
  }

  if (typeof snapshot.reason !== "string" || !snapshot.reason.trim()) {
    errors.push("reason must be a non-empty string");
  }

  if (!snapshot.context || typeof snapshot.context !== "object") {
    errors.push("context must be an object");
  }

  if (snapshot.adapter !== undefined && snapshot.adapter !== null && (typeof snapshot.adapter !== "object" || Array.isArray(snapshot.adapter))) {
    errors.push("adapter must be an object or null");
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Migrates a raw/legacy snapshot record to the target schema version.
 * @param {object} raw
 * @param {number} [targetVersion=SNAPSHOT_SCHEMA_VERSION]
 * @returns {object} Migrated snapshot record conforming to schema
 */
export function migrateSnapshot(raw, targetVersion = SNAPSHOT_SCHEMA_VERSION) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createTabSnapshot();
  }

  const currentVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0;
  let current = { ...raw };

  // Migration V0 -> V1
  if (currentVersion < 1) {
    const tabId = typeof current.tabId === "number" ? current.tabId : 0;
    const ts = extractSnapshotTimestamp(current);

    current = {
      schemaVersion: 1,
      id: current.id || generateSnapshotId(tabId, ts),
      tabId,
      url: extractCanonicalUrl(current.url || current.originalUrl || ""),
      title: extractTabTitle(current),
      favicon: extractTabFavicon(current),
      timestamp: ts,
      createdAt: current.createdAt || ts,
      createdAtIso: current.createdAtIso || new Date(ts).toISOString(),
      scroll: extractScrollPosition(current.scroll),
      forms: sanitizeFormData(current.forms, current.url),
      screenshot: sanitizeScreenshotData(current.screenshot, {
        title: current.title,
        favicon: current.favicon,
        url: current.url
      }),
      reason: sanitizeSuspensionReason(current.reason),
      context: extractTabContext({}, current),
      adapter: sanitizeAdapterState(current.adapter)
    };
  }

  return current;
}

/**
 * Checks whether a snapshot is corrupted or structurally broken.
 * @param {any} snapshot
 * @returns {boolean}
 */
export function isSnapshotCorrupted(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return true;
  const validation = validateSnapshotSchema(snapshot);
  return !validation.valid;
}

/**
 * Attempts to repair a corrupted or malformed snapshot record to preserve user tab state.
 * @param {any} raw
 * @param {number} [fallbackTabId=0]
 * @returns {object|null} Repaired snapshot or null if completely unrecoverable
 */
export function repairCorruptedSnapshot(raw, fallbackTabId = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const errors = validateSnapshotSchema(raw).errors;
  const tabId = typeof raw.tabId === "number" && !Number.isNaN(raw.tabId) ? raw.tabId : fallbackTabId;
  const url = extractCanonicalUrl(raw.url || raw.originalUrl || "");
  const title = extractTabTitle(raw);
  const ts = extractSnapshotTimestamp(raw);
  const scroll = extractScrollPosition(raw.scroll);

  // If there is no URL at all, the tab cannot be meaningfully restored
  if (!url) {
    return null;
  }

  const repairedReason = raw.reason ? sanitizeSuspensionReason(raw.reason) : "corrupted_recovery";

  const repaired = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    id: (typeof raw.id === "string" && raw.id.trim()) ? raw.id : generateSnapshotId(tabId, ts),
    tabId,
    url,
    title,
    favicon: extractTabFavicon(raw),
    timestamp: ts,
    createdAt: typeof raw.createdAt === "number" && raw.createdAt > 0 ? raw.createdAt : ts,
    createdAtIso: typeof raw.createdAtIso === "string" ? raw.createdAtIso : new Date(ts).toISOString(),
    scroll,
    forms: sanitizeFormData(raw.forms, url),
    screenshot: sanitizeScreenshotData(raw.screenshot, { title, url }),
    reason: repairedReason,
    context: extractTabContext({}, raw),
    adapter: sanitizeAdapterState(raw.adapter),
    wasRepaired: true,
    originalCorruptionErrors: errors
  };

  return repaired;
}

/**
 * Builds a structured restoration execution plan from a historical or current snapshot.
 * @param {object} snapshot - Validated snapshot record
 * @param {object} [options]
 * @param {number} [options.targetTabId] - Override target tab ID
 * @param {boolean} [options.openInNewTab=false]
 * @returns {object} RestorationPlan object
 */
export function createRestorationPlan(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object" || !snapshot.url) {
    throw new Error("Invalid snapshot for restoration plan");
  }

  const targetTabId = typeof options.targetTabId === "number" ? options.targetTabId : (snapshot.tabId || 0);

  return {
    snapshotId: snapshot.id,
    targetTabId,
    openInNewTab: Boolean(options.openInNewTab),
    url: snapshot.url,
    title: snapshot.title || "Restored Tab",
    favicon: snapshot.favicon || "",
    scroll: snapshot.scroll || { x: 0, y: 0, percentX: 0, percentY: 0 },
    forms: snapshot.forms || {},
    isHistorical: Boolean(options.isHistorical ?? (options.index && options.index > 0)),
    snapshotTimestamp: snapshot.timestamp,
    plannedAt: Date.now(),
    context: snapshot.context || {},
    adapter: snapshot.adapter || null
  };
}
