// TabVault — Memory Budget & Pressure Engine
// Manages configurable memory budget, warning/critical thresholds, tab memory estimation,
// memory pressure evaluations, suspension triggering, event logs, and simulation mode.

import { calculateTabSuspensionScore, evaluateTabProtection, TabSuspensionPriority, generateSuspensionExplanation } from "./scoring.js";
import { isTabSuspended, resolveTabLastActiveAt } from "./lru.js";

export const STORAGE_KEY_MEMORY_BUDGET = "tabvault_memory_budget_config";
export const STORAGE_KEY_MEMORY_LOGS = "tabvault_memory_pressure_logs";

/**
 * Memory pressure level classifications.
 */
export const MemoryPressureLevel = Object.freeze({
  NORMAL: "normal",
  WARNING: "warning",
  CRITICAL: "critical"
});

/**
 * Bounds for memory budget configuration.
 */
export const MEMORY_BUDGET_BOUNDS = Object.freeze({
  MIN_BUDGET_MB: 256,         // 256 MB minimum allowed budget
  MAX_BUDGET_MB: 65536,       // 64 GB maximum allowed budget
  MIN_TAB_MEMORY_MB: 10,      // 10 MB minimum tab estimate
  MAX_TAB_MEMORY_MB: 4096,    // 4 GB maximum tab estimate
  MIN_THRESHOLD_RATIO: 0.10,  // 10%
  MAX_THRESHOLD_RATIO: 0.99   // 99%
});

/**
 * Default memory budget configuration.
 */
export const DEFAULT_MEMORY_BUDGET_CONFIG = Object.freeze({
  enabled: true,
  budgetMb: 2048,                        // 2048 MB (2 GB) target memory limit
  warningThresholdRatio: 0.75,          // 75% -> 1536 MB triggers warning state
  criticalThresholdRatio: 0.90,         // 90% -> 1843.2 MB triggers critical pressure
  defaultTabMemoryMb: 80,               // Heuristic baseline RAM per standard tab
  sampleIntervalSeconds: 30,            // Polling/sampling interval
  autoEvictOnCritical: true,            // Automatically trigger LRU/scoring suspension on critical
  autoEvictOnWarning: false,            // Trigger suspension on warning
  minIdleMinutesForEviction: 5,         // Minimum idle duration (mins) before eligible for memory eviction
  targetUsageRatioAfterEviction: 0.70   // When relieving pressure, aim to reduce usage to 70% of budget
});

// In-memory active configuration
let activeMemoryConfig = { ...DEFAULT_MEMORY_BUDGET_CONFIG };

/**
 * Normalizes, clamps, and validates memory budget configuration.
 *
 * @param {object} [rawConfig={}]
 * @returns {object} Validated memory budget config
 */
export function normalizeMemoryBudgetConfig(rawConfig = {}) {
  const base = { ...DEFAULT_MEMORY_BUDGET_CONFIG, ...(rawConfig || {}) };

  const enabled = typeof base.enabled === "boolean" ? base.enabled : DEFAULT_MEMORY_BUDGET_CONFIG.enabled;

  let budgetMb = Number(base.budgetMb);
  if (!Number.isFinite(budgetMb) || budgetMb <= 0) {
    budgetMb = DEFAULT_MEMORY_BUDGET_CONFIG.budgetMb;
  }
  budgetMb = Math.round(
    Math.max(MEMORY_BUDGET_BOUNDS.MIN_BUDGET_MB, Math.min(MEMORY_BUDGET_BOUNDS.MAX_BUDGET_MB, budgetMb))
  );

  let warningRatio = Number(base.warningThresholdRatio);
  if (!Number.isFinite(warningRatio) || warningRatio <= 0) {
    warningRatio = DEFAULT_MEMORY_BUDGET_CONFIG.warningThresholdRatio;
  }
  warningRatio = Math.max(MEMORY_BUDGET_BOUNDS.MIN_THRESHOLD_RATIO, Math.min(MEMORY_BUDGET_BOUNDS.MAX_THRESHOLD_RATIO, warningRatio));

  let criticalRatio = Number(base.criticalThresholdRatio);
  if (!Number.isFinite(criticalRatio) || criticalRatio <= 0) {
    criticalRatio = DEFAULT_MEMORY_BUDGET_CONFIG.criticalThresholdRatio;
  }
  criticalRatio = Math.max(MEMORY_BUDGET_BOUNDS.MIN_THRESHOLD_RATIO, Math.min(MEMORY_BUDGET_BOUNDS.MAX_THRESHOLD_RATIO, criticalRatio));

  // Ensure warning ratio is strictly lower than critical ratio
  if (warningRatio >= criticalRatio) {
    if (criticalRatio > 0.15) {
      warningRatio = Math.round((criticalRatio - 0.10) * 100) / 100;
    } else {
      criticalRatio = Math.round((warningRatio + 0.10) * 100) / 100;
    }
  }

  let defaultTabMb = Number(base.defaultTabMemoryMb);
  if (!Number.isFinite(defaultTabMb) || defaultTabMb <= 0) {
    defaultTabMb = DEFAULT_MEMORY_BUDGET_CONFIG.defaultTabMemoryMb;
  }
  defaultTabMb = Math.round(
    Math.max(MEMORY_BUDGET_BOUNDS.MIN_TAB_MEMORY_MB, Math.min(MEMORY_BUDGET_BOUNDS.MAX_TAB_MEMORY_MB, defaultTabMb))
  );

  let sampleSeconds = Number(base.sampleIntervalSeconds);
  if (!Number.isFinite(sampleSeconds) || sampleSeconds < 1) {
    sampleSeconds = DEFAULT_MEMORY_BUDGET_CONFIG.sampleIntervalSeconds;
  }

  let minIdleMins = Number(base.minIdleMinutesForEviction);
  if (!Number.isFinite(minIdleMins) || minIdleMins < 0) {
    minIdleMins = DEFAULT_MEMORY_BUDGET_CONFIG.minIdleMinutesForEviction;
  }

  let targetRatio = Number(base.targetUsageRatioAfterEviction);
  if (!Number.isFinite(targetRatio) || targetRatio <= 0 || targetRatio > warningRatio) {
    targetRatio = Math.round((warningRatio * 0.9) * 100) / 100;
  }

  return {
    enabled,
    budgetMb,
    warningThresholdRatio: Math.round(warningRatio * 10000) / 10000,
    criticalThresholdRatio: Math.round(criticalRatio * 10000) / 10000,
    defaultTabMemoryMb: defaultTabMb,
    sampleIntervalSeconds: Math.round(sampleSeconds),
    autoEvictOnCritical: Boolean(base.autoEvictOnCritical),
    autoEvictOnWarning: Boolean(base.autoEvictOnWarning),
    minIdleMinutesForEviction: minIdleMins,
    targetUsageRatioAfterEviction: Math.round(targetRatio * 10000) / 10000
  };
}

