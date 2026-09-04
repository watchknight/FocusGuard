/**
 * FocusGuard Companion Service — REST API & Main Entry Point
 * Runs on localhost:7575. Provides API for the extension and orchestrates
 * the multi-layer protection watchdog.
 *
 * Usage: node server.js [--extension-id <id>]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const cooldownManager = require('./cooldown-manager');
const hostsManager = require('./hosts-manager');
const dnsManager = require('./dns-manager');
const policiesManager = require('./policies');
const watchdog = require('./watchdog');

const PORT = 7575;
const HOST = '127.0.0.1'; // Listen only on localhost for security

// Parse CLI arguments
function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--extension-id' && argv[i + 1]) {
      args.extensionId = argv[i + 1];
      i++;
    }
  }
  return args;
}

/**
 * Read the request body as a string.
 */
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

/**
 * Parse JSON body, returning {} on failure.
 */
async function parseJsonBody(req) {
  const body = await readBody(req);
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    return {};
  }
}

/**
 * Get safe CORS origin header.
 * Only allows extension origins or localhost tools (no external websites).
 */
function getSafeOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return '*'; // System/CLI tools
  if (origin.startsWith('chrome-extension://') || origin.startsWith('edge-extension://') || origin.includes('127.0.0.1') || origin.includes('localhost')) {
    return origin;
  }
  return null; // Reject web pages
}

/**
 * Send a JSON response.
 */
