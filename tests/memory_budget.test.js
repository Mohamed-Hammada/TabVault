import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MEMORY_BUDGET_CONFIG,
  MEMORY_BUDGET_BOUNDS,
  normalizeMemoryBudgetConfig,
  getMemoryBudgetConfig,
  setMemoryBudgetConfig,
  resetMemoryBudgetConfig,
  isMemoryBudgetEnabled,
  setMemoryBudgetEnabled,
  getMemoryBudgetMb,
  setMemoryBudgetMb,
  MemoryPressureLevel,
  getDefaultTabMemoryMb,
  setDefaultTabMemoryMb,
  getWarningThresholdRatio,
  setWarningThresholdRatio,
  getWarningThresholdMb,
  setWarningThresholdMb,
  isWarningThresholdExceeded,
  getWarningThresholdStatus,
  addMemoryWarningListener,
  removeMemoryWarningListener,
  clearMemoryWarningListeners,
  notifyMemoryWarningListeners,
  getCriticalThresholdRatio,
  setCriticalThresholdRatio,
  getCriticalThresholdMb,
  setCriticalThresholdMb,
  isCriticalThresholdExceeded,
  getCriticalThresholdStatus,
  getMemoryPressureState,
  addMemoryCriticalListener,
  removeMemoryCriticalListener,
  clearMemoryCriticalListeners,
  notifyMemoryCriticalListeners,
  estimateTabMemoryMb,
  estimateTotalMemoryUsageMb,
  selectMemoryPressureSuspensionCandidates,
  evaluateAndTriggerMemorySuspension,
  MemoryPressureLogger,
  logMemoryPressureEvent,
  getMemoryPressureLogs,
  getMemoryPressureLogStats,
  clearMemoryPressureLogs,
  MemorySimulator,
  defaultMemorySimulator,
  isMemorySimulationEnabled,
  enableMemorySimulation,
  disableMemorySimulation,
  setSimulatedMemoryUsage,
  setSimulatedPressureLevel,
  setSimulatedTabMemory,
  getMemorySimulationStatus,
  simulateMemoryPressureSpike
} from "../lib/memory-budget.js";

test("DEFAULT_MEMORY_BUDGET_CONFIG defines sane defaults and bounds", () => {
  assert.equal(DEFAULT_MEMORY_BUDGET_CONFIG.enabled, true);
  assert.equal(DEFAULT_MEMORY_BUDGET_CONFIG.budgetMb, 2048);
  assert.equal(DEFAULT_MEMORY_BUDGET_CONFIG.warningThresholdRatio, 0.75);
  assert.equal(DEFAULT_MEMORY_BUDGET_CONFIG.criticalThresholdRatio, 0.90);
  assert.equal(DEFAULT_MEMORY_BUDGET_CONFIG.defaultTabMemoryMb, 80);

  assert.equal(MEMORY_BUDGET_BOUNDS.MIN_BUDGET_MB, 256);
  assert.equal(MEMORY_BUDGET_BOUNDS.MAX_BUDGET_MB, 65536);
});

test("normalizeMemoryBudgetConfig clamps and validates bounds correctly", () => {
  const clampedLow = normalizeMemoryBudgetConfig({ budgetMb: 50, defaultTabMemoryMb: 2 });
  assert.equal(clampedLow.budgetMb, MEMORY_BUDGET_BOUNDS.MIN_BUDGET_MB);
  assert.equal(clampedLow.defaultTabMemoryMb, MEMORY_BUDGET_BOUNDS.MIN_TAB_MEMORY_MB);

  const clampedHigh = normalizeMemoryBudgetConfig({ budgetMb: 100000, defaultTabMemoryMb: 10000 });
  assert.equal(clampedHigh.budgetMb, MEMORY_BUDGET_BOUNDS.MAX_BUDGET_MB);
  assert.equal(clampedHigh.defaultTabMemoryMb, MEMORY_BUDGET_BOUNDS.MAX_TAB_MEMORY_MB);

  // Warning ratio must be strictly lower than critical ratio
  const inverted = normalizeMemoryBudgetConfig({ warningThresholdRatio: 0.95, criticalThresholdRatio: 0.80 });
  assert.ok(inverted.warningThresholdRatio < inverted.criticalThresholdRatio);
});

