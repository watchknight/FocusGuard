/**
 * FocusGuard Service — DNS Manager (Layer 4)
 * Configures system DNS to use family-safe DNS providers that block adult content.
 * Default: Kahf Guard (medium.kahfguard.com)
 */
'use strict';

const { execSync } = require('child_process');

// DNS Provider configurations
const DNS_PROVIDERS = {
  kahfguard: {
    name: 'Kahf Guard (Medium)',
    primary: '203.190.10.116',
    secondary: '203.190.10.125',
    dohHostname: 'medium.kahfguard.com',
  },
  kahfguard_high: {
    name: 'Kahf Guard (High)',
    primary: '203.190.10.118',
    secondary: '203.190.10.126',
    dohHostname: 'high.kahfguard.com',
  },
  cleanbrowsing: {
    name: 'CleanBrowsing Family',
    primary: '185.228.168.168',
    secondary: '185.228.169.168',
  },
  cloudflare: {
    name: 'Cloudflare Family',
    primary: '1.1.1.3',
    secondary: '1.0.0.3',
  },
  opendns: {
    name: 'OpenDNS FamilyShield',
    primary: '208.67.222.123',
    secondary: '208.67.220.123',
  },
  adguard: {
    name: 'AdGuard Family',
    primary: '94.140.14.15',
    secondary: '94.140.15.16',
  },
};

// Default provider
const DEFAULT_PROVIDER = 'kahfguard';

/**
 * Get list of active network adapter names.
 */
function getActiveAdapters() {
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-NetAdapter | Where-Object { $_.Status -eq \'Up\' } | Select-Object -ExpandProperty Name"',
      { encoding: 'utf8', windowsHide: true }
    ).trim();

    if (!output) return [];
    return output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (err) {
    console.error('[DNS] Failed to get adapters:', err.message);
    return [];
  }
}

/**
 * Get current DNS server addresses for an adapter.
 */
function getCurrentDns(adapterName) {
  try {
    const safeAlias = String(adapterName).replace(/'/g, "''");
    const output = execSync(
      `powershell -NoProfile -Command "Get-DnsClientServerAddress -InterfaceAlias '${safeAlias}' -AddressFamily IPv4 | Select-Object -ExpandProperty ServerAddresses"`,
      { encoding: 'utf8', windowsHide: true }
    ).trim();

    if (!output) return [];
    return output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (err) {
    console.error(`[DNS] Failed to get DNS for ${adapterName}:`, err.message);
    return [];
  }
}

/**
 * Apply DNS settings to a specific adapter.
 */
function setDns(adapterName, primaryDns, secondaryDns) {
  try {
    const safeAlias = String(adapterName).replace(/'/g, "''");
    execSync(
      `powershell -NoProfile -Command "Set-DnsClientServerAddress -InterfaceAlias '${safeAlias}' -ServerAddresses ('${primaryDns}','${secondaryDns}')"`,
      { encoding: 'utf8', windowsHide: true }
    );
    console.log(`[DNS] Set ${adapterName} → ${primaryDns}, ${secondaryDns}`);
    return true;
  } catch (err) {
    console.error(`[DNS] Failed to set DNS for ${adapterName}:`, err.message);
    return false;
  }
}

/**
 * Reset an adapter to automatic (DHCP) DNS.
 */
function resetDns(adapterName) {
  try {
    const safeAlias = String(adapterName).replace(/'/g, "''");
    execSync(
      `powershell -NoProfile -Command "Set-DnsClientServerAddress -InterfaceAlias '${safeAlias}' -ResetServerAddresses"`,
      { encoding: 'utf8', windowsHide: true }
    );
    console.log(`[DNS] Reset ${adapterName} to DHCP`);
    return true;
  } catch (err) {
    console.error(`[DNS] Failed to reset DNS for ${adapterName}:`, err.message);
    return false;
  }
}

/**
 * Apply DNS to all active adapters using the specified provider.
 */
function applyDns(providerKey) {
  const provider = DNS_PROVIDERS[providerKey || DEFAULT_PROVIDER];
  if (!provider) {
    console.error('[DNS] Unknown provider:', providerKey);
    return false;
  }

  const adapters = getActiveAdapters();
  if (adapters.length === 0) {
    console.warn('[DNS] No active network adapters found');
    return false;
  }

  let allSuccess = true;
  for (const adapter of adapters) {
    if (!setDns(adapter, provider.primary, provider.secondary)) {
      allSuccess = false;
    }
  }

  console.log(`[DNS] Applied ${provider.name} to ${adapters.length} adapter(s)`);
  return allSuccess;
}

/**
 * Verify that DNS is correctly set to the expected provider.
 */
function verifyDns(providerKey) {
  const provider = DNS_PROVIDERS[providerKey || DEFAULT_PROVIDER];
  if (!provider) return { valid: false, reason: 'Unknown provider' };

  const adapters = getActiveAdapters();
  if (adapters.length === 0) {
    return { valid: true, reason: 'No active adapters to verify' };
  }

  for (const adapter of adapters) {
    const current = getCurrentDns(adapter);
    if (!current.includes(provider.primary)) {
      return {
        valid: false,
        reason: `Adapter "${adapter}" DNS is [${current.join(', ')}], expected ${provider.primary}`,
        adapter,
      };
    }
  }

  return { valid: true };
}

/**
 * Revert all adapters to automatic DNS.
 */
function revertDns() {
  const adapters = getActiveAdapters();
  for (const adapter of adapters) {
    resetDns(adapter);
  }
  console.log(`[DNS] Reverted ${adapters.length} adapter(s) to DHCP`);
}

module.exports = {
  applyDns,
  verifyDns,
  revertDns,
  getActiveAdapters,
  DNS_PROVIDERS,
  DEFAULT_PROVIDER,
};
