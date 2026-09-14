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
