/**
 * FocusGuard Background Service Worker
 * Handles URL blocking via declarativeNetRequest, cooldown timer management,
 * statistics tracking, tamper detection, and message routing.
 *
 * Manifest V3 — runs as a service worker.
 */

// Import the blocklist data for keyword-based dynamic rules
importScripts('blocklist.js');

// =====================================================================
// CONSTANTS
// =====================================================================
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const DYNAMIC_RULE_START_ID = 10000; // Offset to avoid ID conflicts with static rules
const KEYWORD_RULE_START_ID = 20000; // Offset for keyword-based rules
const SAFESEARCH_RULE_START_ID = 30000; // Offset for SafeSearch enforcement rules
const STATIC_RULESET_ID = 'blocklist_rules';
const SERVICE_URL = 'http://127.0.0.1:7575'; // Companion service API

// =====================================================================
// INITIALIZATION — runs on extension install or update
// =====================================================================
chrome.runtime.onInstalled.addListener(async (details) => {
  const today = new Date().toISOString().split('T')[0];
  const defaults = {
    protectionEnabled: true,
    cooldownDuration: DEFAULT_COOLDOWN_MS,
    cooldownActive: false,
    cooldownEndTime: 0,
    disableRequestTime: 0,
    customDomains: [],
    stats: {
      totalBlocked: 0,
      todayBlocked: 0,
      weekBlocked: 0,
      lastResetDay: today,
      lastResetWeek: today,
    },
  };

  if (details.reason === 'install') {
    // Initial install: set all defaults
    await chrome.storage.local.set(defaults);
    console.log('[FocusGuard] Installed with default settings');
  } else if (details.reason === 'update') {
    // Extension update: fill in any newly added schema keys without overwriting user data
    const current = await chrome.storage.local.get(null);
    const toMerge = {};
    for (const [key, value] of Object.entries(defaults)) {
      if (current[key] === undefined) {
        toMerge[key] = value;
      }
    }
    if (Object.keys(toMerge).length > 0) {
      await chrome.storage.local.set(toMerge);
      console.log('[FocusGuard] Schema migration: added keys:', Object.keys(toMerge));
    }
  }

  // Create stats-reset alarm (checks every hour for day/week boundaries)
  await chrome.alarms.create('statsReset', {
    periodInMinutes: 60,
  });

  // Create heartbeat alarm (pings companion service every 60 seconds)
  await chrome.alarms.create('heartbeat', {
    periodInMinutes: 1,
  });

  // Ensure blocking rules are active
  await updateBlockRules();
});

// =====================================================================
// STARTUP — runs when browser starts with extension already installed
// =====================================================================
chrome.runtime.onStartup.addListener(async () => {
  console.log('[FocusGuard] Browser started');

  // Check for cooldown that may have elapsed while browser was closed
  const data = await chrome.storage.local.get([
    'cooldownActive',
    'cooldownEndTime',
    'protectionEnabled',
  ]);

  if (data.cooldownActive && data.cooldownEndTime) {
    const now = Date.now();
    if (now >= data.cooldownEndTime) {
      // Cooldown expired while browser was closed → disable protection
      console.log('[FocusGuard] Cooldown expired during browser shutdown');
      await chrome.storage.local.set({
        protectionEnabled: false,
        cooldownActive: false,
        cooldownEndTime: 0,
        disableRequestTime: 0,
      });
    } else {
      // Cooldown still active → re-create the alarm
      console.log('[FocusGuard] Cooldown still active, re-creating alarm');
      await chrome.alarms.create('cooldownComplete', {
        when: data.cooldownEndTime,
      });
    }
  }

  // Ensure stats-reset alarm exists
  const existingAlarm = await chrome.alarms.get('statsReset');
  if (!existingAlarm) {
    await chrome.alarms.create('statsReset', {
      periodInMinutes: 60,
    });
  }

  // Ensure heartbeat alarm exists (pings companion service every 60s)
  const heartbeatAlarm = await chrome.alarms.get('heartbeat');
  if (!heartbeatAlarm) {
    await chrome.alarms.create('heartbeat', {
      periodInMinutes: 1,
    });
  }

  // Reset stats if a day/week boundary was crossed while browser was off
  await resetStatsIfNeeded();

  // Ensure rules match current state
  await updateBlockRules();
});

