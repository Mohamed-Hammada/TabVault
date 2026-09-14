import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SCORE_WEIGHTS,
  SCORE_WEIGHT_BOUNDS,
  SCORE_WEIGHT_PRESETS,
  STORAGE_KEY_SCORE_WEIGHTS,
  normalizeScoreWeights,
  getScoreWeights,
  setScoreWeights,
  resetScoreWeights,
  getScoreWeightPresets,
  applyScoreWeightPreset,
  TabSuspensionPriority,
  DEFAULT_PRIORITY_THRESHOLDS,
  determinePriorityLevel,
  getPriorityLevelLabel,
  getPriorityLevelColor,
  filterTabsByPriority,
  UNSUPPORTED_URL_SCHEMES,
  TabProtectionReason,
  ProtectedTabRuleManager,
  isInternalOrUnsupportedUrl,
  evaluateTabProtection,
  calculateTabSuspensionScore,
  scoreTabs,
  dryRunSuspensionEvaluation,
  generateSuspensionExplanation
} from "../lib/scoring.js";

test("isInternalOrUnsupportedUrl identifies internal schemes and suspended placeholder", () => {
  assert.equal(isInternalOrUnsupportedUrl("chrome://settings"), true);
  assert.equal(isInternalOrUnsupportedUrl("edge://extensions"), true);
  assert.equal(isInternalOrUnsupportedUrl("about:blank"), true);
  assert.equal(isInternalOrUnsupportedUrl("chrome-extension://xyz/suspended/suspended.html"), true);
  assert.equal(isInternalOrUnsupportedUrl("devtools://devtools/bundled/inspector.html"), true);
  assert.equal(isInternalOrUnsupportedUrl("view-source:https://example.com"), true);

  assert.equal(isInternalOrUnsupportedUrl("https://example.com"), false);
  assert.equal(isInternalOrUnsupportedUrl("http://localhost:8080"), false);
  assert.equal(isInternalOrUnsupportedUrl(""), true);
  assert.equal(isInternalOrUnsupportedUrl(null), true);
});

test("evaluateTabProtection handles diverse protection conditions", () => {
  // 1. Internal page
  const internal = evaluateTabProtection({ url: "chrome://extensions" });
  assert.equal(internal.isProtected, true);
  assert.equal(internal.reason, TabProtectionReason.INTERNAL_URL);

  // 2. Already discarded
  const discarded = evaluateTabProtection({ url: "https://example.com", discarded: true });
  assert.equal(discarded.isProtected, true);
  assert.equal(discarded.reason, TabProtectionReason.ALREADY_SUSPENDED);

  // 3. Active tab
  const active = evaluateTabProtection({ url: "https://example.com", active: true });
  assert.equal(active.isProtected, true);
  assert.equal(active.reason, TabProtectionReason.ACTIVE);

  // 4. Pinned tab
  const pinned = evaluateTabProtection({ url: "https://example.com", pinned: true });
  assert.equal(pinned.isProtected, true);
  assert.equal(pinned.reason, TabProtectionReason.PINNED);

  // 5. Playing audio
  const audible = evaluateTabProtection({ url: "https://example.com", audible: true });
  assert.equal(audible.isProtected, true);
  assert.equal(audible.reason, TabProtectionReason.AUDIBLE);

  // 6. Form input
  const form = evaluateTabProtection({ url: "https://example.com", hasFormInput: true });
  assert.equal(form.isProtected, true);
  assert.equal(form.reason, TabProtectionReason.FORM_INPUT);

  // 7. Whitelisted domain
  const whitelisted = evaluateTabProtection(
    { url: "https://mail.google.com/inbox" },
    {},
    { whitelist: ["mail.google.com"] }
  );
  assert.equal(whitelisted.isProtected, true);
  assert.equal(whitelisted.reason, TabProtectionReason.WHITELISTED);

  // 8. Tab group protected
  const inGroup = evaluateTabProtection(
    { url: "https://example.com", groupId: 5 },
    {},
    { neverSuspend: { inTabGroup: true } }
  );
  assert.equal(inGroup.isProtected, true);
  assert.equal(inGroup.reason, TabProtectionReason.GROUP_PROTECTED);

  // 9. Standard idle tab - not protected
  const normal = evaluateTabProtection({ url: "https://example.com", active: false, pinned: false });
  assert.equal(normal.isProtected, false);
  assert.equal(normal.reason, null);
});

