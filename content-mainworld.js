// TabVault main-world bridge — call detection, part 1 of 2.
//
// Why this file exists: content.js (the isolated-world content script) runs
// in a separate JS context from the page. Its `navigator`/`RTCPeerConnection`
// bindings are its OWN copies, not the page's — wrapping
// getUserMedia/getDisplayMedia/RTCPeerConnection from the isolated world does
// NOT intercept the page's own calls to those APIs. To actually see the
// page's WebRTC/media calls, the wrapping has to happen in the MAIN world,
// which has no access to chrome.* APIs — so this script only gathers signals
// and hands them to content.js via window.postMessage; content.js is the one
// that talks to background.js.
//
// This is a best-effort signal, not the only line of defense: content.js
// also independently scans the DOM for live <video>/<audio> elements
// (HTMLMediaElement.srcObject is a real platform object visible from either
// world regardless of monkey-patching), which is what actually guarantees
// detection even if this file's wrapping is bypassed — e.g. a page that
// captured its media stream before this script ran (a race is possible even
// at document_start on a slow-attaching listener), holds a reference to the
// original un-wrapped API via an iframe/Realm trick, or a stricter future
// Chrome policy blocks MAIN-world redefinition of these properties.
(() => {
  if (window.__tabvault_mainworld_injected) return;
  window.__tabvault_mainworld_injected = true;

  const MESSAGE_SOURCE = "tabvault-mainworld";

  // Tracks every RTCPeerConnection the page creates, not just the most
  // recent one — a page can run several simultaneously (e.g. a mesh call,
  // or a screen-share connection alongside the audio/video one), and a
  // single connection dropping to "closed" must not erase the others.
  const activeConnections = new Set();

  // A page can call getUserMedia/getDisplayMedia more than once (separate
  // audio and video captures, a second grant after a device switch, etc.).
  // Tracking individual *tracks* rather than a single boolean means one
  // track ending (e.g. the camera track stops because the user toggled
  // their camera off, but the mic track is still live) doesn't wipe out
  // protection for the other, still-active capture.
  const activeCaptureTracks = new Set();
  const activeScreenShareTracks = new Set();

  // A connection reporting "disconnected" (a transient network hiccup — ICE
  // renegotiating, a Wi-Fi blip) is not the same as one that's actually
  // gone. Ranked alongside "connecting"/"new" (both resolve to "probable" in
  // lib/call-detection.js) rather than being excluded, so a brief network
  // interruption doesn't drop protection outright — only an explicit
  // "closed"/"failed" (which Chrome moves to once the underlying failure is
  // confirmed, not instantly) removes the connection below.
  function aggregateRtcState() {
    let best = null;
    const rank = { disconnected: 1, new: 1, connecting: 1, connected: 2 };
    for (const pc of activeConnections) {
      const state = pc.connectionState;
      if (state === "closed" || state === "failed") continue;
      if (best === null || (rank[state] ?? 0) > (rank[best] ?? 0)) {
        best = state;
      }
    }
    return best;
  }

  function postSignal(partial) {
    try {
      window.postMessage({ source: MESSAGE_SOURCE, ...partial }, window.location.origin || "*");
    } catch (_) { /* detached window during navigation */ }
  }

  function reportRtcState() {
    postSignal({ rtcConnectionState: aggregateRtcState() });
  }

  try {
    if (navigator.mediaDevices?.getUserMedia) {
      const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = function (...args) {
        return originalGetUserMedia(...args).then((stream) => {
          for (const track of stream.getTracks()) {
            activeCaptureTracks.add(track);
            track.addEventListener("ended", () => {
              activeCaptureTracks.delete(track);
              postSignal({ getUserMediaActive: activeCaptureTracks.size > 0 });
            });
          }
          postSignal({ getUserMediaActive: activeCaptureTracks.size > 0 });
          return stream;
        });
      };
    }

    if (navigator.mediaDevices?.getDisplayMedia) {
      const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = function (...args) {
        return originalGetDisplayMedia(...args).then((stream) => {
          for (const track of stream.getTracks()) {
            activeScreenShareTracks.add(track);
            track.addEventListener("ended", () => {
              activeScreenShareTracks.delete(track);
              postSignal({ screenShareActive: activeScreenShareTracks.size > 0 });
            });
          }
          postSignal({ screenShareActive: activeScreenShareTracks.size > 0 });
          return stream;
        });
      };
    }

    if (typeof RTCPeerConnection === "function") {
      const OriginalRTCPeerConnection = RTCPeerConnection;
      window.RTCPeerConnection = function (...args) {
        const pc = new OriginalRTCPeerConnection(...args);
        activeConnections.add(pc);
        pc.addEventListener("connectionstatechange", () => {
          if (pc.connectionState === "closed" || pc.connectionState === "failed") {
            activeConnections.delete(pc);
          }
          reportRtcState();
        });
        reportRtcState();
        return pc;
      };
      window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
    }
  } catch (_) { /* page CSP or a frozen navigator can block wrapping — content.js's DOM scan is the fallback */ }
})();
