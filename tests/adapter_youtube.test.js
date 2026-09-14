import test from "node:test";
import assert from "node:assert/strict";

import {
  YouTubeAdapter,
  extractYouTubeVideoId,
  parseYouTubeUrlTimestamp,
  appendYouTubeTimestamp,
  formatYouTubeTimestamp
} from "../lib/adapters/youtube.js";
import {
  getAdapterRegistry,
  resetAdapterRegistry,
  registerBuiltInAdapters
} from "../lib/adapters/registry.js";
import { captureSiteAdapterState } from "../lib/adapters/capture.js";
import { restoreSiteAdapterState } from "../lib/adapters/restore.js";

test("YouTube URL helpers: extractYouTubeVideoId", () => {
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractYouTubeVideoId("https://youtube.com/watch?v=abc123XYZ_0&feature=share"), "abc123XYZ_0");
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/embed/embedId123"), "embedId123");
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/shorts/shortsId456"), "shortsId456");
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/live/liveStream789"), "liveStream789");
  assert.equal(extractYouTubeVideoId("https://youtu.be/shortenedId999"), "shortenedId999");
  assert.equal(extractYouTubeVideoId("https://youtu.be/shortenedId999?t=42"), "shortenedId999");

  // Non-video YouTube or other URLs
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/"), null);
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/feed/subscriptions"), null);
  assert.equal(extractYouTubeVideoId("https://example.com/watch?v=123"), null);
  assert.equal(extractYouTubeVideoId(""), null);
  assert.equal(extractYouTubeVideoId(null), null);
});

test("YouTube URL helpers: parseYouTubeUrlTimestamp", () => {
  assert.equal(parseYouTubeUrlTimestamp("https://www.youtube.com/watch?v=xyz&t=42"), 42);
  assert.equal(parseYouTubeUrlTimestamp("https://www.youtube.com/watch?v=xyz&t=42s"), 42);
  assert.equal(parseYouTubeUrlTimestamp("https://www.youtube.com/watch?v=xyz&t=2m30s"), 150);
  assert.equal(parseYouTubeUrlTimestamp("https://www.youtube.com/watch?v=xyz&t=1h2m3s"), 3723);
  assert.equal(parseYouTubeUrlTimestamp("https://www.youtube.com/watch?v=xyz"), null);
  assert.equal(parseYouTubeUrlTimestamp("https://www.youtube.com/watch?v=xyz&t="), null);
  assert.equal(parseYouTubeUrlTimestamp("not a url"), null);
});

test("YouTube URL helpers: appendYouTubeTimestamp and formatYouTubeTimestamp", () => {
  assert.equal(
    appendYouTubeTimestamp("https://www.youtube.com/watch?v=xyz", 75),
    "https://www.youtube.com/watch?v=xyz&t=75s"
  );
  assert.equal(
    appendYouTubeTimestamp("https://www.youtube.com/watch?v=xyz&t=10s", 90),
    "https://www.youtube.com/watch?v=xyz&t=90s"
  );

  assert.equal(formatYouTubeTimestamp(42), "0:42");
  assert.equal(formatYouTubeTimestamp(150), "2:30");
  assert.equal(formatYouTubeTimestamp(3665), "1:01:05");
  assert.equal(formatYouTubeTimestamp(0), "0:00");
});