test("calculateTabSuspensionScore evaluates idle duration, visit frequency, group, domain, and memory pressure", () => {
  const baseTime = 1000000;

  // 1. Protected tab receives score 0
  const protectedRes = calculateTabSuspensionScore(
    { id: 10, url: "https://example.com", active: true },
    {}
  );
  assert.equal(protectedRes.score, 0);
  assert.equal(protectedRes.isEligible, false);
  assert.equal(protectedRes.protectionReason, TabProtectionReason.ACTIVE);

  // 2. Standard 30-minute idle tab
  const idle30 = calculateTabSuspensionScore(
    { id: 20, url: "https://news.ycombinator.com" },
    { lastActiveAt: baseTime - (30 * 60 * 1000), visitCount: 1 },
    { now: baseTime }
  );
  assert.equal(idle30.isEligible, true);
  assert.equal(idle30.factors.idleMinutes, 30);
  assert.equal(idle30.factors.idleScore, 30);
  assert.equal(idle30.score, 30);
  assert.ok(idle30.breakdown.some(b => b.includes("Idle 30m")));

  // 3. High visit frequency reduces score
  const frequentTab = calculateTabSuspensionScore(
    { id: 30, url: "https://example.com" },
    { lastActiveAt: baseTime - (30 * 60 * 1000), visitCount: 11 }, // 10 visits above 1 * -1.5 = -15
    { now: baseTime }
  );
  assert.equal(frequentTab.factors.visitDeduction, 15);
  assert.equal(frequentTab.score, 15); // 30 - 15 = 15

  // 4. Tab group and domain priority adjustments
  const prioritizedTab = calculateTabSuspensionScore(
    { id: 40, url: "https://jira.corp.internal/browse/T-1", groupId: 2 },
    { lastActiveAt: baseTime - (20 * 60 * 1000), visitCount: 1 },
    {
      now: baseTime,
      groupPriorities: { 2: 5 }, // +5
      domainPriorities: { "jira.corp.internal": 10 } // +10
    }
  );
  assert.equal(prioritizedTab.factors.groupScore, 5);
  assert.equal(prioritizedTab.factors.domainScore, 10);
  assert.equal(prioritizedTab.score, 35); // 20 (idle) + 5 (group) + 10 (domain) = 35

  // 5. Memory pressure amplification
  const memoryStressed = calculateTabSuspensionScore(
    { id: 50, url: "https://example.com" },
    { lastActiveAt: baseTime - (20 * 60 * 1000), visitCount: 1 },
    { now: baseTime, memoryPressure: "critical" } // multiplier 1.0 -> +20 modifier
  );
  assert.equal(memoryStressed.factors.idleScore, 20);
  assert.equal(memoryStressed.factors.memoryModifier, 20);
  assert.equal(memoryStressed.score, 40); // 20 base + 20 boost = 40

  // 6. Restoration cost deduction
  const costlyTab = calculateTabSuspensionScore(
    { id: 60, url: "https://example.com" },
    { lastActiveAt: baseTime - (20 * 60 * 1000), visitCount: 1, restorationCost: 3 }, // 3 * -2 = -6
    { now: baseTime }
  );
  assert.equal(costlyTab.factors.restorationCostDeduction, 6);
  assert.equal(costlyTab.score, 14); // 20 - 6 = 14

  // 7. Clamped at 0 when deductions exceed base score
  const zeroClamped = calculateTabSuspensionScore(
    { id: 70, url: "https://example.com" },
    { lastActiveAt: baseTime - (2 * 60 * 1000), visitCount: 20 },
    { now: baseTime }
  );
  assert.equal(zeroClamped.score, 0);
});

