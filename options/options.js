// TabVault options page

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => root.querySelectorAll(sel);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

let SETTINGS = null;
let dirty = false;

// ─── Toast ──────────────────────────────────────────────────────────────────
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => { t.hidden = true; }, 250);
  }, 1800);
}

// ─── Save (debounced) ───────────────────────────────────────────────────────
let saveTimer = null;
function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await send({ type: "replace-settings", settings: SETTINGS });
    dirty = false;
    toast("Saved");
  }, 350);
}

// ─── Load & render ──────────────────────────────────────────────────────────
async function load() {
  const res = await send({ type: "get-settings" });
  SETTINGS = res.data;
  renderAll();
  loadStats();
  loadSessions();
  loadMemoryInfo();
  loadDashboardOverview();
  loadTabGroups();
  loadActiveTabs();
  loadSuspendedTabs();
  loadRecentlySuspended();
  loadRecentlyRestored();
  loadRestoreFailures();

  // Welcome banner
  if (new URLSearchParams(window.location.search).get("welcome") === "1") {
    $("welcome").hidden = false;
  }

  loadCrashRecoverySummary();
}

// ─── Crash recovery banner ──────────────────────────────────────────────────
async function loadCrashRecoverySummary() {
  try {
    const res = await send({ type: "get-crash-recovery-summary" });
    const summary = res?.summary;
    if (!summary) return;

    const parts = [];
    if (summary.recoveredSnapshots) parts.push(`${summary.recoveredSnapshots} interrupted snapshot${summary.recoveredSnapshots === 1 ? "" : "s"}`);
    if (summary.recoveredRestorations) parts.push(`${summary.recoveredRestorations} interrupted restoration${summary.recoveredRestorations === 1 ? "" : "s"}`);
    if (summary.orphanCount) parts.push(`${summary.orphanCount} tab record${summary.orphanCount === 1 ? "" : "s"} that couldn't be re-matched`);
    if (parts.length === 0) return;

    $("recovery-banner-detail").textContent = `We recovered ${parts.join(", ")}.`;
    $("recovery-banner").hidden = false;
  } catch (_) { /* non-critical */ }
}

function updateWelcomeMinutes() {
  const el = $("welcome-minutes");
  if (el) el.textContent = SETTINGS.suspendAfterMinutes;
}

function renderAll() {
  // General
  $("opt-enabled").checked = SETTINGS.enabled;
  $("opt-minutes").value = SETTINGS.suspendAfterMinutes;
  $("opt-strategy").value = SETTINGS.strategy;
  updateWelcomeMinutes();

  // Never suspend
  $("ns-pinned").checked = SETTINGS.neverSuspend.pinned;
  $("ns-audible").checked = SETTINGS.neverSuspend.audible;
  $("ns-incall").checked = SETTINGS.neverSuspend.inCall;
  $("ns-form").checked = SETTINGS.neverSuspend.hasFormInput;
  $("ns-offline").checked = SETTINGS.neverSuspend.offline;
  $("ns-active").checked = SETTINGS.neverSuspend.activeInAnyWindow;
  $("ns-only").checked = SETTINGS.neverSuspend.onlyTabInWindow;
  $("ns-power").checked = SETTINGS.neverSuspend.onPowerSource;
  $("ns-group").checked = SETTINGS.neverSuspend.inTabGroup;

  // Filters
  renderRuleList("whitelist", SETTINGS.whitelist);
  renderRuleList("blacklist", SETTINGS.blacklist);
  renderPerDomain(SETTINGS.perDomainRules);
  refreshGroupTitles();

  // Schedule
  $("sch-enabled").checked = SETTINGS.schedule.enabled;
  $$('input[type="checkbox"]', $("sch-days")).forEach(cb => {
    cb.checked = SETTINGS.schedule.days.includes(Number(cb.value));
  });
  $("sch-start").value = SETTINGS.schedule.workStart;
  $("sch-end").value = SETTINGS.schedule.workEnd;
  $("sch-work-min").value = SETTINGS.schedule.workSuspendAfterMinutes;
  $("sch-off-min").value = SETTINGS.schedule.offSuspendAfterMinutes;

  // Power & memory
  $("pow-aggro").checked = SETTINGS.power.aggressiveOnBattery;
  $("pow-bat-min").value = SETTINGS.power.batterySuspendAfterMinutes;
  $("mem-enabled").checked = SETTINGS.memoryPressure.enabled;
  $("mem-threshold").value = SETTINGS.memoryPressure.thresholdMB;
  $("mem-min").value = SETTINGS.memoryPressure.aggressiveSuspendAfterMinutes;

  // Smart
  $("smart-enabled").checked = SETTINGS.smart.enabled;
  $("smart-freq").value = SETTINGS.smart.frequentTabMultiplier;
  $("smart-rare").value = SETTINGS.smart.rareTabMultiplier;
  $("smart-visits").value = SETTINGS.smart.visitsThreshold;

  // Appearance
  $("ap-theme").value = SETTINGS.appearance.theme;
  $("ap-accent").value = SETTINGS.appearance.accent;
  $("ap-lastvisit").checked = SETTINGS.appearance.showLastVisited;
  $("ap-hint").checked = SETTINGS.appearance.showRestoreHint;
  $("ap-autorestore").checked = SETTINGS.appearance.autoRestoreOnFocus;
  $("ap-message").value = SETTINGS.appearance.customMessage || "";

  // Site adapters
  if ($("opt-adapters-enabled")) {
    $("opt-adapters-enabled").checked = SETTINGS.adapters ? SETTINGS.adapters.enabled !== false : true;
    renderAdapterList();
  }
}

const KNOWN_ADAPTERS = [
  { id: "youtube", name: "YouTube", desc: "Playback timestamp & video state" },
  { id: "github", name: "GitHub", desc: "Issue filters, PR tabs & review states" },
  { id: "jira", name: "Jira", desc: "Board columns, quick filters & backlog query" },
  { id: "gdocs", name: "Google Docs", desc: "Document scroll heading & cursor location" },
  { id: "notion", name: "Notion", desc: "Page breadcrumbs & active view block" },
  { id: "search", name: "Search Engines", desc: "Google/Bing/DDG queries & pagination" },
  { id: "generic", name: "Generic URL/Hash", desc: "Dynamic SPA deep links & query restoration" }
];

function renderAdapterList() {
  const container = $("adapters-list");
  if (!container) return;
  container.innerHTML = "";

  const disabled = Array.isArray(SETTINGS.adapters?.disabledAdapters)
    ? SETTINGS.adapters.disabledAdapters
    : [];
  const globallyEnabled = SETTINGS.adapters ? SETTINGS.adapters.enabled !== false : true;

  KNOWN_ADAPTERS.forEach(adapter => {
    const label = document.createElement("label");
    label.className = "toggle-card";
    const isChecked = globallyEnabled && !disabled.includes(adapter.id);

    label.innerHTML = `
      <div class="toggle-card-hd" style="display:flex;justify-content:space-between;align-items:center;">
        <span class="toggle-card-title" style="font-weight:600;">${adapter.name}</span>
        <input type="checkbox" class="adapter-toggle" data-id="${adapter.id}" ${isChecked ? "checked" : ""} ${!globallyEnabled ? "disabled" : ""} />
      </div>
      <div class="toggle-card-desc" style="font-size:12px;color:var(--text-muted);margin-top:4px;">${adapter.desc}</div>
    `;

    const checkbox = label.querySelector("input");
    checkbox.addEventListener("change", () => {
      SETTINGS.adapters = SETTINGS.adapters || { enabled: true, disabledAdapters: [] };
      const set = new Set(SETTINGS.adapters.disabledAdapters || []);
      if (checkbox.checked) {
        set.delete(adapter.id);
      } else {
        set.add(adapter.id);
      }
      SETTINGS.adapters.disabledAdapters = Array.from(set);
      scheduleSave();
    });

    container.appendChild(label);
  });
}

// ─── Rule list rendering ────────────────────────────────────────────────────
function renderRuleList(elId, rules) {
  const ul = $(elId);
  ul.innerHTML = "";
  rules.forEach((r, i) => ul.appendChild(buildRuleNode(r, i, elId)));
  if (rules.length === 0) {
    const empty = document.createElement("li");
    empty.className = "rule-empty";
    empty.style.cssText = "padding:14px;color:var(--text-faint);font-size:12.5px;font-style:italic;text-align:center;";
    empty.textContent = "No entries yet. Click + Add entry to get started.";
    ul.appendChild(empty);
  }
}

// Populate the <datalist id="group-titles"> with current Chrome tab-group titles
// so users get autocomplete when authoring group-targeted rules.
async function refreshGroupTitles() {
  const dl = $("group-titles");
  if (!dl) return;
  let groups = [];
  try { groups = await chrome.tabGroups.query({}); } catch { /* tabGroups missing on some forks */ }
  const seen = new Set();
  dl.innerHTML = "";
  for (const g of groups) {
    const title = (g.title || "").trim();
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const opt = document.createElement("option");
    opt.value = title;
    dl.appendChild(opt);
  }
}

// Mode options shown depend on whether the rule targets a URL or a tab-group title.
const MODES_URL = [
  ["domain",     "domain"],
  ["startsWith", "starts with"],
  ["endsWith",   "ends with"],
  ["contains",   "contains"],
  ["exact",      "exact"],
  ["glob",       "glob"],
  ["regex",      "regex"],
];
const MODES_GROUP = [
  ["exact",    "exact"],
  ["contains", "contains"],
];

function applyModeOptions(modeSelect, target, currentValue) {
  const opts = target === "group" ? MODES_GROUP : MODES_URL;
  modeSelect.innerHTML = "";
  for (const [value, label] of opts) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    modeSelect.appendChild(o);
  }
  // Pick the previous mode if it's still valid; otherwise fall back to the first option.
  const valid = opts.some(([v]) => v === currentValue);
  modeSelect.value = valid ? currentValue : opts[0][0];
}

function buildRuleNode(rule, index, listKey) {
  const tpl = $("tpl-rule");
  const node = tpl.content.firstElementChild.cloneNode(true);
  const enabled = node.querySelector(".r-enabled");
  const target  = node.querySelector(".r-target");
  const mode    = node.querySelector(".r-mode");
  const value   = node.querySelector(".r-value");
  const del     = node.querySelector(".r-del");

  enabled.checked = rule.enabled !== false;
  target.value = rule.target || "url";
  applyModeOptions(mode, target.value, rule.mode || (target.value === "group" ? "exact" : "domain"));
  value.value = rule.value || "";
  value.placeholder = target.value === "group" ? "tab group title" : "value";

  enabled.addEventListener("change", () => {
    SETTINGS[listKey][index].enabled = enabled.checked;
    scheduleSave();
  });
  target.addEventListener("change", () => {
    SETTINGS[listKey][index].target = target.value;
    applyModeOptions(mode, target.value, mode.value);
    SETTINGS[listKey][index].mode = mode.value;
    value.placeholder = target.value === "group" ? "tab group title" : "value";
    scheduleSave();
  });
  mode.addEventListener("change", () => {
    SETTINGS[listKey][index].mode = mode.value;
    scheduleSave();
  });
  value.addEventListener("input", () => {
    SETTINGS[listKey][index].value = value.value.trim();
    scheduleSave();
  });
  del.addEventListener("click", () => {
    SETTINGS[listKey].splice(index, 1);
    renderRuleList(listKey, SETTINGS[listKey]);
    scheduleSave();
  });

  return node;
}