/**
 * Gets a deep copy of the current active memory budget configuration.
 *
 * @returns {object}
 */
export function getMemoryBudgetConfig() {
  return { ...activeMemoryConfig };
}

/**
 * Sets and applies memory budget configuration with validation and optional chrome.storage sync.
 *
 * @param {object} updates
 * @returns {object} Updated configuration
 */
export function setMemoryBudgetConfig(updates = {}) {
  const merged = { ...activeMemoryConfig, ...(updates || {}) };
  const normalized = normalizeMemoryBudgetConfig(merged);
  activeMemoryConfig = { ...normalized };

  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ [STORAGE_KEY_MEMORY_BUDGET]: normalized });
    }
  } catch (err) {
    // Gracefully handle storage failures in non-extension environments
  }

  return { ...activeMemoryConfig };
}

/**
 * Resets memory budget configuration to default values.
 *
 * @returns {object} Default configuration
 */
export function resetMemoryBudgetConfig() {
  activeMemoryConfig = { ...DEFAULT_MEMORY_BUDGET_CONFIG };
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ [STORAGE_KEY_MEMORY_BUDGET]: DEFAULT_MEMORY_BUDGET_CONFIG });
    }
  } catch (err) {
    // Gracefully handle storage failures
  }
  return { ...activeMemoryConfig };
}

/**
 * Checks if memory budgeting is enabled.
 *
 * @returns {boolean}
 */
export function isMemoryBudgetEnabled() {
  return Boolean(activeMemoryConfig.enabled);
}

/**
 * Sets whether memory budgeting is enabled.
 *
 * @param {boolean} enabled
 * @returns {boolean}
 */
export function setMemoryBudgetEnabled(enabled) {
  setMemoryBudgetConfig({ enabled: Boolean(enabled) });
  return isMemoryBudgetEnabled();
}

/**
 * Gets configured memory budget in MB.
 *
 * @returns {number}
 */
export function getMemoryBudgetMb() {
  return activeMemoryConfig.budgetMb;
}

/**
 * Sets configured memory budget in MB.
 *
 * @param {number} budgetMb
 * @returns {number} Normalized budget in MB
 */
export function setMemoryBudgetMb(budgetMb) {
  const updated = setMemoryBudgetConfig({ budgetMb });
  return updated.budgetMb;
}

/**
 * Gets default estimated tab memory in MB.
 *
 * @returns {number}
 */
export function getDefaultTabMemoryMb() {
  return activeMemoryConfig.defaultTabMemoryMb;
}

/**
 * Sets default estimated tab memory in MB.
 *
 * @param {number} defaultTabMemoryMb
 * @returns {number}
 */
export function setDefaultTabMemoryMb(defaultTabMemoryMb) {
  const updated = setMemoryBudgetConfig({ defaultTabMemoryMb });
  return updated.defaultTabMemoryMb;
}

/**
 * Gets the warning threshold ratio (e.g. 0.75 for 75%).
 *
 * @returns {number}
 */
export function getWarningThresholdRatio() {
  return activeMemoryConfig.warningThresholdRatio;
}

/**
 * Sets the warning threshold ratio.
 *
 * @param {number} ratio - Value between 0.1 and criticalThresholdRatio
 * @returns {number} Normalized ratio
 */
export function setWarningThresholdRatio(ratio) {
  const updated = setMemoryBudgetConfig({ warningThresholdRatio: ratio });
  return updated.warningThresholdRatio;
}

/**
 * Gets the absolute warning threshold in MB (budgetMb * warningThresholdRatio).
 *
 * @returns {number} Absolute warning threshold in MB
 */
export function getWarningThresholdMb() {
  return Math.round(activeMemoryConfig.budgetMb * activeMemoryConfig.warningThresholdRatio);
}

/**
 * Sets warning threshold by specifying target MB directly.
 *
 * @param {number} thresholdMb
 * @returns {number} Resulting warning threshold in MB
 */
export function setWarningThresholdMb(thresholdMb) {
  const budget = activeMemoryConfig.budgetMb;
  if (!Number.isFinite(thresholdMb) || thresholdMb <= 0 || budget <= 0) {
    return getWarningThresholdMb();
  }
  const ratio = thresholdMb / budget;
  setWarningThresholdRatio(ratio);
  return getWarningThresholdMb();
}

/**
 * Checks whether current memory usage exceeds the configured warning threshold.
 *
 * @param {number} currentUsageMb
 * @param {object} [config=null]
 * @returns {boolean}
 */
export function isWarningThresholdExceeded(currentUsageMb, config = null) {
  const safeConfig = config ? normalizeMemoryBudgetConfig(config) : activeMemoryConfig;
  if (!safeConfig.enabled) return false;
  const warningMb = Math.round(safeConfig.budgetMb * safeConfig.warningThresholdRatio);
  return Number(currentUsageMb) >= warningMb;
}

/**
 * Evaluates warning threshold status and provides actionable metrics.
 *
 * @param {number} currentUsageMb
 * @param {object} [config=null]
 * @returns {object}
 */
export function getWarningThresholdStatus(currentUsageMb, config = null) {
  const safeConfig = config ? normalizeMemoryBudgetConfig(config) : activeMemoryConfig;
  const usage = Math.max(0, Number(currentUsageMb) || 0);
  const budgetMb = safeConfig.budgetMb;
  const warningThresholdRatio = safeConfig.warningThresholdRatio;
  const warningThresholdMb = Math.round(budgetMb * warningThresholdRatio);
  const isExceeded = safeConfig.enabled && usage >= warningThresholdMb;
  const excessMb = isExceeded ? Math.round(usage - warningThresholdMb) : 0;
  const utilizationPercent = Math.round((usage / budgetMb) * 100);

  return {
    enabled: safeConfig.enabled,
    isExceeded,
    currentUsageMb: Math.round(usage),
    warningThresholdMb,
    warningThresholdRatio,
    budgetMb,
    excessMb,
    utilizationPercent,
    summary: isExceeded
      ? `Memory warning: Usage at ${Math.round(usage)} MB (${utilizationPercent}% of ${budgetMb} MB budget) exceeds warning threshold (${warningThresholdMb} MB).`
      : `Memory normal: Usage at ${Math.round(usage)} MB (${utilizationPercent}% of ${budgetMb} MB budget) is within warning threshold (${warningThresholdMb} MB).`
  };
}

// Warning listeners registry
const warningListeners = new Set();

/**
 * Registers a listener callback invoked when warning threshold is evaluated and exceeded.
 *
 * @param {Function} callback
 * @returns {Function} Unsubscribe function
 */
export function addMemoryWarningListener(callback) {
  if (typeof callback === "function") {
    warningListeners.add(callback);
  }
  return () => removeMemoryWarningListener(callback);
}