test("scoreTabs ranks multiple tabs with candidates first and protected tabs last", () => {
  const baseTime = 1000000;

  const tabs = [
    { id: 1, url: "https://example.com/1", active: true }, // protected
    { id: 2, url: "https://example.com/2", pinned: true }, // protected
    { id: 3, url: "https://example.com/3", active: false }, // idle 10m
    { id: 4, url: "https://example.com/4", active: false }, // idle 60m
    { id: 5, url: "https://example.com/5", active: false }  // idle 30m
  ];

  const metaMap = new Map([
    [1, { lastActiveAt: baseTime }],
    [2, { lastActiveAt: baseTime - (100 * 60 * 1000) }],
    [3, { lastActiveAt: baseTime - (10 * 60 * 1000), visitCount: 1 }],
    [4, { lastActiveAt: baseTime - (60 * 60 * 1000), visitCount: 1 }],
    [5, { lastActiveAt: baseTime - (30 * 60 * 1000), visitCount: 1 }]
  ]);

  const ranked = scoreTabs(tabs, metaMap, { now: baseTime });

  assert.equal(ranked.length, 5);

  // Tab 4 (60m idle) should be top
  assert.equal(ranked[0].tabId, 4);
  assert.equal(ranked[0].score, 60);
  assert.equal(ranked[0].isEligible, true);

  // Tab 5 (30m idle) should be second
  assert.equal(ranked[1].tabId, 5);
  assert.equal(ranked[1].score, 30);
  assert.equal(ranked[1].isEligible, true);

  // Tab 3 (10m idle) should be third
  assert.equal(ranked[2].tabId, 3);
  assert.equal(ranked[2].score, 10);
  assert.equal(ranked[2].isEligible, true);

  // Tabs 1 and 2 should be at the bottom and marked ineligible
  assert.equal(ranked[3].isEligible, false);
  assert.equal(ranked[4].isEligible, false);
});

test("normalizeScoreWeights validates, clamps, and defaults missing properties", () => {
  assert.deepEqual(normalizeScoreWeights(null), DEFAULT_SCORE_WEIGHTS);
  assert.deepEqual(normalizeScoreWeights(undefined), DEFAULT_SCORE_WEIGHTS);
  assert.deepEqual(normalizeScoreWeights({}), DEFAULT_SCORE_WEIGHTS);

  const clamped = normalizeScoreWeights({
    idleDurationWeight: 999, // max 10.0
    maxIdleScore: 5,        // min 10.0
    visitFrequencyWeight: -50, // min -10.0
    memoryPressureMultiplier: 10 // max 5.0
  });

  assert.equal(clamped.idleDurationWeight, SCORE_WEIGHT_BOUNDS.idleDurationWeight.max);
  assert.equal(clamped.maxIdleScore, SCORE_WEIGHT_BOUNDS.maxIdleScore.min);
  assert.equal(clamped.visitFrequencyWeight, SCORE_WEIGHT_BOUNDS.visitFrequencyWeight.min);
  assert.equal(clamped.memoryPressureMultiplier, SCORE_WEIGHT_BOUNDS.memoryPressureMultiplier.max);
  assert.equal(clamped.domainPriorityWeight, DEFAULT_SCORE_WEIGHTS.domainPriorityWeight);
});

test("getScoreWeights, setScoreWeights, and resetScoreWeights manage configuration with storage sync", () => {
  resetScoreWeights();

  const mockStorage = new Map();
  const storageAdapter = {
    get(k) {
      return mockStorage.get(k);
    },
    set(k, v) {
      mockStorage.set(k, v);
    },
    remove(k) {
      mockStorage.delete(k);
    }
  };

  // Set custom weights
  const custom = setScoreWeights(
    {
      idleDurationWeight: 3.0,
      maxIdleScore: 120.0
    },
    storageAdapter
  );

  assert.equal(custom.idleDurationWeight, 3.0);
  assert.equal(custom.maxIdleScore, 120.0);
  assert.equal(mockStorage.has(STORAGE_KEY_SCORE_WEIGHTS), true);

  // Retrieve via getScoreWeights with storage
  const retrieved = getScoreWeights(storageAdapter);
  assert.equal(retrieved.idleDurationWeight, 3.0);
  assert.equal(retrieved.maxIdleScore, 120.0);

  // Reset to defaults
  const reset = resetScoreWeights(storageAdapter);
  assert.equal(reset.idleDurationWeight, DEFAULT_SCORE_WEIGHTS.idleDurationWeight);
  assert.equal(reset.maxIdleScore, DEFAULT_SCORE_WEIGHTS.maxIdleScore);
});

