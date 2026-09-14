// TabVault — YouTube Site State Adapter
// Captures and restores playback timestamp, video ID, and playing/paused state.

import { BaseSiteAdapter } from "./base.js";

/**
 * Extracts YouTube video ID from various YouTube URL formats.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function extractYouTubeVideoId(url) {
  if (!url || typeof url !== "string") return null;

  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    const host = parsed.hostname.toLowerCase();

    // Standard watch URL: youtube.com/watch?v=VIDEO_ID
    if (host.includes("youtube.com")) {
      const v = parsed.searchParams.get("v");
      if (v) return v.slice(0, 32);

      // Embed URL: youtube.com/embed/VIDEO_ID
      if (parsed.pathname.startsWith("/embed/")) {
        const seg = parsed.pathname.split("/")[2];
        if (seg) return seg.slice(0, 32);
      }

      // Shorts URL: youtube.com/shorts/VIDEO_ID
      if (parsed.pathname.startsWith("/shorts/")) {
        const seg = parsed.pathname.split("/")[2];
        if (seg) return seg.slice(0, 32);
      }

      // Live URL: youtube.com/live/VIDEO_ID
      if (parsed.pathname.startsWith("/live/")) {
        const seg = parsed.pathname.split("/")[2];
        if (seg) return seg.slice(0, 32);
      }
    }

    // Shortened URL: youtu.be/VIDEO_ID
    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
      const seg = parsed.pathname.slice(1).split("/")[0].split("?")[0];
      if (seg) return seg.slice(0, 32);
    }
  } catch (_) {}

  return null;
}

/**
 * Parses timestamp seconds from URL query param 't' (e.g. 42, 42s, 1m30s).
 *
 * @param {string} url
 * @returns {number|null} Seconds
 */
export function parseYouTubeUrlTimestamp(url) {
  if (!url || typeof url !== "string") return null;

  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    const t = parsed.searchParams.get("t");
    if (!t) return null;

    // Pure number
    if (/^\d+$/.test(t)) {
      return parseInt(t, 10);
    }

    // Seconds format (e.g. 42s)
    if (/^\d+s$/i.test(t)) {
      return parseInt(t.slice(0, -1), 10);
    }

    // Minutes and seconds (e.g. 1m30s or 1h2m3s)
    let totalSec = 0;
    const hoursMatch = t.match(/(\d+)h/i);
    const minsMatch = t.match(/(\d+)m/i);
    const secsMatch = t.match(/(\d+)s/i);

    if (hoursMatch) totalSec += parseInt(hoursMatch[1], 10) * 3600;
    if (minsMatch) totalSec += parseInt(minsMatch[1], 10) * 60;
    if (secsMatch) totalSec += parseInt(secsMatch[1], 10);

    return totalSec > 0 ? totalSec : null;
  } catch (_) {
    return null;
  }
}

/**
 * Appends or updates the 't' timestamp parameter in a YouTube URL.
 *
 * @param {string} url
 * @param {number} seconds
 * @returns {string} Updated URL
 */
export function appendYouTubeTimestamp(url, seconds) {
  if (!url || typeof url !== "string") return "";
  const sec = Math.max(0, Math.floor(seconds || 0));

  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    parsed.searchParams.set("t", `${sec}s`);
    return parsed.toString();
  } catch (_) {
    const delim = url.includes("?") ? "&" : "?";
    return `${url}${delim}t=${sec}s`;
  }
}

/**
 * Formats seconds into human-readable timestamp (e.g. 42 -> 0:42, 3665 -> 1:01:05).
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatYouTubeTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Site adapter for YouTube video tabs.
 */
export class YouTubeAdapter extends BaseSiteAdapter {
  constructor(options = {}) {
    super({
      id: "youtube",
      name: "YouTube",
      description: "Captures and restores playback timestamp, video ID, and playing/paused state",
      domainPatterns: [
        "*://*.youtube.com/watch*",
        "*://youtube.com/watch*",
        "*://*.youtube.com/shorts/*",
        "*://*.youtube.com/embed/*",
        "*://youtu.be/*"
      ],
      priority: 150,
      timeoutMs: 3000,
      ...options
    });
  }

  /**
   * Matches YouTube URLs that have a watchable video ID.
   *
   * @param {string} url
   * @returns {boolean}
   */
  matches(url) {
    if (!super.matches(url)) return false;
    return Boolean(extractYouTubeVideoId(url));
  }