/**
 * Unsubscribes a warning listener callback.
 *
 * @param {Function} callback
 * @returns {boolean} True if callback was removed
 */
export function removeMemoryWarningListener(callback) {
  return warningListeners.delete(callback);
}

/**
 * Clears all registered warning listeners.
 */
export function clearMemoryWarningListeners() {
  warningListeners.clear();
}

/**
 * Dispatches notification to warning listeners.
 *
 * @param {object} status
 */
export function notifyMemoryWarningListeners(status) {
  for (const listener of warningListeners) {
    try {
      listener(status);
    } catch (err) {
      console.error("[TabVault] Error in memory warning listener:", err);
    }
  }
}

/**
 * Gets the critical threshold ratio (e.g. 0.90 for 90%).
 *
 * @returns {number}
 */
export function getCriticalThresholdRatio() {
  return activeMemoryConfig.criticalThresholdRatio;
}

/**
 * Sets the critical threshold ratio.
 *
 * @param {number} ratio - Value between warningThresholdRatio and 0.99
 * @returns {number} Normalized ratio
 */
export function setCriticalThresholdRatio(ratio) {
  const updated = setMemoryBudgetConfig({ criticalThresholdRatio: ratio });
  return updated.criticalThresholdRatio;
}

/**
 * Gets the absolute critical threshold in MB (budgetMb * criticalThresholdRatio).
 *
 * @returns {number} Absolute critical threshold in MB
 */
export function getCriticalThresholdMb() {
  return Math.round(activeMemoryConfig.budgetMb * activeMemoryConfig.criticalThresholdRatio);
}

/**
 * Sets critical threshold by specifying target MB directly.
 *
 * @param {number} thresholdMb
 * @returns {number} Resulting critical threshold in MB
 */
export function setCriticalThresholdMb(thresholdMb) {
  const budget = activeMemoryConfig.budgetMb;
  if (!Number.isFinite(thresholdMb) || thresholdMb <= 0 || budget <= 0) {
    return getCriticalThresholdMb();
  }
  const ratio = thresholdMb / budget;
  setCriticalThresholdRatio(ratio);
  return getCriticalThresholdMb();
}

/**
 * Checks whether current memory usage exceeds the configured critical threshold.
 *
 * @param {number} currentUsageMb
 * @param {object} [config=null]
 * @returns {boolean}
 */
export function isCriticalThresholdExceeded(currentUsageMb, config = null) {
  const safeConfig = config ? normalizeMemoryBudgetConfig(config) : activeMemoryConfig;
  if (!safeConfig.enabled) return false;
  const criticalMb = Math.round(safeConfig.budgetMb * safeConfig.criticalThresholdRatio);
  return Number(currentUsageMb) >= criticalMb;
}

/**
 * Evaluates critical threshold status and provides actionable metrics.
 *
 * @param {number} currentUsageMb
 * @param {object} [config=null]
 * @returns {object}
 */
export function getCriticalThresholdStatus(currentUsageMb, config = null) {
  const safeConfig = config ? normalizeMemoryBudgetConfig(config) : activeMemoryConfig;
  const usage = Math.max(0, Number(currentUsageMb) || 0);
  const budgetMb = safeConfig.budgetMb;
  const criticalThresholdRatio = safeConfig.criticalThresholdRatio;
  const criticalThresholdMb = Math.round(budgetMb * criticalThresholdRatio);
  const isExceeded = safeConfig.enabled && usage >= criticalThresholdMb;
  const excessMb = isExceeded ? Math.round(usage - criticalThresholdMb) : 0;
  const utilizationPercent = Math.round((usage / budgetMb) * 100);

  return {
    enabled: safeConfig.enabled,
    isExceeded,
    currentUsageMb: Math.round(usage),
    criticalThresholdMb,
    criticalThresholdRatio,
    budgetMb,
    excessMb,
    utilizationPercent,
    summary: isExceeded
      ? `Memory critical: Usage at ${Math.round(usage)} MB (${utilizationPercent}% of ${budgetMb} MB budget) exceeds critical threshold (${criticalThresholdMb} MB).`
      : `Memory sub-critical: Usage at ${Math.round(usage)} MB (${utilizationPercent}% of ${budgetMb} MB budget) is below critical threshold (${criticalThresholdMb} MB).`
  };
}

/**
 * Comprehensive memory pressure state evaluator.
 * Classifies current memory usage into NORMAL, WARNING, or CRITICAL levels.
 *
 * @param {number} currentUsageMb
 * @param {object} [config=null]
 * @returns {object} Comprehensive pressure state
 */
export function getMemoryPressureState(currentUsageMb, config = null) {
  const safeConfig = config ? normalizeMemoryBudgetConfig(config) : activeMemoryConfig;
  const usage = Math.max(0, Number(currentUsageMb) || 0);
  const budgetMb = safeConfig.budgetMb;

  const warningMb = Math.round(budgetMb * safeConfig.warningThresholdRatio);
  const criticalMb = Math.round(budgetMb * safeConfig.criticalThresholdRatio);

  let level = MemoryPressureLevel.NORMAL;
  let isWarning = false;
  let isCritical = false;

  if (safeConfig.enabled) {
    if (usage >= criticalMb) {
      level = MemoryPressureLevel.CRITICAL;
      isCritical = true;
      isWarning = true;
    } else if (usage >= warningMb) {
      level = MemoryPressureLevel.WARNING;
      isWarning = true;
    }
  }

  const excessOverWarningMb = Math.max(0, usage - warningMb);
  const excessOverCriticalMb = Math.max(0, usage - criticalMb);
  const targetRecoveryMb = Math.round(budgetMb * safeConfig.targetUsageRatioAfterEviction);
  const deficitToTargetMb = Math.max(0, usage - targetRecoveryMb);
  const utilizationPercent = Math.round((usage / budgetMb) * 100);

  return {
    enabled: safeConfig.enabled,
    level,
    isNormal: level === MemoryPressureLevel.NORMAL,
    isWarning,
    isCritical,
    currentUsageMb: Math.round(usage),
    budgetMb,
    warningThresholdMb: warningMb,
    criticalThresholdMb: criticalMb,
    targetRecoveryMb,
    excessOverWarningMb,
    excessOverCriticalMb,
    deficitToTargetMb,
    utilizationPercent,
    timestamp: Date.now()
  };
}

// Critical listeners registry
const criticalListeners = new Set();

/**
 * Registers a listener callback invoked when critical threshold is evaluated and exceeded.
 *
 * @param {Function} callback
 * @returns {Function} Unsubscribe function
 */
export function addMemoryCriticalListener(callback) {
  if (typeof callback === "function") {
    criticalListeners.add(callback);
  }
  return () => removeMemoryCriticalListener(callback);
}