test("getMemoryBudgetConfig, setMemoryBudgetConfig, and resetMemoryBudgetConfig", () => {
  resetMemoryBudgetConfig();
  assert.equal(getMemoryBudgetMb(), 2048);
  assert.equal(isMemoryBudgetEnabled(), true);

  setMemoryBudgetConfig({ budgetMb: 4096, defaultTabMemoryMb: 120, enabled: false });
  assert.equal(getMemoryBudgetMb(), 4096);
  assert.equal(getDefaultTabMemoryMb(), 120);
  assert.equal(isMemoryBudgetEnabled(), false);

  setMemoryBudgetEnabled(true);
  assert.equal(isMemoryBudgetEnabled(), true);

  setMemoryBudgetMb(1024);
  assert.equal(getMemoryBudgetMb(), 1024);

  setDefaultTabMemoryMb(95);
  assert.equal(getDefaultTabMemoryMb(), 95);

  resetMemoryBudgetConfig();
  assert.equal(getMemoryBudgetMb(), 2048);
  assert.equal(getDefaultTabMemoryMb(), 80);
  assert.equal(isMemoryBudgetEnabled(), true);
});

test("estimateTabMemoryMb computes accurate heuristic memory usage", () => {
  // Base ordinary tab
  const tabBase = { id: 1, url: "https://example.com/page", active: false, audible: false };
  assert.equal(estimateTabMemoryMb(tabBase), 80);

  // Active tab gets active boost
  const tabActive = { id: 2, url: "https://example.com/page", active: true, audible: false };
  assert.equal(estimateTabMemoryMb(tabActive), 115); // 80 + 35

  // Heavy web application (e.g. YouTube, Figma)
  const tabHeavy = { id: 3, url: "https://www.youtube.com/watch?v=123", active: false, audible: false };
  assert.equal(estimateTabMemoryMb(tabHeavy), 170); // 80 + 90

  // Media audible tab
  const tabAudible = { id: 4, url: "https://example.com/music", active: false, audible: true };
  assert.equal(estimateTabMemoryMb(tabAudible), 200); // 80 + 120

  // Suspended tab consumes minimal overhead
  const tabSuspended = {
    id: 5,
    url: "chrome-extension://abcdef/suspended/suspended.html?url=https%3A%2F%2Fexample.com",
    active: false,
    discarded: true
  };
  assert.equal(estimateTabMemoryMb(tabSuspended), 15);

  // Explicit measurement overrides heuristics
  const tabExplicit = { id: 6, url: "https://example.com", actualMemoryMb: 350 };
  assert.equal(estimateTabMemoryMb(tabExplicit), 350);
});

test("estimateTotalMemoryUsageMb aggregates breakdown across active and suspended tabs", () => {
  const tabs = [
    { id: 1, url: "https://example.com", active: true, audible: false },
    { id: 2, url: "https://www.youtube.com/watch?v=123", active: false, audible: false },
    { id: 3, url: "chrome-extension://xyz/suspended/suspended.html?url=test", active: false, discarded: true }
  ];

  const result = estimateTotalMemoryUsageMb(tabs);
  assert.equal(result.tabCount, 3);
  assert.equal(result.activeCount, 1);
  assert.equal(result.unsuspendedCount, 2);
  assert.equal(result.suspendedCount, 1);

  // tab 1: 115 MB (80+35 active)
  // tab 2: 170 MB (80+90 youtube)
  // tab 3: 15 MB (suspended)
  // total: 300 MB
  assert.equal(result.totalEstimatedMb, 300);
  assert.equal(result.activeEstimatedMb, 115);
  assert.equal(result.unsuspendedEstimatedMb, 285);
  assert.equal(result.suspendedEstimatedMb, 15);
  assert.equal(result.tabEstimates.length, 3);
});