test("SCORE_WEIGHT_PRESETS and applyScoreWeightPreset", () => {
  resetScoreWeights();

  const presets = getScoreWeightPresets();
  assert.ok(presets.balanced);
  assert.ok(presets.aggressive);
  assert.ok(presets.conservative);
  assert.ok(presets.low_memory);

  // Apply aggressive preset
  const agg = applyScoreWeightPreset("aggressive");
  assert.equal(agg.idleDurationWeight, 2.0);
  assert.equal(agg.maxIdleScore, 80.0);

  // Apply conservative preset
  const con = applyScoreWeightPreset("conservative");
  assert.equal(con.idleDurationWeight, 0.5);
  assert.equal(con.maxIdleScore, 40.0);

  // Throws on unknown preset
  assert.throws(() => applyScoreWeightPreset("non_existent"), /Unknown score weight preset/);

  resetScoreWeights();
});

test("calculateTabSuspensionScore uses custom configured weights accurately", () => {
  const baseTime = 1000000;

  // With aggressive weights: idleDurationWeight = 2.0
  const aggressiveWeights = {
    ...DEFAULT_SCORE_WEIGHTS,
    idleDurationWeight: 2.0
  };

  const scored = calculateTabSuspensionScore(
    { id: 10, url: "https://example.com" },
    { lastActiveAt: baseTime - (15 * 60 * 1000), visitCount: 1 },
    { now: baseTime },
    aggressiveWeights
  );

  // 15m * 2.0 = 30 points (instead of 15 * 1.0 = 15 points)
  assert.equal(scored.factors.idleScore, 30);
  assert.equal(scored.score, 30);
});

test("determinePriorityLevel, labels, and badge colors", () => {
  assert.equal(determinePriorityLevel(0, false), TabSuspensionPriority.IMMUNE);
  assert.equal(determinePriorityLevel(0, true), TabSuspensionPriority.IMMUNE);
  assert.equal(determinePriorityLevel(10, true), TabSuspensionPriority.LOW);
  assert.equal(determinePriorityLevel(20, true), TabSuspensionPriority.MEDIUM);
  assert.equal(determinePriorityLevel(39.9, true), TabSuspensionPriority.MEDIUM);
  assert.equal(determinePriorityLevel(40, true), TabSuspensionPriority.HIGH);
  assert.equal(determinePriorityLevel(59.9, true), TabSuspensionPriority.HIGH);
  assert.equal(determinePriorityLevel(60, true), TabSuspensionPriority.URGENT);
  assert.equal(determinePriorityLevel(120, true), TabSuspensionPriority.URGENT);

  // Labels
  assert.equal(getPriorityLevelLabel(TabSuspensionPriority.IMMUNE), "Immune");
  assert.equal(getPriorityLevelLabel(TabSuspensionPriority.LOW), "Low");
  assert.equal(getPriorityLevelLabel(TabSuspensionPriority.MEDIUM), "Medium");
  assert.equal(getPriorityLevelLabel(TabSuspensionPriority.HIGH), "High");
  assert.equal(getPriorityLevelLabel(TabSuspensionPriority.URGENT), "Urgent");

  // Colors
  assert.equal(getPriorityLevelColor(TabSuspensionPriority.IMMUNE), "#10b981");
  assert.equal(getPriorityLevelColor(TabSuspensionPriority.LOW), "#3b82f6");
  assert.equal(getPriorityLevelColor(TabSuspensionPriority.MEDIUM), "#f59e0b");
  assert.equal(getPriorityLevelColor(TabSuspensionPriority.HIGH), "#f97316");
  assert.equal(getPriorityLevelColor(TabSuspensionPriority.URGENT), "#ef4444");
});