/**
 * Unsubscribes a critical listener callback.
 *
 * @param {Function} callback
 * @returns {boolean} True if callback was removed
 */
export function removeMemoryCriticalListener(callback) {
  return criticalListeners.delete(callback);
}

/**
 * Clears all registered critical listeners.
 */
export function clearMemoryCriticalListeners() {
  criticalListeners.clear();
}

/**
 * Dispatches notification to critical listeners.
 *
 * @param {object} status
 */
export function notifyMemoryCriticalListeners(status) {
  for (const listener of criticalListeners) {
    try {
      listener(status);
    } catch (err) {
      console.error("[TabVault] Error in memory critical listener:", err);
    }
  }
}

/**
 * Heavy domain patterns known to consume substantial memory.
 */
const HEAVY_DOMAINS = [
  "youtube.com", "youtu.be", "twitch.tv", "netflix.com", "vimeo.com",
  "docs.google.com", "sheets.google.com", "slides.google.com",
  "figma.com", "canva.com", "miro.com",
  "notion.so", "jira.atlassian.com", "atlassian.net",
  "github.com", "gitlab.com",
  "discord.com", "slack.com", "teams.microsoft.com",
  "twitter.com", "x.com", "facebook.com", "instagram.com", "reddit.com"
];

/**
 * Checks if a URL belongs to a heavy web application.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isHeavyDomain(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return HEAVY_DOMAINS.some(d => hostname === d || hostname.endsWith("." + d));
  } catch {
    return false;
  }
}

/**
 * Estimates the memory usage in MB for an individual tab based on its state and metadata.
 *
 * @param {object} tab - Chrome tab object
 * @param {object} [metadata=null] - Tab metadata
 * @param {object} [config=null] - Configuration overrides
 * @returns {number} Estimated memory in MB
 */
export function estimateTabMemoryMb(tab = {}, metadata = null, config = null) {
  const safeConfig = config ? normalizeMemoryBudgetConfig(config) : activeMemoryConfig;
  const baseMb = safeConfig.defaultTabMemoryMb;

  // Synthetic simulation override
  if (typeof defaultMemorySimulator !== "undefined" && defaultMemorySimulator.isSimulationActive()) {
    const simTabMb = defaultMemorySimulator.getSimulatedTabMemory(tab.id);
    if (typeof simTabMb === "number") {
      return simTabMb;
    }
  }

  // If explicit measurement is already recorded on tab or metadata, honor it
  if (typeof tab.actualMemoryMb === "number" && tab.actualMemoryMb > 0) {
    return Math.round(tab.actualMemoryMb);
  }
  if (metadata && typeof metadata.actualMemoryMb === "number" && metadata.actualMemoryMb > 0) {
    return Math.round(metadata.actualMemoryMb);
  }
  if (typeof tab.estimatedMemoryMb === "number" && tab.estimatedMemoryMb > 0) {
    return Math.round(tab.estimatedMemoryMb);
  }
  if (metadata && typeof metadata.estimatedMemoryMb === "number" && metadata.estimatedMemoryMb > 0) {
    return Math.round(metadata.estimatedMemoryMb);
  }

  // Suspended tabs consume minimal overhead (stub placeholder or discarded)
  if (isTabSuspended(tab, metadata)) {
    return 15; // Minimal placeholder overhead in MB
  }

  let estimate = baseMb;

  // Media / Audio playback uses significant decoder buffers
  if (tab.audible || (metadata && metadata.isAudible)) {
    estimate += 120;
  }

  // Heavy web apps (Figma, Docs, YouTube, etc.)
  const url = tab.url || (metadata && metadata.url) || "";
  if (isHeavyDomain(url)) {
    estimate += 90;
  }

  // Currently active tab holds more renderer and GPU cache
  if (tab.active) {
    estimate += 35;
  }

  // Form input activity indicates interactive document
  if (metadata && (metadata.hasFormData || metadata.hasUnsavedInput)) {
    estimate += 25;
  }

  return Math.round(
    Math.max(MEMORY_BUDGET_BOUNDS.MIN_TAB_MEMORY_MB, Math.min(MEMORY_BUDGET_BOUNDS.MAX_TAB_MEMORY_MB, estimate))
  );
}

/**
 * Calculates total estimated memory usage across an array of tabs.
 *
 * @param {Array<object>} tabs - Array of Chrome tabs
 * @param {Map<number, object>|object} [metadataStore=null] - Metadata map or lookup
 * @param {object} [config=null] - Configuration overrides
 * @returns {object} Breakdown of estimated memory usage
 */
export function estimateTotalMemoryUsageMb(tabs = [], metadataStore = null, config = null) {
  const safeTabs = Array.isArray(tabs) ? tabs : [];
  const safeConfig = config ? normalizeMemoryBudgetConfig(config) : activeMemoryConfig;

  let totalEstimatedMb = 0;
  let activeEstimatedMb = 0;
  let unsuspendedEstimatedMb = 0;
  let suspendedEstimatedMb = 0;

  let activeCount = 0;
  let unsuspendedCount = 0;
  let suspendedCount = 0;

  const tabEstimates = [];

  for (const tab of safeTabs) {
    const tabId = tab.id;
    let meta = null;
    if (metadataStore) {
      if (typeof metadataStore.get === "function") {
        meta = metadataStore.get(tabId) || null;
      } else if (metadataStore[tabId]) {
        meta = metadataStore[tabId];
      }
    }

    const estimatedMb = estimateTabMemoryMb(tab, meta, safeConfig);
    const suspended = isTabSuspended(tab, meta);

    totalEstimatedMb += estimatedMb;

    if (suspended) {
      suspendedCount++;
      suspendedEstimatedMb += estimatedMb;
    } else {
      unsuspendedCount++;
      unsuspendedEstimatedMb += estimatedMb;
      if (tab.active) {
        activeCount++;
        activeEstimatedMb += estimatedMb;
      }
    }

    tabEstimates.push({
      tabId,
      url: tab.url,
      title: tab.title,
      isSuspended: suspended,
      isActive: Boolean(tab.active),
      estimatedMb
    });
  }

  // Synthetic simulation override for total memory
  if (typeof defaultMemorySimulator !== "undefined" && defaultMemorySimulator.isSimulationActive()) {
    const simTotalMb = defaultMemorySimulator.getSimulatedUsageMb();
    if (typeof simTotalMb === "number") {
      totalEstimatedMb = simTotalMb;
    }
  }

  return {
    totalEstimatedMb: Math.round(totalEstimatedMb),
    activeEstimatedMb: Math.round(activeEstimatedMb),
    unsuspendedEstimatedMb: Math.round(unsuspendedEstimatedMb),
    suspendedEstimatedMb: Math.round(suspendedEstimatedMb),
    tabCount: safeTabs.length,
    activeCount,
    unsuspendedCount,
    suspendedCount,
    tabEstimates
  };
}