  /**
   * Captures YouTube video playback state.
   *
   * @param {number} tabId
   * @param {object} [context={}]
   * @returns {Promise<object|null>}
   */
  async capture(tabId, context = {}) {
    const url = context.url || context.tab?.url || "";
    const videoId = extractYouTubeVideoId(url);

    if (!videoId) {
      return null;
    }

    let currentTime = 0;
    let duration = null;
    let isPaused = true;
    let volume = 1;
    let isMuted = false;
    let capturedFromDom = false;

    // 1. Direct DOM inspection (if running in page/content script context or test context)
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc) {
      const videoEl = doc.querySelector?.("video.html5-main-video") || doc.querySelector?.("video");
      if (videoEl) {
        currentTime = typeof videoEl.currentTime === "number" ? videoEl.currentTime : 0;
        duration = typeof videoEl.duration === "number" && !Number.isNaN(videoEl.duration) ? videoEl.duration : null;
        isPaused = Boolean(videoEl.paused);
        volume = typeof videoEl.volume === "number" ? videoEl.volume : 1;
        isMuted = Boolean(videoEl.muted);
        capturedFromDom = true;
      }
    }

    // 2. Chrome scripting API (if in background service worker context)
    if (!capturedFromDom && context.chromeApi?.scripting?.executeScript) {
      try {
        const results = await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: () => {
            const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
            if (!v) return null;
            return {
              currentTime: v.currentTime,
              duration: v.duration,
              isPaused: v.paused,
              volume: v.volume,
              isMuted: v.muted
            };
          }
        });

        const data = results?.[0]?.result;
        if (data && typeof data.currentTime === "number") {
          currentTime = data.currentTime;
          duration = data.duration;
          isPaused = data.isPaused;
          volume = data.volume;
          isMuted = data.isMuted;
          capturedFromDom = true;
        }
      } catch (_) {
        // Fallback to URL timestamp parsing
      }
    }

    // 3. Fallback to existing URL timestamp if DOM video element was unavailable
    if (!capturedFromDom) {
      const urlTimestamp = parseYouTubeUrlTimestamp(url);
      if (urlTimestamp !== null) {
        currentTime = urlTimestamp;
      }
    }

    // Round to single decimal place
    currentTime = Math.round(currentTime * 10) / 10;

    return {
      videoId,
      currentTime,
      duration: duration ? Math.round(duration * 10) / 10 : null,
      isPaused,
      volume,
      isMuted,
      formattedTime: formatYouTubeTimestamp(currentTime),
      resumeUrl: appendYouTubeTimestamp(url, currentTime)
    };
  }

  /**
   * Restores YouTube video playback position.
   *
   * @param {number} tabId
   * @param {object} [plan={}]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async restore(tabId, plan = {}, context = {}) {
    const state = plan.adapter?.state || plan.adapter || {};
    const currentTime = typeof state.currentTime === "number" ? state.currentTime : 0;
    const videoId = state.videoId || extractYouTubeVideoId(plan.url || "");

    // 1. If DOM is accessible, seek video element directly
    const doc = context.document || (typeof document !== "undefined" ? document : null);
    if (doc && currentTime > 0) {
      const videoEl = doc.querySelector?.("video.html5-main-video") || doc.querySelector?.("video");
      if (videoEl) {
        videoEl.currentTime = currentTime;
      }
    }

    // 2. Injected seek script via chrome.scripting
    if (context.chromeApi?.scripting?.executeScript && currentTime > 0) {
      try {
        await context.chromeApi.scripting.executeScript({
          target: { tabId },
          func: (seekTime) => {
            const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
            if (v && Math.abs(v.currentTime - seekTime) > 2) {
              v.currentTime = seekTime;
            }
          },
          args: [currentTime]
        });
      } catch (_) {}
    }

    return {
      ok: true,
      videoId,
      currentTime,
      formattedTime: formatYouTubeTimestamp(currentTime)
    };
  }

  /**
   * Validates that state has a valid videoId and non-negative currentTime.
   *
   * @param {*} state
   * @returns {boolean}
   */
  validateState(state) {
    if (!state || typeof state !== "object") return false;
    if (typeof state.currentTime !== "number" || state.currentTime < 0) return false;
    return typeof state.videoId === "string" && state.videoId.length > 0;
  }

  /**
   * Human-readable summary for display in suspended UI card.
   *
   * @param {*} state
   * @returns {string}
   */
  formatSummary(state) {
    if (!state || typeof state.currentTime !== "number") {
      return "YouTube video";
    }
    const time = formatYouTubeTimestamp(state.currentTime);
    const status = state.isPaused ? "paused" : "playing";
    return `Playback at ${time} (${status})`;
  }
}
