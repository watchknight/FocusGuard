/**
 * FocusGuard Service — Hosts File Manager (Layer 3)
 * Blocks all domains at the OS level via C:\Windows\System32\drivers\etc\hosts.
 * Works across ALL browsers, not just Chrome.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOSTS_FILE = path.join(
  process.env.SYSTEMROOT || 'C:\\Windows',
  'System32', 'drivers', 'etc', 'hosts'
);
const BACKUP_FILE = HOSTS_FILE + '.focusguard.bak';
const START_MARKER = '# === FOCUSGUARD START ===';
const END_MARKER = '# === FOCUSGUARD END ===';

/**
 * Create a backup of the hosts file before first modification.
 */
function backupHostsFile() {
  try {
    if (!fs.existsSync(BACKUP_FILE)) {
      fs.copyFileSync(HOSTS_FILE, BACKUP_FILE);
      console.log('[Hosts] Backup created at:', BACKUP_FILE);
    }
  } catch (err) {
    console.error('[Hosts] Failed to create backup:', err.message);
  }
}

/**
 * Read the current hosts file content.
 */
function readHostsFile() {
  try {
    return fs.readFileSync(HOSTS_FILE, 'utf8');
  } catch (err) {
    console.error('[Hosts] Failed to read hosts file:', err.message);
    return '';
  }
}

/**
 * Build the FocusGuard hosts block from the domain list.
 */
function buildHostsBlock(domains) {
  const lines = [
    START_MARKER,
    '# Managed by FocusGuard — DO NOT EDIT THIS SECTION',
    `# Last updated: ${new Date().toISOString()}`,
    `# ${domains.length} domains blocked`,
    '',
  ];

  for (const domain of domains) {
    lines.push(`0.0.0.0 ${domain}`);
    lines.push(`0.0.0.0 www.${domain}`);
  }

  lines.push('', END_MARKER);
  return lines.join('\n');
}

/**
 * Remove the FocusGuard section from hosts content.
 */
function stripFocusGuardSection(content) {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    return content;
  }

  const before = content.substring(0, startIdx).trimEnd();
  const after = content.substring(endIdx + END_MARKER.length).trimStart();

  return before + (after ? '\n' + after : '');
}

/**
 * Check if the FocusGuard hosts entries are present and complete.
 */
function verifyHostsEntries(domains) {
  const content = readHostsFile();

  // Check markers exist
  if (!content.includes(START_MARKER) || !content.includes(END_MARKER)) {
    return { valid: false, reason: 'FocusGuard section missing' };
  }

  // Extract the section between markers
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  const section = content.substring(startIdx, endIdx);

  // 1. Verify total entry count (each domain produces 2 lines: domain and www.domain)
  const entryCount = (section.match(/^0\.0\.0\.0\s+/gm) || []).length;
  const expectedMinCount = domains.length * 2;
  if (entryCount < expectedMinCount) {
    return { 
      valid: false, 
      reason: `Hosts entries count mismatch: found ${entryCount}, expected at least ${expectedMinCount}` 
    };
  }

  // 2. Check representative sample of domains across the list
  const sampleSize = Math.min(25, domains.length);
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.floor((i / sampleSize) * domains.length);
    const domain = domains[idx];
    if (!section.includes(`0.0.0.0 ${domain}`)) {
      return { valid: false, reason: `Domain missing: ${domain}` };
    }
  }

  return { valid: true };
}

/**
 * Apply FocusGuard entries to the hosts file.
 */
function applyHostsEntries(domains) {
  try {
    backupHostsFile();

    let content = readHostsFile();

    // Remove existing FocusGuard section (if any)
    content = stripFocusGuardSection(content);

    // Append new block
    const block = buildHostsBlock(domains);
    const newContent = content.trimEnd() + '\n\n' + block + '\n';

    fs.writeFileSync(HOSTS_FILE, newContent, 'utf8');
    console.log(`[Hosts] Applied ${domains.length} domain entries`);

    // Flush DNS cache
    flushDns();

    return true;
  } catch (err) {
    console.error('[Hosts] Failed to apply entries:', err.message);
    return false;
  }
}

/**
 * Remove all FocusGuard entries from the hosts file.
 */
function removeHostsEntries() {
  try {
    let content = readHostsFile();
    content = stripFocusGuardSection(content);
    fs.writeFileSync(HOSTS_FILE, content.trimEnd() + '\n', 'utf8');
    flushDns();
    console.log('[Hosts] Entries removed');
    return true;
  } catch (err) {
    console.error('[Hosts] Failed to remove entries:', err.message);
    return false;
  }
}

/**
 * Restore the original hosts file from backup.
 */
function restoreBackup() {
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      fs.copyFileSync(BACKUP_FILE, HOSTS_FILE);
      fs.unlinkSync(BACKUP_FILE);
      flushDns();
      console.log('[Hosts] Restored from backup');
      return true;
    }
    console.log('[Hosts] No backup found');
    return false;
  } catch (err) {
    console.error('[Hosts] Failed to restore backup:', err.message);
    return false;
  }
}

/**
 * Flush DNS cache so hosts changes take effect immediately.
 */
function flushDns() {
  try {
    execSync('ipconfig /flushdns', { stdio: 'ignore', windowsHide: true });
    console.log('[Hosts] DNS cache flushed');
  } catch (err) {
    console.error('[Hosts] Failed to flush DNS:', err.message);
  }
}

module.exports = {
  applyHostsEntries,
  removeHostsEntries,
  verifyHostsEntries,
  restoreBackup,
  flushDns,
  HOSTS_FILE,
  BACKUP_FILE,
};