// =====================================================================
// DYNAMIC RULE MANAGEMENT
// =====================================================================

/**
 * Update declarativeNetRequest rules based on current protection state.
 * - Static rules (rules.json) handle the built-in blocklist of 500+ domains.
 * - Dynamic rules handle:
 *   1. Custom user-added domains
 *   2. Keyword-based URL patterns (using BlocklistData.BLOCKED_KEYWORDS)
 * - Both are enabled/disabled together based on protectionEnabled.
 */
async function updateBlockRules() {
  const data = await chrome.storage.local.get([
    'protectionEnabled',
    'customDomains',
  ]);

  // Get all existing dynamic rules so we can replace them
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const existingRuleIds = existingRules.map((rule) => rule.id);

  if (!data.protectionEnabled) {
    // Protection is OFF — remove all dynamic rules and disable static ruleset
    if (existingRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingRuleIds,
      });
    }

    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        disableRulesetIds: [STATIC_RULESET_ID],
      });
    } catch (e) {
      console.log('[FocusGuard] Static ruleset already disabled or error:', e.message);
    }

    console.log('[FocusGuard] Protection OFF — all rules disabled');
    return;
  }

  // Protection is ON — enable static ruleset and build dynamic rules
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [STATIC_RULESET_ID],
    });
  } catch (e) {
    console.log('[FocusGuard] Static ruleset already enabled or error:', e.message);
  }

  const newRules = [];

  // --- Custom domain rules ---
  let ruleId = DYNAMIC_RULE_START_ID;
  const customDomains = data.customDomains || [];

  for (const domain of customDomains) {
    if (!domain || typeof domain !== 'string') continue;
    newRules.push({
      id: ruleId++,
      priority: 2, // Higher than keyword rules (priority 1) so domain-specific blocks take precedence
      action: {
        type: 'redirect',
        redirect: {
          extensionPath:
            '/blocked.html?domain=' + encodeURIComponent(domain),
        },
      },
      condition: {
        urlFilter: `||${domain}^`,
        resourceTypes: ['main_frame', 'sub_frame'],
      },
    });
  }

  // --- Keyword-based rules ---
  // These catch sites not in the static domain list but containing adult keywords.
  // Uses declarativeNetRequest urlFilter patterns with wildcards.
  let keywordRuleId = KEYWORD_RULE_START_ID;
  const keywords = BlocklistData.BLOCKED_KEYWORDS || [];

  for (const keyword of keywords) {
    if (!keyword || typeof keyword !== 'string') continue;

    // For short keywords (<= 4 chars), use regexFilter with word boundary delimiters
    // to avoid false positives (e.g. "milford.com" matching "milf", "wankel.com" matching "wank")
    let condition;
    if (keyword.length <= 4) {
      condition = {
        regexFilter: `^https?://.*[\\./\\?&=_\\-]${keyword}[\\./\\?&=_\\-].*`,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame', 'sub_frame'],
        excludedInitiatorDomains: [chrome.runtime.id],
      };
    } else {
      condition = {
        urlFilter: `*${keyword}*`,
        resourceTypes: ['main_frame', 'sub_frame'],
        excludedInitiatorDomains: [chrome.runtime.id],
      };
    }

    newRules.push({
      id: keywordRuleId++,
      priority: 1, // Lower than domain rules (priority 2) so explicit domain blocks take precedence
      action: {
        type: 'redirect',
        redirect: {
          extensionPath:
            '/blocked.html?domain=' + encodeURIComponent('keyword:' + keyword),
        },
      },
      condition: condition,
    });
  }

  // Replace existing dynamic rules with new set
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRuleIds,
    addRules: newRules,
  });

  console.log(
    `[FocusGuard] Protection ON — ${customDomains.length} custom domain rules + ${keywords.length} keyword rules active (static rules also enabled)`
  );

  // Re-apply SafeSearch rules (they were removed with the bulk delete above)
  await applySafeSearchRules();
}