test("filterTabsByPriority filters by priority levels and preserves order", () => {
  const tabs = [
    { tabId: 1, priorityLevel: TabSuspensionPriority.URGENT, score: 70 },
    { tabId: 2, priorityLevel: TabSuspensionPriority.HIGH, score: 50 },
    { tabId: 3, priorityLevel: TabSuspensionPriority.MEDIUM, score: 30 },
    { tabId: 4, priorityLevel: TabSuspensionPriority.LOW, score: 10 },
    { tabId: 5, priorityLevel: TabSuspensionPriority.IMMUNE, score: 0 }
  ];

  const urgentAndHigh = filterTabsByPriority(tabs, [TabSuspensionPriority.URGENT, TabSuspensionPriority.HIGH]);
  assert.equal(urgentAndHigh.length, 2);
  assert.equal(urgentAndHigh[0].tabId, 1);
  assert.equal(urgentAndHigh[1].tabId, 2);

  const immuneOnly = filterTabsByPriority(tabs, [TabSuspensionPriority.IMMUNE]);
  assert.equal(immuneOnly.length, 1);
  assert.equal(immuneOnly[0].tabId, 5);

  const all = filterTabsByPriority(tabs, []);
  assert.equal(all.length, 5);
});

test("calculateTabSuspensionScore includes priorityLevel, label, and color", () => {
  const baseTime = 1000000;

  // 1. Protected tab
  const protectedTab = calculateTabSuspensionScore(
    { id: 1, url: "https://example.com", active: true },
    {}
  );
  assert.equal(protectedTab.priorityLevel, TabSuspensionPriority.IMMUNE);
  assert.equal(protectedTab.priorityLabel, "Immune");
  assert.equal(protectedTab.priorityColor, "#10b981");

  // 2. High priority tab (idle 45m)
  const highTab = calculateTabSuspensionScore(
    { id: 2, url: "https://example.com" },
    { lastActiveAt: baseTime - (45 * 60 * 1000), visitCount: 1 },
    { now: baseTime }
  );
  assert.equal(highTab.priorityLevel, TabSuspensionPriority.HIGH);
  assert.equal(highTab.priorityLabel, "High");
  assert.equal(highTab.priorityColor, "#f97316");

  // 3. Urgent priority tab (idle 70m)
  const urgentTab = calculateTabSuspensionScore(
    { id: 3, url: "https://example.com" },
    { lastActiveAt: baseTime - (70 * 60 * 1000), visitCount: 1 },
    { now: baseTime }
  );
  assert.equal(urgentTab.priorityLevel, TabSuspensionPriority.URGENT);
  assert.equal(urgentTab.priorityLabel, "Urgent");
  assert.equal(urgentTab.priorityColor, "#ef4444");
});

test("ProtectedTabRuleManager rule registration and matching conditions", () => {
  const manager = new ProtectedTabRuleManager();

  // 1. Add domain rule
  manager.addRule({
    id: "slack-protect",
    domain: "*.slack.com",
    reason: "Slack workspace protected"
  });

  // 2. Add URL pattern rule
  manager.addRule({
    id: "meet-protect",
    urlPattern: "*://meet.google.com/*",
    reason: "Google Meet call active"
  });

  // 3. Add title pattern rule
  manager.addRule({
    id: "dashboard-protect",
    titlePattern: "Live Dashboard",
    reason: "Live Monitoring Dashboard"
  });

  // 4. Add streaming rule
  manager.addRule({
    id: "stream-protect",
    streaming: true,
    reason: "Active streaming media"
  });

  // 5. Add custom predicate rule
  manager.addRule({
    id: "local-dev-protect",
    customPredicate: (tab) => tab.url && tab.url.includes("localhost:3000"),
    reason: "Local dev server tab"
  });

  assert.equal(manager.getAllRules().length, 5);
  assert.ok(manager.getRule("slack-protect"));

  // Match domain rule
  const slackMatch = manager.evaluate({ url: "https://app.slack.com/client/T123/C456" });
  assert.equal(slackMatch.isProtected, true);
  assert.equal(slackMatch.reason, "Slack workspace protected");

  // Match URL pattern
  const meetMatch = manager.evaluate({ url: "https://meet.google.com/abc-defg-hij" });
  assert.equal(meetMatch.isProtected, true);
  assert.equal(meetMatch.reason, "Google Meet call active");

  // Match Title pattern
  const titleMatch = manager.evaluate({ url: "https://monitoring.corp.org", title: "Cluster A - Live Dashboard" });
  assert.equal(titleMatch.isProtected, true);
  assert.equal(titleMatch.reason, "Live Monitoring Dashboard");

  // Match Streaming rule
  const streamMatch = manager.evaluate({ url: "https://radio.example.com", streaming: true });
  assert.equal(streamMatch.isProtected, true);
  assert.equal(streamMatch.reason, "Active streaming media");

  // Match custom predicate
  const devMatch = manager.evaluate({ url: "http://localhost:3000/app" });
  assert.equal(devMatch.isProtected, true);
  assert.equal(devMatch.reason, "Local dev server tab");

  // Non-matching tab
  const noMatch = manager.evaluate({ url: "https://en.wikipedia.org/wiki/JavaScript", title: "JavaScript - Wikipedia" });
  assert.equal(noMatch.isProtected, false);

  // Disable rule
  manager.setRuleEnabled("slack-protect", false);
  const disabledSlack = manager.evaluate({ url: "https://app.slack.com/client/T123/C456" });
  assert.equal(disabledSlack.isProtected, false);

  // Remove rule
  assert.equal(manager.removeRule("meet-protect"), true);
  assert.equal(manager.getRule("meet-protect"), null);
});