function renderPerDomain(rules) {
  const ul = $("perdomain");
  ul.innerHTML = "";
  rules.forEach((r, i) => ul.appendChild(buildPdNode(r, i)));
  if (rules.length === 0) {
    const empty = document.createElement("li");
    empty.className = "rule-empty";
    empty.style.cssText = "padding:14px;color:var(--text-faint);font-size:12.5px;font-style:italic;text-align:center;";
    empty.textContent = "No per-domain rules. The General timer applies to everything.";
    ul.appendChild(empty);
  }
}

function buildPdNode(rule, index) {
  const tpl = $("tpl-pd");
  const node = tpl.content.firstElementChild.cloneNode(true);
  const enabled = node.querySelector(".r-enabled");
  const target  = node.querySelector(".r-target");
  const mode    = node.querySelector(".r-mode");
  const value   = node.querySelector(".r-value");
  const action  = node.querySelector(".r-action");
  const min     = node.querySelector(".r-min");
  const del     = node.querySelector(".r-del");

  enabled.checked = rule.enabled !== false;
  target.value = rule.target || "url";
  applyModeOptions(mode, target.value, rule.mode || (target.value === "group" ? "exact" : "domain"));
  value.value = rule.value || rule.pattern || "";
  value.placeholder = target.value === "group" ? "tab group title" : "pattern";
  action.value = rule.neverSuspend ? "never" : "custom";
  min.value = rule.suspendAfterMinutes ?? 30;
  min.disabled = rule.neverSuspend;

  enabled.addEventListener("change", () => {
    SETTINGS.perDomainRules[index].enabled = enabled.checked;
    scheduleSave();
  });
  target.addEventListener("change", () => {
    SETTINGS.perDomainRules[index].target = target.value;
    applyModeOptions(mode, target.value, mode.value);
    SETTINGS.perDomainRules[index].mode = mode.value;
    value.placeholder = target.value === "group" ? "tab group title" : "pattern";
    scheduleSave();
  });
  mode.addEventListener("change", () => {
    SETTINGS.perDomainRules[index].mode = mode.value;
    scheduleSave();
  });
  value.addEventListener("input", () => {
    SETTINGS.perDomainRules[index].value = value.value.trim();
    scheduleSave();
  });
  action.addEventListener("change", () => {
    const isNever = action.value === "never";
    SETTINGS.perDomainRules[index].neverSuspend = isNever;
    min.disabled = isNever;
    scheduleSave();
  });
  min.addEventListener("input", () => {
    SETTINGS.perDomainRules[index].suspendAfterMinutes = Number(min.value);
    scheduleSave();
  });
  del.addEventListener("click", () => {
    SETTINGS.perDomainRules.splice(index, 1);
    renderPerDomain(SETTINGS.perDomainRules);
    scheduleSave();
  });

  return node;
}