// =====================================================================
// COOLDOWN TIMER SYSTEM
// =====================================================================

/**
 * Start the cooldown timer. Protection remains active during the entire
 * cooldown period. Only after it expires will protection be disabled.
 */
async function startCooldown() {
  const { cooldownDuration } = await chrome.storage.local.get([
    'cooldownDuration',
  ]);
  const duration = cooldownDuration || DEFAULT_COOLDOWN_MS;
  const now = Date.now();
  const cooldownEndTime = now + duration;

  await chrome.storage.local.set({
    cooldownActive: true,
    disableRequestTime: now,
    cooldownEndTime: cooldownEndTime,
  });

  // Create an alarm that fires exactly when cooldown expires
  await chrome.alarms.create('cooldownComplete', {
    when: cooldownEndTime,
  });

  console.log(
    `[FocusGuard] Cooldown started — ${duration / 1000 / 3600}h until protection can be disabled`
  );

  // Sync with companion service
  notifyService('/request-disable', { duration });

  return cooldownEndTime;
}

/**
 * Cancel the active cooldown — protection stays ON (re-armed instantly).
 */
async function cancelCooldown() {
  await chrome.alarms.clear('cooldownComplete');
  await chrome.storage.local.set({
    cooldownActive: false,
    disableRequestTime: 0,
    cooldownEndTime: 0,
  });
  console.log('[FocusGuard] Cooldown cancelled — protection re-armed');

  // Sync with companion service
  notifyService('/cancel-disable');
}

// =====================================================================
// ALARM HANDLER
// =====================================================================
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'cooldownComplete') {
    // Cooldown has expired — disable protection
    console.log('[FocusGuard] Cooldown complete — disabling protection');
    await chrome.storage.local.set({
      protectionEnabled: false,
      cooldownActive: false,
      cooldownEndTime: 0,
      disableRequestTime: 0,
    });
    await updateBlockRules();

    // Notify companion service
    notifyService('/cancel-disable');

    // Notify user
    try {
      await chrome.notifications.create('cooldownDone', {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'FocusGuard',
        message:
          'Cooldown period complete. Protection has been disabled. Re-enable it when you are ready.',
      });
    } catch (e) {
      // Notifications might not be available
    }
  } else if (alarm.name === 'statsReset') {
    await resetStatsIfNeeded();
  } else if (alarm.name === 'heartbeat') {
    // Ping companion service to prove extension is alive
    sendHeartbeat();
  }
});

// =====================================================================
// STATISTICS TRACKING
// =====================================================================

/**
 * Increment all block counters (total, today, week).
 * Stats are tracked via messages from blocked.html — this is the only
 * reliable tracking path since onRuleMatchedDebug only fires with DevTools open.
 */
async function trackBlock() {
  const { stats } = await chrome.storage.local.get(['stats']);
  if (!stats) return;

  stats.totalBlocked = (stats.totalBlocked || 0) + 1;
  stats.todayBlocked = (stats.todayBlocked || 0) + 1;
  stats.weekBlocked = (stats.weekBlocked || 0) + 1;

  await chrome.storage.local.set({ stats });
}

/**
 * Reset daily and/or weekly counters if the day/week boundary has been crossed.
 */