/**
 * Evaluates memory pressure and selects optimal candidate tabs to suspend in order to
 * reduce memory consumption to safe target levels.
 *
 * @param {object} params
 * @param {Array<object>} params.tabs - Chrome tab objects
 * @param {Map<number, object>|object} [params.metadataStore=null] - Tab metadata
 * @param {number} [params.currentUsageMb=null] - Current usage in MB (if omitted, estimated from tabs)
 * @param {object} [params.context={}] - Contextual parameters (now, scoring weights)
 * @param {object} [params.options={}] - Options (targetSavingsMb, maxTabsToSuspend, force)
 * @returns {object} Selection report with candidates, projected savings, and pressure state
 */
export function selectMemoryPressureSuspensionCandidates({
  tabs = [],
  metadataStore = null,
  currentUsageMb = null,
  context = {},
  options = {}
} = {}) {
  const safeTabs = Array.isArray(tabs) ? tabs : [];
  const safeContext = { ...(context || {}) };
  const safeOptions = {
    force: false,
    maxTabsToSuspend: Infinity,
    targetSavingsMb: null,
    ignoreMinIdle: false,
    ...(options || {})
  };

  const config = getMemoryBudgetConfig();

  // If memory budget is disabled and force is not set, skip evaluation
  if (!config.enabled && !safeOptions.force) {
    return {
      triggered: false,
      pressureState: getMemoryPressureState(0, config),
      candidates: [],
      projectedSavingsMb: 0,
      candidateCount: 0,
      reason: "budget_disabled",
      summary: "Memory budget is currently disabled."
    };
  }

  // Determine current memory usage: explicit reading, simulated, or estimated from tabs
  let usage = currentUsageMb;
  let usageBreakdown = null;
  if (typeof usage !== "number" || usage < 0) {
    if (typeof defaultMemorySimulator !== "undefined" && defaultMemorySimulator.isSimulationActive() && typeof defaultMemorySimulator.getSimulatedUsageMb() === "number") {
      usage = defaultMemorySimulator.getSimulatedUsageMb();
    } else {
      usageBreakdown = estimateTotalMemoryUsageMb(safeTabs, metadataStore, config);
      usage = usageBreakdown.totalEstimatedMb;
    }
  }

  const pressureState = getMemoryPressureState(usage, config);

  // Determine whether eviction should run:
  // - critical: runs if autoEvictOnCritical is true
  // - warning: runs if autoEvictOnWarning is true
  // - force: runs unconditionally
  const shouldEvict = safeOptions.force ||
    (pressureState.isCritical && config.autoEvictOnCritical) ||
    (pressureState.isWarning && config.autoEvictOnWarning);

  if (!shouldEvict) {
    return {
      triggered: false,
      pressureState,
      candidates: [],
      projectedSavingsMb: 0,
      candidateCount: 0,
      reason: "within_budget_or_auto_evict_disabled",
      summary: `Memory pressure at ${pressureState.level.toUpperCase()} (${pressureState.currentUsageMb} MB). No automatic eviction required.`
    };
  }

  // Calculate target savings
  let targetSavingsMb = safeOptions.targetSavingsMb;
  if (typeof targetSavingsMb !== "number" || targetSavingsMb <= 0) {
    // Relieve to target recovery level (targetUsageRatioAfterEviction)
    targetSavingsMb = pressureState.deficitToTargetMb;
    if (targetSavingsMb <= 0 && pressureState.isCritical) {
      targetSavingsMb = pressureState.excessOverCriticalMb || 100;
    } else if (targetSavingsMb <= 0 && pressureState.isWarning) {
      targetSavingsMb = pressureState.excessOverWarningMb || 50;
    }
  }

  if (targetSavingsMb <= 0 && !safeOptions.force) {
    return {
      triggered: false,
      pressureState,
      candidates: [],
      projectedSavingsMb: 0,
      candidateCount: 0,
      reason: "target_savings_zero",
      summary: "Memory is within desired bounds; target savings is zero."
    };
  }

  const now = safeContext.now || Date.now();
  const scoredCandidates = [];

  for (const tab of safeTabs) {
    const tabId = tab.id;
    let meta = null;
    if (metadataStore) {
      if (typeof metadataStore.get === "function") {
        meta = metadataStore.get(tabId) || null;
      } else if (metadataStore[tabId]) {
        meta = metadataStore[tabId];
      }
    }

    // Active tabs are preserved
    if (tab.active && !safeOptions.allowActive) {
      continue;
    }

    // Already suspended tabs are skipped
    if (isTabSuspended(tab, meta)) {
      continue;
    }

    // Evaluate protection rules (pinned, audio, whitelist)
    const protection = evaluateTabProtection(tab, meta, safeContext);
    if (protection.isProtected) {
      continue;
    }

    // Check idle duration threshold unless ignored
    const lastActiveAt = resolveTabLastActiveAt(tab, meta, now);
    const idleMs = Math.max(0, now - lastActiveAt);
    const idleMinutes = Math.floor(idleMs / 60000);

    if (!safeOptions.ignoreMinIdle && idleMinutes < config.minIdleMinutesForEviction) {
      // If critical pressure is acute (>95%), we can relax idle requirement to 1 min
      if (!(pressureState.utilizationPercent >= 95 && idleMinutes >= 1)) {
        continue;
      }
    }

    // Score tab with elevated memory pressure multiplier
    const scoringContext = {
      ...safeContext,
      now,
      memoryPressure: pressureState.isCritical ? "critical" : "high"
    };
    const scoreResult = calculateTabSuspensionScore(tab, meta, scoringContext);

    // Skip immune priority
    if (scoreResult.priorityLevel === TabSuspensionPriority.IMMUNE) {
      continue;
    }

    const estimatedMemoryMb = estimateTabMemoryMb(tab, meta, config);

    scoredCandidates.push({
      tabId,
      windowId: tab.windowId,
      title: tab.title || "Untitled Tab",
      url: tab.url || "",
      tab,
      metadata: meta,
      score: scoreResult.suspensionScore,
      scoreDetails: scoreResult,
      priorityLevel: scoreResult.priorityLevel,
      priorityLabel: scoreResult.priorityLabel,
      lastActiveAt,
      idleMinutes,
      estimatedMemoryMb
    });
  }

  // Sort candidates by highest suspension score first, then least recently used (highest idleMinutes)
  scoredCandidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.idleMinutes - a.idleMinutes;
  });

  const selectedCandidates = [];
  let projectedSavingsMb = 0;
  const maxTabs = Number.isFinite(safeOptions.maxTabsToSuspend) ? safeOptions.maxTabsToSuspend : Infinity;

  for (const candidate of scoredCandidates) {
    if (selectedCandidates.length >= maxTabs) {
      break;
    }

    const explanation = generateSuspensionExplanation(
      candidate.scoreDetails,
      {
        trigger: "memory_pressure",
        now,
        pressureLevel: pressureState.level,
        currentUsageMb: pressureState.currentUsageMb,
        budgetMb: pressureState.budgetMb
      }
    );

    selectedCandidates.push({
      tabId: candidate.tabId,
      windowId: candidate.windowId,
      title: candidate.title,
      url: candidate.url,
      tab: candidate.tab,
      metadata: candidate.metadata,
      score: candidate.score,
      priorityLevel: candidate.priorityLevel,
      priorityLabel: candidate.priorityLabel,
      lastActiveAt: candidate.lastActiveAt,
      idleMinutes: candidate.idleMinutes,
      estimatedMemoryMb: candidate.estimatedMemoryMb,
      explanation
    });

    projectedSavingsMb += candidate.estimatedMemoryMb;

    if (projectedSavingsMb >= targetSavingsMb) {
      break;
    }
  }

  const remainingUsageMb = Math.max(0, Math.round(usage - projectedSavingsMb));
  const newUtilizationPercent = Math.round((remainingUsageMb / config.budgetMb) * 100);

  const summary = selectedCandidates.length > 0
    ? `Memory pressure (${pressureState.level.toUpperCase()} at ${Math.round(usage)} MB) triggered suspension of ${selectedCandidates.length} tab(s), saving ~${projectedSavingsMb} MB (reducing usage to ~${remainingUsageMb} MB / ${newUtilizationPercent}%).`
    : `Memory pressure evaluated (${pressureState.level.toUpperCase()} at ${Math.round(usage)} MB). No eligible candidate tabs found for suspension.`;

  return {
    triggered: selectedCandidates.length > 0,
    pressureState,
    targetSavingsMb,
    projectedSavingsMb,
    candidates: selectedCandidates,
    candidateCount: selectedCandidates.length,
    initialUsageMb: Math.round(usage),
    remainingUsageMb,
    newUtilizationPercent,
    summary
  };
}