// ─── Wire controls ──────────────────────────────────────────────────────────
function wire() {
  const recoveryDismiss = $("recovery-banner-dismiss");
  if (recoveryDismiss) {
    recoveryDismiss.addEventListener("click", async () => {
      $("recovery-banner").hidden = true;
      try { await send({ type: "dismiss-crash-recovery-summary" }); } catch (_) {}
    });
  }

  // Dashboard
  let activeTabsDebounce = null;
  const activeSearch = $("dash-active-search");
  if (activeSearch) {
    activeSearch.addEventListener("input", () => {
      clearTimeout(activeTabsDebounce);
      activeTabsDebounce = setTimeout(() => {
        loadActiveTabs();
      }, 250);
    });
  }
  const activeSort = $("dash-active-sort");
  if (activeSort) {
    activeSort.addEventListener("change", () => {
      loadActiveTabs();
    });
  }
  const activeGroup = $("dash-active-group-filter");
  if (activeGroup) {
    activeGroup.addEventListener("change", () => {
      loadActiveTabs();
    });
  }
  const activeSnapshot = $("dash-active-snapshot-filter");
  if (activeSnapshot) {
    activeSnapshot.addEventListener("change", () => {
      loadActiveTabs();
    });
  }
  const suspendAllEligibleBtn = $("dash-suspend-all-eligible");
  if (suspendAllEligibleBtn) {
    suspendAllEligibleBtn.addEventListener("click", async () => {
      suspendAllEligibleBtn.disabled = true;
      suspendAllEligibleBtn.textContent = "Suspending...";
      try {
        const res = await send({ type: "suspend-all-eligible" });
        if (res?.ok) {
          toast(`Suspended ${res.count || 0} eligible tab${res?.count === 1 ? "" : "s"}`);
        } else {
          toast(res?.error || "Could not suspend eligible tabs", "error");
        }
      } catch (err) {
        toast("Error suspending eligible tabs: " + (err?.message || err), "error");
      }
      await loadDashboardOverview();
      await loadTabGroups();
      await loadActiveTabs();
      await loadSuspendedTabs();
      await loadRecentlySuspended();
    });
  }

  let suspendedTabsDebounce = null;
  const suspendedSearch = $("dash-suspended-search");
  if (suspendedSearch) {
    suspendedSearch.addEventListener("input", () => {
      clearTimeout(suspendedTabsDebounce);
      suspendedTabsDebounce = setTimeout(() => {
        loadSuspendedTabs();
      }, 250);
    });
  }
  const suspendedSort = $("dash-suspended-sort");
  if (suspendedSort) {
    suspendedSort.addEventListener("change", () => {
      loadSuspendedTabs();
    });
  }
  const suspendedGroup = $("dash-suspended-group-filter");
  if (suspendedGroup) {
    suspendedGroup.addEventListener("change", () => {
      loadSuspendedTabs();
    });
  }
  const suspendedReason = $("dash-suspended-reason-filter");
  if (suspendedReason) {
    suspendedReason.addEventListener("change", () => {
      loadSuspendedTabs();
    });
  }
  const suspendedSnapshot = $("dash-suspended-snapshot-filter");
  if (suspendedSnapshot) {
    suspendedSnapshot.addEventListener("change", () => {
      loadSuspendedTabs();
    });
  }
  const restoreAllBtn = $("dash-restore-all");
  if (restoreAllBtn) {
    restoreAllBtn.addEventListener("click", async () => {
      restoreAllBtn.disabled = true;
      restoreAllBtn.textContent = "Restoring...";
      try {
        const res = await send({ type: "restore-all", options: { source: "batch", priority: 10 } });
        if (res?.ok) {
          toast(`Restored ${res.count || 0} suspended tab${res?.count === 1 ? "" : "s"}`);
        } else {
          toast(res?.error || "Could not restore all tabs", "error");
        }
      } catch (err) {
        toast("Error restoring tabs: " + (err?.message || err), "error");
      }
      await loadDashboardOverview();
      await loadTabGroups();
      await loadActiveTabs();
      await loadSuspendedTabs();
      await loadRecentlySuspended();
      await loadRecentlyRestored();
    });
  }

  let recentSuspendedDebounce = null;
  const recentSearch = $("dash-recent-suspended-search");
  if (recentSearch) {
    recentSearch.addEventListener("input", () => {
      clearTimeout(recentSuspendedDebounce);
      recentSuspendedDebounce = setTimeout(() => {
        loadRecentlySuspended();
      }, 250);
    });
  }

  const recentClear = $("dash-recent-suspended-clear");
  if (recentClear) {
    recentClear.addEventListener("click", async () => {
      if (confirm("Clear recent suspension history?")) {
        await send({ type: "clear-recently-suspended" });
        toast("Suspension history cleared");
        await loadRecentlySuspended();
      }
    });
  }

  let recentRestoredDebounce = null;
  const restoredSearch = $("dash-recent-restored-search");
  if (restoredSearch) {
    restoredSearch.addEventListener("input", () => {
      clearTimeout(recentRestoredDebounce);
      recentRestoredDebounce = setTimeout(() => {
        loadRecentlyRestored();
      }, 250);
    });
  }

  const restoredClear = $("dash-recent-restored-clear");
  if (restoredClear) {
    restoredClear.addEventListener("click", async () => {
      if (confirm("Clear recent restoration history?")) {
        await send({ type: "clear-recently-restored" });
        toast("Restoration history cleared");
        await loadRecentlyRestored();
      }
    });
  }

  let failuresDebounce = null;
  const failuresSearch = $("dash-failures-search");
  if (failuresSearch) {
    failuresSearch.addEventListener("input", () => {
      clearTimeout(failuresDebounce);
      failuresDebounce = setTimeout(() => {
        loadRestoreFailures();
      }, 250);
    });
  }

  const failuresSort = $("dash-failures-sort");
  if (failuresSort) {
    failuresSort.addEventListener("change", () => {
      loadRestoreFailures();
    });
  }

  const failuresRetryAll = $("dash-failures-retry-all");
  if (failuresRetryAll) {
    failuresRetryAll.addEventListener("click", async () => {
      failuresRetryAll.disabled = true;
      failuresRetryAll.textContent = "Retrying...";
      await send({ type: "retry-all-failed" });
      toast("Retrying all failed restorations...");
      await loadRestoreFailures();
      await loadDashboardOverview();
      await loadActiveTabs();
      await loadSuspendedTabs();
      failuresRetryAll.disabled = false;
      failuresRetryAll.textContent = "Retry All";
    });
  }

  const failuresClear = $("dash-failures-clear");
  if (failuresClear) {
    failuresClear.addEventListener("click", async () => {
      if (confirm("Clear all restoration failure records?")) {
        await send({ type: "clear-restore-failures" });
        toast("Restoration failures cleared");
        await loadRestoreFailures();
        await loadDashboardOverview();
      }
    });
  }

  // Snapshot preview modal
  const snapClose = $("snap-modal-close");
  if (snapClose) snapClose.addEventListener("click", closeSnapshotModal);
  const snapDone = $("snap-modal-done-btn");
  if (snapDone) snapDone.addEventListener("click", closeSnapshotModal);
  const snapModal = $("snapshot-modal");
  if (snapModal) {
    snapModal.addEventListener("click", (e) => {
      if (e.target === snapModal) closeSnapshotModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && snapModal && !snapModal.hidden) {
      closeSnapshotModal();
    }
  });

  // General
  $("opt-enabled").addEventListener("change", () => { SETTINGS.enabled = $("opt-enabled").checked; scheduleSave(); });
  $("opt-minutes").addEventListener("input", () => { SETTINGS.suspendAfterMinutes = clampInt($("opt-minutes").value, 1, 1440, 30); updateWelcomeMinutes(); scheduleSave(); });
  $("opt-strategy").addEventListener("change", () => { SETTINGS.strategy = $("opt-strategy").value; scheduleSave(); });

  // Never suspend
  const nsMap = {
    "ns-pinned": "pinned",
    "ns-audible": "audible",
    "ns-incall": "inCall",
    "ns-form": "hasFormInput",
    "ns-offline": "offline",
    "ns-active": "activeInAnyWindow",
    "ns-only": "onlyTabInWindow",
    "ns-power": "onPowerSource",
    "ns-group": "inTabGroup"
  };
  for (const [id, key] of Object.entries(nsMap)) {
    $(id).addEventListener("change", () => {
      SETTINGS.neverSuspend[key] = $(id).checked;
      scheduleSave();
    });
  }

  // Filters
  $("add-whitelist").addEventListener("click", () => {
    SETTINGS.whitelist.push({ target: "url", mode: "domain", value: "", enabled: true });
    renderRuleList("whitelist", SETTINGS.whitelist);
    refreshGroupTitles();
    scheduleSave();
  });
  $("add-blacklist").addEventListener("click", () => {
    SETTINGS.blacklist.push({ target: "url", mode: "domain", value: "", enabled: true });
    renderRuleList("blacklist", SETTINGS.blacklist);
    refreshGroupTitles();
    scheduleSave();
  });
  $("add-perdomain").addEventListener("click", () => {
    SETTINGS.perDomainRules.push({ target: "url", mode: "domain", value: "", enabled: true, neverSuspend: false, suspendAfterMinutes: 60 });
    renderPerDomain(SETTINGS.perDomainRules);
    refreshGroupTitles();
    scheduleSave();
  });

  // Schedule
  $("sch-enabled").addEventListener("change", () => { SETTINGS.schedule.enabled = $("sch-enabled").checked; scheduleSave(); });
  $$("input[type='checkbox']", $("sch-days")).forEach(cb => {
    cb.addEventListener("change", () => {
      const day = Number(cb.value);
      if (cb.checked && !SETTINGS.schedule.days.includes(day)) SETTINGS.schedule.days.push(day);
      else if (!cb.checked) SETTINGS.schedule.days = SETTINGS.schedule.days.filter(d => d !== day);
      scheduleSave();
    });
  });
  $("sch-start").addEventListener("change", () => { SETTINGS.schedule.workStart = $("sch-start").value; scheduleSave(); });
  $("sch-end").addEventListener("change", () => { SETTINGS.schedule.workEnd = $("sch-end").value; scheduleSave(); });
  $("sch-work-min").addEventListener("input", () => { SETTINGS.schedule.workSuspendAfterMinutes = clampInt($("sch-work-min").value, 1, 1440, 15); scheduleSave(); });
  $("sch-off-min").addEventListener("input", () => { SETTINGS.schedule.offSuspendAfterMinutes = clampInt($("sch-off-min").value, 1, 1440, 90); scheduleSave(); });

  // Power & memory
  $("pow-aggro").addEventListener("change", () => { SETTINGS.power.aggressiveOnBattery = $("pow-aggro").checked; scheduleSave(); });
  $("pow-bat-min").addEventListener("input", () => { SETTINGS.power.batterySuspendAfterMinutes = clampInt($("pow-bat-min").value, 1, 1440, 10); scheduleSave(); });
  $("mem-enabled").addEventListener("change", () => { SETTINGS.memoryPressure.enabled = $("mem-enabled").checked; scheduleSave(); });
  $("mem-threshold").addEventListener("input", () => { SETTINGS.memoryPressure.thresholdMB = clampInt($("mem-threshold").value, 256, 65536, 4096); scheduleSave(); });
  $("mem-min").addEventListener("input", () => { SETTINGS.memoryPressure.aggressiveSuspendAfterMinutes = clampInt($("mem-min").value, 1, 1440, 5); scheduleSave(); });

  // Smart
  $("smart-enabled").addEventListener("change", () => { SETTINGS.smart.enabled = $("smart-enabled").checked; scheduleSave(); });
  $("smart-freq").addEventListener("input", () => { SETTINGS.smart.frequentTabMultiplier = clampFloat($("smart-freq").value, 1, 10, 2); scheduleSave(); });
  $("smart-rare").addEventListener("input", () => { SETTINGS.smart.rareTabMultiplier = clampFloat($("smart-rare").value, 0.1, 2, 0.6); scheduleSave(); });
  $("smart-visits").addEventListener("input", () => { SETTINGS.smart.visitsThreshold = clampInt($("smart-visits").value, 2, 100, 5); scheduleSave(); });

  // Appearance
  $("ap-theme").addEventListener("change", () => { SETTINGS.appearance.theme = $("ap-theme").value; scheduleSave(); });
  $("ap-accent").addEventListener("input", () => { SETTINGS.appearance.accent = $("ap-accent").value; scheduleSave(); });
  $("ap-lastvisit").addEventListener("change", () => { SETTINGS.appearance.showLastVisited = $("ap-lastvisit").checked; scheduleSave(); });
  $("ap-hint").addEventListener("change", () => { SETTINGS.appearance.showRestoreHint = $("ap-hint").checked; scheduleSave(); });
  $("ap-autorestore").addEventListener("change", () => { SETTINGS.appearance.autoRestoreOnFocus = $("ap-autorestore").checked; scheduleSave(); });
  $("ap-message").addEventListener("input", () => { SETTINGS.appearance.customMessage = $("ap-message").value; scheduleSave(); });

  // Site adapters
  if ($("opt-adapters-enabled")) {
    $("opt-adapters-enabled").addEventListener("change", () => {
      SETTINGS.adapters = SETTINGS.adapters || { enabled: true, disabledAdapters: [] };
      SETTINGS.adapters.enabled = $("opt-adapters-enabled").checked;
      scheduleSave();
      renderAdapterList();
    });
  }

  // Sessions
  $("save-session").addEventListener("click", saveSession);
  const expAllSessions = $("export-all-sessions");
  if (expAllSessions) {
    expAllSessions.addEventListener("click", async () => {
      const res = await send({ type: "export-session", all: true });
      if (res?.ok && res.json) {
        const blob = new Blob([res.json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = res.filename || "tabvault-all-sessions.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast(`Exported ${res.payload?.totalSessions || 0} sessions`);
      } else {
        toast(res?.error || "Could not export sessions", "error");
      }
    });
  }
  const importSessionBtn = $("import-session-btn");
  const importSessionFile = $("import-session-file");
  if (importSessionBtn && importSessionFile) {
    importSessionBtn.addEventListener("click", () => {
      importSessionFile.click();
    });
    importSessionFile.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = await send({ type: "import-session", payload: text });
        if (res?.ok) {
          toast(`Imported ${res.importedCount || 1} session(s)`);
          await loadSessions();
        } else {
          toast(res?.error || "Failed to import session", "error");
        }
      } catch (err) {
        toast("Error reading session file: " + (err?.message || err), "error");
      }
      importSessionFile.value = "";
    });
  }

  // Stats
  $("reset-stats").addEventListener("click", async () => {
    if (!confirm("Clear all suspension statistics?")) return;
    await send({ type: "reset-stats" });
    loadStats();
    toast("Stats reset");
  });

  // Shortcuts
  $("open-shortcuts").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  // Data
  $("export-btn").addEventListener("click", exportSettings);
  $("import-file").addEventListener("change", importSettings);
  $("reset-all").addEventListener("click", async () => {
    if (!confirm("This will erase all rules, stats, sessions, and settings. Continue?")) return;
    await chrome.storage.local.clear();
    location.reload();
  });

  // Sidebar nav highlighting
  setupNav();
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function clampFloat(v, min, max, fallback) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ─── Sidebar nav highlight on scroll ────────────────────────────────────────
function setupNav() {
  const items = Array.from($$(".nav-item"));

  // Map nav-item element → panel element. The href is "#general" but the
  // panel id is "general-panel", so we add the suffix when looking it up.
  const pairs = items.map(a => {
    const target = a.getAttribute("href") || "";
    const panelId = target.replace(/^#/, "") + "-panel";
    return { item: a, panel: document.getElementById(panelId) };
  }).filter(p => p.panel);

  // Click handler — scroll the panel into view and mark the item active.
  // We call preventDefault so the browser doesn't jump to a non-existent #id
  // (the href is "#general" but the actual id on the panel is "general-panel").
  pairs.forEach(({ item, panel }) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      items.forEach(x => x.classList.remove("active"));
      item.classList.add("active");
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
      // Reflect the section in the URL without triggering a jump
      history.replaceState(null, "", item.getAttribute("href"));
    });
  });

  // Highlight on scroll — pick the panel whose top is closest to (but above)
  // a band 30% from the top of the viewport.
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter(e => e.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible[0]) {
      const panelId = visible[0].target.id;
      const pair = pairs.find(p => p.panel.id === panelId);
      if (pair) {
        items.forEach(x => x.classList.remove("active"));
        pair.item.classList.add("active");
      }
    }
  }, { rootMargin: "-20% 0px -70% 0px", threshold: 0 });

  pairs.forEach(p => observer.observe(p.panel));

  // If the page loaded with a hash, jump there now (after fonts/layout settle)
  if (window.location.hash) {
    const target = window.location.hash.replace(/^#/, "") + "-panel";
    const panel = document.getElementById(target);
    if (panel) {
      requestAnimationFrame(() => panel.scrollIntoView({ block: "start" }));
    }
  }
}