test("warning threshold configuration, ratio, MB conversion, and clamping", () => {
  resetMemoryBudgetConfig();
  assert.equal(getWarningThresholdRatio(), 0.75);
  assert.equal(getMemoryBudgetMb(), 2048);
  assert.equal(getWarningThresholdMb(), 1536); // 2048 * 0.75 = 1536

  // Set warning threshold ratio directly
  setWarningThresholdRatio(0.80);
  assert.equal(getWarningThresholdRatio(), 0.80);
  assert.equal(getWarningThresholdMb(), 1638); // 2048 * 0.80 = 1638.4 -> 1638

  // Set warning threshold via MB directly
  setWarningThresholdMb(1024); // 1024 / 2048 = 0.5
  assert.equal(getWarningThresholdRatio(), 0.50);
  assert.equal(getWarningThresholdMb(), 1024);

  resetMemoryBudgetConfig();
});

test("isWarningThresholdExceeded and getWarningThresholdStatus evaluate warning pressure correctly", () => {
  resetMemoryBudgetConfig(); // budget 2048, warning 0.75 -> 1536 MB
  assert.equal(isWarningThresholdExceeded(1200), false);
  assert.equal(isWarningThresholdExceeded(1536), true);
  assert.equal(isWarningThresholdExceeded(1700), true);

  const statusNormal = getWarningThresholdStatus(1200);
  assert.equal(statusNormal.isExceeded, false);
  assert.equal(statusNormal.currentUsageMb, 1200);
  assert.equal(statusNormal.warningThresholdMb, 1536);
  assert.equal(statusNormal.excessMb, 0);
  assert.equal(statusNormal.utilizationPercent, 59); // 1200/2048 ~ 58.59 -> 59%

  const statusExceeded = getWarningThresholdStatus(1600);
  assert.equal(statusExceeded.isExceeded, true);
  assert.equal(statusExceeded.currentUsageMb, 1600);
  assert.equal(statusExceeded.warningThresholdMb, 1536);
  assert.equal(statusExceeded.excessMb, 64);
  assert.equal(statusExceeded.utilizationPercent, 78);
  assert.ok(statusExceeded.summary.includes("Memory warning"));

  // Respects enabled: false
  setMemoryBudgetEnabled(false);
  assert.equal(isWarningThresholdExceeded(1800), false);
  assert.equal(getWarningThresholdStatus(1800).isExceeded, false);

  resetMemoryBudgetConfig();
});

test("warning listeners subscribe, receive notifications, and unsubscribe cleanly", () => {
  clearMemoryWarningListeners();
  const received = [];
  const listener = (status) => {
    received.push(status);
  };

  const unsubscribe = addMemoryWarningListener(listener);
  const status = getWarningThresholdStatus(1700);
  notifyMemoryWarningListeners(status);

  assert.equal(received.length, 1);
  assert.equal(received[0].isExceeded, true);
  assert.equal(received[0].currentUsageMb, 1700);

  // Unsubscribe
  unsubscribe();
  notifyMemoryWarningListeners(status);
  assert.equal(received.length, 1); // No new events

  clearMemoryWarningListeners();
});

test("critical threshold configuration, ratio, MB conversion, and bounds", () => {
  resetMemoryBudgetConfig();
  assert.equal(getCriticalThresholdRatio(), 0.90);
  assert.equal(getMemoryBudgetMb(), 2048);
  assert.equal(getCriticalThresholdMb(), 1843); // 2048 * 0.90 = 1843.2 -> 1843

  // Set critical threshold ratio
  setCriticalThresholdRatio(0.95);
  assert.equal(getCriticalThresholdRatio(), 0.95);
  assert.equal(getCriticalThresholdMb(), 1946); // 2048 * 0.95 = 1945.6 -> 1946

  // Set critical threshold via MB
  setCriticalThresholdMb(1900);
  assert.equal(getCriticalThresholdMb(), 1900); // 1900/2048 = 0.9277 -> 0.93 -> 1905 or 1900

  resetMemoryBudgetConfig();
});

