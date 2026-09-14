// TabVault — Intelligent Tab Suspension Scoring Engine
// Evaluates tab activity, idle duration, visit frequency, audio, forms, memory pressure, and domain rules to calculate suspension priority.

import { matchDomainPattern, globToRegex } from "./adapters/domain.js";

/**
 * Default weights applied to various scoring dimensions.
 */
export const DEFAULT_SCORE_WEIGHTS = Object.freeze({
  idleDurationWeight: 1.0,           // Points per minute idle
  maxIdleScore: 60.0,                // Maximum idle points
  visitFrequencyWeight: -1.5,        // Deduction per visit above 1
  maxVisitDeduction: 25.0,           // Maximum deduction for frequent visits
  tabGroupPriorityWeight: 1.0,       // Points per group priority unit
  domainPriorityWeight: 1.0,         // Points per domain priority unit
  memoryPressureMultiplier: 1.0,     // Scaling factor for high memory pressure
  restorationCostWeight: -2.0,       // Deduction per restoration cost unit
  maxRestorationCostDeduction: 15.0  // Maximum deduction for expensive restores
});

/**
 * Valid bounds for each configurable scoring weight.
 */
export const SCORE_WEIGHT_BOUNDS = Object.freeze({
  idleDurationWeight: Object.freeze({ min: 0.1, max: 10.0 }),
  maxIdleScore: Object.freeze({ min: 10.0, max: 200.0 }),
  visitFrequencyWeight: Object.freeze({ min: -10.0, max: 0.0 }),
  maxVisitDeduction: Object.freeze({ min: 0.0, max: 100.0 }),
  tabGroupPriorityWeight: Object.freeze({ min: 0.0, max: 10.0 }),
  domainPriorityWeight: Object.freeze({ min: 0.0, max: 10.0 }),
  memoryPressureMultiplier: Object.freeze({ min: 0.0, max: 5.0 }),
  restorationCostWeight: Object.freeze({ min: -10.0, max: 0.0 }),
  maxRestorationCostDeduction: Object.freeze({ min: 0.0, max: 50.0 })
});

/**
 * Named scoring presets for different user preferences and operating modes.
 */
export const SCORE_WEIGHT_PRESETS = Object.freeze({
  balanced: DEFAULT_SCORE_WEIGHTS,
  aggressive: Object.freeze({
    idleDurationWeight: 2.0,
    maxIdleScore: 80.0,
    visitFrequencyWeight: -0.5,
    maxVisitDeduction: 10.0,
    tabGroupPriorityWeight: 1.5,
    domainPriorityWeight: 1.5,
    memoryPressureMultiplier: 1.5,
    restorationCostWeight: -1.0,
    maxRestorationCostDeduction: 10.0
  }),
  conservative: Object.freeze({
    idleDurationWeight: 0.5,
    maxIdleScore: 40.0,
    visitFrequencyWeight: -2.5,
    maxVisitDeduction: 35.0,
    tabGroupPriorityWeight: 0.5,
    domainPriorityWeight: 0.5,
    memoryPressureMultiplier: 0.5,
    restorationCostWeight: -3.0,
    maxRestorationCostDeduction: 20.0
  }),
  low_memory: Object.freeze({
    idleDurationWeight: 2.5,
    maxIdleScore: 100.0,
    visitFrequencyWeight: -0.5,
    maxVisitDeduction: 10.0,
    tabGroupPriorityWeight: 1.0,
    domainPriorityWeight: 1.0,
    memoryPressureMultiplier: 2.5,
    restorationCostWeight: -0.5,
    maxRestorationCostDeduction: 5.0
  })
});

export const STORAGE_KEY_SCORE_WEIGHTS = "tabvault_scoring_weights";

let activeInMemoryWeights = { ...DEFAULT_SCORE_WEIGHTS };

/**
 * Validates, clamps, and fills defaults for scoring weights.
 *
 * @param {object} [raw={}]
 * @returns {object} Sanitized and clamped weights
 */
export function normalizeScoreWeights(raw = {}) {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_SCORE_WEIGHTS };
  }

  const result = {};
  for (const [key, defaultVal] of Object.entries(DEFAULT_SCORE_WEIGHTS)) {
    const val = typeof raw[key] === "number" && !Number.isNaN(raw[key]) ? raw[key] : defaultVal;
    const bounds = SCORE_WEIGHT_BOUNDS[key];
    if (bounds) {
      result[key] = Math.max(bounds.min, Math.min(bounds.max, val));
    } else {
      result[key] = val;
    }
  }

  return result;
}

/**
 * Retrieves the currently active scoring weights.
 *
 * @param {object} [storage]
 * @returns {object}
 */
export function getScoreWeights(storage = null) {
  if (storage && typeof storage.get === "function") {
    const stored = storage.get(STORAGE_KEY_SCORE_WEIGHTS);
    if (stored) return normalizeScoreWeights(stored);
  }
  return { ...activeInMemoryWeights };
}

/**
 * Updates the active scoring weights and optionally persists to storage.
 *
 * @param {object} newWeights
 * @param {object} [storage]
 * @returns {object} Normalized active weights
 */