/**
 * High-level orchestration function: evaluates memory pressure, identifies candidates,
 * dispatches notifications, and optionally executes the provided suspendTabFn.
 *
 * @param {object} params
 * @param {Array<object>} params.tabs - Chrome tabs
 * @param {Map<number, object>|object} [params.metadataStore=null]
 * @param {number} [params.currentUsageMb=null]
 * @param {Function} [params.suspendTabFn=null] - (tabId, reason, candidate) => Promise<any> | any
 * @param {object} [params.context={}]
 * @param {object} [params.options={}]
 * @returns {Promise<object>} Execution report
 */
export async function evaluateAndTriggerMemorySuspension({
  tabs = [],
  metadataStore = null,
  currentUsageMb = null,
  suspendTabFn = null,
  context = {},
  options = {}
} = {}) {
  const selection = selectMemoryPressureSuspensionCandidates({
    tabs,
    metadataStore,
    currentUsageMb,
    context,
    options
  });

  // Notify listeners according to pressure state
  if (selection.pressureState.isCritical) {
    notifyMemoryCriticalListeners(getCriticalThresholdStatus(selection.pressureState.currentUsageMb));
  } else if (selection.pressureState.isWarning) {
    notifyMemoryWarningListeners(getWarningThresholdStatus(selection.pressureState.currentUsageMb));
  }

  const suspendedResults = [];
  const errors = [];

  if (selection.triggered && typeof suspendTabFn === "function") {
    for (const candidate of selection.candidates) {
      try {
        const result = await Promise.resolve(
          suspendTabFn(candidate.tabId, "memory_pressure", candidate)
        );
        suspendedResults.push({
          tabId: candidate.tabId,
          success: true,
          result
        });
      } catch (err) {
        errors.push({
          tabId: candidate.tabId,
          success: false,
          error: err ? err.message || String(err) : "Unknown suspension error"
        });
      }
    }
  }

  const report = {
    ...selection,
    executedSuspensions: suspendedResults,
    errors,
    suspendedCount: suspendedResults.length,
    errorCount: errors.length
  };

  // Automatic event logging
  if (options.logEvent !== false && (selection.pressureState.isWarning || selection.triggered)) {
    const level = selection.triggered
      ? "eviction"
      : (selection.pressureState.isCritical ? "critical" : "warning");

    const message = selection.triggered
      ? `Evicted ${suspendedResults.length} tab(s) to relieve memory pressure (~${selection.projectedSavingsMb} MB projected savings).`
      : `Memory pressure reached ${selection.pressureState.level.toUpperCase()} at ${selection.pressureState.currentUsageMb} MB (${selection.pressureState.utilizationPercent}%).`;

    logMemoryPressureEvent({
      level,
      trigger: options.trigger || "auto_evict",
      currentUsageMb: selection.pressureState.currentUsageMb,
      budgetMb: selection.pressureState.budgetMb,
      warningThresholdMb: selection.pressureState.warningThresholdMb,
      criticalThresholdMb: selection.pressureState.criticalThresholdMb,
      utilizationPercent: selection.pressureState.utilizationPercent,
      candidatesCount: selection.candidates.length,
      projectedSavingsMb: selection.projectedSavingsMb,
      suspendedTabIds: suspendedResults.map(r => r.tabId),
      message,
      details: {
        errorCount: errors.length,
        errors: errors.map(e => e.error)
      }
    });
  }

  return report;
}

/**
 * Manages event logs for memory pressure incidents and automatic evictions.
 * Uses a circular buffer in memory and synchronizes with chrome.storage.local.
 */
export class MemoryPressureLogger {
  /**
   * @param {object} [options={}]
   * @param {number} [options.maxEntries=100] - Maximum log entries retained
   */
  constructor({ maxEntries = 100 } = {}) {
    this.maxEntries = Math.max(1, Math.min(1000, Number(maxEntries) || 100));
    /** @type {Array<object>} */
    this._logs = [];
  }

