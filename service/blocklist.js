/**
 * FocusGuard Service — Blocklist Bridge
 * Imports the extension's blocklist data for use in the companion service.
 */
'use strict';

const path = require('path');

// Import the shared blocklist from the extension directory (one level up)
const blocklistPath = path.join(__dirname, '..', 'blocklist.js');

// blocklist.js sets `module.exports = BlocklistData` at the bottom,
// so we can require() it directly.
let BlocklistData;
try {
  BlocklistData = require(blocklistPath);
} catch (err) {
  console.error('[Blocklist] Failed to load blocklist from:', blocklistPath, err.message);
  // Fallback: minimal data so the service doesn't crash
  BlocklistData = {
    BLOCKED_DOMAINS: [],
    BLOCKED_KEYWORDS: [],
    isBlocked: () => false,
    isDomainBlocked: () => false,
    isKeywordBlocked: () => false,
  };
}

module.exports = BlocklistData;