export function setScoreWeights(newWeights, storage = null) {
  const normalized = normalizeScoreWeights(newWeights);
  activeInMemoryWeights = { ...normalized };
  if (storage && typeof storage.set === "function") {
    storage.set(STORAGE_KEY_SCORE_WEIGHTS, normalized);
  }
  return { ...activeInMemoryWeights };
}

/**
 * Resets scoring weights to factory defaults.
 *
 * @param {object} [storage]
 * @returns {object} Default weights
 */
export function resetScoreWeights(storage = null) {
  activeInMemoryWeights = { ...DEFAULT_SCORE_WEIGHTS };
  if (storage && typeof storage.set === "function") {
    storage.set(STORAGE_KEY_SCORE_WEIGHTS, { ...DEFAULT_SCORE_WEIGHTS });
  } else if (storage && typeof storage.remove === "function") {
    storage.remove(STORAGE_KEY_SCORE_WEIGHTS);
  }
  return { ...DEFAULT_SCORE_WEIGHTS };
}

/**
 * Returns available scoring weight presets.
 *
 * @returns {object}
 */
export function getScoreWeightPresets() {
  return { ...SCORE_WEIGHT_PRESETS };
}

/**
 * Applies a named scoring preset.
 *
 * @param {string} presetName
 * @param {object} [storage]
 * @returns {object} Active weights after applying preset
 */
export function applyScoreWeightPreset(presetName, storage = null) {
  if (!presetName || !SCORE_WEIGHT_PRESETS[presetName]) {
    throw new Error(`Unknown score weight preset: '${presetName}'`);
  }
  return setScoreWeights(SCORE_WEIGHT_PRESETS[presetName], storage);
}

/**
 * Known internal and unsupported URL schemes that must never be suspended.
 */
export const UNSUPPORTED_URL_SCHEMES = Object.freeze([
  "chrome:",
  "edge:",
  "about:",
  "devtools:",
  "chrome-extension:",
  "chrome-untrusted:",
  "view-source:",
  "file:"
]);

/**
 * Standard reasons why a tab is protected from suspension.
 */
export const TabProtectionReason = Object.freeze({
  ACTIVE: "active_tab",
  PINNED: "pinned",
  AUDIBLE: "audible",
  FORM_INPUT: "form_input",
  INTERNAL_URL: "internal_url",
  ALREADY_SUSPENDED: "already_suspended",
  WHITELISTED: "whitelisted",
  GROUP_PROTECTED: "group_protected",
  NEVER_SUSPEND_DOMAIN: "never_suspend_domain",
  MANUAL_PIN: "manual_pin"
});

/**
 * Tab suspension priority levels.
 */
export const TabSuspensionPriority = Object.freeze({
  IMMUNE: "IMMUNE",
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  URGENT: "URGENT"
});

/**
 * Default score cutoffs for each priority level.
 */
export const DEFAULT_PRIORITY_THRESHOLDS = Object.freeze({
  urgent: 60.0,
  high: 40.0,
  medium: 20.0,
  low: 0.0
});

/**
 * Resolves the priority level from a score and eligibility flag.
 *
 * @param {number} score
 * @param {boolean} isEligible
 * @param {object} [thresholds=DEFAULT_PRIORITY_THRESHOLDS]
 * @returns {string} One of TabSuspensionPriority values
 */
export function determinePriorityLevel(score, isEligible, thresholds = DEFAULT_PRIORITY_THRESHOLDS) {
  if (!isEligible || score <= 0) {
    return TabSuspensionPriority.IMMUNE;
  }
  const t = { ...DEFAULT_PRIORITY_THRESHOLDS, ...(thresholds || {}) };
  if (score >= t.urgent) return TabSuspensionPriority.URGENT;
  if (score >= t.high) return TabSuspensionPriority.HIGH;
  if (score >= t.medium) return TabSuspensionPriority.MEDIUM;
  return TabSuspensionPriority.LOW;
}

/**
 * Human-readable display label for priority level.
 *
 * @param {string} priorityLevel
 * @returns {string}
 */
export function getPriorityLevelLabel(priorityLevel) {
  switch (priorityLevel) {
    case TabSuspensionPriority.URGENT: return "Urgent";
    case TabSuspensionPriority.HIGH: return "High";
    case TabSuspensionPriority.MEDIUM: return "Medium";
    case TabSuspensionPriority.LOW: return "Low";
    case TabSuspensionPriority.IMMUNE: return "Immune";
    default: return String(priorityLevel);
  }
}

/**
 * Visual badge/color indicator for priority level.
 *
 * @param {string} priorityLevel
 * @returns {string} Hex color string
 */
export function getPriorityLevelColor(priorityLevel) {
  switch (priorityLevel) {
    case TabSuspensionPriority.URGENT: return "#ef4444";
    case TabSuspensionPriority.HIGH: return "#f97316";
    case TabSuspensionPriority.MEDIUM: return "#f59e0b";
    case TabSuspensionPriority.LOW: return "#3b82f6";
    case TabSuspensionPriority.IMMUNE: return "#10b981";
    default: return "#6b7280";
  }
}