function jsonResponse(res, statusCode, data, origin = '*') {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

/**
 * Handle incoming HTTP requests.
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;
  const safeOrigin = getSafeOrigin(req);

  // Reject unauthorized origins (e.g. web pages trying to call local service)
  if (req.headers.origin && !safeOrigin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized origin: cross-origin web requests forbidden' }));
    return;
  }

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': safeOrigin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    switch (pathname) {
      // === Status ===
      case '/status': {
        if (method !== 'GET') break;
        const config = cooldownManager.getStatus();
        const extensionAlive = cooldownManager.isExtensionAlive();
        jsonResponse(res, 200, {
          protectionEnabled: config.protectionEnabled,
          cooldownActive: config.cooldownActive,
          cooldownEndTime: config.cooldownEndTime,
          cooldownDuration: config.cooldownDuration,
          extensionAlive,
          layers: {
            extension: extensionAlive ? 'healthy' : 'unknown',
            policies: 'active',
            hosts: 'active',
            dns: 'active',
            watchdog: 'running',
          },
        });
        return;
      }

      // === Heartbeat ===
      case '/heartbeat': {
        if (method !== 'POST') break;
        cooldownManager.recordHeartbeat();
        const body = await parseJsonBody(req);
        // If extension sends its ID, update the watchdog
        if (body.extensionId) {
          watchdog.setExtensionId(body.extensionId);
        }
        jsonResponse(res, 200, { ok: true, timestamp: Date.now() });
        return;
      }

      // === Cooldown: Request Disable ===
      case '/request-disable': {
        if (method !== 'POST') break;
        const body = await parseJsonBody(req);
        const config = cooldownManager.startCooldown(body.duration);
        jsonResponse(res, 200, {
          ok: true,
          cooldownEndTime: config.cooldownEndTime,
          message: 'Cooldown started. Protection will remain active until it expires.',
        });
        return;
      }

      // === Cooldown: Cancel ===
      case '/cancel-disable': {
        if (method !== 'POST') break;
        cooldownManager.cancelCooldown();
        jsonResponse(res, 200, { ok: true, message: 'Cooldown cancelled. Protection re-armed.' });
        return;
      }

      // === Enterprise Force-Install: Update Manifest ===
      case '/update.xml': {
        const defaultIds = ['fikmkkdbhncddfijgnhoeakicaahcioh', 'bmdnnddofeckmdmdooadmfgladkpipkj'];
        const customId = watchdog.getExtensionId();
        const appIds = [...new Set([...defaultIds, customId].filter(Boolean))];
        const appsXml = appIds.map(id => `  <app appid='${id}'>
    <updatecheck codebase='http://127.0.0.1:7575/focusguard.crx' version='1.0.0' />
  </app>`).join('\n');

        const xml = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
${appsXml}
</gupdate>`;
        res.writeHead(200, { 
          'Content-Type': 'application/xml',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(xml);
        return;
      }

      // === Enterprise Force-Install: CRX Download ===
      case '/focusguard.crx': {
        const candidates = [
          path.join(__dirname, '..', 'Blocker.crx'),
          path.join(__dirname, '..', '..', 'Blocker.crx'),
          path.join(__dirname, 'focusguard.crx'),
          'D:\\Projects\\Blocker.crx',
        ];
        const crxPath = candidates.find(p => fs.existsSync(p));
        if (crxPath) {
          res.writeHead(200, { 
            'Content-Type': 'application/x-chrome-extension',
            'Access-Control-Allow-Origin': '*',
          });
          fs.createReadStream(crxPath).pipe(res);
        } else {
          jsonResponse(res, 404, { error: 'CRX package not found' });
        }
        return;
      }

      // === Re-enable Protection ===
      case '/enable': {
        if (method !== 'POST') break;
        cooldownManager.enableProtection();
        // Re-apply all layers
        const domains = watchdog.getAllDomains();
        hostsManager.applyHostsEntries(domains);
        dnsManager.applyDns();
        jsonResponse(res, 200, { ok: true, message: 'Protection re-enabled across all layers.' });
        return;
      }

      // === Custom Domains: Add ===
      case '/add-domain': {
        if (method !== 'POST') break;
        const body = await parseJsonBody(req);
        if (!body.domain) {
          jsonResponse(res, 400, { error: 'Missing "domain" field' });
          return;
        }
        const added = cooldownManager.addCustomDomain(body.domain);
        if (added) {
          // Re-apply hosts with updated domain list
          const domains = watchdog.getAllDomains();
          hostsManager.applyHostsEntries(domains);
        }
        jsonResponse(res, 200, { ok: true, added, domain: body.domain });
        return;
      }

      // === Custom Domains: Remove ===
      case '/remove-domain': {
        if (method !== 'POST') break;
        const body = await parseJsonBody(req);
        if (!body.domain) {
          jsonResponse(res, 400, { error: 'Missing "domain" field' });
          return;
        }
        const removed = cooldownManager.removeCustomDomain(body.domain);
        if (removed) {
          const domains = watchdog.getAllDomains();
          hostsManager.applyHostsEntries(domains);
        }
        jsonResponse(res, 200, { ok: true, removed, domain: body.domain });
        return;
      }

      // === Stats ===
      case '/stats': {
        if (method !== 'GET') break;
        const config = cooldownManager.loadConfig();
        jsonResponse(res, 200, config.stats || {});
        return;
      }

      // === Force re-check all layers ===
      case '/verify': {
        if (method !== 'POST') break;
        watchdog.runCheck();
        jsonResponse(res, 200, { ok: true, message: 'All layers verified.' });
        return;
      }

      default:
        break;
    }

    // 404 for unmatched routes
    jsonResponse(res, 404, { error: 'Not found', path: pathname });
  } catch (err) {
    console.error('[Server] Error handling request:', err);
    jsonResponse(res, 500, { error: err.message });
  }
}

// === Main ===
const args = parseArgs();

const server = http.createServer(handleRequest);

server.listen(PORT, HOST, () => {
  console.log('='.repeat(60));
  console.log(' FocusGuard Companion Service');
  console.log(`  API: http://${HOST}:${PORT}`);
  console.log(`  Config: ${cooldownManager.CONFIG_FILE}`);
  console.log('='.repeat(60));

  // Start the watchdog with optional extension ID
  watchdog.start(args.extensionId);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  watchdog.stop();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  watchdog.stop();
  server.close();
  process.exit(0);
});

// Prevent crashes from killing the service
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[Server] Unhandled rejection:', err);
});
