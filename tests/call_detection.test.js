import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveFrameLevel,
  aggregateFrameLevels,
  resolveEffectiveLevel,
  shouldProtectFromCallState,
  isKnownMeetingDomain,
  shouldProtectTab
} from "../lib/call-detection.js";

test("deriveFrameLevel: confirmed for a live media track regardless of mute state", () => {
  // Mute is not a signal here on purpose — the caller only passes live-track
  // counts (readyState === 'live'), so a muted track already counts as live.
  const level = deriveFrameLevel({
    liveMediaTrackCount: 1,
    screenShareActive: false,
    rtcConnectionState: null,
    isKnownMeetingDomain: false
  });
  assert.equal(level, "confirmed");
});

test("deriveFrameLevel: confirmed for camera-only call", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 1,
    screenShareActive: false,
    rtcConnectionState: "connected",
    isKnownMeetingDomain: true
  });
  assert.equal(level, "confirmed");
});

test("deriveFrameLevel: confirmed for microphone-only call", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 1,
    screenShareActive: false,
    rtcConnectionState: "connected",
    isKnownMeetingDomain: false
  });
  assert.equal(level, "confirmed");
});

test("deriveFrameLevel: confirmed for screen-share alone", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 0,
    screenShareActive: true,
    rtcConnectionState: null,
    isKnownMeetingDomain: false
  });
  assert.equal(level, "confirmed");
});

test("deriveFrameLevel: confirmed does not depend on audibility — no audible input exists", () => {
  // Signals intentionally omit anything audio-output related; a background,
  // silent call with a live track is still confirmed.
  const level = deriveFrameLevel({
    liveMediaTrackCount: 1,
    screenShareActive: false,
    rtcConnectionState: "connected",
    isKnownMeetingDomain: false
  });
  assert.equal(level, "confirmed");
});

test("deriveFrameLevel: probable for a connecting RTCPeerConnection with no live track yet", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 0,
    screenShareActive: false,
    rtcConnectionState: "connecting",
    isKnownMeetingDomain: false
  });
  assert.equal(level, "probable");
});

test("deriveFrameLevel: possible for a known meeting domain with no call signals", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 0,
    screenShareActive: false,
    rtcConnectionState: null,
    isKnownMeetingDomain: true
  });
  assert.equal(level, "possible");
});

test("deriveFrameLevel: none for an ordinary page", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 0,
    screenShareActive: false,
    rtcConnectionState: null,
    isKnownMeetingDomain: false
  });
  assert.equal(level, "none");
});

test("deriveFrameLevel: transitions from none to confirmed once a call starts after the tab was already scanned", () => {
  const before = deriveFrameLevel({ liveMediaTrackCount: 0, screenShareActive: false, rtcConnectionState: null, isKnownMeetingDomain: false });
  const after = deriveFrameLevel({ liveMediaTrackCount: 1, screenShareActive: false, rtcConnectionState: "connected", isKnownMeetingDomain: false });
  assert.equal(before, "none");
  assert.equal(after, "confirmed");
});

test("deriveFrameLevel + SPA route transition: lobby (possible) -> connecting (probable) -> in-call (confirmed)", () => {
  const lobby = deriveFrameLevel({ liveMediaTrackCount: 0, screenShareActive: false, rtcConnectionState: null, isKnownMeetingDomain: true });
  const connecting = deriveFrameLevel({ liveMediaTrackCount: 0, screenShareActive: false, rtcConnectionState: "connecting", isKnownMeetingDomain: true });
  const inCall = deriveFrameLevel({ liveMediaTrackCount: 1, screenShareActive: false, rtcConnectionState: "connected", isKnownMeetingDomain: true });
  assert.equal(lobby, "possible");
  assert.equal(connecting, "probable");
  assert.equal(inCall, "confirmed");
});

test("aggregateFrameLevels: tab level is the highest-ranked frame level (iframe call beats top-frame none)", () => {
  assert.equal(aggregateFrameLevels(["none", "confirmed", "possible"]), "confirmed");
  assert.equal(aggregateFrameLevels(["none", "probable"]), "probable");
  assert.equal(aggregateFrameLevels(["none", "possible"]), "possible");
  assert.equal(aggregateFrameLevels([]), "none");
});