test("YouTubeAdapter metadata and matching", () => {
  const adapter = new YouTubeAdapter();

  assert.equal(adapter.id, "youtube");
  assert.equal(adapter.name, "YouTube");
  assert.equal(adapter.priority, 150);

  assert.equal(adapter.matches("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
  assert.equal(adapter.matches("https://www.youtube.com/shorts/shorts123"), true);
  assert.equal(adapter.matches("https://www.youtube.com/embed/embed123"), true);
  assert.equal(adapter.matches("https://youtu.be/dQw4w9WgXcQ"), true);

  // Does not match YouTube pages without video ID
  assert.equal(adapter.matches("https://www.youtube.com/"), false);
  assert.equal(adapter.matches("https://www.youtube.com/feed/explore"), false);
  assert.equal(adapter.matches("https://vimeo.com/12345"), false);
});

test("YouTubeAdapter capture: via DOM inspection", async () => {
  const adapter = new YouTubeAdapter();

  const mockVideo = {
    currentTime: 124.6,
    duration: 300,
    paused: false,
    volume: 0.8,
    muted: false
  };

  const mockDoc = {
    querySelector(selector) {
      if (selector.includes("video")) return mockVideo;
      return null;
    }
  };

  const captured = await adapter.capture(101, {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    document: mockDoc
  });

  assert.ok(captured);
  assert.equal(captured.videoId, "dQw4w9WgXcQ");
  assert.equal(captured.currentTime, 124.6);
  assert.equal(captured.duration, 300);
  assert.equal(captured.isPaused, false);
  assert.equal(captured.formattedTime, "2:04");
  assert.ok(captured.resumeUrl.includes("t=124s") || captured.resumeUrl.includes("t=125s"));
});

test("YouTubeAdapter capture: via chromeApi scripting fallback", async () => {
  const adapter = new YouTubeAdapter();

  const chromeApi = {
    scripting: {
      executeScript: async () => [
        {
          result: {
            currentTime: 62.4,
            duration: 180,
            isPaused: true,
            volume: 1,
            isMuted: false
          }
        }
      ]
    }
  };

  const captured = await adapter.capture(101, {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    chromeApi
  });

  assert.ok(captured);
  assert.equal(captured.videoId, "dQw4w9WgXcQ");
  assert.equal(captured.currentTime, 62.4);
  assert.equal(captured.isPaused, true);
  assert.equal(captured.formattedTime, "1:02");
});

test("YouTubeAdapter capture: fallback to URL timestamp if no DOM or scripting", async () => {
  const adapter = new YouTubeAdapter();

  const captured = await adapter.capture(101, {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45s"
  });

  assert.ok(captured);
  assert.equal(captured.videoId, "dQw4w9WgXcQ");
  assert.equal(captured.currentTime, 45);
  assert.equal(captured.formattedTime, "0:45");
});

test("YouTubeAdapter capture: returns null when no video ID present", async () => {
  const adapter = new YouTubeAdapter();

  const captured = await adapter.capture(101, {
    url: "https://www.youtube.com/feed/subscriptions"
  });

  assert.equal(captured, null);
});

test("YouTubeAdapter restore: seeks DOM video element", async () => {
  const adapter = new YouTubeAdapter();

  let seekTarget = null;
  const mockVideo = {
    set currentTime(val) {
      seekTarget = val;
    },
    get currentTime() {
      return seekTarget || 0;
    }
  };

  const mockDoc = {
    querySelector(selector) {
      if (selector.includes("video")) return mockVideo;
      return null;
    }
  };

  const res = await adapter.restore(
    101,
    {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      adapter: {
        id: "youtube",
        state: {
          videoId: "dQw4w9WgXcQ",
          currentTime: 85.5
        }
      }
    },
    { document: mockDoc }
  );

  assert.equal(res.ok, true);
  assert.equal(res.videoId, "dQw4w9WgXcQ");
  assert.equal(res.currentTime, 85.5);
  assert.equal(seekTarget, 85.5);
});

test("YouTubeAdapter restore: via chromeApi.scripting.executeScript", async () => {
  const adapter = new YouTubeAdapter();

  let scriptCalled = false;
  let seekPassed = null;
  const chromeApi = {
    scripting: {
      executeScript: async (options) => {
        scriptCalled = true;
        seekPassed = options.args?.[0];
        return [{ result: true }];
      }
    }
  };

  const res = await adapter.restore(
    101,
    {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      adapter: {
        id: "youtube",
        state: {
          videoId: "dQw4w9WgXcQ",
          currentTime: 120
        }
      }
    },
    { chromeApi }
  );

  assert.equal(res.ok, true);
  assert.equal(scriptCalled, true);
  assert.equal(seekPassed, 120);
});

test("YouTubeAdapter validation and summary formatting", () => {
  const adapter = new YouTubeAdapter();

  assert.equal(adapter.validateState({ videoId: "abc", currentTime: 10 }), true);
  assert.equal(adapter.validateState({ videoId: "", currentTime: 10 }), false);
  assert.equal(adapter.validateState({ videoId: "abc", currentTime: -1 }), false);
  assert.equal(adapter.validateState(null), false);

  assert.equal(
    adapter.formatSummary({ currentTime: 65, isPaused: true }),
    "Playback at 1:05 (paused)"
  );
  assert.equal(
    adapter.formatSummary({ currentTime: 130, isPaused: false }),
    "Playback at 2:10 (playing)"
  );
  assert.equal(adapter.formatSummary(null), "YouTube video");
});

test("YouTubeAdapter registry integration and pipeline execution", async () => {
  resetAdapterRegistry();
  const registry = getAdapterRegistry();
  registerBuiltInAdapters(registry);

  const matched = registry.findMatchingAdapter("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.ok(matched);
  assert.equal(matched.id, "youtube");

  const captureRes = await captureSiteAdapterState(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s",
    101,
    { adapterRegistry: registry }
  );

  assert.ok(captureRes);
  assert.equal(captureRes.matched, true);
  assert.equal(captureRes.ok, true);
  assert.equal(captureRes.adapterId, "youtube");
  assert.equal(captureRes.state.videoId, "dQw4w9WgXcQ");
  assert.equal(captureRes.state.currentTime, 90);

  const restoreRes = await restoreSiteAdapterState(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    101,
    {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      adapter: captureRes
    },
    { adapterRegistry: registry }
  );

  assert.equal(restoreRes.matched, true);
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.adapterId, "youtube");
});