/**
 * Filters a list of scored tabs by one or more priority levels.
 *
 * @param {Array<object>} scoredTabs
 * @param {Array<string>} [priorityLevels]
 * @returns {Array<object>}
 */
export function filterTabsByPriority(scoredTabs = [], priorityLevels = []) {
  if (!Array.isArray(scoredTabs)) return [];
  if (!Array.isArray(priorityLevels) || priorityLevels.length === 0) return [...scoredTabs];
  const set = new Set(priorityLevels.map(p => String(p).toUpperCase()));
  return scoredTabs.filter(tab => set.has(tab.priorityLevel));
}

/**
 * Checks if a tab's URL is an internal or non-suspendable browser URL.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isInternalOrUnsupportedUrl(url) {
  if (!url || typeof url !== "string") return true;
  const clean = url.trim().toLowerCase();
  if (clean.includes("suspended/suspended.html")) return true;
  return UNSUPPORTED_URL_SCHEMES.some(scheme => clean.startsWith(scheme));
}

/**
 * Determines whether a tab is immune/protected from suspension.
 *
 * @param {object} tab - Chrome tab object
 * @param {object} [metadata={}] - Tab metadata ledger record
 * @param {object} [options={}] - Protection rule options
 * @returns {{ isProtected: boolean, reason: string|null }}
 */
export function evaluateTabProtection(tab = {}, metadata = {}, options = {}) {
  const safeTab = tab || {};
  const safeMeta = metadata || {};
  const safeOpts = options || {};
  const neverSuspend = safeOpts.neverSuspend || {};
  const url = safeTab.url || safeMeta.url || "";

  // 1. Internal or extension pages
  if (isInternalOrUnsupportedUrl(url)) {
    return { isProtected: true, reason: TabProtectionReason.INTERNAL_URL };
  }

  // 2. Already suspended or discarded
  if (safeTab.discarded || safeMeta.lifecycleState === "DISCARDED") {
    return { isProtected: true, reason: TabProtectionReason.ALREADY_SUSPENDED };
  }

  // 3. Active tab in current or any window
  if (safeTab.active) {
    return { isProtected: true, reason: TabProtectionReason.ACTIVE };
  }
  if (neverSuspend.activeInAnyWindow && safeTab.activeInWindow) {
    return { isProtected: true, reason: TabProtectionReason.ACTIVE };
  }

  // 3.5. Manually protected tab
  if (
    safeTab.isManuallyProtected ||
    safeTab.manualProtected ||
    safeMeta.isManuallyProtected ||
    safeMeta.manualProtected ||
    (options.protectedTabIds && (options.protectedTabIds.has?.(safeTab.id) || (Array.isArray(options.protectedTabIds) && options.protectedTabIds.includes(safeTab.id))))
  ) {
    return { isProtected: true, reason: TabProtectionReason.MANUAL_PIN };
  }

  // 4. Pinned tab
  if (safeTab.pinned && neverSuspend.pinned !== false) {
    return { isProtected: true, reason: TabProtectionReason.PINNED };
  }

  // 5. Playing audio
  if ((safeTab.audible || safeMeta.audible) && neverSuspend.audible !== false) {
    return { isProtected: true, reason: TabProtectionReason.AUDIBLE };
  }

  // 6. Active form inputs
  if ((safeTab.hasFormInput || safeMeta.hasFormInput) && neverSuspend.hasFormInput !== false) {
    return { isProtected: true, reason: TabProtectionReason.FORM_INPUT };
  }

  // 7. Whitelisted domain or URL pattern
  if (Array.isArray(options.whitelist) && options.whitelist.length > 0) {
    const isWhitelisted = options.whitelist.some(entry => {
      if (typeof entry === "string") {
        return url.toLowerCase().includes(entry.toLowerCase());
      }
      if (entry && typeof entry.value === "string") {
        return url.toLowerCase().includes(entry.value.toLowerCase());
      }
      return false;
    });
    if (isWhitelisted) {
      return { isProtected: true, reason: TabProtectionReason.WHITELISTED };
    }
  }

  // 8. Tab group protection
  if (tab.groupId && tab.groupId > 0 && neverSuspend.inTabGroup === true) {
    return { isProtected: true, reason: TabProtectionReason.GROUP_PROTECTED };
  }

  // 9. Custom protected tab rules
  if (options.ruleManager && typeof options.ruleManager.evaluate === "function") {
    const ruleEval = options.ruleManager.evaluate(tab, metadata, options.context || {});
    if (ruleEval.isProtected) {
      return { isProtected: true, reason: ruleEval.reason, rule: ruleEval.matchedRule };
    }
  } else if (Array.isArray(options.rules) && options.rules.length > 0) {
    const manager = new ProtectedTabRuleManager(options.rules);
    const ruleEval = manager.evaluate(tab, metadata, options.context || {});
    if (ruleEval.isProtected) {
      return { isProtected: true, reason: ruleEval.reason, rule: ruleEval.matchedRule };
    }
  }

  return { isProtected: false, reason: null };
}