// ─── Stats ──────────────────────────────────────────────────────────────────
async function loadStats() {
  const stats = (await send({ type: "get-stats" }))?.data;
  if (!stats) return;
  $("bs-suspensions").textContent = String(stats.totalSuspensions || 0);
  $("bs-saved").textContent = formatBytes(stats.estimatedBytesSaved || 0);
  $("bs-restored").textContent = String(stats.totalRestorations || 0);
  $("bs-since").textContent = stats.installedAt ? new Date(stats.installedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

  const ul = $("top-domains");
  ul.innerHTML = "";
  const entries = Object.entries(stats.byDomain || {})
    .sort((a, b) => b[1].suspensions - a[1].suspensions)
    .slice(0, 10);
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.style.cssText = "color:var(--text-faint);font-style:italic;justify-content:center;";
    li.textContent = "No data yet — keep browsing.";
    ul.appendChild(li);
  } else {
    for (const [host, info] of entries) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="dom">${escapeHtml(host)}</span><span class="cnt">${info.suspensions} suspensions</span>`;
      ul.appendChild(li);
    }
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&": "&amp;","<": "&lt;",">": "&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ─── Sessions ───────────────────────────────────────────────────────────────
async function saveSession() {
  const name = prompt("Name this session:", `Session ${new Date().toLocaleString()}`);
  if (!name) return;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const stripped = tabs.map(t => {
    let url = t.url;
    // If suspended, store the original
    const susp = chrome.runtime.getURL("suspended/");
    if (url && url.startsWith(susp)) {
      const params = new URLSearchParams(url.split("#")[1] || "");
      url = params.get("u") || url;
    }
    return { title: t.title, url, favIconUrl: t.favIconUrl, pinned: t.pinned };
  });
  await send({ type: "save-session", name, tabs: stripped });
  loadSessions();
  toast("Session saved");
}

async function loadSessions() {
  const res = await send({ type: "list-sessions" });
  const list = res?.data || [];
  const ul = $("session-list");
  ul.innerHTML = "";
  if (list.length === 0) {
    const li = document.createElement("li");
    li.style.cssText = "justify-content:center;color:var(--text-faint);font-style:italic;";
    li.textContent = "No saved sessions.";
    ul.appendChild(li);
    return;
  }
  list.forEach((s, i) => {
    const li = document.createElement("li");
    const left = document.createElement("div");
    left.innerHTML = `<div class="s-name">${escapeHtml(s.name)}</div><div class="s-meta">${s.tabs.length} tabs · ${new Date(s.savedAt).toLocaleString()}</div>`;
    const right = document.createElement("div");
    right.className = "s-actions";

    const restoreBtn = document.createElement("button");
    restoreBtn.className = "btn primary-btn";
    restoreBtn.textContent = "Open";
    restoreBtn.addEventListener("click", async () => {
      for (const t of s.tabs) {
        await chrome.tabs.create({ url: t.url, pinned: t.pinned, active: false });
      }
      toast(`Opened ${s.tabs.length} tabs`);
    });

    const expBtn = document.createElement("button");
    expBtn.className = "btn";
    expBtn.textContent = "Export";
    expBtn.title = `Export session "${s.name}" to JSON file`;
    expBtn.addEventListener("click", async () => {
      const res = await send({ type: "export-session", index: i });
      if (res?.ok && res.json) {
        const blob = new Blob([res.json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = res.filename || `tabvault-session-${i}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast(`Exported session: ${s.name}`);
      } else {
        toast(res?.error || "Could not export session", "error");
      }
    });

    const delBtn = document.createElement("button");
    delBtn.className = "btn danger-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete session "${s.name}"?`)) return;
      await send({ type: "delete-session", index: i });
      loadSessions();
      toast("Session deleted");
    });

    right.appendChild(restoreBtn);
    right.appendChild(expBtn);
    right.appendChild(delBtn);
    li.appendChild(left);
    li.appendChild(right);
    ul.appendChild(li);
  });
}

// ─── Dashboard ──────────────────────────────────────────────────────────────
async function loadDashboardOverview() {
  const cards = $("dashboard-overview-cards");
  if (!cards) return;
  try {
    const res = await send({ type: "get-dashboard-overview" });
    if (res?.ok && res?.data) {
      const data = res.data;
      if ($("dash-active-count")) $("dash-active-count").textContent = String(data.activeCount ?? 0);
      if ($("dash-suspended-count")) $("dash-suspended-count").textContent = String(data.suspendedCount ?? 0);
      if ($("dash-mem-saved")) $("dash-mem-saved").textContent = data.totalMemorySavedFormatted || "0 MB";
      if ($("dash-active-mem")) $("dash-active-mem").textContent = data.totalActiveMemoryFormatted || "0 MB";
      if ($("dash-snapshot-coverage")) {
        const snap = data.snapshotAvailability;
        const pct = snap?.suspendedCoveragePercentage ?? 100;
        $("dash-snapshot-coverage").textContent = `${pct}%`;
        $("dash-snapshot-coverage").title = `${snap?.suspendedWithSnapshots ?? 0} of ${snap?.suspendedTabsCount ?? 0} suspended tabs have snapshots (${snap?.tabsWithSnapshots ?? 0} total saved)`;
      }
      if ($("dash-failures-badge") && data.restoreFailuresCount !== undefined) {
        $("dash-failures-badge").textContent = `${data.restoreFailuresCount || 0} failure${data.restoreFailuresCount === 1 ? "" : "s"}`;
      }

      // Detailed Memory Savings breakdown
      if ($("dash-savings-pct-badge")) $("dash-savings-pct-badge").textContent = `${data.savingsPercentage || 0}% saved`;
      if ($("dash-savings-bar")) $("dash-savings-bar").style.width = `${Math.min(100, data.savingsPercentage || 0)}%`;
      if ($("dash-lifetime-saved")) $("dash-lifetime-saved").textContent = `Lifetime saved: ${data.lifetimeMemorySavedFormatted || "0 MB"}`;
      if ($("dash-savings-current")) $("dash-savings-current").textContent = data.totalMemorySavedFormatted || "0 MB";
      if ($("dash-savings-active")) $("dash-savings-active").textContent = data.totalActiveMemoryFormatted || "0 MB";
      if ($("dash-savings-avg")) $("dash-savings-avg").textContent = data.averageSavedPerTabFormatted || "0 MB";

      // Domain savings list
      const domainWrap = $("dash-domain-savings-wrap");
      const domainList = $("dash-domain-savings-list");
      if (domainWrap && domainList) {
        if (Array.isArray(data.topDomainSavings) && data.topDomainSavings.length > 0) {
          domainWrap.hidden = false;
          domainList.innerHTML = "";
          for (const ds of data.topDomainSavings) {
            const li = document.createElement("li");
            li.className = "dash-domain-chip";
            li.innerHTML = `<span class="dash-domain-chip-name">${escapeHtml(ds.domain)}</span> <span class="dash-domain-chip-val">${ds.memorySavedFormatted}</span> <span class="subtle-meta">(${ds.tabCount} tab${ds.tabCount === 1 ? "" : "s"})</span>`;
            domainList.appendChild(li);
          }
        } else {
          domainWrap.hidden = true;
        }
      }

      // Reasons breakdown list
      const reasonsWrap = $("dash-reasons-breakdown-wrap");
      const reasonsList = $("dash-reasons-breakdown-list");
      if (reasonsWrap && reasonsList) {
        if (data.reasonsBreakdown && Array.isArray(data.reasonsBreakdown.reasons) && data.reasonsBreakdown.reasons.length > 0) {
          reasonsWrap.hidden = false;
          reasonsList.innerHTML = "";
          for (const rb of data.reasonsBreakdown.reasons) {
            const li = document.createElement("li");
            li.className = "dash-domain-chip";
            li.style.cursor = "pointer";
            li.title = `Click to filter suspended tabs by ${rb.label}`;
            li.innerHTML = `<span class="dash-domain-chip-name" style="color: ${rb.color || "inherit"}">${escapeHtml(rb.label)}</span> <span class="dash-domain-chip-val">${rb.count}</span> <span class="subtle-meta">(${rb.percentage}%)</span>`;
            li.addEventListener("click", () => {
              const filterSelect = $("dash-suspended-reason-filter");
              if (filterSelect) {
                let matched = false;
                for (const opt of filterSelect.options) {
                  if (opt.value === rb.key || opt.text.toLowerCase().includes(rb.label.toLowerCase())) {
                    filterSelect.value = opt.value;
                    matched = true;
                    break;
                  }
                }
                if (!matched) filterSelect.value = "all";
                loadSuspendedTabs();
                const suspendedSection = $("dashboard-suspended-section");
                if (suspendedSection) suspendedSection.scrollIntoView({ behavior: "smooth" });
              }
            });
            reasonsList.appendChild(li);
          }
        } else {
          reasonsWrap.hidden = true;
        }
      }
    }
  } catch (_) {}
}

async function loadTabGroups() {
  const list = $("dash-groups-list");
  const badge = $("dash-groups-badge");
  const empty = $("dash-groups-empty");
  const loading = $("dash-groups-loading");
  const activeFilter = $("dash-active-group-filter");
  const suspendedFilter = $("dash-suspended-group-filter");
  if (!list) return;

  if (loading) loading.hidden = false;

  try {
    const res = await send({ type: "get-tab-groups" });
    if (loading) loading.hidden = true;

    if (!res?.ok || !Array.isArray(res?.data)) {
      if (empty) empty.hidden = false;
      return;
    }

    const groups = res.data;
    if (badge) badge.textContent = `${groups.length} group${groups.length === 1 ? "" : "s"}`;

    // Update filter dropdowns while preserving current selected values
    const updateFilterOptions = (select) => {
      if (!select) return;
      const currentVal = select.value;
      select.innerHTML = `<option value="all">All Groups</option>`;
      for (const g of groups) {
        const opt = document.createElement("option");
        opt.value = String(g.id);
        opt.textContent = `${g.title} (${g.totalTabs})`;
        select.appendChild(opt);
      }
      if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
        select.value = currentVal;
      }
    };
    updateFilterOptions(activeFilter);
    updateFilterOptions(suspendedFilter);

    list.innerHTML = "";
    if (groups.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    for (const g of groups) {
      const li = document.createElement("li");
      li.className = "dash-tab-row";
      li.dataset.groupId = String(g.id);

      // Group color dot / circle
      const dot = document.createElement("div");
      dot.className = "dash-group-dot";
      dot.style.width = "12px";
      dot.style.height = "12px";
      dot.style.borderRadius = "50%";
      dot.style.backgroundColor = g.colorCode || "#5f6368";
      dot.style.boxShadow = `0 0 6px ${g.colorCode || "#5f6368"}66`;
      dot.style.flexShrink = "0";
      li.appendChild(dot);

      // Meta: Title & tab counts
      const meta = document.createElement("div");
      meta.className = "dash-tab-meta";

      const titleEl = document.createElement("div");
      titleEl.className = "dash-tab-title";
      titleEl.textContent = g.title || "Untitled Group";
      meta.appendChild(titleEl);

      const sub = document.createElement("div");
      sub.className = "dash-tab-sub";
      sub.textContent = `${g.totalTabs} tab${g.totalTabs === 1 ? "" : "s"} · ${g.activeCount} active · ${g.suspendedCount} suspended`;
      meta.appendChild(sub);

      li.appendChild(meta);

      // Badges: Memory metrics
      const badges = document.createElement("div");
      badges.className = "dash-tab-badges";

      const actBadge = document.createElement("span");
      actBadge.className = "dash-badge dash-badge-active";
      actBadge.textContent = `${g.activeCount} Active (${g.activeMemoryFormatted})`;
      badges.appendChild(actBadge);

      if (g.suspendedCount > 0) {
        const suspBadge = document.createElement("span");
        suspBadge.className = "dash-badge dash-badge-suspended";
        suspBadge.textContent = `${g.suspendedCount} Suspended (Saved ${g.savedMemoryFormatted})`;
        badges.appendChild(suspBadge);
      }

      li.appendChild(badges);

      // Actions: Quick group actions
      const actions = document.createElement("div");
      actions.className = "dash-tab-actions";

      if (g.activeCount > 0) {
        const suspBtn = document.createElement("button");
        suspBtn.className = "dash-btn dash-btn-suspend";
        suspBtn.type = "button";
        suspBtn.textContent = "Suspend Group";
        suspBtn.title = `Suspend all eligible tabs in ${g.title}`;
        suspBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          suspBtn.disabled = true;
          suspBtn.textContent = "Suspending...";
          await send({ type: "suspend-group", groupId: g.id });
          toast(`Suspended group "${g.title}"`);
          await loadDashboardOverview();
          await loadTabGroups();
          await loadActiveTabs();
          await loadSuspendedTabs();
          await loadRecentlySuspended();
        });
        actions.appendChild(suspBtn);
      }

      if (g.suspendedCount > 0) {
        const restBtn = document.createElement("button");
        restBtn.className = "dash-btn dash-btn-restore";
        restBtn.type = "button";
        restBtn.textContent = "Restore Group";
        restBtn.title = `Restore all suspended tabs in ${g.title}`;
        restBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          restBtn.disabled = true;
          restBtn.textContent = "Restoring...";
          await send({ type: "restore-group", groupId: g.id });
          toast(`Restored group "${g.title}"`);
          await loadDashboardOverview();
          await loadTabGroups();
          await loadActiveTabs();
          await loadSuspendedTabs();
          await loadRecentlyRestored();
        });
        actions.appendChild(restBtn);
      }

      li.appendChild(actions);

      // Clicking row filters active/suspended tabs to this group
      li.style.cursor = "pointer";
      li.title = `Click to filter tabs by group "${g.title}"`;
      li.addEventListener("click", () => {
        if (activeFilter) activeFilter.value = String(g.id);
        if (suspendedFilter) suspendedFilter.value = String(g.id);
        loadActiveTabs();
        loadSuspendedTabs();
        const activeSection = $("dashboard-active-section");
        if (activeSection) activeSection.scrollIntoView({ behavior: "smooth" });
      });

      list.appendChild(li);
    }
  } catch (err) {
    if (loading) loading.hidden = true;
    if (empty) empty.hidden = false;
  }
}

