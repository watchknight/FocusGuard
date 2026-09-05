/**
 * FocusGuard Service — Chrome/Edge Enterprise Policies (Layer 2)
 * Force-installs the extension and optionally disables incognito/DevTools
 * via Windows Registry enterprise policies.
 */
'use strict';

const { execSync } = require('child_process');

// Registry paths for Chrome and Edge policies
const POLICY_PATHS = {
  chrome: 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome',
  edge: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge',
};

/**
 * Run a `reg` command silently.
 */
function regCommand(args) {
  try {
    execSync(`reg ${args}`, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (err) {
    // reg command returns error if key already exists or doesn't exist
    return false;
  }
}

/**
 * Read a registry value. Returns null if not found.
 */
function regQuery(keyPath, valueName) {
  try {
    const output = execSync(
      `reg query "${keyPath}" /v "${valueName}" 2>nul`,
      { encoding: 'utf8', windowsHide: true }
    );
    // Parse the output — format is: "    ValueName    REG_TYPE    Value"
    const match = output.match(/REG_(?:SZ|DWORD)\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Apply the ExtensionInstallForcelist policy to force-install our extension.
 * The extension ID is needed — it changes based on the load path.
 *
 * @param {string} extensionId — The chrome extension ID (from chrome://extensions)
 */
const CRX_EXT_ID = 'fikmkkdbhncddfijgnhoeakicaahcioh';

/**
 * Check if machine is joined to an Active Directory domain.
 */
function isDomainJoined() {
  try {
    const output = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).PartOfDomain"', { encoding: 'utf8', windowsHide: true }).trim();
    return output.toLowerCase() === 'true';
  } catch {
    return false;
  }
}

/**
 * Apply the ExtensionInstallForcelist policy to force-install our extension via local service.
 * This locks the extension in Chrome: cannot be removed or disabled by the user.
 * On standalone PCs, Chrome policy requires Web Store hosting for silent force-install.
 *
 * @param {string} extensionId — The chrome extension ID (optional)
 */
function applyForceInstallPolicy(extensionId) {
  const extId = extensionId || CRX_EXT_ID;
  const isDomain = isDomainJoined();

  if (!isDomain) {
    console.log('[Policies] Standalone PC detected — browser traffic secured via DoH policy & OS layers');
    return true;
  }

  for (const [browser, basePath] of Object.entries(POLICY_PATHS)) {
    const forceKey = `${basePath}\\ExtensionInstallForcelist`;
    const sourceKey = `${basePath}\\ExtensionInstallSources`;

    // 1. Force install from local companion service
    regCommand(`add "${forceKey}" /v "1" /t REG_SZ /d "${extId};http://127.0.0.1:7575/update.xml" /f`);

    // 2. Allow Chrome to install from localhost source
    regCommand(`add "${sourceKey}" /v "1" /t REG_SZ /d "http://127.0.0.1:7575/*" /f`);
    regCommand(`add "${sourceKey}" /v "2" /t REG_SZ /d "http://localhost:7575/*" /f`);

    console.log(`[Policies] Force-install policy set for ${browser}: ${extId}`);
  }

  return true;
}

/**
 * Disable incognito mode via enterprise policy.
 * Value: 1 = Incognito mode disabled
 */
function disableIncognito() {
  for (const [browser, basePath] of Object.entries(POLICY_PATHS)) {
    regCommand(`add "${basePath}" /v "IncognitoModeAvailability" /t REG_DWORD /d "1" /f`);
    console.log(`[Policies] Incognito disabled for ${browser}`);
  }
}

/**
 * Disable Developer Tools via enterprise policy.
 * Value: 2 = DevTools disabled entirely
 */
function disableDevTools() {
  for (const [browser, basePath] of Object.entries(POLICY_PATHS)) {
    regCommand(`add "${basePath}" /v "DeveloperToolsAvailability" /t REG_DWORD /d "2" /f`);
    console.log(`[Policies] DevTools disabled for ${browser}`);
  }
}

/**
 * Disable DNS-over-HTTPS in Chrome/Edge to prevent bypassing hosts/DNS blocking.
 * Value: "off" = DoH disabled
 */
function disableDoh() {
  for (const [browser, basePath] of Object.entries(POLICY_PATHS)) {
    regCommand(`add "${basePath}" /v "DnsOverHttpsMode" /t REG_SZ /d "off" /f`);
    console.log(`[Policies] DoH disabled for ${browser}`);
  }
}

/**
 * Enforce SafeSearch across Google and Bing via enterprise policy.
 * (YouTube safety mode is explicitly NOT enforced so music/songs play normally).
 */
function enableSafeSearchPolicies() {
  for (const [browser, basePath] of Object.entries(POLICY_PATHS)) {
    regCommand(`add "${basePath}" /v "ForceGoogleSafeSearch" /t REG_DWORD /d 1 /f`);
    regCommand(`delete "${basePath}" /v "ForceYouTubeSafetyMode" /f`);
    if (browser === 'edge') {
      regCommand(`add "${basePath}" /v "ForceBingSafeSearch" /t REG_DWORD /d 1 /f`);
    }
    console.log(`[Policies] SafeSearch policies enabled for ${browser}`);
  }
}

/**
 * Apply all recommended policies.
 * @param {Object} options
 * @param {string} options.extensionId — Extension ID (optional)
 * @param {boolean} options.disableIncognito — Whether to disable incognito (optional)
 * @param {boolean} options.disableDevTools — Whether to disable devtools (optional)
 */
function applyAllPolicies(options = {}) {
  console.log('[Policies] Applying enterprise policies...');

  // Force install FocusGuard if domain joined
  applyForceInstallPolicy(options.extensionId);

  // Always disable DoH to prevent DNS bypass
  disableDoh();

  // Always enforce SafeSearch for Google, Bing, and YouTube
  enableSafeSearchPolicies();

  // Optional policies
  if (options.disableIncognito) {
    disableIncognito();
  }
  if (options.disableDevTools) {
    disableDevTools();
  }

  console.log('[Policies] All policies applied');
}

/**
 * Verify that policies are still in place.
 */
function verifyPolicies(extensionId) {
  const results = { valid: true, issues: [] };
  const extId = extensionId || CRX_EXT_ID;
  const isDomain = isDomainJoined();

  for (const [browser, basePath] of Object.entries(POLICY_PATHS)) {
    // Check DoH is disabled
    const dohMode = regQuery(basePath, 'DnsOverHttpsMode');
    if (dohMode !== 'off') {
      results.valid = false;
      results.issues.push(`${browser}: DnsOverHttpsMode is "${dohMode}" (expected "off")`);
    }

    // Check SafeSearch is enabled
    const safeSearch = regQuery(basePath, 'ForceGoogleSafeSearch');
    if (safeSearch !== '0x1' && safeSearch !== '1') {
      results.valid = false;
      results.issues.push(`${browser}: ForceGoogleSafeSearch missing or disabled`);
    }

    // Check force-install is in place if domain-joined
    if (isDomain) {
      const forceKey = `${basePath}\\ExtensionInstallForcelist`;
      const val = regQuery(forceKey, '1');
      if (!val || !val.includes(extId)) {
        results.valid = false;
        results.issues.push(`${browser}: ExtensionInstallForcelist missing or wrong`);
      }
    }
  }

  return results;
}

/**
 * Remove all FocusGuard policies.
 */
function removeAllPolicies() {
  console.log('[Policies] Removing enterprise policies...');

  for (const [browser, basePath] of Object.entries(POLICY_PATHS)) {
    // Remove force-install list
    regCommand(`delete "${basePath}\\ExtensionInstallForcelist" /f`);
    // Remove incognito restriction
    regCommand(`delete "${basePath}" /v "IncognitoModeAvailability" /f`);
    // Remove DevTools restriction
    regCommand(`delete "${basePath}" /v "DeveloperToolsAvailability" /f`);
    // Remove DoH restriction
    regCommand(`delete "${basePath}" /v "DnsOverHttpsMode" /f`);
    // Remove SafeSearch policies
    regCommand(`delete "${basePath}" /v "ForceGoogleSafeSearch" /f`);
    regCommand(`delete "${basePath}" /v "ForceYouTubeSafetyMode" /f`);
    regCommand(`delete "${basePath}" /v "ForceBingSafeSearch" /f`);
    console.log(`[Policies] Policies removed for ${browser}`);
  }
}

module.exports = {
  applyForceInstallPolicy,
  disableIncognito,
  disableDevTools,
  disableDoh,
  enableSafeSearchPolicies,
  applyAllPolicies,
  verifyPolicies,
  removeAllPolicies,
  POLICY_PATHS,
};