/**
 * Manager for user-defined and dynamic protected-tab rules.
 */
export class ProtectedTabRuleManager {
  constructor(initialRules = []) {
    this.rules = new Map();
    if (Array.isArray(initialRules)) {
      initialRules.forEach(r => this.addRule(r));
    }
  }

  /**
   * Adds or updates a protected tab rule.
   *
   * @param {object} rule
   * @returns {string|null} Rule ID
   */
  addRule(rule) {
    if (!rule || typeof rule !== "object") return null;
    const id = String(rule.id || `rule_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const normalized = {
      id,
      name: rule.name || id,
      enabled: rule.enabled !== false,
      priority: typeof rule.priority === "number" ? rule.priority : 100,
      domain: rule.domain || null,
      urlPattern: rule.urlPattern || null,
      titlePattern: rule.titlePattern || null,
      groupName: rule.groupName || null,
      groupId: rule.groupId ?? null,
      streaming: Boolean(rule.streaming),
      customPredicate: typeof rule.customPredicate === "function" ? rule.customPredicate : null,
      reason: rule.reason || `protected_by_rule:${id}`
    };
    this.rules.set(id, normalized);
    return id;
  }

  /**
   * Removes a rule by ID.
   *
   * @param {string} id
   * @returns {boolean}
   */
  removeRule(id) {
    return this.rules.delete(id);
  }

  /**
   * Gets a rule by ID.
   *
   * @param {string} id
   * @returns {object|null}
   */
  getRule(id) {
    return this.rules.get(id) || null;
  }

  /**
   * Returns all rules sorted by priority descending.
   *
   * @returns {Array<object>}
   */
  getAllRules() {
    return Array.from(this.rules.values()).sort((a, b) => b.priority - a.priority);
  }

  /**
   * Enables or disables a rule.
   *
   * @param {string} id
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setRuleEnabled(id, enabled) {
    const rule = this.rules.get(id);
    if (!rule) return false;
    rule.enabled = Boolean(enabled);
    return true;
  }

  /**
   * Clears all registered rules.
   */
  clear() {
    this.rules.clear();
  }

  /**
   * Evaluates a tab against all active protection rules.
   *
   * @param {object} tab
   * @param {object} [metadata={}]
   * @param {object} [context={}]
   * @returns {{ isProtected: boolean, matchedRule: object|null, reason: string|null }}
   */
  evaluate(tab = {}, metadata = {}, context = {}) {
    const enabledRules = this.getAllRules().filter(r => r.enabled);
    const url = tab.url || metadata.url || "";
    const title = tab.title || metadata.title || "";

    for (const rule of enabledRules) {
      let matched = false;

      // 1. Custom predicate
      if (rule.customPredicate) {
        try {
          if (rule.customPredicate(tab, metadata, context)) {
            matched = true;
          }
        } catch (_) {}
      }

      // 2. Domain pattern
      if (!matched && rule.domain) {
        if (matchDomainPattern(url, rule.domain)) {
          matched = true;
        }
      }

      // 3. URL pattern (glob or regex)
      if (!matched && rule.urlPattern) {
        if (rule.urlPattern instanceof RegExp) {
          matched = rule.urlPattern.test(url);
        } else if (typeof rule.urlPattern === "string") {
          matched = globToRegex(rule.urlPattern).test(url);
        }
      }

      // 4. Title pattern
      if (!matched && rule.titlePattern && title) {
        if (rule.titlePattern instanceof RegExp) {
          matched = rule.titlePattern.test(title);
        } else if (typeof rule.titlePattern === "string") {
          matched = title.toLowerCase().includes(rule.titlePattern.toLowerCase());
        }
      }

      // 5. Tab group name or ID
      if (!matched && (rule.groupName || rule.groupId !== null)) {
        if (rule.groupId !== null && tab.groupId !== undefined && tab.groupId === rule.groupId) {
          matched = true;
        } else if (rule.groupName && context.tabGroupNames && tab.groupId !== undefined) {
          const name = context.tabGroupNames[tab.groupId];
          if (name && name.toLowerCase() === rule.groupName.toLowerCase()) {
            matched = true;
          }
        }
      }

      // 6. Media / camera / microphone streaming
      if (!matched && rule.streaming) {
        const isStreaming = Boolean(tab.audible || metadata.audible || tab.streaming || metadata.streaming);
        const isActiveMedia = context.activeMediaTabId !== undefined && tab.id !== undefined && context.activeMediaTabId === tab.id;
        if (isStreaming || isActiveMedia) {
          matched = true;
        }
      }

      if (matched) {
        return {
          isProtected: true,
          matchedRule: rule,
          reason: rule.reason
        };
      }
    }

    return {
      isProtected: false,
      matchedRule: null,
      reason: null
    };
  }
}

/**
 * Generates a human-readable explanation of why a tab was selected for suspension or protected.
 * Combines scoring factors, trigger events, and verified safety guards into a structured narrative.
 *
 * @param {object} scoredTab - Tab scoring details or tab state
 * @param {object} [triggerContext={}] - Context containing trigger/reason, memory pressure, etc.
 * @returns {object} Structured explanation
 */
export function generateSuspensionExplanation(scoredTab = {}, triggerContext = {}) {
  const trigger = triggerContext.trigger || triggerContext.reason || "idle_timeout";
  const factors = scoredTab.factors || {};
  const score = typeof scoredTab.score === "number" ? scoredTab.score : 0;
  const isProtected = scoredTab.isEligible === false || scoredTab.protectionReason != null;
  const priorityLevel = scoredTab.priorityLevel || determinePriorityLevel(score, !isProtected);
  const priorityLabel = scoredTab.priorityLabel || getPriorityLevelLabel(priorityLevel);

  if (isProtected) {
    const reason = scoredTab.protectionReason || "Protected tab rule";
    return {
      headline: `Tab is protected from suspension (${reason}).`,
      shortSummary: `Protected: ${reason}`,
      primaryReason: "protected",
      priorityLevel: TabSuspensionPriority.IMMUNE,
      priorityLabel: getPriorityLevelLabel(TabSuspensionPriority.IMMUNE),
      score: 0,
      contributingFactors: [`Protected by condition/rule: ${reason}`],
      safeguardsVerified: [reason],
      fullNarrative: `This tab was not suspended because it is currently protected (${reason}).`,
      timestamp: triggerContext.timestamp || triggerContext.now || Date.now()
    };
  }

  const contributingFactors = [];
  let primaryReason = "idle_duration";

  // Determine primary driver
  const triggerLower = String(trigger).toLowerCase();
  if (triggerLower.includes("manual")) {
    primaryReason = "manual_action";
  } else if (triggerLower.includes("memory") || (factors.memoryModifier && factors.memoryModifier > 15)) {
    primaryReason = "memory_pressure";
  } else if (triggerLower.includes("lru") || triggerLower.includes("limit") || triggerLower.includes("max_tabs")) {
    primaryReason = "lru_quota";
  } else if (triggerLower.includes("battery")) {
    primaryReason = "battery_saver";
  } else if (triggerLower.includes("snooze")) {
    primaryReason = "scheduled_snooze";
  } else {
    primaryReason = "idle_duration";
  }

  // Factor 1: Idle duration
  const idleMins = factors.idleMinutes ?? 0;
  if (idleMins > 0) {
    const idleScore = factors.idleScore ?? idleMins;
    contributingFactors.push(`Inactive for ${idleMins} ${idleMins === 1 ? "minute" : "minutes"} (+${Number(idleScore).toFixed(1)} pts)`);
  } else {
    contributingFactors.push("Tab recently placed in background");
  }

  // Factor 2: Memory pressure
  if (factors.memoryModifier && factors.memoryModifier > 0) {
    contributingFactors.push(`Elevated system memory pressure (+${Number(factors.memoryModifier).toFixed(1)} pts)`);
  }

  // Factor 3: Visit frequency
  if (factors.visitDeduction && factors.visitDeduction > 0) {
    contributingFactors.push(`Frequent user visit history deduction (-${Number(factors.visitDeduction).toFixed(1)} pts)`);
  }

  // Factor 4: Group priority
  if (factors.groupScore && factors.groupScore !== 0) {
    const sign = factors.groupScore > 0 ? "+" : "";
    contributingFactors.push(`Tab group priority adjustment (${sign}${Number(factors.groupScore).toFixed(1)} pts)`);
  }

  // Factor 5: Domain priority
  if (factors.domainScore && factors.domainScore !== 0) {
    const sign = factors.domainScore > 0 ? "+" : "";
    contributingFactors.push(`Domain priority adjustment (${sign}${Number(factors.domainScore).toFixed(1)} pts)`);
  }

  // Factor 6: Restoration cost
  if (factors.restorationCostDeduction && factors.restorationCostDeduction > 0) {
    contributingFactors.push(`Heavy restoration complexity safeguard (-${Number(factors.restorationCostDeduction).toFixed(1)} pts)`);
  }

  const safeguardsVerified = [
    "Not currently focused or active",
    "Tab is not pinned",
    "No active audio or media playback detected",
    "No unsaved form inputs present",
    "Not matching any user-defined protected domain or pattern rules"
  ];

  let headline = "";
  if (primaryReason === "memory_pressure") {
    headline = `Suspended to relieve memory pressure (idle for ${idleMins}m, score: ${score.toFixed(1)} — ${priorityLabel}).`;
  } else if (primaryReason === "lru_quota") {
    headline = `Suspended by tab limit policy (least recently used, idle for ${idleMins}m, score: ${score.toFixed(1)}).`;
  } else if (primaryReason === "manual_action") {
    headline = "Suspended manually by user request.";
  } else if (primaryReason === "battery_saver") {
    headline = `Suspended by battery saver policy (idle for ${idleMins}m).`;
  } else if (primaryReason === "scheduled_snooze") {
    headline = "Suspended on schedule via snooze action.";
  } else {
    headline = `Suspended after ${idleMins} ${idleMins === 1 ? "minute" : "minutes"} of inactivity (${priorityLabel}, score: ${score.toFixed(1)}).`;
  }

  const shortSummary = headline;
  const factorsNarrative = contributingFactors.length > 0
    ? `Contributing factors: ${contributingFactors.join("; ")}.`
    : "No adverse scoring factors recorded.";
  const fullNarrative = `${headline} ${factorsNarrative} All safety guards passed (no audio, no unsaved form data, not pinned).`;

  return {
    headline,
    shortSummary,
    primaryReason,
    priorityLevel,
    priorityLabel,
    score,
    contributingFactors,
    safeguardsVerified,
    fullNarrative,
    timestamp: triggerContext.timestamp || triggerContext.now || Date.now()
  };
}

/**
 * Calculates a numerical suspension score for a tab.
 * Higher score = higher priority to suspend.
 *
 * @param {object} tab - Chrome tab object
 * @param {object} [metadata={}] - Tab metadata ledger record
 * @param {object} [context={}] - Contextual environment (now, memoryPressure, groupPriorities, domainPriorities)
 * @param {object} [weights=DEFAULT_SCORE_WEIGHTS] - Custom weight overrides
 * @param {object} [options={}] - Options (neverSuspend, whitelist)
 * @returns {object} Calculated score details
 */
export function calculateTabSuspensionScore(
  tab = {},
  metadata = {},
  context = {},
  weights = DEFAULT_SCORE_WEIGHTS,
  options = {}
) {
  const safeTab = tab || {};
  const safeMeta = metadata || {};
  const safeContext = context || {};
  const safeOpts = options || {};

  const tabId = safeTab.id ?? safeMeta.tabId ?? 0;
  const protection = evaluateTabProtection(safeTab, safeMeta, safeOpts);

  if (protection.isProtected) {
    const priorityLevel = TabSuspensionPriority.IMMUNE;
    const priorityLabel = getPriorityLevelLabel(priorityLevel);
    const explanation = generateSuspensionExplanation({
      tabId,
      score: 0,
      isEligible: false,
      priorityLevel,
      priorityLabel,
      protectionReason: protection.reason
    }, safeContext);

    return {
      tabId,
      score: 0,
      isEligible: false,
      dryRun: Boolean(safeOpts.dryRun),
      priorityLevel,
      priorityLabel,
      priorityColor: getPriorityLevelColor(priorityLevel),
      protectionReason: protection.reason,
      explanation,
      factors: {
        idleMinutes: 0,
        idleScore: 0,
        visitDeduction: 0,
        groupScore: 0,
        domainScore: 0,
        memoryModifier: 0,
        restorationCostDeduction: 0
      },
      breakdown: [`Protected from suspension: ${protection.reason}`]
    };
  }

  const activeWeights = { ...DEFAULT_SCORE_WEIGHTS, ...(weights || {}) };
  const now = safeContext.now || Date.now();
  const lastActive = safeMeta.lastActiveAt || safeTab.lastActiveAt || now;
  const idleMs = Math.max(0, now - lastActive);
  const idleMinutes = Math.floor(idleMs / 60000);

  const breakdown = [];

  // 1. Idle score
  const baseIdleScore = Math.min(
    idleMinutes * activeWeights.idleDurationWeight,
    activeWeights.maxIdleScore
  );
  breakdown.push(`Idle ${idleMinutes}m: +${baseIdleScore.toFixed(1)} pts`);

  // 2. Memory pressure boost
  let memoryModifier = 0;
  if (safeContext.memoryPressure) {
    const pressureMultiplier = typeof safeContext.memoryPressure === "number"
      ? safeContext.memoryPressure
      : (safeContext.memoryPressure === "critical" ? 1.0 : (safeContext.memoryPressure === "high" ? 0.5 : 0));

    if (pressureMultiplier > 0) {
      memoryModifier = baseIdleScore * pressureMultiplier * activeWeights.memoryPressureMultiplier;
      breakdown.push(`Memory pressure (${safeContext.memoryPressure}): +${memoryModifier.toFixed(1)} pts`);
    }
  }
  const totalIdleScore = baseIdleScore + memoryModifier;

  // 3. Visit frequency deduction (frequent tabs remain active longer)
  const visitCount = safeMeta.visitCount ?? safeTab.visitCount ?? 1;
  let visitDeduction = 0;
  if (visitCount > 1) {
    visitDeduction = Math.min(
      Math.abs((visitCount - 1) * activeWeights.visitFrequencyWeight),
      activeWeights.maxVisitDeduction
    );
    breakdown.push(`Visit frequency (${visitCount} visits): -${visitDeduction.toFixed(1)} pts`);
  }

  // 4. Tab group priority
  let groupScore = 0;
  const groupId = safeTab.groupId ?? safeMeta.groupId ?? null;
  if (groupId !== null && safeContext.groupPriorities && typeof safeContext.groupPriorities[groupId] === "number") {
    const groupPriority = safeContext.groupPriorities[groupId];
    groupScore = groupPriority * activeWeights.tabGroupPriorityWeight;
    const sign = groupScore >= 0 ? "+" : "";
    breakdown.push(`Group priority (${groupPriority}): ${sign}${groupScore.toFixed(1)} pts`);
  }

  // 5. Domain priority
  let domainScore = 0;
  const url = safeTab.url || safeMeta.url || "";
  if (url && safeContext.domainPriorities && typeof safeContext.domainPriorities === "object") {
    for (const [domain, priority] of Object.entries(safeContext.domainPriorities)) {
      if (url.toLowerCase().includes(domain.toLowerCase()) && typeof priority === "number") {
        domainScore = priority * activeWeights.domainPriorityWeight;
        const sign = domainScore >= 0 ? "+" : "";
        breakdown.push(`Domain priority '${domain}' (${priority}): ${sign}${domainScore.toFixed(1)} pts`);
        break;
      }
    }
  }

  // 6. Restoration cost deduction
  let restorationCostDeduction = 0;
  const restorationCost = safeContext.restorationCost ?? safeMeta.restorationCost ?? 0;
  if (restorationCost > 0) {
    restorationCostDeduction = Math.min(
      Math.abs(restorationCost * activeWeights.restorationCostWeight),
      activeWeights.maxRestorationCostDeduction
    );
    breakdown.push(`Restoration cost (${restorationCost}): -${restorationCostDeduction.toFixed(1)} pts`);
  }

  // Calculate final score clamped at 0
  const rawScore = totalIdleScore - visitDeduction + groupScore + domainScore - restorationCostDeduction;
  const finalScore = Math.max(0, Math.round(rawScore * 10) / 10);
  const priorityLevel = determinePriorityLevel(finalScore, true, safeOpts.priorityThresholds);
  const priorityLabel = getPriorityLevelLabel(priorityLevel);
  const priorityColor = getPriorityLevelColor(priorityLevel);
  const factors = {
    idleMinutes,
    idleScore: Math.round(baseIdleScore * 10) / 10,
    memoryModifier: Math.round(memoryModifier * 10) / 10,
    visitDeduction: Math.round(visitDeduction * 10) / 10,
    groupScore: Math.round(groupScore * 10) / 10,
    domainScore: Math.round(domainScore * 10) / 10,
    restorationCostDeduction: Math.round(restorationCostDeduction * 10) / 10
  };

  const explanation = generateSuspensionExplanation({
    tabId,
    score: finalScore,
    isEligible: true,
    priorityLevel,
    priorityLabel,
    factors,
    breakdown
  }, context);

  return {
    tabId,
    score: finalScore,
    isEligible: true,
    dryRun: Boolean(options.dryRun),
    priorityLevel,
    priorityLabel,
    priorityColor,
    protectionReason: null,
    explanation,
    factors,
    breakdown
  };
}

/**
 * Scores multiple tabs and returns them sorted by suspension score descending.
 * Eligible candidates appear first with highest scores; protected tabs appear at the end with score 0.
 *
 * @param {Array<object>} tabs - List of Chrome tab objects
 * @param {Map<number, object>|object} [metadataMap] - Tab metadata mapping
 * @param {object} [context={}] - Evaluation context
 * @param {object} [weights=DEFAULT_SCORE_WEIGHTS] - Custom score weights
 * @param {object} [options={}] - Protection options
 * @returns {Array<object>} Ranked scoring list
 */
export function scoreTabs(
  tabs = [],
  metadataMap = new Map(),
  context = {},
  weights = DEFAULT_SCORE_WEIGHTS,
  options = {}
) {
  if (!Array.isArray(tabs)) return [];

  const getMeta = (tabId) => {
    if (!metadataMap) return {};
    if (metadataMap instanceof Map) return metadataMap.get(tabId) || {};
    return metadataMap[tabId] || {};
  };

  return tabs
    .map(tab => {
      const meta = getMeta(tab.id);
      return calculateTabSuspensionScore(tab, meta, context, weights, options);
    })
    .sort((a, b) => {
      // Eligible tabs come before protected tabs
      if (a.isEligible && !b.isEligible) return -1;
      if (!a.isEligible && b.isEligible) return 1;
      // Highest score first
      return b.score - a.score;
    });
}

/**
 * Executes a simulated dry-run suspension evaluation across a list of tabs.
 * Does not suspend tabs, alter lifecycle state, or discard processes.
 * Identifies eligible tabs, applies quotas/targets/filters, and projects memory savings.
 *
 * @param {Array<object>} tabs - List of Chrome tab objects
 * @param {Map<number, object>|object} [metadataMap] - Tab metadata mapping
 * @param {object} [context={}] - Evaluation context (memoryPressure, groupPriorities, etc.)
 * @param {object} [weights=DEFAULT_SCORE_WEIGHTS] - Custom scoring weights
 * @param {object} [options={}] - Dry-run options
 * @param {number} [options.minScore=0.1] - Minimum score required for suspension candidate
 * @param {number} [options.maxTabsToSuspend=Infinity] - Max tabs to project for suspension
 * @param {number} [options.targetMemoryMb=Infinity] - Target memory savings in MB
 * @param {number} [options.defaultTabMemoryMb=80] - Assumed MB per tab if unspecified
 * @param {Array<string>} [options.priorityFilter] - If provided, only include these priority levels
 * @param {number} [options.timestamp] - Evaluation timestamp
 * @returns {object} Dry-run simulation report
 */
export function dryRunSuspensionEvaluation(
  tabs = [],
  metadataMap = new Map(),
  context = {},
  weights = DEFAULT_SCORE_WEIGHTS,
  options = {}
) {
  const safeOptions = {
    minScore: 0.1,
    maxTabsToSuspend: Infinity,
    targetMemoryMb: Infinity,
    defaultTabMemoryMb: 80,
    ...options,
    dryRun: true
  };

  const getMeta = (tabId) => {
    if (!metadataMap) return {};
    if (metadataMap instanceof Map) return metadataMap.get(tabId) || {};
    return metadataMap[tabId] || {};
  };

  const tabById = new Map();
  if (Array.isArray(tabs)) {
    for (const tab of tabs) {
      if (tab && tab.id !== undefined) {
        tabById.set(tab.id, tab);
      }
    }
  }

  const scoredTabs = scoreTabs(tabs, metadataMap, context, weights, safeOptions);

  let eligibleCandidatesCount = 0;
  let protectedTabsCount = 0;
  const projectedSuspensions = [];
  const exemptTabs = [];
  let currentSavingsMb = 0;

  for (const scored of scoredTabs) {
    const originalTab = tabById.get(scored.tabId) || {};
    const meta = getMeta(scored.tabId);
    const tabTitle = originalTab.title || meta.title || "Untitled";
    const tabUrl = originalTab.url || meta.url || "";
    const tabEstimatedMemoryMb = originalTab.estimatedMemoryMb ??
      meta.estimatedMemoryMb ??
      safeOptions.defaultTabMemoryMb;

    if (!scored.isEligible) {
      protectedTabsCount++;
      exemptTabs.push({
        tabId: scored.tabId,
        title: tabTitle,
        url: tabUrl,
        score: 0,
        priorityLevel: scored.priorityLevel,
        reason: scored.protectionReason || "protected"
      });
      continue;
    }

    eligibleCandidatesCount++;

    // Check minScore cutoff
    if (scored.score < safeOptions.minScore) {
      exemptTabs.push({
        tabId: scored.tabId,
        title: tabTitle,
        url: tabUrl,
        score: scored.score,
        priorityLevel: scored.priorityLevel,
        reason: "score_below_cutoff"
      });
      continue;
    }

    // Check priorityFilter
    if (Array.isArray(safeOptions.priorityFilter) && safeOptions.priorityFilter.length > 0) {
      if (!safeOptions.priorityFilter.includes(scored.priorityLevel)) {
        exemptTabs.push({
          tabId: scored.tabId,
          title: tabTitle,
          url: tabUrl,
          score: scored.score,
          priorityLevel: scored.priorityLevel,
          reason: "priority_not_matched"
        });
        continue;
      }
    }

    // Check maxTabsToSuspend
    if (projectedSuspensions.length >= safeOptions.maxTabsToSuspend) {
      exemptTabs.push({
        tabId: scored.tabId,
        title: tabTitle,
        url: tabUrl,
        score: scored.score,
        priorityLevel: scored.priorityLevel,
        reason: "quota_limit_reached"
      });
      continue;
    }

    // Check targetMemoryMb
    if (safeOptions.targetMemoryMb !== Infinity && currentSavingsMb >= safeOptions.targetMemoryMb) {
      exemptTabs.push({
        tabId: scored.tabId,
        title: tabTitle,
        url: tabUrl,
        score: scored.score,
        priorityLevel: scored.priorityLevel,
        reason: "target_memory_met"
      });
      continue;
    }

    currentSavingsMb += tabEstimatedMemoryMb;
    projectedSuspensions.push({
      tabId: scored.tabId,
      title: tabTitle,
      url: tabUrl,
      score: scored.score,
      priorityLevel: scored.priorityLevel,
      priorityLabel: scored.priorityLabel,
      priorityColor: scored.priorityColor,
      estimatedMemoryMb: tabEstimatedMemoryMb,
      explanation: scored.explanation,
      factors: scored.factors,
      breakdown: scored.breakdown
    });
  }

  const timestamp = safeOptions.timestamp || context.timestamp || Date.now();
  const roundedSavingsMb = Math.round(currentSavingsMb * 10) / 10;
  const totalTabs = Array.isArray(tabs) ? tabs.length : 0;

  const summary = `Dry run completed: ${projectedSuspensions.length} of ${totalTabs} tabs projected for suspension. Estimated memory savings: ${roundedSavingsMb} MB.`;

  return {
    dryRun: true,
    timestamp,
    totalTabsEvaluated: totalTabs,
    eligibleCandidatesCount,
    protectedTabsCount,
    projectedSuspensionsCount: projectedSuspensions.length,
    projectedMemorySavingsMb: roundedSavingsMb,
    projectedSuspensions,
    exemptTabs,
    summary
  };
}