  /**
   * Logs a memory pressure or eviction event.
   *
   * @param {object} eventData
   * @returns {object} Normalized log entry
   */
  logEvent(eventData = {}) {
    const timestamp = Number(eventData.timestamp) || Date.now();
    const id = eventData.id || `mem-log-${timestamp}-${Math.random().toString(36).slice(2, 7)}`;
    const level = String(eventData.level || "warning").toLowerCase();
    const trigger = String(eventData.trigger || "manual").toLowerCase();

    const currentUsageMb = Math.round(Number(eventData.currentUsageMb) || 0);
    const budgetMb = Math.round(Number(eventData.budgetMb) || activeMemoryConfig.budgetMb);
    const warningThresholdMb = Math.round(
      Number(eventData.warningThresholdMb) || (budgetMb * activeMemoryConfig.warningThresholdRatio)
    );
    const criticalThresholdMb = Math.round(
      Number(eventData.criticalThresholdMb) || (budgetMb * activeMemoryConfig.criticalThresholdRatio)
    );

    const utilizationPercent = Math.round(
      Number.isFinite(eventData.utilizationPercent)
        ? eventData.utilizationPercent
        : (budgetMb > 0 ? (currentUsageMb / budgetMb) * 100 : 0)
    );

    const candidatesCount = Number(eventData.candidatesCount) || 0;
    const projectedSavingsMb = Math.round(Number(eventData.projectedSavingsMb) || 0);
    const suspendedTabIds = Array.isArray(eventData.suspendedTabIds) ? [...eventData.suspendedTabIds] : [];

    const defaultMessage = `Memory event [${level.toUpperCase()}]: ${currentUsageMb} MB / ${budgetMb} MB (${utilizationPercent}%).`;
    const message = typeof eventData.message === "string" && eventData.message.trim()
      ? eventData.message.trim()
      : defaultMessage;

    const entry = {
      id,
      timestamp,
      level,
      trigger,
      currentUsageMb,
      budgetMb,
      warningThresholdMb,
      criticalThresholdMb,
      utilizationPercent,
      candidatesCount,
      projectedSavingsMb,
      suspendedTabIds,
      details: eventData.details && typeof eventData.details === "object" ? { ...eventData.details } : {},
      message
    };

    // Prepend (newest first)
    this._logs.unshift(entry);

    // Enforce circular buffer capacity
    if (this._logs.length > this.maxEntries) {
      this._logs = this._logs.slice(0, this.maxEntries);
    }

    // Persist to chrome.storage.local
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [STORAGE_KEY_MEMORY_LOGS]: this._logs.slice(0, 50) });
      }
    } catch {
      // Ignore storage persistence errors in non-extension environment
    }

    return entry;
  }

  /**
   * Retrieves logs matching filter criteria.
   *
   * @param {object} [filter={}]
   * @param {string} [filter.level] - Optional level filter ("warning", "critical", "eviction")
   * @param {number} [filter.sinceTimestamp] - Optional timestamp cutoff
   * @param {number} [filter.limit=50] - Max logs to return
   * @param {number} [filter.offset=0] - Offset for pagination
   * @returns {Array<object>} Filtered logs
   */
  getLogs({ level, sinceTimestamp, limit = 50, offset = 0 } = {}) {
    let filtered = this._logs;

    if (level) {
      const targetLevel = String(level).toLowerCase();
      filtered = filtered.filter(item => item.level === targetLevel);
    }

    if (typeof sinceTimestamp === "number" && sinceTimestamp > 0) {
      filtered = filtered.filter(item => item.timestamp >= sinceTimestamp);
    }

    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(this.maxEntries, Number(limit) || 50));

    return filtered.slice(safeOffset, safeOffset + safeLimit);
  }

  /**
   * Retrieves the most recent N log entries.
   *
   * @param {number} [count=20]
   * @returns {Array<object>}
   */
  getRecentLogs(count = 20) {
    return this.getLogs({ limit: count, offset: 0 });
  }

  /**
   * Computes summary metrics across stored logs.
   *
   * @returns {object} Summary statistics
   */
  getLogStats() {
    let warningCount = 0;
    let criticalCount = 0;
    let evictionCount = 0;
    let totalProjectedSavingsMb = 0;
    let totalSuspendedTabs = 0;

    for (const log of this._logs) {
      if (log.level === "warning") warningCount++;
      if (log.level === "critical") criticalCount++;
      if (log.level === "eviction") evictionCount++;
      totalProjectedSavingsMb += log.projectedSavingsMb || 0;
      totalSuspendedTabs += (log.suspendedTabIds && log.suspendedTabIds.length) || 0;
    }

    return {
      totalLogs: this._logs.length,
      warningCount,
      criticalCount,
      evictionCount,
      totalProjectedSavingsMb,
      totalSuspendedTabs,
      oldestTimestamp: this._logs.length > 0 ? this._logs[this._logs.length - 1].timestamp : null,
      newestTimestamp: this._logs.length > 0 ? this._logs[0].timestamp : null
    };
  }

  /**
   * Clears all log entries from memory and storage.
   */
  clearLogs() {
    this._logs = [];
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(STORAGE_KEY_MEMORY_LOGS);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Exports logs as JSON payload.
   *
   * @returns {object}
   */
  exportLogs() {
    return {
      version: 1,
      exportedAt: Date.now(),
      count: this._logs.length,
      logs: [...this._logs]
    };
  }

  /**
   * Imports logs with validation.
   *
   * @param {Array<object>|object} payload
   * @param {boolean} [overwrite=false]
   * @returns {number} Number of logs imported
   */
  importLogs(payload, overwrite = false) {
    const rawList = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.logs) ? payload.logs : []);
    if (overwrite) {
      this._logs = [];
    }
    let count = 0;
    for (const item of rawList) {
      if (item && typeof item === "object") {
        this.logEvent(item);
        count++;
      }
    }
    return count;
  }
}

// Global default memory pressure logger instance
export const defaultMemoryPressureLogger = new MemoryPressureLogger({ maxEntries: 100 });

/**
 * Convenience helper to log a memory pressure event.
 *
 * @param {object} eventData
 * @returns {object}
 */
export function logMemoryPressureEvent(eventData) {
  return defaultMemoryPressureLogger.logEvent(eventData);
}

/**
 * Convenience helper to query memory pressure logs.
 *
 * @param {object} [filter={}]
 * @returns {Array<object>}
 */
export function getMemoryPressureLogs(filter = {}) {
  return defaultMemoryPressureLogger.getLogs(filter);
}

/**
 * Convenience helper to get recent memory pressure logs.
 *
 * @param {number} [count=20]
 * @returns {Array<object>}
 */
export function getRecentMemoryPressureLogs(count = 20) {
  return defaultMemoryPressureLogger.getRecentLogs(count);
}

/**
 * Convenience helper to get log statistics.
 *
 * @returns {object}
 */
export function getMemoryPressureLogStats() {
  return defaultMemoryPressureLogger.getLogStats();
}

/**
 * Convenience helper to clear memory pressure logs.
 */
export function clearMemoryPressureLogs() {
  defaultMemoryPressureLogger.clearLogs();
}

/**
 * Synthetic memory simulation engine for testing and validation.
 * Allows simulating various memory pressure conditions without requiring actual OS memory usage.
 */
export class MemorySimulator {
  constructor() {
    this._isActive = false;
    this._simulatedUsageMb = null;
    this._simulatedPressureLevel = null;
    /** @type {Map<number, number>} */
    this._tabMemoryOverrides = new Map();
  }