test("isCriticalThresholdExceeded and getCriticalThresholdStatus evaluate critical pressure correctly", () => {
  resetMemoryBudgetConfig(); // budget 2048, critical 0.90 -> 1843 MB
  assert.equal(isCriticalThresholdExceeded(1500), false);
  assert.equal(isCriticalThresholdExceeded(1800), false);
  assert.equal(isCriticalThresholdExceeded(1843), true);
  assert.equal(isCriticalThresholdExceeded(2000), true);

  const statusSub = getCriticalThresholdStatus(1800);
  assert.equal(statusSub.isExceeded, false);
  assert.equal(statusSub.currentUsageMb, 1800);
  assert.equal(statusSub.excessMb, 0);

  const statusCrit = getCriticalThresholdStatus(1950);
  assert.equal(statusCrit.isExceeded, true);
  assert.equal(statusCrit.currentUsageMb, 1950);
  assert.equal(statusCrit.criticalThresholdMb, 1843);
  assert.equal(statusCrit.excessMb, 107);
  assert.equal(statusCrit.utilizationPercent, 95);
  assert.ok(statusCrit.summary.includes("Memory critical"));

  // Respects enabled: false
  setMemoryBudgetEnabled(false);
  assert.equal(isCriticalThresholdExceeded(2000), false);
  assert.equal(getCriticalThresholdStatus(2000).isExceeded, false);

  resetMemoryBudgetConfig();
});

test("getMemoryPressureState classifies NORMAL, WARNING, and CRITICAL levels accurately", () => {
  resetMemoryBudgetConfig(); // budget 2048, warning 1536 (75%), critical 1843 (90%)

  // Normal: 1000 MB (< 1536)
  const stateNormal = getMemoryPressureState(1000);
  assert.equal(stateNormal.level, MemoryPressureLevel.NORMAL);
  assert.equal(stateNormal.isNormal, true);
  assert.equal(stateNormal.isWarning, false);
  assert.equal(stateNormal.isCritical, false);

  // Warning: 1600 MB (>= 1536 and < 1843)
  const stateWarning = getMemoryPressureState(1600);
  assert.equal(stateWarning.level, MemoryPressureLevel.WARNING);
  assert.equal(stateWarning.isNormal, false);
  assert.equal(stateWarning.isWarning, true);
  assert.equal(stateWarning.isCritical, false);
  assert.equal(stateWarning.excessOverWarningMb, 64);
  assert.equal(stateWarning.excessOverCriticalMb, 0);

  // Critical: 1900 MB (>= 1843)
  const stateCritical = getMemoryPressureState(1900);
  assert.equal(stateCritical.level, MemoryPressureLevel.CRITICAL);
  assert.equal(stateCritical.isNormal, false);
  assert.equal(stateCritical.isWarning, true);
  assert.equal(stateCritical.isCritical, true);
  assert.equal(stateCritical.excessOverCriticalMb, 57);
});

test("critical listeners subscribe, receive notifications, and unsubscribe cleanly", () => {
  clearMemoryCriticalListeners();
  const received = [];
  const listener = (status) => {
    received.push(status);
  };

  const unsubscribe = addMemoryCriticalListener(listener);
  const status = getCriticalThresholdStatus(1900);
  notifyMemoryCriticalListeners(status);

  assert.equal(received.length, 1);
  assert.equal(received[0].isExceeded, true);
  assert.equal(received[0].currentUsageMb, 1900);

  // Unsubscribe
  unsubscribe();
  notifyMemoryCriticalListeners(status);
  assert.equal(received.length, 1);

  clearMemoryCriticalListeners();
});

