# TabVault — Known Chrome Extension API Limitations

This document details fundamental technical limitations imposed by the Chrome Extension architecture, Chromium sandbox, and Manifest V3 specifications.

---

## 1. JavaScript Execution & Heap Serialization

- **Heap State Inaccessibility**: Chrome Extensions run in isolated sandboxes and have no access to the renderer's V8 heap or memory pages. Closures, internal variables, event listeners, and timers cannot be serialized or frozen generically.
- **Component Framework Internals (React, Vue, Angular, Svelte)**: Virtual DOM state and reactive stores cannot be extracted generically. TabVault compensates by capturing real DOM input values, HTML form elements, scroll coordinates, and site-specific URL/hash state.

---

## 2. Real-Time Network & Media Connections

- **WebSockets and WebRTC**: Active duplex sockets and media streams cannot be suspended in place. Replacing the tab or discarding it terminates the connection. Upon restoration, web apps must establish fresh socket connections.
- **Hardware Decoders & Canvas Buffers**: GPU textures and video playback decoders cannot be saved. Video sites require custom state adapters (such as saving YouTube timestamp and playback status).

---

## 3. Memory Measurement Granularity

- **No Per-Tab RAM API**: Standard Chrome Extension APIs (such as `chrome.system.memory`) only expose aggregate host system capacity and available capacity.
- Chromium intentionally does not provide per-tab renderer process RAM metrics through standard WebExtension APIs due to process-isolation security boundaries.
- TabVault uses an empirical heuristic model (~80MB average per tab) with system-level memory pressure detection, with an optional Windows Native Agent architecture for exact PID-level memory monitoring.

---

## 4. Visual Previews & Screenshot Capture

- **`captureVisibleTab` Boundary**: Chrome's screenshot API (`chrome.tabs.captureVisibleTab`) can only capture the **active** tab in a focused window.
- Inactive tabs that have been in the background cannot be retroactively screenshotted. TabVault captures the preview at the moment of tab deactivation or relies on metadata cards and site favicons when visual capture is unavailable.

---

## 5. Protected and Internal URLs

Chrome strictly prevents content-script injection and script execution on:
- `chrome://` and `edge://` internal URLs.
- `chrome-extension://` resources from other extensions.
- `about:blank` and `view-source:`.
- The Chrome Web Store (`chromewebstore.google.com`).

TabVault automatically bypasses these tabs from suspension to prevent navigation breakage.

---

## 6. Manifest V3 Service Worker Ephemeral Lifecycle

- Service workers do not run continuously in the background. Chrome terminates the service worker after approximately 30 seconds of inactivity.
- Any state stored in memory variables is lost on worker shutdown. TabVault addresses this through persistent storage ledgers (`chrome.storage.local`) that rehydrate on worker wake.

---

## 7. Isolated World vs. Main World for API Interception

- **Content scripts cannot see the page's own API calls by default.** A standard content script runs in an "isolated world" — its own copy of the JS global scope, separate from the page's. Wrapping `navigator.mediaDevices.getUserMedia` or `RTCPeerConnection` from an isolated-world script does not intercept the page's own calls to those APIs, because the page is calling its own, unwrapped copies.
- TabVault's meeting-protection feature needs to see the page's real WebRTC/media-capture calls, so it injects a second content script declared with `"world": "MAIN"` (`content-mainworld.js`) to do the actual wrapping in the page's real JS context, and bridges signals back to the isolated-world script via `window.postMessage` — a MAIN-world script has no access to `chrome.*` APIs to report through directly.
- This bridge is a best-effort signal, not a guarantee: a page could theoretically hold a reference to the original, unwrapped API captured before injection, or a future Chrome policy could restrict MAIN-world redefinition of these properties. TabVault's fallback is a direct DOM scan for live `<video>`/`<audio>` elements (`HTMLMediaElement.srcObject`), which reads real platform objects visible from either world regardless of monkey-patching, and independently confirms any call that renders local media.
