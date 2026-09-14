// TabVault — User Enable/Disable Control & Settings for Site Adapters

import { getAdapterRegistry } from "./registry.js";

export const STORAGE_KEY_ADAPTER_SETTINGS = "tabvault_adapter_settings";

export const DEFAULT_ADAPTER_SETTINGS = Object.freeze({
  enabled: true,
  disabledAdapters: [] // e.g. ["youtube", "jira"]
});

let inMemorySettings = {
  enabled: true,
  disabledAdapters: []
};

/**
 * Returns the current adapter settings.
 *
 * @returns {object} Copy of current settings
 */
export function getAdapterSettings() {
  return {
    enabled: inMemorySettings.enabled !== false,
    disabledAdapters: Array.isArray(inMemorySettings.disabledAdapters)
      ? [...inMemorySettings.disabledAdapters]
      : []
  };
}

/**
 * Updates adapter settings.
 *
 * @param {object} patch
 * @param {object} [options={}]
 * @param {boolean} [options.syncRegistry=true] - Whether to sync registered adapters
 * @returns {object} Updated settings
 */
export function setAdapterSettings(patch = {}, options = {}) {
  if (patch && typeof patch === "object") {
    if (typeof patch.enabled === "boolean") {
      inMemorySettings.enabled = patch.enabled;
    }
    if (Array.isArray(patch.disabledAdapters)) {
      inMemorySettings.disabledAdapters = Array.from(
        new Set(patch.disabledAdapters.map(id => String(id).trim().toLowerCase()).filter(Boolean))
      );
    }
  }

  const current = getAdapterSettings();

  if (options.syncRegistry !== false) {
    try {
      syncRegistryWithSettings(options.registry || getAdapterRegistry(), current);
    } catch (_) {}
  }

  // Best effort chrome storage persistence if available
  if (typeof chrome !== "undefined" && chrome?.storage?.local?.set) {
    try {
      chrome.storage.local.set({ [STORAGE_KEY_ADAPTER_SETTINGS]: current }).catch(() => {});
    } catch (_) {}
  }

  return current;
}

/**
 * Resets adapter settings to default.
 *
 * @param {object} [options={}]
 * @returns {object}
 */
export function resetAdapterSettings(options = {}) {
  inMemorySettings = {
    enabled: DEFAULT_ADAPTER_SETTINGS.enabled,
    disabledAdapters: [...DEFAULT_ADAPTER_SETTINGS.disabledAdapters]
  };

  const current = getAdapterSettings();
  if (options.syncRegistry !== false) {
    try {
      syncRegistryWithSettings(options.registry || getAdapterRegistry(), current);
    } catch (_) {}
  }

  return current;
}

/**
 * Checks whether adapters are globally enabled.
 *
 * @returns {boolean}
 */
export function isAdaptersGloballyEnabled() {
  return getAdapterSettings().enabled;
}

/**
 * Sets global enabled state for all adapters.
 *
 * @param {boolean} enabled
 * @returns {boolean}
 */
export function setAdaptersGloballyEnabled(enabled) {
  setAdapterSettings({ enabled: Boolean(enabled) });
  return isAdaptersGloballyEnabled();
}

/**
 * Checks whether a specific adapter is enabled under current settings.
 *
 * @param {string} adapterId
 * @param {object} [settings]
 * @returns {boolean}
 */
export function isAdapterEnabled(adapterId, settings = getAdapterSettings()) {
  if (!adapterId || typeof adapterId !== "string") return false;
  if (!settings.enabled) return false;

  const id = adapterId.trim().toLowerCase();
  const disabled = Array.isArray(settings.disabledAdapters) ? settings.disabledAdapters : [];
  return !disabled.includes(id);
}

/**
 * Enables or disables a specific adapter by ID.
 *
 * @param {string} adapterId
 * @param {boolean} enabled
 * @param {object} [options={}]
 * @returns {boolean} New enabled state
 */
export function setAdapterEnabled(adapterId, enabled, options = {}) {
  if (!adapterId || typeof adapterId !== "string") return false;
  const id = adapterId.trim().toLowerCase();
  const current = getAdapterSettings();
  const disabledSet = new Set(current.disabledAdapters);

  if (enabled) {
    disabledSet.delete(id);
  } else {
    disabledSet.add(id);
  }

  setAdapterSettings({ disabledAdapters: Array.from(disabledSet) }, options);

  const registry = options.registry || getAdapterRegistry();
  const adapter = registry.get(id);
  if (adapter) {
    if (enabled && current.enabled) {
      adapter.enable();
    } else {
      adapter.disable();
    }
  }

  return isAdapterEnabled(id);
}

/**
 * Synchronizes an AdapterRegistry instance with given settings.
 *
 * @param {object} registry - AdapterRegistry instance
 * @param {object} [settings] - Settings object
 */
export function syncRegistryWithSettings(registry, settings = getAdapterSettings()) {
  if (!registry || typeof registry.getAll !== "function") return;

  const globallyEnabled = settings.enabled !== false;
  const disabledSet = new Set(
    (Array.isArray(settings.disabledAdapters) ? settings.disabledAdapters : []).map(id => String(id).toLowerCase())
  );

  for (const adapter of registry.getAll()) {
    if (!globallyEnabled || disabledSet.has(adapter.id)) {
      adapter.disable();
    } else {
      adapter.enable();
    }
  }
}