test("selectMemoryPressureSuspensionCandidates returns not triggered when usage is within normal bounds", () => {
  resetMemoryBudgetConfig(); // 2048 MB budget
  const now = 1000000;
  const tabs = [
    { id: 1, url: "https://example.com/1", active: false, lastActiveAt: now - 3600000 },
    { id: 2, url: "https://example.com/2", active: false, lastActiveAt: now - 3600000 }
  ];

  // Under normal usage (e.g. 500 MB), no eviction is triggered
  const result = selectMemoryPressureSuspensionCandidates({
    tabs,
    currentUsageMb: 500,
    context: { now }
  });

  assert.equal(result.triggered, false);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.projectedSavingsMb, 0);
  assert.equal(result.reason, "within_budget_or_auto_evict_disabled");
});

test("selectMemoryPressureSuspensionCandidates selects eligible tabs under critical pressure and satisfies savings target", () => {
  resetMemoryBudgetConfig(); // 2048 MB budget, critical 1843 MB
  const now = 10000000;
  const tabs = [
    // Tab 1: Active tab (should be preserved)
    { id: 1, url: "https://example.com/active", active: true, lastActiveAt: now },
    // Tab 2: Pinned tab (protected)
    { id: 2, url: "https://example.com/pinned", active: false, pinned: true, lastActiveAt: now - 3600000 },
    // Tab 3: Audible tab (protected)
    { id: 3, url: "https://example.com/music", active: false, audible: true, lastActiveAt: now - 3600000 },
    // Tab 4: Already suspended tab (should be skipped)
    { id: 4, url: "chrome-extension://xyz/suspended/suspended.html?url=test", active: false, discarded: true },
    // Tab 5: Idle tab 1 (30 mins idle)
    { id: 5, url: "https://example.com/doc", active: false, lastActiveAt: now - 30 * 60000 },
    // Tab 6: Idle tab 2 (60 mins idle, heavy domain youtube -> ~170MB)
    { id: 6, url: "https://www.youtube.com/watch?v=xyz", active: false, lastActiveAt: now - 60 * 60000 },
    // Tab 7: Idle tab 3 (120 mins idle -> ~80MB)
    { id: 7, url: "https://example.com/article", active: false, lastActiveAt: now - 120 * 60000 }
  ];

  // Critical usage: 1950 MB
  const result = selectMemoryPressureSuspensionCandidates({
    tabs,
    currentUsageMb: 1950,
    context: { now },
    options: { targetSavingsMb: 200 } // target 200 MB savings
  });

  assert.equal(result.triggered, true);
  assert.equal(result.pressureState.isCritical, true);
  assert.ok(result.candidates.length >= 1);
  assert.ok(result.projectedSavingsMb >= 200);

  // Protected and active tabs must NOT be in candidates
  const candidateIds = result.candidates.map(c => c.tabId);
  assert.ok(!candidateIds.includes(1), "Active tab must not be selected");
  assert.ok(!candidateIds.includes(2), "Pinned tab must not be selected");
  assert.ok(!candidateIds.includes(3), "Audible tab must not be selected");
  assert.ok(!candidateIds.includes(4), "Already suspended tab must not be selected");

  // Verify explanation includes memory pressure
  for (const candidate of result.candidates) {
    assert.ok(candidate.explanation);
    assert.ok(candidate.explanation.headline.includes("memory pressure"));
  }
});