test("evaluateTabProtection and calculateTabSuspensionScore integrate with custom rules", () => {
  const manager = new ProtectedTabRuleManager([
    {
      id: "protect-work-group",
      groupName: "Critical Work",
      reason: "Critical Work Group"
    }
  ]);

  const protectedTab = calculateTabSuspensionScore(
    { id: 101, url: "https://docs.google.com/document/d/123/edit", groupId: 1 },
    { lastActiveAt: 1000 },
    {},
    DEFAULT_SCORE_WEIGHTS,
    {
      ruleManager: manager,
      context: { tabGroupNames: { 1: "Critical Work" } }
    }
  );

  assert.equal(protectedTab.isEligible, false);
  assert.equal(protectedTab.score, 0);
  assert.equal(protectedTab.priorityLevel, TabSuspensionPriority.IMMUNE);
  assert.equal(protectedTab.protectionReason, "Critical Work Group");
});

test("dryRunSuspensionEvaluation computes projected suspensions and memory savings without side effects", () => {
  const now = 1000000;
  const tabs = [
    { id: 1, title: "Tab 1 (Idle 40m)", url: "https://news.ycombinator.com", active: false, pinned: false, estimatedMemoryMb: 90 },
    { id: 2, title: "Tab 2 (Idle 20m)", url: "https://github.com/trending", active: false, pinned: false, estimatedMemoryMb: 110 },
    { id: 3, title: "Tab 3 (Active Tab)", url: "https://mail.google.com", active: true, pinned: false, estimatedMemoryMb: 150 },
    { id: 4, title: "Tab 4 (Pinned Tab)", url: "https://calendar.google.com", active: false, pinned: true, estimatedMemoryMb: 75 }
  ];

  const metaMap = new Map([
    [1, { lastActiveAt: now - 40 * 60000, visitCount: 1 }],
    [2, { lastActiveAt: now - 20 * 60000, visitCount: 1 }],
    [3, { lastActiveAt: now, visitCount: 5 }],
    [4, { lastActiveAt: now - 60 * 60000, visitCount: 2 }]
  ]);

  const report = dryRunSuspensionEvaluation(tabs, metaMap, { now });

  assert.equal(report.dryRun, true);
  assert.equal(report.totalTabsEvaluated, 4);
  assert.equal(report.eligibleCandidatesCount, 2);
  assert.equal(report.protectedTabsCount, 2);
  assert.equal(report.projectedSuspensionsCount, 2);
  assert.equal(report.projectedMemorySavingsMb, 200); // 90 + 110
  assert.match(report.summary, /2 of 4 tabs projected for suspension/);

  // Highest score first (Tab 1 idle 40m vs Tab 2 idle 20m)
  assert.equal(report.projectedSuspensions[0].tabId, 1);
  assert.equal(report.projectedSuspensions[0].estimatedMemoryMb, 90);
  assert.equal(report.projectedSuspensions[0].priorityLevel, TabSuspensionPriority.HIGH);
  assert.equal(report.projectedSuspensions[1].tabId, 2);
  assert.equal(report.projectedSuspensions[1].estimatedMemoryMb, 110);

  // Exempt tabs
  const exemptIds = report.exemptTabs.map(t => t.tabId);
  assert.ok(exemptIds.includes(3));
  assert.ok(exemptIds.includes(4));
  const activeExempt = report.exemptTabs.find(t => t.tabId === 3);
  const pinnedExempt = report.exemptTabs.find(t => t.tabId === 4);
  assert.equal(activeExempt.reason, TabProtectionReason.ACTIVE);
  assert.equal(pinnedExempt.reason, TabProtectionReason.PINNED);
});

