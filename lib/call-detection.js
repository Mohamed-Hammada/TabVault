// lib/call-detection.js
// Pure call-state logic for meeting protection. No browser APIs here —
// content.js gathers raw signals, background.js calls these functions.

const LEVEL_RANK = { none: 0, possible: 1, probable: 2, confirmed: 3 };

/**
 * Derives a single frame's instantaneous call level from raw signals.
 * Deliberately has no "muted" or "audible" input: a muted track is still a
 * live track (readyState === "live"), and callers must already have
 * filtered signals down to live tracks before calling this.
 *
 * @param {{ liveMediaTrackCount: number, screenShareActive: boolean, rtcConnectionState: string|null, isKnownMeetingDomain: boolean }} signals
 * @returns {"none"|"possible"|"probable"|"confirmed"}
 */
export function deriveFrameLevel(signals) {
  const {
    liveMediaTrackCount = 0,
    screenShareActive = false,
    rtcConnectionState = null,
    isKnownMeetingDomain = false
  } = signals || {};

  if (liveMediaTrackCount > 0 || screenShareActive || rtcConnectionState === "connected") {
    return "confirmed";
  }
  if (rtcConnectionState === "connecting" || rtcConnectionState === "new") {
    return "probable";
  }
  if (isKnownMeetingDomain) {
    return "possible";
  }
  return "none";
}

/**
 * Aggregates per-frame levels (top frame + any iframes) into one tab-level
 * value — the highest-ranked level wins, so a call happening inside an
 * iframe still protects the whole tab.
 *
 * @param {string[]} levels
 * @returns {"none"|"possible"|"probable"|"confirmed"}
 */
export function aggregateFrameLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return "none";
  return levels.reduce((best, level) => {
    const rank = LEVEL_RANK[level] ?? 0;
    return rank > LEVEL_RANK[best] ? level : best;
  }, "none");
}

/**
 * Resolves the level background.js should actually act on, factoring in how
 * long it's been since the tab last reported. A tab that goes quiet decays
 * one step (confirmed -> probable) while merely stale, then to "unknown"
 * once stale for long enough — including the case where there is no prior
 * report at all (e.g. right after a service-worker restart).
 *
 * @param {{ lastLevel: string|null, lastReportedAt: number|null, now: number, staleAfterMs?: number, unknownAfterMs?: number }} args
 * @returns {"none"|"possible"|"probable"|"confirmed"|"unknown"}
 */
export function resolveEffectiveLevel({
  lastLevel,
  lastReportedAt,
  now,
  staleAfterMs = 20_000,
  unknownAfterMs = 90_000
}) {
  if (lastLevel == null || lastReportedAt == null) return "unknown";

  const age = now - lastReportedAt;
  if (age >= unknownAfterMs) return "unknown";
  if (age >= staleAfterMs && lastLevel === "confirmed") return "probable";
  return lastLevel;
}

/**
 * Whether a call-state level alone is enough to block a destructive action
 * (suspend / close-to-vault). Unknown fails safe — treated the same as
 * probable.
 *
 * @param {string} effectiveLevel
 * @returns {boolean}
 */
export function shouldProtectFromCallState(effectiveLevel) {
  return effectiveLevel === "confirmed" || effectiveLevel === "probable" || effectiveLevel === "unknown";
}

/**
 * The known-meeting-domain safety floor. This is independent of detected
 * call state — it protects the whole domain by default, not just
 * meeting-path URLs, unless the user has explicitly excepted it.
 *
 * @param {string} hostname
 * @param {string[]} knownDomains
 * @param {string[]} exceptions
 * @returns {boolean}
 */
export function isKnownMeetingDomain(hostname, knownDomains, exceptions) {
  if (!hostname) return false;
  const list = Array.isArray(knownDomains) ? knownDomains : [];
  const excepted = Array.isArray(exceptions) ? exceptions : [];
  return list.includes(hostname) && !excepted.includes(hostname);
}

/**
 * Combined guard: protect if either the detected call state says so, or the
 * domain-level safety floor says so. This is the single function callers
 * (background.js) should use immediately before any destructive action.
 *
 * @param {{ effectiveLevel: string, hostname: string, knownDomains: string[], exceptions: string[] }} args
 * @returns {boolean}
 */
export function shouldProtectTab({ effectiveLevel, hostname, knownDomains, exceptions }) {
  return shouldProtectFromCallState(effectiveLevel) || isKnownMeetingDomain(hostname, knownDomains, exceptions);
}