test("evaluateAndTriggerMemorySuspension executes suspendTabFn and logs results", async () => {
  resetMemoryBudgetConfig();
  const now = 10000000;
  const tabs = [
    { id: 10, url: "https://example.com/page1", active: false, lastActiveAt: now - 60 * 60000 },
    { id: 20, url: "https://example.com/page2", active: false, lastActiveAt: now - 90 * 60000 }
  ];

  const suspendedCalls = [];
  const suspendFn = async (tabId, reason, candidate) => {
    suspendedCalls.push({ tabId, reason, candidate });
    return { tabId, status: "suspended" };
  };

  const report = await evaluateAndTriggerMemorySuspension({
    tabs,
    currentUsageMb: 1950, // Critical
    suspendTabFn: suspendFn,
    context: { now },
    options: { targetSavingsMb: 150 }
  });

  assert.equal(report.triggered, true);
  assert.ok(report.executedSuspensions.length >= 1);
  assert.equal(report.suspendedCount, suspendedCalls.length);
  assert.equal(report.errors.length, 0);
  assert.equal(suspendedCalls[0].reason, "memory_pressure");
});

test("MemoryPressureLogger records events, enforces maxEntries capacity, and filters logs", () => {
  const logger = new MemoryPressureLogger({ maxEntries: 5 });

  for (let i = 1; i <= 7; i++) {
    logger.logEvent({
      id: `ev-${i}`,
      timestamp: 1000 + i * 100,
      level: i % 2 === 0 ? "critical" : "warning",
      currentUsageMb: 1500 + i * 50,
      projectedSavingsMb: i * 20,
      suspendedTabIds: [i]
    });
  }

  // Capacity clamped to 5 newest
  const allLogs = logger.getLogs({ limit: 10 });
  assert.equal(allLogs.length, 5);
  // Newest first: ev-7, ev-6, ev-5, ev-4, ev-3
  assert.equal(allLogs[0].id, "ev-7");
  assert.equal(allLogs[4].id, "ev-3");

  // Filter by level
  const criticalLogs = logger.getLogs({ level: "critical" });
  assert.ok(criticalLogs.every(l => l.level === "critical"));

  // Filter by sinceTimestamp
  const sinceLogs = logger.getLogs({ sinceTimestamp: 1500 });
  assert.ok(sinceLogs.every(l => l.timestamp >= 1500));

  // Log stats
  const stats = logger.getLogStats();
  assert.equal(stats.totalLogs, 5);
  assert.ok(stats.totalProjectedSavingsMb > 0);
  assert.ok(stats.totalSuspendedTabs > 0);

  // Clear logs
  logger.clearLogs();
  assert.equal(logger.getLogs().length, 0);
});

test("MemoryPressureLogger exports and imports logs cleanly", () => {
  const logger = new MemoryPressureLogger({ maxEntries: 20 });
  logger.logEvent({ id: "log-1", level: "warning", currentUsageMb: 1600 });
  logger.logEvent({ id: "log-2", level: "critical", currentUsageMb: 1900 });

  const exported = logger.exportLogs();
  assert.equal(exported.count, 2);
  assert.equal(exported.version, 1);

  const newLogger = new MemoryPressureLogger();
  const importedCount = newLogger.importLogs(exported);
  assert.equal(importedCount, 2);
  assert.equal(newLogger.getLogs().length, 2);
});

test("evaluateAndTriggerMemorySuspension automatically logs eviction events to defaultMemoryPressureLogger", async () => {
  clearMemoryPressureLogs();
  resetMemoryBudgetConfig();
  const now = 5000000;
  const tabs = [
    { id: 101, url: "https://example.com/tab1", active: false, lastActiveAt: now - 60 * 60000 }
  ];

  await evaluateAndTriggerMemorySuspension({
    tabs,
    currentUsageMb: 1900,
    suspendTabFn: () => ({ success: true }),
    context: { now },
    options: { targetSavingsMb: 50, logEvent: true }
  });

  const logs = getMemoryPressureLogs();
  assert.ok(logs.length >= 1);
  assert.equal(logs[0].level, "eviction");
  assert.equal(logs[0].suspendedTabIds[0], 101);

  const stats = getMemoryPressureLogStats();
  assert.equal(stats.evictionCount, 1);

  clearMemoryPressureLogs();
});

