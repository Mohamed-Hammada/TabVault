# TabVault Development Setup

This guide walks you through setting up your local development environment for building, running, and debugging TabVault.

---

## 1. Prerequisites

- **Chromium-based Browser**: Chrome 116+, Brave, Edge, or Arc.
- **Node.js**: Node 18+ (tested on Node.js v24.18.0) and npm 10+.
- **Git**: Installed and available in your terminal PATH.

---

## 2. Initial Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Mohamed-Hammada/TabVault.git
   cd TabVault
   ```

2. **Verify installation**:
   Ensure Node is available:
   ```bash
   node -v
   npm test
   ```

---

## 3. Loading the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`.
2. Toggle **Developer mode** in the upper right corner.
3. Click **Load unpacked** (top-left button).
4. Select the `TabVault/` project root directory.
5. The **TabVault — Smart Tab Suspension & Restoration** card will now appear in your extensions list.
6. Pin the extension icon to your Chrome toolbar for quick access.

---

## 4. Debugging & Inspection

### Background Service Worker (`background.js`)
- On `chrome://extensions`, locate the TabVault card.
- Click the **service worker** link to launch DevTools attached directly to the background service worker context.
- All `[TabVault]` lifecycle transition logs, sweep results, and alarm triggers appear in the Console tab.

### Popup (`popup/popup.html`)
- Click the TabVault extension icon on the toolbar to open the popup.
- Right-click anywhere inside the popup window and select **Inspect** to open DevTools for the popup DOM and script.

### Options Page (`options/options.html`)
- Right-click the extension icon and select **Options** (or open via popup settings icon).
- Press `F12` or right-click -> **Inspect** to debug settings storage and rule evaluation.

### Content Script (`content.js`)
- Open any regular web page (e.g. `https://example.com`).
- Open page DevTools (`F12`), switch to the **Console** or **Sources** tab, and filter by extension scripts to inspect scroll and form detection hooks.

---

## 5. Reloading Code Changes

- After modifying `background.js`, `manifest.json`, or permissions, click the **Reload icon** (circular arrow) on the TabVault card at `chrome://extensions`.
- Changes to `popup/`, `options/`, or `suspended/` take effect immediately upon closing and reopening those pages.