async function resetStatsIfNeeded() {
  const { stats } = await chrome.storage.local.get(['stats']);
  if (!stats) return;

  const today = new Date().toISOString().split('T')[0];
  let updated = false;

  // Daily reset
  if (stats.lastResetDay !== today) {
    stats.todayBlocked = 0;
    stats.lastResetDay = today;
    updated = true;
  }

  // Weekly reset (7-day rolling window)
  if (stats.lastResetWeek) {
    const lastWeekDate = new Date(stats.lastResetWeek);
    const daysSinceReset = Math.floor(
      (Date.now() - lastWeekDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysSinceReset >= 7) {
      stats.weekBlocked = 0;
      stats.lastResetWeek = today;
      updated = true;
    }
  }

  if (updated) {
    await chrome.storage.local.set({ stats });
    console.log('[FocusGuard] Stats reset for new day/week');
  }
}

// =====================================================================
// TAMPER DETECTION
// =====================================================================

/**
// Note: Enterprise Policy (Layer 2) already locks FocusGuard specifically in chrome://extensions
// (remove button gone, disable switch grayed out). We allow unrestricted access to chrome://extensions
// so you can freely install, manage, and use all your other work extensions.

// =====================================================================
// MESSAGE HANDLING — communication with popup, settings, and blocked pages
// =====================================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate sender: ensure request is strictly from within this extension
  if (sender.id && sender.id !== chrome.runtime.id) {
    console.warn('[FocusGuard] Rejected message from unauthorized sender ID:', sender.id);
    sendResponse({ error: 'Unauthorized sender' });
    return false;
  }
  handleMessage(message, sender, sendResponse);
  return true; // Keep message channel open for async response
});

async function handleMessage(message, sender, sendResponse) {
  try {
    switch (message.action) {
      case 'getStatus': {
        const status = await chrome.storage.local.get([
          'protectionEnabled',
          'cooldownActive',
          'cooldownEndTime',
          'cooldownDuration',
          'stats',
        ]);
        sendResponse(status);
        break;
      }

      case 'startCooldown': {
        const endTime = await startCooldown();
        sendResponse({ success: true, cooldownEndTime: endTime });
        break;
      }

      case 'cancelCooldown': {
        await cancelCooldown();
        sendResponse({ success: true });
        break;
      }

      case 'reEnableProtection': {
        await chrome.storage.local.set({ protectionEnabled: true });
        await cancelCooldown(); // Clear any lingering cooldown state
        await updateBlockRules();
        // Sync with companion service
        notifyService('/enable');
        sendResponse({ success: true });
        console.log('[FocusGuard] Protection re-enabled by user');
        break;
      }

      case 'updateCustomDomains': {
        const domains = message.domains || [];
        await chrome.storage.local.set({ customDomains: domains });
        await updateBlockRules();
        sendResponse({ success: true });
        break;
      }

      case 'updateCooldownDuration': {
        // Enforce duration whitelist: 1h, 6h, 12h, 24h, 48h, 72h, 7d
        const ALLOWED_DURATIONS = [3600000, 21600000, 43200000, 86400000, 172800000, 259200000, 604800000];
        const { cooldownActive } = await chrome.storage.local.get(['cooldownActive']);
        
        if (cooldownActive) {
          sendResponse({ error: 'Cannot change cooldown duration while cooldown is active' });
          break;
        }

        const requested = parseInt(message.duration, 10);
        const duration = ALLOWED_DURATIONS.includes(requested) ? requested : DEFAULT_COOLDOWN_MS;
        
        await chrome.storage.local.set({ cooldownDuration: duration });
        sendResponse({ success: true, duration });
        console.log(
          `[FocusGuard] Cooldown duration updated to ${duration / 1000 / 3600}h`
        );
        break;
      }

      case 'getStats': {
        const { stats } = await chrome.storage.local.get(['stats']);
        sendResponse(stats || { totalBlocked: 0, todayBlocked: 0, weekBlocked: 0 });
        break;
      }

      case 'trackBlock': {
        await trackBlock();
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ error: 'Unknown action: ' + message.action });
    }
  } catch (error) {
    console.error('[FocusGuard] Error handling message:', error);
    sendResponse({ error: error.message });
  }
}

// =====================================================================
// COMPANION SERVICE COMMUNICATION
// =====================================================================

/**
 * Send a heartbeat ping to the companion service (localhost:7575).
 * Fires every 60 seconds via chrome.alarms. Silently fails if service is down.
 */
function sendHeartbeat() {
  const body = JSON.stringify({
    extensionId: chrome.runtime.id,
    timestamp: Date.now(),
  });

  fetch(`${SERVICE_URL}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body,
  }).catch(() => {
    // Companion service may not be running — fail silently
  });
}

/**
 * Notify the companion service of a state change (cooldown start/cancel, re-enable, etc.)
 * @param {string} endpoint — e.g. '/request-disable', '/cancel-disable', '/enable'
 * @param {object} data — optional JSON body
 */
function notifyService(endpoint, data) {
  fetch(`${SERVICE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {}),
  }).catch(() => {
    // Companion service may not be running — fail silently
  });
}