  /**
   * Activates simulation mode with optional initial usage, pressure level, or tab overrides.
   *
   * @param {object} [options={}]
   * @param {number} [options.usageMb] - Initial simulated memory usage in MB
   * @param {string} [options.pressureLevel] - Initial simulated pressure ("normal", "warning", "critical")
   * @param {object} [options.tabOverrides] - Map or object of { tabId: memoryMb }
   * @returns {object} Status after enabling
   */
  enable({ usageMb = null, pressureLevel = null, tabOverrides = null } = {}) {
    this._isActive = true;
    if (typeof usageMb === "number") {
      this.setSimulatedUsageMb(usageMb);
    } else if (pressureLevel) {
      this.setSimulatedPressureLevel(pressureLevel);
    }
    if (tabOverrides && typeof tabOverrides === "object") {
      for (const [tabId, mb] of Object.entries(tabOverrides)) {
        this.setSimulatedTabMemory(Number(tabId), Number(mb));
      }
    }
    return this.getStatus();
  }

  /**
   * Deactivates simulation mode and clears synthetic overrides.
   *
   * @returns {object} Status after disabling
   */
  disable() {
    this._isActive = false;
    this._simulatedUsageMb = null;
    this._simulatedPressureLevel = null;
    this._tabMemoryOverrides.clear();
    return this.getStatus();
  }

  /**
   * Returns whether simulation mode is currently active.
   *
   * @returns {boolean}
   */
  isSimulationActive() {
    return this._isActive;
  }

  /**
   * Sets synthetic memory usage in MB.
   *
   * @param {number|null} mb
   * @returns {number|null}
   */
  setSimulatedUsageMb(mb) {
    this._simulatedUsageMb = (typeof mb === "number" && Number.isFinite(mb)) ? Math.max(0, Math.round(mb)) : null;
    return this._simulatedUsageMb;
  }

  /**
   * Gets current synthetic memory usage in MB if active.
   *
   * @returns {number|null}
   */
  getSimulatedUsageMb() {
    if (!this._isActive) return null;
    return this._simulatedUsageMb;
  }

  /**
   * Sets synthetic memory pressure by level ("normal", "warning", "critical").
   * Automatically calculates representative MB value based on active budget.
   *
   * @param {string} level - "normal", "warning", "critical"
   * @returns {object}
   */
  setSimulatedPressureLevel(level) {
    const config = getMemoryBudgetConfig();
    const budget = config.budgetMb;
    const warningMb = Math.round(budget * config.warningThresholdRatio);
    const criticalMb = Math.round(budget * config.criticalThresholdRatio);

    const normLevel = String(level || "normal").toLowerCase();
    this._simulatedPressureLevel = normLevel;

    if (normLevel === "critical") {
      this._simulatedUsageMb = criticalMb + 100;
    } else if (normLevel === "warning") {
      this._simulatedUsageMb = warningMb + 50;
    } else {
      this._simulatedUsageMb = Math.round(budget * 0.5);
    }

    return {
      level: normLevel,
      simulatedUsageMb: this._simulatedUsageMb
    };
  }

  /**
   * Sets synthetic memory override for a specific tab.
   *
   * @param {number} tabId
   * @param {number} memoryMb
   */
  setSimulatedTabMemory(tabId, memoryMb) {
    if (typeof tabId === "number" && typeof memoryMb === "number" && Number.isFinite(memoryMb)) {
      this._tabMemoryOverrides.set(tabId, Math.max(0, Math.round(memoryMb)));
    }
  }

  /**
   * Gets synthetic memory override for a specific tab if simulation is active.
   *
   * @param {number} tabId
   * @returns {number|null}
   */
  getSimulatedTabMemory(tabId) {
    if (!this._isActive || typeof tabId !== "number") return null;
    return this._tabMemoryOverrides.get(tabId) ?? null;
  }

  /**
   * Clears synthetic memory override for a specific tab or all tabs.
   *
   * @param {number} [tabId]
   */
  clearSimulatedTabMemory(tabId) {
    if (typeof tabId === "number") {
      return this._tabMemoryOverrides.delete(tabId);
    }
    this._tabMemoryOverrides.clear();
  }

  /**
   * Simulates an acute memory pressure spike and returns projected consequences.
   *
   * @param {string} [targetLevel="critical"]
   * @returns {object}
   */
  simulateMemoryPressureSpike(targetLevel = "critical") {
    this._isActive = true;
    const pressureInfo = this.setSimulatedPressureLevel(targetLevel);
    return {
      simulationActive: true,
      level: pressureInfo.level,
      simulatedUsageMb: pressureInfo.simulatedUsageMb,
      timestamp: Date.now()
    };
  }

  /**
   * Returns current status summary of simulation engine.
   *
   * @returns {object}
   */
  getStatus() {
    return {
      isActive: this._isActive,
      simulatedUsageMb: this._simulatedUsageMb,
      simulatedPressureLevel: this._simulatedPressureLevel,
      tabOverridesCount: this._tabMemoryOverrides.size
    };
  }
}

// Global default memory simulator instance
export const defaultMemorySimulator = new MemorySimulator();

/**
 * Convenience helper to check if simulation mode is enabled.
 *
 * @returns {boolean}
 */
export function isMemorySimulationEnabled() {
  return defaultMemorySimulator.isSimulationActive();
}

/**
 * Convenience helper to enable memory simulation mode.
 *
 * @param {object} [options={}]
 * @returns {object}
 */
export function enableMemorySimulation(options = {}) {
  return defaultMemorySimulator.enable(options);
}

/**
 * Convenience helper to disable memory simulation mode.
 *
 * @returns {object}
 */
export function disableMemorySimulation() {
  return defaultMemorySimulator.disable();
}

/**
 * Convenience helper to set simulated memory usage in MB.
 *
 * @param {number} mb
 * @returns {number|null}
 */
export function setSimulatedMemoryUsage(mb) {
  return defaultMemorySimulator.setSimulatedUsageMb(mb);
}

/**
 * Convenience helper to set simulated pressure level.
 *
 * @param {string} level - "normal", "warning", "critical"
 * @returns {object}
 */
export function setSimulatedPressureLevel(level) {
  return defaultMemorySimulator.setSimulatedPressureLevel(level);
}

/**
 * Convenience helper to set simulated per-tab memory.
 *
 * @param {number} tabId
 * @param {number} memoryMb
 */
export function setSimulatedTabMemory(tabId, memoryMb) {
  defaultMemorySimulator.setSimulatedTabMemory(tabId, memoryMb);
}

/**
 * Convenience helper to get simulation status.
 *
 * @returns {object}
 */
export function getMemorySimulationStatus() {
  return defaultMemorySimulator.getStatus();
}

/**
 * Convenience helper to trigger a simulated memory pressure spike.
 *
 * @param {string} [level="critical"]
 * @returns {object}
 */
export function simulateMemoryPressureSpike(level = "critical") {
  return defaultMemorySimulator.simulateMemoryPressureSpike(level);
}