test("dryRunSuspensionEvaluation respects minScore, priorityFilter, maxTabsToSuspend, and targetMemoryMb", () => {
  const now = 2000000;
  const tabs = [
    { id: 10, title: "Urgent Tab", url: "https://siteA.com", estimatedMemoryMb: 50 },
    { id: 20, title: "High Tab", url: "https://siteB.com", estimatedMemoryMb: 50 },
    { id: 30, title: "Medium Tab", url: "https://siteC.com", estimatedMemoryMb: 50 },
    { id: 40, title: "Low Tab", url: "https://siteD.com", estimatedMemoryMb: 50 }
  ];

  const metaMap = new Map([
    [10, { lastActiveAt: now - 70 * 60000, visitCount: 1 }], // score 60 -> URGENT
    [20, { lastActiveAt: now - 45 * 60000, visitCount: 1 }], // score 45 -> HIGH
    [30, { lastActiveAt: now - 25 * 60000, visitCount: 1 }], // score 25 -> MEDIUM
    [40, { lastActiveAt: now - 10 * 60000, visitCount: 1 }]  // score 10 -> LOW
  ]);

  // Test minScore cutoff
  const minScoreReport = dryRunSuspensionEvaluation(tabs, metaMap, { now }, DEFAULT_SCORE_WEIGHTS, {
    minScore: 30.0
  });
  assert.equal(minScoreReport.projectedSuspensionsCount, 2);
  assert.deepEqual(minScoreReport.projectedSuspensions.map(t => t.tabId), [10, 20]);
  const belowCutoff = minScoreReport.exemptTabs.filter(t => t.reason === "score_below_cutoff");
  assert.equal(belowCutoff.length, 2);

  // Test priorityFilter
  const priorityReport = dryRunSuspensionEvaluation(tabs, metaMap, { now }, DEFAULT_SCORE_WEIGHTS, {
    priorityFilter: [TabSuspensionPriority.URGENT]
  });
  assert.equal(priorityReport.projectedSuspensionsCount, 1);
  assert.equal(priorityReport.projectedSuspensions[0].tabId, 10);
  const priorityExempt = priorityReport.exemptTabs.filter(t => t.reason === "priority_not_matched");
  assert.equal(priorityExempt.length, 3);

  // Test maxTabsToSuspend quota
  const maxQuotaReport = dryRunSuspensionEvaluation(tabs, metaMap, { now }, DEFAULT_SCORE_WEIGHTS, {
    maxTabsToSuspend: 2
  });
  assert.equal(maxQuotaReport.projectedSuspensionsCount, 2);
  assert.deepEqual(maxQuotaReport.projectedSuspensions.map(t => t.tabId), [10, 20]);
  const quotaExempt = maxQuotaReport.exemptTabs.filter(t => t.reason === "quota_limit_reached");
  assert.equal(quotaExempt.length, 2);

  // Test targetMemoryMb ceiling
  const targetMemReport = dryRunSuspensionEvaluation(tabs, metaMap, { now }, DEFAULT_SCORE_WEIGHTS, {
    targetMemoryMb: 60 // Tab 10 provides 50MB (total 50MB < 60MB), Tab 20 provides 50MB (total 100MB >= 60MB, so next tabs are exempt)
  });
  assert.equal(targetMemReport.projectedSuspensionsCount, 2);
  assert.equal(targetMemReport.projectedMemorySavingsMb, 100);
  const targetExempt = targetMemReport.exemptTabs.filter(t => t.reason === "target_memory_met");
  assert.equal(targetExempt.length, 2);
});

