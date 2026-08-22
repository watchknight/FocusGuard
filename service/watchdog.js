/**
 * FocusGuard Service — Watchdog (Layer 5 Orchestrator)
 * Runs a 60-second verification loop across all protection layers.
 * Re-applies any protection that has been tampered with.
 * Logs all tamper attempts with timestamps.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const hostsManager = require('./hosts-manager');
const dnsManager = require('./dns-manager');
const policies = require('./policies');
const cooldownManager = require('./cooldown-manager');
const blocklist = require('./blocklist');

const TAMPER_LOG = path.join(cooldownManager.CONFIG_DIR, 'tamper.log');
const CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds

let watchdogTimer = null;
let extensionId = null; // Set during initialization

/**
 * Log a tamper attempt to the tamper log file.
 */
function logTamper(layer, message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [Layer ${layer}] ${message}\n`;

  try {
    // Ensure directory exists
    const dir = path.dirname(TAMPER_LOG);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(TAMPER_LOG, entry, 'utf8');
  } catch (err) {
    console.error('[Watchdog] Failed to write tamper log:', err.message);
  }

  console.warn(`[Watchdog] TAMPER DETECTED — ${entry.trim()}`);
}

/**
 * Get all domains to enforce (built-in + custom).
 */
function getAllDomains() {
  const builtIn = blocklist.BLOCKED_DOMAINS || [];
  const custom = cooldownManager.getCustomDomains();
  return [...new Set([...builtIn, ...custom])];
}

/**
 * Verify and re-apply Layer 2: Chrome/Edge enterprise policies.
 */
function checkLayer2() {
  const config = cooldownManager.getStatus();
  if (!config.protectionEnabled) return;

  const result = policies.verifyPolicies(extensionId);
  if (!result.valid) {
    logTamper(2, `Policies tampered: ${result.issues.join('; ')}`);
    policies.applyAllPolicies({
      extensionId: extensionId,
      disableIncognito: false, // Optional — respect user choice
      disableDevTools: false,  // Optional — respect user choice
    });
  }
}

/**
 * Verify and re-apply Layer 3: Hosts file entries.
 */
function checkLayer3() {
  const config = cooldownManager.getStatus();
  if (!config.protectionEnabled) return;

  const domains = getAllDomains();
  const result = hostsManager.verifyHostsEntries(domains);
  if (!result.valid) {
    logTamper(3, `Hosts file tampered: ${result.reason}`);
    hostsManager.applyHostsEntries(domains);
  }
}

/**
 * Verify and re-apply Layer 4: DNS settings.
 */
function checkLayer4() {
  const config = cooldownManager.getStatus();
  if (!config.protectionEnabled) return;

  const result = dnsManager.verifyDns();
  if (!result.valid) {
    logTamper(4, `DNS tampered: ${result.reason}`);
    dnsManager.applyDns();
  }
}

/**
 * Check extension heartbeat (Layer 1 health).
 */
let heartbeatLossLogged = false;

function checkLayer1() {
  if (!cooldownManager.isExtensionAlive()) {
    const config = cooldownManager.loadConfig();
    const lastBeat = config.lastHeartbeat;
    if (lastBeat > 0 && !heartbeatLossLogged) {
      // Log once when heartbeat is first detected as lost
      const minutesAgo = Math.floor((Date.now() - lastBeat) / 60000);
      logTamper(1, `Extension heartbeat lost — last seen ${minutesAgo} minutes ago. Extension may have been force-removed.`);
      heartbeatLossLogged = true;
    }
  } else {
    // Extension is alive — reset the flag so future losses are logged
    heartbeatLossLogged = false;
  }
}

/**
 * Process cooldown timer.
 */
function checkCooldown() {
  cooldownManager.processCooldown();
}

/**
 * Run one full verification cycle across all layers.
 */
function runCheck() {
  try {
    checkCooldown();
    checkLayer1();
    checkLayer2();
    checkLayer3();
    checkLayer4();
  } catch (err) {
    console.error('[Watchdog] Error during check cycle:', err.message);
  }
}

/**
 * Start the watchdog loop.
 * @param {string} extId — The Chrome extension ID (optional, for policy enforcement)
 */
function start(extId) {
  extensionId = extId || null;

  console.log('[Watchdog] Starting verification loop (every 60s)...');
  console.log(`[Watchdog] Extension ID: ${extensionId || '(not set)'}`);
  console.log(`[Watchdog] Tamper log: ${TAMPER_LOG}`);

  // Run first check immediately
  runCheck();

  // Then every 60 seconds
  watchdogTimer = setInterval(runCheck, CHECK_INTERVAL_MS);
}

/**
 * Stop the watchdog loop.
 */
function stop() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    console.log('[Watchdog] Stopped');
  }
}

/**
 * Set the extension ID (can be updated at runtime via API).
 */
function setExtensionId(id) {
  extensionId = id;
  console.log(`[Watchdog] Extension ID updated: ${id}`);
}

/**
 * Get the current extension ID.
 */
function getExtensionId() {
  return extensionId;
}

module.exports = {
  start,
  stop,
  runCheck,
  setExtensionId,
  getExtensionId,
  getAllDomains,
  TAMPER_LOG,
};
