/**
 * FocusGuard Popup Script
 * Controls the popup UI: status display, cooldown timer, and action buttons.
 */

// Format remaining milliseconds as HH:MM:SS (or D:HH:MM:SS for >24h)
function formatTime(ms) {
  if (ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hh = hours.toString().padStart(2, '0');
  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');

  if (days > 0) {
    return `${days}d ${hh}:${mm}:${ss}`;
  }
  return `${hh}:${mm}:${ss}`;
}

/**
 * Request current status from the background service worker.
 * Returns { protectionEnabled, cooldownActive, cooldownEndTime, stats }.
 */
async function fetchStatus() {
  return new Promise((resolve) => {
    if (!chrome?.runtime?.sendMessage) {
      resolve({
        protectionEnabled: true,
        cooldownActive: false,
        cooldownEndTime: 0,
        stats: { totalBlocked: 0, todayBlocked: 0, weekBlocked: 0 },
      });
      return;
    }

    chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        // Fallback if background isn't responding
        resolve({
          protectionEnabled: true,
          cooldownActive: false,
          cooldownEndTime: 0,
          stats: { totalBlocked: 0, todayBlocked: 0, weekBlocked: 0 },
        });
      } else {
        resolve(response);
      }
    });
  });
}

// Timer interval reference
let updateInterval = null;

/**
 * Main UI update function — called on load and every second during cooldown.
 */
async function updateUI() {
  const status = await fetchStatus();
  if (!status) return;

  // --- Update Stats ---
  const stats = status.stats || {};
  document.getElementById('blocksToday').textContent = stats.todayBlocked || 0;
  document.getElementById('blocksWeek').textContent = stats.weekBlocked || 0;
  document.getElementById('blocksAllTime').textContent =
    stats.totalBlocked || 0;

  // --- Update Status Indicator ---
  const indicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const stateActive = document.getElementById('stateActive');
  const stateCooldown = document.getElementById('stateCooldown');
  const stateDisabled = document.getElementById('stateDisabled');

  // Hide all state panels
  stateActive.classList.add('hidden');
  stateCooldown.classList.add('hidden');
  stateDisabled.classList.add('hidden');
  indicator.className = 'status-indicator';

  // Check if cooldown has expired locally (browser may not have processed alarm yet)
  let isCooldownActive = status.cooldownActive;
  if (isCooldownActive && status.cooldownEndTime) {
    if (Date.now() >= status.cooldownEndTime) {
      isCooldownActive = false;
    }
  }

  if (!status.protectionEnabled && !isCooldownActive) {
    // === State: Protection OFF ===
    indicator.classList.add('off');
    statusText.textContent = 'Protection OFF';
    statusText.style.color = 'var(--danger)';
    stateDisabled.classList.remove('hidden');
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  } else if (isCooldownActive) {
    // === State: Cooldown Active ===
    indicator.classList.add('cooldown');
    statusText.textContent = 'Cooldown Active';
    statusText.style.color = 'var(--warning)';
    stateCooldown.classList.remove('hidden');

    // Start live countdown timer
    const endTime = status.cooldownEndTime;
    const tick = () => {
      const remaining = endTime - Date.now();
      if (remaining <= 0) {
        if (updateInterval) {
          clearInterval(updateInterval);
          updateInterval = null;
        }
        document.getElementById('cooldownTimer').textContent = '00:00:00';
        // Give background time to process alarm, then refresh
        setTimeout(updateUI, 1000);
      } else {
        document.getElementById('cooldownTimer').textContent =
          formatTime(remaining);
      }
    };

    if (updateInterval) clearInterval(updateInterval);
    tick(); // Immediate first tick
    updateInterval = setInterval(tick, 1000);
  } else {
    // === State: Protection ON ===
    indicator.classList.add('on');
    statusText.textContent = 'Protection ON';
    statusText.style.color = 'var(--success)';
    stateActive.classList.remove('hidden');
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  }
}

// === Event Listeners ===
document.addEventListener('DOMContentLoaded', () => {
  // Initial UI load
  updateUI();

  // Periodic status refresh (catches state changes from background)
  setInterval(() => {
    // Only do a full refresh if we're not already running a timer
    if (!updateInterval) {
      updateUI();
    }
  }, 5000);

  // Settings button — open settings page
  document.getElementById('settingsBtn').addEventListener('click', () => {
    if (chrome?.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open('settings.html');
    }
  });

  // "Disable Protection" button — starts cooldown
  document.getElementById('disableBtn').addEventListener('click', () => {
    const confirmed = confirm(
      'Are you sure you want to disable protection?\n\n' +
        'Blocking will remain FULLY ACTIVE during the entire cooldown period. ' +
        'Protection will only turn off after the cooldown timer expires.'
    );
    if (confirmed) {
      chrome.runtime.sendMessage({ action: 'startCooldown' }, () => {
        updateUI();
      });
    }
  });

  // "Cancel Disable Request" button — cancels cooldown
  document.getElementById('cancelBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'cancelCooldown' }, () => {
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      updateUI();
    });
  });

  // "Re-enable Protection" button
  document.getElementById('enableBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'reEnableProtection' }, () => {
      updateUI();
    });
  });
});