test("generateSuspensionExplanation generates detailed narrative and structured factors", () => {
  // 1. Idle tab explanation
  const idleTabScored = {
    tabId: 5,
    score: 45.0,
    priorityLevel: TabSuspensionPriority.HIGH,
    priorityLabel: "High Priority",
    isEligible: true,
    factors: {
      idleMinutes: 45,
      idleScore: 45.0,
      memoryModifier: 0,
      visitDeduction: 0,
      groupScore: 0,
      domainScore: 0,
      restorationCostDeduction: 0
    }
  };

  const idleExp = generateSuspensionExplanation(idleTabScored, { trigger: "idle_timeout" });
  assert.equal(idleExp.primaryReason, "idle_duration");
  assert.equal(idleExp.priorityLevel, TabSuspensionPriority.HIGH);
  assert.equal(idleExp.score, 45.0);
  assert.match(idleExp.headline, /Suspended after 45 minutes of inactivity/);
  assert.ok(idleExp.contributingFactors.some(f => f.includes("Inactive for 45 minutes")));
  assert.ok(idleExp.safeguardsVerified.length >= 4);
  assert.match(idleExp.fullNarrative, /All safety guards passed/);

  // 2. Memory pressure explanation
  const memoryExp = generateSuspensionExplanation(
    {
      tabId: 6,
      score: 60.0,
      priorityLevel: TabSuspensionPriority.URGENT,
      priorityLabel: "Urgent Priority",
      isEligible: true,
      factors: {
        idleMinutes: 30,
        idleScore: 30.0,
        memoryModifier: 30.0
      }
    },
    { trigger: "memory_pressure" }
  );
  assert.equal(memoryExp.primaryReason, "memory_pressure");
  assert.match(memoryExp.headline, /Suspended to relieve memory pressure/);
  assert.ok(memoryExp.contributingFactors.some(f => f.includes("Elevated system memory pressure")));

  // 3. LRU tab limit explanation
  const lruExp = generateSuspensionExplanation(
    {
      tabId: 7,
      score: 25.0,
      priorityLevel: TabSuspensionPriority.MEDIUM,
      priorityLabel: "Medium Priority",
      isEligible: true,
      factors: { idleMinutes: 25 }
    },
    { trigger: "lru_quota" }
  );
  assert.equal(lruExp.primaryReason, "lru_quota");
  assert.match(lruExp.headline, /Suspended by tab limit policy/);

  // 4. Protected tab explanation
  const protectedExp = generateSuspensionExplanation(
    {
      tabId: 8,
      score: 0,
      isEligible: false,
      protectionReason: TabProtectionReason.AUDIBLE
    }
  );
  assert.equal(protectedExp.primaryReason, "protected");
  assert.equal(protectedExp.priorityLevel, TabSuspensionPriority.IMMUNE);
  assert.match(protectedExp.headline, /Tab is protected from suspension/);
  assert.match(protectedExp.fullNarrative, /audible/);
});

test("calculateTabSuspensionScore and dryRunSuspensionEvaluation include explanation automatically", () => {
  const tab = { id: 99, url: "https://example.org/article", active: false, pinned: false };
  const meta = { lastActiveAt: Date.now() - 50 * 60000 };
  const scored = calculateTabSuspensionScore(tab, meta);

  assert.ok(scored.explanation);
  assert.equal(typeof scored.explanation.headline, "string");
  assert.equal(typeof scored.explanation.fullNarrative, "string");
  assert.equal(scored.explanation.priorityLevel, scored.priorityLevel);
  assert.equal(scored.explanation.score, scored.score);

  const dryRunReport = dryRunSuspensionEvaluation([tab], new Map([[99, meta]]));
  assert.equal(dryRunReport.projectedSuspensions.length, 1);
  assert.ok(dryRunReport.projectedSuspensions[0].explanation);
  assert.equal(dryRunReport.projectedSuspensions[0].explanation.headline, scored.explanation.headline);
});





