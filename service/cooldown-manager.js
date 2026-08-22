/**
 * FocusGuard Service — Cooldown Manager
 * Maintains an independent cooldown timer in a persistent config file.
 * Survives browser restart, extension removal, and PC reboot.
 *
 * Config stored at: C:\ProgramData\FocusGuard\config.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'FocusGuard'
);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// Default config — fail-safe: protection ON
const DEFAULT_CONFIG = {
  protectionEnabled: true,
  cooldownActive: false,
  cooldownEndTime: 0,
  cooldownDuration: DEFAULT_COOLDOWN_MS,
  disableRequestTime: 0,
  customDomains: [],
  lastHeartbeat: 0,
  stats: {
    totalBlocked: 0,
    todayBlocked: 0,
    weekBlocked: 0,
    lastResetDay: new Date().toISOString().split('T')[0],
    lastResetWeek: new Date().toISOString().split('T')[0],
  },
};

/**
 * Ensure the config directory exists.
 */
function ensureConfigDir() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('[Cooldown] Failed to create config directory:', err.message);
  }
}

/**
 * Load config from disk. Returns default config if file doesn't exist or is corrupted.
 */
function loadConfig() {
  ensureConfigDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const config = JSON.parse(raw);
      // Merge with defaults to ensure all keys exist (forward compatibility)
      return { ...DEFAULT_CONFIG, ...config, stats: { ...DEFAULT_CONFIG.stats, ...(config.stats || {}) } };
    }
  } catch (err) {
    console.error('[Cooldown] Failed to read config, using defaults:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save config to disk.
 */
function saveConfig(config) {
  ensureConfigDir();
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('[Cooldown] Failed to save config:', err.message);
  }
}

/**
 * Check and process cooldown state. Call this periodically.
 * Returns the current config after processing.
 */
function processCooldown() {
  const config = loadConfig();

  if (config.cooldownActive && config.cooldownEndTime > 0) {
    if (Date.now() >= config.cooldownEndTime) {
      // Cooldown has expired — disable protection
      config.protectionEnabled = false;
      config.cooldownActive = false;
      config.cooldownEndTime = 0;
      config.disableRequestTime = 0;
      saveConfig(config);
      console.log('[Cooldown] Cooldown expired — protection disabled');
    }
  }

  return config;
}

/**
 * Start a new cooldown.
 */
function startCooldown(durationMs) {
  const config = loadConfig();
  const duration = durationMs || config.cooldownDuration || DEFAULT_COOLDOWN_MS;
  const now = Date.now();

  config.cooldownActive = true;
  config.disableRequestTime = now;
  config.cooldownEndTime = now + duration;
  saveConfig(config);

  console.log(`[Cooldown] Started — ${(duration / 3600000).toFixed(1)}h until protection can be disabled`);
  return config;
}

/**
 * Cancel an active cooldown — re-arms protection.
 */
function cancelCooldown() {
  const config = loadConfig();
  config.cooldownActive = false;
  config.disableRequestTime = 0;
  config.cooldownEndTime = 0;
  saveConfig(config);

  console.log('[Cooldown] Cancelled — protection re-armed');
  return config;
}

/**
 * Re-enable protection.
 */
function enableProtection() {
  const config = loadConfig();
  config.protectionEnabled = true;
  config.cooldownActive = false;
  config.cooldownEndTime = 0;
  config.disableRequestTime = 0;
  saveConfig(config);

  console.log('[Cooldown] Protection re-enabled');
  return config;
}

/**
 * Get current status.
 */
function getStatus() {
  return processCooldown();
}

/**
 * Record extension heartbeat.
 */
function recordHeartbeat() {
  const config = loadConfig();
  config.lastHeartbeat = Date.now();
  saveConfig(config);
}

/**
 * Check if extension heartbeat is stale (no ping for 5+ minutes).
 */
function isExtensionAlive() {
  const config = loadConfig();
  if (!config.lastHeartbeat) return false;
  return (Date.now() - config.lastHeartbeat) < 5 * 60 * 1000;
}

/**
 * Add a custom domain.
 */
function addCustomDomain(domain) {
  const config = loadConfig();
  if (!config.customDomains) config.customDomains = [];
  const clean = domain.toLowerCase().replace(/^www\./, '').trim();
  if (clean && !config.customDomains.includes(clean)) {
    config.customDomains.push(clean);
    saveConfig(config);
    return true;
  }
  return false;
}

/**
 * Remove a custom domain.
 */
function removeCustomDomain(domain) {
  const config = loadConfig();
  if (!config.customDomains) return false;
  const clean = domain.toLowerCase().replace(/^www\./, '').trim();
  const idx = config.customDomains.indexOf(clean);
  if (idx !== -1) {
    config.customDomains.splice(idx, 1);
    saveConfig(config);
    return true;
  }
  return false;
}

/**
 * Get all custom domains.
 */
function getCustomDomains() {
  const config = loadConfig();
  return config.customDomains || [];
}

/**
 * Check if cooldown is active (for uninstall protection).
 */
function isCooldownActive() {
  const config = processCooldown();
  return config.cooldownActive;
}

/**
 * Get remaining cooldown time in ms.
 */
function getRemainingCooldown() {
  const config = loadConfig();
  if (!config.cooldownActive || !config.cooldownEndTime) return 0;
  const remaining = config.cooldownEndTime - Date.now();
  return remaining > 0 ? remaining : 0;
}

module.exports = {
  loadConfig,
  saveConfig,
  processCooldown,
  startCooldown,
  cancelCooldown,
  enableProtection,
  getStatus,
  recordHeartbeat,
  isExtensionAlive,
  addCustomDomain,
  removeCustomDomain,
  getCustomDomains,
  isCooldownActive,
  getRemainingCooldown,
  CONFIG_DIR,
  CONFIG_FILE,
};