async function loadActiveTabs() {
  const list = $("dash-active-list");
  const badge = $("dash-active-badge");
  const empty = $("dash-active-empty");
  const loading = $("dash-active-loading");
  if (!list) return;

  const searchQuery = ($("dash-active-search")?.value || "").trim();
  const sortBy = $("dash-active-sort")?.value || "recency";
  const groupVal = $("dash-active-group-filter")?.value;
  const groupId = groupVal && groupVal !== "all" ? Number(groupVal) : undefined;
  const filterSnapshot = $("dash-active-snapshot-filter")?.value || "all";

  if (loading) loading.hidden = false;

  try {
    const res = await send({ type: "get-active-tabs", searchQuery, sortBy, groupId, filterSnapshot });
    if (loading) loading.hidden = true;

    if (!res?.ok || !Array.isArray(res?.data)) {
      if (empty) empty.hidden = false;
      return;
    }

    const tabs = res.data;
    if (badge) badge.textContent = `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;

    const eligibleCount = tabs.filter(t => t.isEligible && !t.isProtected && t.canSuspend).length;
    const suspendAllBtn = $("dash-suspend-all-eligible");
    if (suspendAllBtn) {
      suspendAllBtn.textContent = `Suspend Eligible (${eligibleCount})`;
      suspendAllBtn.disabled = eligibleCount === 0;
      suspendAllBtn.title = eligibleCount > 0
        ? `Suspend ${eligibleCount} eligible tab${eligibleCount === 1 ? "" : "s"} now`
        : "No eligible tabs to suspend";
    }

    list.innerHTML = "";
    if (tabs.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    for (const tab of tabs) {
      const li = document.createElement("li");
      li.className = "dash-tab-row";
      li.dataset.tabId = String(tab.id);

      // Favicon
      const img = document.createElement("img");
      img.className = "dash-tab-fav";
      img.alt = "";
      if (tab.favIconUrl) {
        img.src = tab.favIconUrl;
        img.onerror = () => { img.style.display = "none"; };
      } else {
        img.style.display = "none";
      }
      li.appendChild(img);

      // Meta: Title & sub (domain)
      const meta = document.createElement("div");
      meta.className = "dash-tab-meta";

      const titleEl = document.createElement("div");
      titleEl.className = "dash-tab-title";
      titleEl.textContent = tab.title || tab.domain || "Untitled Tab";
      titleEl.title = `${tab.title}\n${tab.url}`;
      meta.appendChild(titleEl);

      const sub = document.createElement("div");
      sub.className = "dash-tab-sub";
      sub.textContent = tab.domain || "";
      meta.appendChild(sub);

      li.appendChild(meta);

      // Badges
      const badges = document.createElement("div");
      badges.className = "dash-tab-badges";

      if (tab.group?.title) {
        const gb = document.createElement("span");
        gb.className = "dash-badge dash-badge-group";
        gb.textContent = tab.group.title;
        if (tab.group.colorCode) {
          gb.style.borderColor = tab.group.colorCode;
          gb.style.color = tab.group.colorCode;
        }
        gb.style.cursor = "pointer";
        gb.title = `Click to filter by group: ${tab.group.title}`;
        gb.addEventListener("click", () => {
          const filter = $("dash-active-group-filter");
          if (filter) {
            filter.value = String(tab.group.id);
            loadActiveTabs();
          }
        });
        badges.appendChild(gb);
      }

      if (tab.active) {
        const ab = document.createElement("span");
        ab.className = "dash-badge dash-badge-active";
        ab.textContent = "Active";
        badges.appendChild(ab);
      }

      if (tab.pinned) {
        const pb = document.createElement("span");
        pb.className = "dash-badge dash-badge-pinned";
        pb.textContent = "Pinned";
        badges.appendChild(pb);
      }

      if (tab.audible) {
        const aub = document.createElement("span");
        aub.className = "dash-badge dash-badge-audible";
        aub.textContent = "Audible";
        badges.appendChild(aub);
      }

      if (tab.isProtected) {
        const prb = document.createElement("span");
        prb.className = "dash-badge dash-badge-protected";
        prb.textContent = "Protected";
        prb.title = tab.protectionReasons?.join(", ") || "Protected from suspension";
        badges.appendChild(prb);
      }

      if (tab.isDomainExcluded) {
        const exb = document.createElement("span");
        exb.className = "dash-badge dash-badge-excluded";
        exb.textContent = "Excluded Domain";
        exb.title = `${tab.domain} is excluded from automatic suspension`;
        badges.appendChild(exb);
      }

      if (!tab.active && tab.idleDurationMs >= 30 * 60 * 1000) {
        const idb = document.createElement("span");
        idb.className = "dash-badge dash-badge-time";
        idb.textContent = tab.idleDurationFormatted;
        idb.title = `Idle for ${tab.idleDurationFormatted}`;
        badges.appendChild(idb);
      }

      if (tab.hasSnapshot) {
        const snb = document.createElement("span");
        snb.className = "dash-badge dash-badge-snapshot";
        snb.textContent = "Snapshot";
        snb.title = tab.snapshotAgeFormatted ? `Snapshot available (captured ${tab.snapshotAgeFormatted}) — click to view` : "Snapshot available — click to view";
        snb.style.cursor = "pointer";
        snb.addEventListener("click", () => {
          openSnapshotModal(tab.snapshotId, tab.id, {
            title: tab.title,
            url: tab.url,
            favIconUrl: tab.favIconUrl,
            isSuspended: false
          });
        });
        badges.appendChild(snb);
      }

      li.appendChild(badges);

      // Memory estimation
      const mem = document.createElement("div");
      mem.className = "dash-tab-mem";
      mem.textContent = tab.estimatedMemoryFormatted || "—";
      mem.title = `Estimated RAM consumption: ~${tab.estimatedMemoryMb || 80} MB`;
      li.appendChild(mem);

      // Last active time
      const time = document.createElement("div");
      time.className = "dash-tab-time";
      time.textContent = tab.active ? "active now" : tab.idleDurationFormatted || tab.lastActiveRelative || "just now";
      time.title = `Last active: ${tab.lastActiveFormatted || new Date(tab.lastActiveAt).toLocaleString()}${tab.active ? " (active tab)" : ` (${tab.idleDurationFormatted || tab.lastActiveRelative})`}`;
      li.appendChild(time);

      // Actions: Suspend button
      const actions = document.createElement("div");
      actions.className = "dash-tab-actions";

      const suspBtn = document.createElement("button");
      suspBtn.className = "dash-btn dash-btn-suspend";
      suspBtn.type = "button";
      suspBtn.textContent = "Suspend";
      if (tab.canSuspend === false) {
        suspBtn.disabled = true;
        suspBtn.title = "Internal system pages cannot be suspended";
      } else {
        suspBtn.title = tab.isProtected
          ? `Protected (${tab.protectionReasons?.join(", ") || "rule"}) — click to force suspend`
          : "Suspend this tab immediately";
        suspBtn.addEventListener("click", async () => {
          suspBtn.disabled = true;
          suspBtn.textContent = "Suspending...";
          try {
            const res = await send({ type: "suspend-tab", tabId: tab.id, reason: "manual", force: true });
            if (res?.ok) {
              const displayTitle = tab.title || tab.domain || "Untitled Tab";
              toast(`Suspended tab: ${displayTitle.slice(0, 24)}...`);
            } else {
              toast(res?.error || "Could not suspend tab", "error");
            }
          } catch (err) {
            toast("Error suspending tab: " + (err?.message || err), "error");
          }
          await loadDashboardOverview();
          await loadTabGroups();
          await loadActiveTabs();
          await loadSuspendedTabs();
          await loadRecentlySuspended();
        });
      }

      actions.appendChild(suspBtn);

      if (tab.hasSnapshot) {
        const snapBtn = document.createElement("button");
        snapBtn.className = "dash-btn dash-btn-snapshot";
        snapBtn.type = "button";
        snapBtn.textContent = "Snapshot";
        snapBtn.title = "View captured snapshot and state details";
        snapBtn.addEventListener("click", () => {
          openSnapshotModal(tab.snapshotId, tab.id, {
            title: tab.title,
            url: tab.url,
            favIconUrl: tab.favIconUrl,
            isSuspended: false
          });
        });
        actions.appendChild(snapBtn);
      }

      if (tab.domain && tab.domain !== "Extension Page" && !tab.url?.startsWith("chrome://") && !tab.url?.startsWith("about:")) {
        const excludeBtn = document.createElement("button");
        excludeBtn.className = "dash-btn dash-btn-exclude" + (tab.isDomainExcluded ? " active" : "");
        excludeBtn.type = "button";
        excludeBtn.textContent = tab.isDomainExcluded ? "Excluded" : "Exclude Domain";
        excludeBtn.title = tab.isDomainExcluded
          ? `${tab.domain} is excluded from suspension (click to allow suspension)`
          : `Never suspend tabs from ${tab.domain}`;
        excludeBtn.addEventListener("click", async () => {
          excludeBtn.disabled = true;
          try {
            const res = await send({ type: "toggle-exclude-domain", domain: tab.domain });
            if (res?.ok) {
              const msg = res.isExcluded
                ? `Excluded ${tab.domain} from auto-suspension`
                : `Removed exclusion for ${tab.domain}`;
              toast(msg);
              if (typeof SETTINGS !== "undefined" && Array.isArray(SETTINGS.whitelist)) {
                const fresh = (await send({ type: "get-settings" }))?.data;
                if (fresh) {
                  SETTINGS.whitelist = fresh.whitelist;
                  renderRuleList("whitelist", SETTINGS.whitelist);
                }
              }
            } else {
              toast(res?.error || "Could not toggle domain exclusion", "error");
            }
          } catch (err) {
            toast("Error toggling exclusion: " + (err?.message || err), "error");
          }
          await loadDashboardOverview();
          await loadActiveTabs();
          await loadSuspendedTabs();
        });
        actions.appendChild(excludeBtn);
      }

      if (tab.canSuspend !== false) {
        const isManuallyProt = Boolean(tab.isManuallyProtected);
        const protectBtn = document.createElement("button");
        protectBtn.className = "dash-btn dash-btn-protect" + (isManuallyProt ? " active" : "");
        protectBtn.type = "button";
        protectBtn.textContent = isManuallyProt ? "Protected" : "Protect Tab";
        protectBtn.title = isManuallyProt
          ? "Tab is manually protected from suspension (click to unprotect)"
          : "Protect this tab from automatic suspension";
        protectBtn.addEventListener("click", async () => {
          protectBtn.disabled = true;
          try {
            const res = await send({ type: "toggle-protect-tab", tabId: tab.id });
            if (res?.ok) {
              const msg = res.isProtected
                ? `Protected tab: ${(tab.title || "Tab").slice(0, 24)}...`
                : `Removed protection for tab: ${(tab.title || "Tab").slice(0, 24)}...`;
              toast(msg);
            } else {
              toast(res?.error || "Could not toggle tab protection", "error");
            }
          } catch (err) {
            toast("Error toggling protection: " + (err?.message || err), "error");
          }
          await loadDashboardOverview();
          await loadActiveTabs();
        });
        actions.appendChild(protectBtn);
      }

      li.appendChild(actions);

      list.appendChild(li);
    }
  } catch (err) {
    if (loading) loading.hidden = true;
    if (empty) empty.hidden = false;
  }
}

async function loadSuspendedTabs() {
  const list = $("dash-suspended-list");
  const badge = $("dash-suspended-badge");
  const empty = $("dash-suspended-empty");
  const loading = $("dash-suspended-loading");
  if (!list) return;

  const searchQuery = ($("dash-suspended-search")?.value || "").trim();
  const sortBy = $("dash-suspended-sort")?.value || "recency";
  const filterReason = $("dash-suspended-reason-filter")?.value || "all";
  const filterSnapshot = $("dash-suspended-snapshot-filter")?.value || "all";
  const groupVal = $("dash-suspended-group-filter")?.value;
  const groupId = groupVal && groupVal !== "all" ? Number(groupVal) : undefined;

  if (loading) loading.hidden = false;

  try {
    const res = await send({ type: "get-suspended-tabs", searchQuery, sortBy, filterReason, filterSnapshot, groupId });
    if (loading) loading.hidden = true;

    if (!res?.ok || !Array.isArray(res?.data)) {
      if (empty) empty.hidden = false;
      return;
    }

    const tabs = res.data;
    if (badge) badge.textContent = `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;

    const restoreAllBtn = $("dash-restore-all");
    if (restoreAllBtn) {
      restoreAllBtn.textContent = `Restore All (${tabs.length})`;
      restoreAllBtn.disabled = tabs.length === 0;
      restoreAllBtn.title = tabs.length > 0
        ? `Restore ${tabs.length} suspended tab${tabs.length === 1 ? "" : "s"} now`
        : "No suspended tabs to restore";
    }

    list.innerHTML = "";
    if (tabs.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    for (const tab of tabs) {
      const li = document.createElement("li");
      li.className = "dash-tab-row";
      li.dataset.tabId = String(tab.id);

      // Favicon
      const img = document.createElement("img");
      img.className = "dash-tab-fav";
      img.alt = "";
      if (tab.favIconUrl) {
        img.src = tab.favIconUrl;
        img.onerror = () => { img.style.display = "none"; };
      } else {
        img.style.display = "none";
      }
      li.appendChild(img);

      // Meta: Title & sub (domain)
      const meta = document.createElement("div");
      meta.className = "dash-tab-meta";

      const titleEl = document.createElement("div");
      titleEl.className = "dash-tab-title";
      titleEl.textContent = tab.title || tab.domain || "Untitled Tab";
      titleEl.title = `${tab.title}\n${tab.url}`;
      meta.appendChild(titleEl);

      const sub = document.createElement("div");
      sub.className = "dash-tab-sub";
      sub.textContent = tab.domain || "";
      meta.appendChild(sub);

      li.appendChild(meta);

      // Badges
      const badges = document.createElement("div");
      badges.className = "dash-tab-badges";

      if (tab.group?.title) {
        const gb = document.createElement("span");
        gb.className = "dash-badge dash-badge-group";
        gb.textContent = tab.group.title;
        if (tab.group.colorCode) {
          gb.style.borderColor = tab.group.colorCode;
          gb.style.color = tab.group.colorCode;
        }
        gb.style.cursor = "pointer";
        gb.title = `Click to filter by group: ${tab.group.title}`;
        gb.addEventListener("click", () => {
          const filter = $("dash-suspended-group-filter");
          if (filter) {
            filter.value = String(tab.group.id);
            loadSuspendedTabs();
          }
        });
        badges.appendChild(gb);
      }

      const sb = document.createElement("span");
      sb.className = "dash-badge dash-badge-suspended";
      sb.textContent = "Suspended";
      badges.appendChild(sb);

      if (tab.reasonFormatted) {
        const rb = document.createElement("span");
        rb.className = "dash-badge dash-badge-reason";
        rb.textContent = tab.reasonFormatted;
        rb.title = `Suspension reason: ${tab.reasonFormatted}`;
        badges.appendChild(rb);
      }

      if (tab.hasSnapshot) {
        const snb = document.createElement("span");
        snb.className = "dash-badge dash-badge-snapshot";
        snb.textContent = "Snapshot";
        let snTitle = "Snapshot available for smart restoration (click to view)";
        if (tab.snapshotAgeFormatted) snTitle += ` (captured ${tab.snapshotAgeFormatted})`;
        if (tab.hasScreenshot) snTitle += " • Screenshot";
        if (tab.hasScroll) snTitle += " • Scroll pos";
        if (tab.hasFormData) snTitle += " • Form data";
        snb.title = snTitle;
        snb.style.cursor = "pointer";
        snb.addEventListener("click", () => {
          openSnapshotModal(tab.snapshotId, tab.id, {
            title: tab.title,
            url: tab.url,
            favIconUrl: tab.favIconUrl,
            isSuspended: true
          });
        });
        badges.appendChild(snb);
      } else {
        const snb = document.createElement("span");
        snb.className = "dash-badge dash-badge-no-snapshot";
        snb.textContent = "No snapshot";
        snb.title = "No snapshot recorded; tab will restore directly from URL";
        badges.appendChild(snb);
      }

      if (tab.isDomainExcluded) {
        const exb = document.createElement("span");
        exb.className = "dash-badge dash-badge-excluded";
        exb.textContent = "Excluded Domain";
        exb.title = `${tab.domain} is excluded from automatic suspension`;
        badges.appendChild(exb);
      }

      if (tab.lastActiveRelative) {
        const lab = document.createElement("span");
        lab.className = "dash-badge dash-badge-time";
        lab.textContent = `Active ${tab.lastActiveRelative}`;
        lab.title = `Last active prior to suspension: ${tab.lastActiveFormatted || new Date(tab.lastActiveAt).toLocaleString()}`;
        badges.appendChild(lab);
      }

      li.appendChild(badges);

      // Saved RAM estimation
      const mem = document.createElement("div");
      mem.className = "dash-tab-mem";
      mem.textContent = `Saved ${tab.estimatedMemorySavedFormatted || "—"}`;
      mem.title = `Estimated RAM reclaimed: ~${tab.estimatedMemorySavedMb || 80} MB`;
      li.appendChild(mem);

      // Suspended relative time
      const time = document.createElement("div");
      time.className = "dash-tab-time";
      time.textContent = tab.suspendedRelative ? `Suspended ${tab.suspendedRelative}` : "suspended";
      let timeTitle = `Suspended at: ${new Date(tab.suspendedAt).toLocaleString()}`;
      if (tab.lastActiveAt) {
        timeTitle += `\nLast active: ${tab.lastActiveFormatted || new Date(tab.lastActiveAt).toLocaleString()} (${tab.lastActiveRelative})`;
      }
      time.title = timeTitle;
      li.appendChild(time);

      // Actions: Restore button
      const actions = document.createElement("div");
      actions.className = "dash-tab-actions";

      const restoreBtn = document.createElement("button");
      restoreBtn.className = "dash-btn dash-btn-restore";
      restoreBtn.type = "button";
      restoreBtn.textContent = "Restore";
      restoreBtn.title = "Restore this tab immediately";
      restoreBtn.addEventListener("click", async () => {
        restoreBtn.disabled = true;
        restoreBtn.textContent = "Restoring...";
        try {
          const res = await send({
            type: "restore-tab",
            tabId: tab.id,
            options: { source: "user", userInitiated: true, priority: 100 }
          });
          if (res?.ok) {
            toast(`Restored tab: ${tab.title.slice(0, 24)}...`);
          } else {
            toast(res?.error || "Could not restore tab", "error");
          }
        } catch (err) {
          toast("Error restoring tab: " + (err?.message || err), "error");
        }
        await loadDashboardOverview();
        await loadTabGroups();
        await loadActiveTabs();
        await loadSuspendedTabs();
        await loadRecentlySuspended();
        await loadRecentlyRestored();
      });

      actions.appendChild(restoreBtn);

      if (tab.hasSnapshot) {
        const snapBtn = document.createElement("button");
        snapBtn.className = "dash-btn dash-btn-snapshot";
        snapBtn.type = "button";
        snapBtn.textContent = "Snapshot";
        snapBtn.title = "View captured snapshot and state preview";
        snapBtn.addEventListener("click", () => {
          openSnapshotModal(tab.snapshotId, tab.id, {
            title: tab.title,
            url: tab.url,
            favIconUrl: tab.favIconUrl,
            isSuspended: true
          });
        });
        actions.appendChild(snapBtn);
      }

      if (tab.domain && tab.domain !== "Extension Page" && !tab.url?.startsWith("chrome://") && !tab.url?.startsWith("about:")) {
        const excludeBtn = document.createElement("button");
        excludeBtn.className = "dash-btn dash-btn-exclude" + (tab.isDomainExcluded ? " active" : "");
        excludeBtn.type = "button";
        excludeBtn.textContent = tab.isDomainExcluded ? "Excluded" : "Exclude Domain";
        excludeBtn.title = tab.isDomainExcluded
          ? `${tab.domain} is excluded from suspension (click to allow suspension)`
          : `Never suspend tabs from ${tab.domain}`;
        excludeBtn.addEventListener("click", async () => {
          excludeBtn.disabled = true;
          try {
            const res = await send({ type: "toggle-exclude-domain", domain: tab.domain });
            if (res?.ok) {
              const msg = res.isExcluded
                ? `Excluded ${tab.domain} from auto-suspension`
                : `Removed exclusion for ${tab.domain}`;
              toast(msg);
              if (typeof SETTINGS !== "undefined" && Array.isArray(SETTINGS.whitelist)) {
                const fresh = (await send({ type: "get-settings" }))?.data;
                if (fresh) {
                  SETTINGS.whitelist = fresh.whitelist;
                  renderRuleList("whitelist", SETTINGS.whitelist);
                }
              }
            } else {
              toast(res?.error || "Could not toggle domain exclusion", "error");
            }
          } catch (err) {
            toast("Error toggling exclusion: " + (err?.message || err), "error");
          }
          await loadDashboardOverview();
          await loadActiveTabs();
          await loadSuspendedTabs();
        });
        actions.appendChild(excludeBtn);
      }

      li.appendChild(actions);

      list.appendChild(li);
    }
  } catch (err) {
    if (loading) loading.hidden = true;
    if (empty) empty.hidden = false;
  }
}

async function loadRecentlySuspended() {
  const list = $("dash-recent-suspended-list");
  const badge = $("dash-recent-suspended-badge");
  const empty = $("dash-recent-suspended-empty");
  const loading = $("dash-recent-suspended-loading");
  if (!list) return;

  const searchQuery = ($("dash-recent-suspended-search")?.value || "").trim();

  if (loading) loading.hidden = false;

  try {
    const res = await send({ type: "get-recently-suspended", searchQuery, limit: 30 });
    if (loading) loading.hidden = true;

    if (!res?.ok || !Array.isArray(res?.data)) {
      if (empty) empty.hidden = false;
      return;
    }

    const items = res.data;
    if (badge) badge.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;

    list.innerHTML = "";
    if (items.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    for (const item of items) {
      const li = document.createElement("li");
      li.className = "dash-tab-row";
      if (item.tabId) li.dataset.tabId = String(item.tabId);

      // Favicon
      const img = document.createElement("img");
      img.className = "dash-tab-fav";
      img.alt = "";
      if (item.favIconUrl) {
        img.src = item.favIconUrl;
        img.onerror = () => { img.style.display = "none"; };
      } else {
        img.style.display = "none";
      }
      li.appendChild(img);

      // Meta: Title & sub (domain)
      const meta = document.createElement("div");
      meta.className = "dash-tab-meta";

      const titleEl = document.createElement("div");
      titleEl.className = "dash-tab-title";
      titleEl.textContent = item.title || item.domain || "Untitled Tab";
      titleEl.title = `${item.title}\n${item.url}`;
      meta.appendChild(titleEl);

      const sub = document.createElement("div");
      sub.className = "dash-tab-sub";
      sub.textContent = item.domain || "";
      meta.appendChild(sub);

      li.appendChild(meta);

      // Badges: Reason badge
      const badges = document.createElement("div");
      badges.className = "dash-tab-badges";

      if (item.reasonFormatted) {
        const rb = document.createElement("span");
        rb.className = "dash-badge dash-badge-reason";
        rb.textContent = item.reasonFormatted;
        rb.title = `Suspension reason: ${item.reasonFormatted}`;
        badges.appendChild(rb);
      }

      li.appendChild(badges);

      // Saved RAM
      const mem = document.createElement("div");
      mem.className = "dash-tab-mem";
      mem.textContent = `Saved ${item.estimatedMemorySavedFormatted || "—"}`;
      li.appendChild(mem);

      // Relative time
      const time = document.createElement("div");
      time.className = "dash-tab-time";
      time.textContent = item.relativeTime || "recently";
      time.title = `Suspended at: ${new Date(item.timestamp).toLocaleString()}`;
      li.appendChild(time);

      // Action: Restore or Re-open button
      const actions = document.createElement("div");
      actions.className = "dash-tab-actions";

      const reopenBtn = document.createElement("button");
      reopenBtn.className = "dash-btn dash-btn-restore";
      reopenBtn.type = "button";
      reopenBtn.textContent = "Restore";
      reopenBtn.title = "Restore or open this tab";
      reopenBtn.addEventListener("click", async () => {
        reopenBtn.disabled = true;
        reopenBtn.textContent = "Restoring...";
        let restored = false;
        if (item.tabId) {
          try {
            const r = await send({ type: "restore-tab", tabId: item.tabId });
            restored = !!r?.ok;
          } catch (_) {}
        }
        if (!restored && item.url) {
          chrome.tabs.create({ url: item.url });
          restored = true;
        }
        toast(`Restored: ${item.title.slice(0, 24)}...`);
        await loadDashboardOverview();
        await loadActiveTabs();
        await loadSuspendedTabs();
        await loadRecentlySuspended();
        await loadRecentlyRestored();
      });

      actions.appendChild(reopenBtn);
      li.appendChild(actions);

      list.appendChild(li);
    }
  } catch (err) {
    if (loading) loading.hidden = true;
    if (empty) empty.hidden = false;
  }
}

async function loadRecentlyRestored() {
  const list = $("dash-recent-restored-list");
  const badge = $("dash-recent-restored-badge");
  const empty = $("dash-recent-restored-empty");
  const loading = $("dash-recent-restored-loading");
  if (!list) return;

  const searchQuery = ($("dash-recent-restored-search")?.value || "").trim();

  if (loading) loading.hidden = false;

  try {
    const res = await send({ type: "get-recently-restored", searchQuery, limit: 30 });
    if (loading) loading.hidden = true;

    if (!res?.ok || !Array.isArray(res?.data)) {
      if (empty) empty.hidden = false;
      return;
    }

    const items = res.data;
    if (badge) badge.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;

    list.innerHTML = "";
    if (items.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    for (const item of items) {
      const li = document.createElement("li");
      li.className = "dash-tab-row";
      if (item.tabId) li.dataset.tabId = String(item.tabId);

      // Favicon
      const img = document.createElement("img");
      img.className = "dash-tab-fav";
      img.alt = "";
      if (item.favIconUrl) {
        img.src = item.favIconUrl;
        img.onerror = () => { img.style.display = "none"; };
      } else {
        img.style.display = "none";
      }
      li.appendChild(img);

      // Meta: Title & sub (domain)
      const meta = document.createElement("div");
      meta.className = "dash-tab-meta";

      const titleEl = document.createElement("div");
      titleEl.className = "dash-tab-title";
      titleEl.textContent = item.title || item.domain || "Restored Tab";
      titleEl.title = `${item.title}\n${item.url}`;
      meta.appendChild(titleEl);

      const sub = document.createElement("div");
      sub.className = "dash-tab-sub";
      sub.textContent = item.domain || "";
      meta.appendChild(sub);

      li.appendChild(meta);

      // Badges: Restored / Method badge
      const badges = document.createElement("div");
      badges.className = "dash-tab-badges";

      const rb = document.createElement("span");
      rb.className = "dash-badge dash-badge-active";
      rb.textContent = item.methodLabel || "Restored";
      badges.appendChild(rb);

      if (item.durationMs) {
        const db = document.createElement("span");
        db.className = "dash-badge dash-badge-reason";
        db.textContent = `${item.durationMs}ms`;
        db.title = `Restoration duration: ${item.durationMs}ms`;
        badges.appendChild(db);
      }

      li.appendChild(badges);

      // Relative time
      const time = document.createElement("div");
      time.className = "dash-tab-time";
      time.textContent = item.relativeTime || "recently";
      time.title = `Restored at: ${new Date(item.timestamp).toLocaleString()}`;
      li.appendChild(time);

      // Action: Focus tab or reopen button
      const actions = document.createElement("div");
      actions.className = "dash-tab-actions";

      const focusBtn = document.createElement("button");
      focusBtn.className = "dash-btn";
      focusBtn.type = "button";
      focusBtn.textContent = "Focus";
      focusBtn.title = "Focus or switch to this tab";
      focusBtn.addEventListener("click", async () => {
        let focused = false;
        if (item.tabId) {
          try {
            await chrome.tabs.update(item.tabId, { active: true });
            focused = true;
          } catch (_) {}
        }
        if (!focused && item.url) {
          chrome.tabs.create({ url: item.url });
        }
      });

      actions.appendChild(focusBtn);
      li.appendChild(actions);

      list.appendChild(li);
    }
  } catch (err) {
    if (loading) loading.hidden = true;
    if (empty) empty.hidden = false;
  }
}

async function loadRestoreFailures() {
  const list = $("dash-failures-list");
  const badge = $("dash-failures-badge");
  const empty = $("dash-failures-empty");
  const loading = $("dash-failures-loading");
  if (!list) return;

  const searchQuery = ($("dash-failures-search")?.value || "").trim();
  const sortBy = $("dash-failures-sort")?.value || "recency";

  if (loading) loading.hidden = false;

  try {
    const res = await send({ type: "get-restore-failures", searchQuery, sortBy });
    if (loading) loading.hidden = true;

    if (!res?.ok || !Array.isArray(res?.data)) {
      if (empty) empty.hidden = false;
      return;
    }

    const failures = res.data;
    if (badge) badge.textContent = `${failures.length} failure${failures.length === 1 ? "" : "s"}`;

    list.innerHTML = "";
    if (failures.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    for (const fail of failures) {
      const li = document.createElement("li");
      li.className = "dash-tab-row";
      li.dataset.tabId = String(fail.tabId || "");

      // Favicon
      const img = document.createElement("img");
      img.className = "dash-tab-fav";
      img.alt = "";
      if (fail.favIconUrl) {
        img.src = fail.favIconUrl;
        img.onerror = () => { img.style.display = "none"; };
      } else {
        img.style.display = "none";
      }
      li.appendChild(img);

      // Meta (title & sub/domain)
      const meta = document.createElement("div");
      meta.className = "dash-tab-meta";

      const titleEl = document.createElement("div");
      titleEl.className = "dash-tab-title";
      titleEl.textContent = fail.title || fail.domain || "Restoration Failure";
      titleEl.title = `${fail.title}\n${fail.targetUrl || ""}`;
      meta.appendChild(titleEl);

      const sub = document.createElement("div");
      sub.className = "dash-tab-sub";
      sub.textContent = fail.domain || fail.targetUrl || "";
      meta.appendChild(sub);

      li.appendChild(meta);

      // Badges
      const badges = document.createElement("div");
      badges.className = "dash-tab-badges";

      const fb = document.createElement("span");
      fb.className = "dash-badge dash-badge-failure";
      fb.textContent = "Failed";
      badges.appendChild(fb);

      if (fail.stageLabel) {
        const sb = document.createElement("span");
        sb.className = "dash-badge dash-badge-stage";
        sb.textContent = fail.stageLabel;
        sb.title = `Failed at pipeline stage: ${fail.stageLabel}`;
        badges.appendChild(sb);
      }

      const ab = document.createElement("span");
      ab.className = "dash-badge dash-badge-time";
      ab.textContent = `${fail.attempts} attempt${fail.attempts === 1 ? "" : "s"}`;
      badges.appendChild(ab);

      li.appendChild(badges);

      // Error snippet
      const errBox = document.createElement("div");
      errBox.className = "dash-tab-error";
      errBox.textContent = fail.error;
      errBox.title = `Error: ${fail.error}`;
      li.appendChild(errBox);

      // Time
      const time = document.createElement("div");
      time.className = "dash-tab-time";
      time.textContent = fail.failedRelative || "recently";
      time.title = `Failed at: ${fail.failedFormatted || new Date(fail.failedAt).toLocaleString()}`;
      li.appendChild(time);

      // Actions: Retry and Dismiss
      const actions = document.createElement("div");
      actions.className = "dash-tab-actions";

      if (fail.tabId) {
        const retryBtn = document.createElement("button");
        retryBtn.className = "dash-btn dash-btn-retry";
        retryBtn.type = "button";
        retryBtn.textContent = "Retry";
        retryBtn.title = "Retry tab restoration";
        retryBtn.addEventListener("click", async () => {
          retryBtn.disabled = true;
          retryBtn.textContent = "Retrying...";
          await send({ type: "retry-restoration", tabId: fail.tabId });
          toast("Retrying tab restoration...");
          await loadRestoreFailures();
          await loadDashboardOverview();
          await loadActiveTabs();
          await loadSuspendedTabs();
        });
        actions.appendChild(retryBtn);
      }

      const dismissBtn = document.createElement("button");
      dismissBtn.className = "dash-btn";
      dismissBtn.type = "button";
      dismissBtn.textContent = "Dismiss";
      dismissBtn.title = "Dismiss this failure record";
      dismissBtn.addEventListener("click", async () => {
        await send({ type: "clear-restore-failures", tabId: fail.tabId });
        await loadRestoreFailures();
        await loadDashboardOverview();
      });
      actions.appendChild(dismissBtn);

      li.appendChild(actions);
      list.appendChild(li);
    }
  } catch (err) {
    if (loading) loading.hidden = true;
    if (empty) empty.hidden = false;
  }
}

// ─── Snapshot modal viewer ──────────────────────────────────────────────────
function closeSnapshotModal() {
  const modal = $("snapshot-modal");
  if (!modal) return;
  modal.hidden = true;
  const imgEl = $("snap-modal-img");
  if (imgEl) {
    imgEl.src = "";
    imgEl.hidden = true;
  }
  const fallbackEl = $("snap-modal-fallback");
  if (fallbackEl) fallbackEl.hidden = true;
}

async function openSnapshotModal(snapshotId, tabId, tabInfo = {}) {
  const modal = $("snapshot-modal");
  if (!modal) return;

  // Set initial placeholders from tabInfo
  const favEl = $("snap-modal-fav");
  if (favEl) {
    if (tabInfo.favIconUrl) {
      favEl.src = tabInfo.favIconUrl;
      favEl.style.display = "block";
    } else {
      favEl.style.display = "none";
    }
  }

  const titleEl = $("snap-modal-title");
  if (titleEl) titleEl.textContent = tabInfo.title || "Tab Snapshot";

  const urlEl = $("snap-modal-url");
  if (urlEl) urlEl.textContent = tabInfo.url || "";

  const timeEl = $("snap-modal-time");
  if (timeEl) timeEl.textContent = "Loading snapshot details...";

  const imgEl = $("snap-modal-img");
  const fallbackEl = $("snap-modal-fallback");
  const fallbackTextEl = $("snap-modal-fallback-text");
  if (imgEl) imgEl.hidden = true;
  if (fallbackEl) fallbackEl.hidden = true;

  const idEl = $("snap-modal-id");
  if (idEl) idEl.textContent = snapshotId || (tabId ? `Tab #${tabId}` : "—");

  const deleteBtn = $("snap-modal-delete-btn");
  if (deleteBtn) {
    deleteBtn.disabled = false;
    deleteBtn.textContent = "Delete Snapshot";
    deleteBtn.onclick = async () => {
      const activeSnapId = idEl?.textContent && idEl.textContent !== "—" ? idEl.textContent : snapshotId;
      if (!confirm("Are you sure you want to delete this tab snapshot?")) return;
      deleteBtn.disabled = true;
      deleteBtn.textContent = "Deleting...";
      try {
        const res = await send({
          type: "delete-snapshot",
          snapshotId: activeSnapId,
          tabId,
          force: true
        });
        if (res?.ok && res?.deleted !== false) {
          toast("Snapshot deleted successfully");
          closeSnapshotModal();
          await loadDashboardOverview();
          await loadActiveTabs();
          await loadSuspendedTabs();
        } else {
          toast(res?.error || "Could not delete snapshot", "error");
          deleteBtn.disabled = false;
          deleteBtn.textContent = "Delete Snapshot";
        }
      } catch (err) {
        toast("Error deleting snapshot: " + (err?.message || err), "error");
        deleteBtn.disabled = false;
        deleteBtn.textContent = "Delete Snapshot";
      }
    };
  }

  const restoreBtn = $("snap-modal-restore-btn");
  if (restoreBtn) {
    if (tabInfo.isSuspended && tabId) {
      restoreBtn.hidden = false;
      restoreBtn.disabled = false;
      restoreBtn.textContent = "Restore This Tab";
      restoreBtn.onclick = async () => {
        restoreBtn.disabled = true;
        restoreBtn.textContent = "Restoring...";
        await send({
          type: "restore-tab",
          tabId,
          options: { source: "user", userInitiated: true, priority: 100 }
        });
        toast("Restoring tab...");
        closeSnapshotModal();
        await loadDashboardOverview();
        await loadSuspendedTabs();
        await loadActiveTabs();
        await loadRecentlyRestored();
      };
    } else {
      restoreBtn.hidden = true;
    }
  }

  modal.hidden = false;

  try {
    const res = await send({ type: "get-snapshot", snapshotId, tabId });
    if (!res?.ok || !res?.details) {
      if (fallbackEl) {
        fallbackEl.hidden = false;
        if (fallbackTextEl) fallbackTextEl.textContent = res?.error || "Snapshot not found or expired";
      }
      if (timeEl) timeEl.textContent = "Unavailable";
      return;
    }

    const d = res.details;
    if (titleEl) titleEl.textContent = d.title || tabInfo.title || "Tab Snapshot";
    if (urlEl) urlEl.textContent = d.url || tabInfo.url || "";
    if (favEl && d.favicon) {
      favEl.src = d.favicon;
      favEl.style.display = "block";
    }
    if (idEl) idEl.textContent = d.id || snapshotId || "—";

    if (timeEl) {
      timeEl.textContent = `${d.timeRelative} (${d.timeFormatted})`;
    }

    const reasonEl = $("snap-modal-reason");
    if (reasonEl) {
      reasonEl.textContent = d.reasonLabel || "Idle timeout";
      if (d.reasonColor) {
        reasonEl.style.borderColor = d.reasonColor;
        reasonEl.style.color = d.reasonColor;
      }
    }

    const scrollEl = $("snap-modal-scroll");
    if (scrollEl) {
      scrollEl.textContent = d.scroll?.formatted || "Top of page";
    }

    const formsEl = $("snap-modal-forms");
    if (formsEl) {
      formsEl.textContent = d.forms?.formatted || "0 safe fields";
    }

    const adapterRow = $("snap-modal-adapter-row");
    const adapterEl = $("snap-modal-adapter");
    if (adapterRow && adapterEl) {
      if (d.adapter?.hasAdapter) {
        adapterRow.hidden = false;
        adapterEl.textContent = d.adapter.label;
      } else {
        adapterRow.hidden = true;
      }
    }

    // Preview
    if (d.screenshot?.hasScreenshot && d.screenshot?.dataUrl) {
      if (imgEl) {
        imgEl.src = d.screenshot.dataUrl;
        imgEl.hidden = false;
      }
      if (fallbackEl) fallbackEl.hidden = true;
    } else {
      if (imgEl) imgEl.hidden = true;
      if (fallbackEl) {
        fallbackEl.hidden = false;
        if (fallbackTextEl) {
          fallbackTextEl.textContent = d.screenshot?.fallbackReason || "No screenshot preview available";
        }
      }
    }
  } catch (err) {
    if (fallbackEl) {
      fallbackEl.hidden = false;
      if (fallbackTextEl) fallbackTextEl.textContent = "Error loading snapshot details";
    }
  }
}

// ─── Memory info ────────────────────────────────────────────────────────────
async function loadMemoryInfo() {
  const res = await send({ type: "memory-info" });
  if (res?.ok) {
    $("mem-current").textContent = res.freeMB ? `${(res.freeMB / 1024).toFixed(1)} GB` : "unknown";
    $("mem-battery").textContent = res.onBattery ? "on battery" : "on power";
  }
}

// ─── Import / export ────────────────────────────────────────────────────────
function exportSettings() {
  const blob = new Blob([JSON.stringify(SETTINGS, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tabvault-config-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Configuration exported");
}

async function importSettings(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || !parsed) throw new Error("invalid format");
    if (!confirm("Replace current configuration with imported settings?")) return;
    await send({ type: "replace-settings", settings: parsed });
    location.reload();
  } catch (err) {
    alert("Could not import: " + err.message);
  }
  e.target.value = "";
}

// ─── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await load();
  wire();
});