test("resolveEffectiveLevel: unknown when there is no prior report at all (fresh service worker)", () => {
  const level = resolveEffectiveLevel({ lastLevel: null, lastReportedAt: null, now: Date.now() });
  assert.equal(level, "unknown");
});

test("resolveEffectiveLevel: unknown after a service-worker restart wipes in-memory state during an active call", () => {
  // Simulates: tab was confirmed before restart, but the restarted worker has
  // no lastReportedAt for it yet because its in-memory map was rebuilt empty.
  const level = resolveEffectiveLevel({ lastLevel: null, lastReportedAt: null, now: Date.now() });
  assert.equal(level, "unknown");
  assert.equal(shouldProtectFromCallState(level), true);
});

test("resolveEffectiveLevel: confirmed decays to probable once stale, before becoming unknown", () => {
  const now = 1_000_000;
  const level = resolveEffectiveLevel({ lastLevel: "confirmed", lastReportedAt: now - 25_000, now, staleAfterMs: 20_000, unknownAfterMs: 90_000 });
  assert.equal(level, "probable");
});

test("resolveEffectiveLevel: becomes unknown once far enough past the last report", () => {
  const now = 1_000_000;
  const level = resolveEffectiveLevel({ lastLevel: "confirmed", lastReportedAt: now - 100_000, now, staleAfterMs: 20_000, unknownAfterMs: 90_000 });
  assert.equal(level, "unknown");
});

test("resolveEffectiveLevel: fresh confirmed report stays confirmed", () => {
  const now = 1_000_000;
  const level = resolveEffectiveLevel({ lastLevel: "confirmed", lastReportedAt: now - 1_000, now });
  assert.equal(level, "confirmed");
});

test("shouldProtectFromCallState: confirmed, probable, and unknown block destruction; possible and none do not", () => {
  assert.equal(shouldProtectFromCallState("confirmed"), true);
  assert.equal(shouldProtectFromCallState("probable"), true);
  assert.equal(shouldProtectFromCallState("unknown"), true);
  assert.equal(shouldProtectFromCallState("possible"), false);
  assert.equal(shouldProtectFromCallState("none"), false);
});

test("isKnownMeetingDomain: matches known domains unless explicitly excepted by the user", () => {
  const known = ["meet.google.com", "zoom.us"];
  assert.equal(isKnownMeetingDomain("meet.google.com", known, []), true);
  assert.equal(isKnownMeetingDomain("meet.google.com", known, ["meet.google.com"]), false);
  assert.equal(isKnownMeetingDomain("example.com", known, []), false);
});

test("shouldProtectTab: known meeting domain protects even with no detected call (possible/none)", () => {
  const protectedTab = shouldProtectTab({
    effectiveLevel: "none",
    hostname: "meet.google.com",
    knownDomains: ["meet.google.com"],
    exceptions: []
  });
  assert.equal(protectedTab, true);
});

test("shouldProtectTab: an ordinary domain with a confirmed call is protected", () => {
  const protectedTab = shouldProtectTab({
    effectiveLevel: "confirmed",
    hostname: "example.com",
    knownDomains: ["meet.google.com"],
    exceptions: []
  });
  assert.equal(protectedTab, true);
});

test("shouldProtectTab: close-to-vault / suspend is rejected while a call is confirmed active", () => {
  const protectedTab = shouldProtectTab({
    effectiveLevel: "confirmed",
    hostname: "example.com",
    knownDomains: [],
    exceptions: []
  });
  assert.equal(protectedTab, true);
});

test("shouldProtectTab: an ordinary domain with no call and not a meeting domain is not protected", () => {
  const protectedTab = shouldProtectTab({
    effectiveLevel: "none",
    hostname: "example.com",
    knownDomains: ["meet.google.com"],
    exceptions: []
  });
  assert.equal(protectedTab, false);
});