/**
 * Sync a custom domain to the companion service (add or remove).
 * @param {string} action — 'add-domain' or 'remove-domain'
 * @param {string} domain — the domain name
 */
function syncDomainToService(action, domain) {
  fetch(`${SERVICE_URL}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
  }).catch(() => {
    // Companion service may not be running — fail silently
  });
}

// =====================================================================
// SAFESEARCH ENFORCEMENT
// =====================================================================

/**
 * Apply SafeSearch enforcement rules to Google, Bing, and DuckDuckGo.
 * These are dynamic declarativeNetRequest rules that redirect search URLs
 * to their SafeSearch-enabled equivalents.
 */
async function applySafeSearchRules() {
  const { protectionEnabled } = await chrome.storage.local.get(['protectionEnabled']);
  if (!protectionEnabled) return;

  // SafeSearch rules use redirect to add SafeSearch parameters
  const safeSearchRules = [
    // Google: force safe=active parameter (wildcard covers all Google TLDs)
    {
      id: SAFESEARCH_RULE_START_ID,
      priority: 3,
      action: {
        type: 'redirect',
        redirect: {
          transform: {
            queryTransform: {
              addOrReplaceParams: [{ key: 'safe', value: 'active' }],
            },
          },
        },
      },
      condition: {
        urlFilter: '||google.*/search*',
        resourceTypes: ['main_frame'],
      },
    },
    // Bing: force adlt=strict parameter
    {
      id: SAFESEARCH_RULE_START_ID + 1,
      priority: 3,
      action: {
        type: 'redirect',
        redirect: {
          transform: {
            queryTransform: {
              addOrReplaceParams: [{ key: 'adlt', value: 'strict' }],
            },
          },
        },
      },
      condition: {
        urlFilter: '||bing.com/search',
        resourceTypes: ['main_frame'],
      },
    },
    // DuckDuckGo: force kp=1 (strict) parameter — only on search queries
    {
      id: SAFESEARCH_RULE_START_ID + 2,
      priority: 3,
      action: {
        type: 'redirect',
        redirect: {
          transform: {
            queryTransform: {
              addOrReplaceParams: [{ key: 'kp', value: '1' }],
            },
          },
        },
      },
      condition: {
        urlFilter: '||duckduckgo.com/?q',
        resourceTypes: ['main_frame'],
      },
    },
  ];

  // Get existing SafeSearch rule IDs to remove before re-adding
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const safeSearchIds = existingRules
    .filter(r => r.id >= SAFESEARCH_RULE_START_ID && r.id < SAFESEARCH_RULE_START_ID + 100)
    .map(r => r.id);

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: safeSearchIds,
      addRules: safeSearchRules,
    });
    console.log('[FocusGuard] SafeSearch enforcement rules applied');
  } catch (err) {
    console.error('[FocusGuard] Failed to apply SafeSearch rules:', err);
  }
}

// Apply SafeSearch rules on startup and install
chrome.runtime.onInstalled.addListener(() => applySafeSearchRules());
chrome.runtime.onStartup.addListener(() => applySafeSearchRules());