test("MemorySimulator lifecycle: enable, disable, and status tracking", () => {
  const sim = new MemorySimulator();
  assert.equal(sim.isSimulationActive(), false);

  const status = sim.enable({ usageMb: 1600, tabOverrides: { 1: 250, 2: 300 } });
  assert.equal(sim.isSimulationActive(), true);
  assert.equal(status.isActive, true);
  assert.equal(status.simulatedUsageMb, 1600);
  assert.equal(status.tabOverridesCount, 2);
  assert.equal(sim.getSimulatedUsageMb(), 1600);
  assert.equal(sim.getSimulatedTabMemory(1), 250);
  assert.equal(sim.getSimulatedTabMemory(2), 300);
  assert.equal(sim.getSimulatedTabMemory(999), null);

  sim.disable();
  assert.equal(sim.isSimulationActive(), false);
  assert.equal(sim.getSimulatedUsageMb(), null);
  assert.equal(sim.getSimulatedTabMemory(1), null);
});

test("MemorySimulator setSimulatedPressureLevel computes correct target values", () => {
  resetMemoryBudgetConfig(); // budget 2048, warning 1536, critical 1843
  const sim = new MemorySimulator();
  sim.enable();

  const warn = sim.setSimulatedPressureLevel("warning");
  assert.equal(warn.level, "warning");
  assert.equal(warn.simulatedUsageMb, 1536 + 50); // 1586 MB

  const crit = sim.setSimulatedPressureLevel("critical");
  assert.equal(crit.level, "critical");
  assert.equal(crit.simulatedUsageMb, 1843 + 100); // 1943 MB

  const norm = sim.setSimulatedPressureLevel("normal");
  assert.equal(norm.level, "normal");
  assert.equal(norm.simulatedUsageMb, 1024); // 50% of 2048

  sim.disable();
});

test("simulation overrides propagate into estimateTabMemoryMb and estimateTotalMemoryUsageMb", () => {
  disableMemorySimulation();
  resetMemoryBudgetConfig();

  const tab = { id: 777, url: "https://example.com", active: false };
  // Without simulation: default tab memory is 80 MB
  assert.equal(estimateTabMemoryMb(tab), 80);

  // Enable simulation and set custom tab memory
  enableMemorySimulation({ tabOverrides: { 777: 420 } });
  assert.equal(isMemorySimulationEnabled(), true);
  assert.equal(estimateTabMemoryMb(tab), 420);

  // Total memory usage override
  setSimulatedMemoryUsage(2150);
  const total = estimateTotalMemoryUsageMb([tab]);
  assert.equal(total.totalEstimatedMb, 2150);

  disableMemorySimulation();
  assert.equal(isMemorySimulationEnabled(), false);
  assert.equal(estimateTabMemoryMb(tab), 80);
});

test("simulateMemoryPressureSpike drives candidate selection and automated eviction", async () => {
  disableMemorySimulation();
  resetMemoryBudgetConfig();
  const now = 8000000;

  const tabs = [
    { id: 501, url: "https://example.com/tab1", active: false, lastActiveAt: now - 30 * 60000 },
    { id: 502, url: "https://example.com/tab2", active: false, lastActiveAt: now - 45 * 60000 }
  ];

  // Trigger synthetic critical pressure spike
  const spike = simulateMemoryPressureSpike("critical");
  assert.equal(spike.simulationActive, true);
  assert.equal(spike.level, "critical");

  const status = getMemorySimulationStatus();
  assert.equal(status.isActive, true);
  assert.equal(status.simulatedPressureLevel, "critical");

  const candidates = selectMemoryPressureSuspensionCandidates({
    tabs,
    context: { now },
    options: { targetSavingsMb: 80 }
  });

  assert.equal(candidates.triggered, true);
  assert.equal(candidates.pressureState.isCritical, true);
  assert.ok(candidates.candidates.length >= 1);

  disableMemorySimulation();
});





