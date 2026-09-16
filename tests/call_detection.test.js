import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveFrameLevel,
  aggregateFrameLevels,
  resolveEffectiveLevel,
  shouldProtectFromCallState,
  isKnownMeetingDomain,
  shouldProtectTab,
  resolveTabProtection
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

test("deriveFrameLevel: probable (not dropped) for a transiently-disconnected RTCPeerConnection with no live track", () => {
  // "disconnected" is WebRTC's transient network-hiccup state — a brief
  // Wi-Fi blip or ICE renegotiation, not proof the call ended. It must not
  // drop straight to none/possible while there's a chance it self-heals.
  const level = deriveFrameLevel({
    liveMediaTrackCount: 0,
    screenShareActive: false,
    rtcConnectionState: "disconnected",
    isKnownMeetingDomain: false
  });
  assert.equal(level, "probable");
  assert.equal(shouldProtectFromCallState(level), true);
});

test("deriveFrameLevel: a disconnected RTCPeerConnection does not override a live local track's confirmed level", () => {
  // liveMediaTrackCount takes priority regardless of connection state — the
  // local capture staying live is stronger evidence than the transport hiccup.
  const level = deriveFrameLevel({
    liveMediaTrackCount: 1,
    screenShareActive: false,
    rtcConnectionState: "disconnected",
    isKnownMeetingDomain: false
  });
  assert.equal(level, "confirmed");
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

test("deriveFrameLevel: confirmed from a bare getUserMedia grant even with no rendered media element (mic-only, audio sent straight to a peer connection)", () => {
  const level = deriveFrameLevel({
    liveMediaTrackCount: 0,
    screenShareActive: false,
    rtcConnectionState: null,
    isKnownMeetingDomain: false,
    getUserMediaActive: true
  });
  assert.equal(level, "confirmed");
});

// ─── resolveTabProtection: the single guard every destructive suspend path uses ───

test("resolveTabProtection: blocks a fresh confirmed call on an ordinary domain", () => {
  const now = 1_000_000;
  const blocked = resolveTabProtection({
    neverSuspendInCall: true,
    level: "confirmed",
    lastReportedAt: now - 1000,
    now,
    hostname: "example.com",
    knownDomains: [],
    exceptions: []
  });
  assert.equal(blocked, true);
});

test("resolveTabProtection: blocks a probable call", () => {
  const now = 1_000_000;
  const blocked = resolveTabProtection({
    neverSuspendInCall: true,
    level: "probable",
    lastReportedAt: now - 1000,
    now,
    hostname: "example.com",
    knownDomains: [],
    exceptions: []
  });
  assert.equal(blocked, true);
});

test("resolveTabProtection: blocks when there is no report at all yet (unknown, e.g. fresh service-worker restart)", () => {
  const blocked = resolveTabProtection({
    neverSuspendInCall: true,
    level: null,
    lastReportedAt: null,
    now: Date.now(),
    hostname: "example.com",
    knownDomains: [],
    exceptions: []
  });
  assert.equal(blocked, true);
});

test("resolveTabProtection: blocks a decayed-to-unknown call after a long gap since the last report", () => {
  const now = 1_000_000;
  const blocked = resolveTabProtection({
    neverSuspendInCall: true,
    level: "confirmed",
    lastReportedAt: now - 200_000,
    now,
    hostname: "example.com",
    knownDomains: [],
    exceptions: []
  });
  assert.equal(blocked, true);
});

test("resolveTabProtection: does not block an ordinary page with no call and no domain floor", () => {
  const now = 1_000_000;
  const blocked = resolveTabProtection({
    neverSuspendInCall: true,
    level: "none",
    lastReportedAt: now - 1000,
    now,
    hostname: "example.com",
    knownDomains: [],
    exceptions: []
  });
  assert.equal(blocked, false);
});

test("resolveTabProtection: known meeting domain still blocks even with level 'none'", () => {
  const now = 1_000_000;
  const blocked = resolveTabProtection({
    neverSuspendInCall: true,
    level: "none",
    lastReportedAt: now - 1000,
    now,
    hostname: "meet.google.com",
    knownDomains: ["meet.google.com"],
    exceptions: []
  });
  assert.equal(blocked, true);
});

test("resolveTabProtection: user-disabled neverSuspend.inCall turns off all protection, including the domain floor", () => {
  const now = 1_000_000;
  const blocked = resolveTabProtection({
    neverSuspendInCall: false,
    level: "confirmed",
    lastReportedAt: now - 1000,
    now,
    hostname: "meet.google.com",
    knownDomains: ["meet.google.com"],
    exceptions: []
  });
  assert.equal(blocked, false);
});
