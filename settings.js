document.addEventListener('DOMContentLoaded', async () => {
    // UI Elements
    const cooldownSelect = document.getElementById('cooldown-select');
    const newDomainInput = document.getElementById('new-domain');
    const addDomainBtn = document.getElementById('add-domain-btn');
    const domainList = document.getElementById('domain-list');
    const importBtn = document.getElementById('import-btn');
    const exportBtn = document.getElementById('export-btn');
    const importModal = document.getElementById('import-modal');
    const cancelImportBtn = document.getElementById('cancel-import');
    const confirmImportBtn = document.getElementById('confirm-import');
    const importTextarea = document.getElementById('import-textarea');
    const closeTabBtn = document.getElementById('close-tab');
    
    // Statistics Elements
    const statTotal = document.getElementById('stat-total');
    const statToday = document.getElementById('stat-today');
    const statWeek = document.getElementById('stat-week');

    let customDomains = [];

    // Initialize the page
    await loadSettings();

    // Event Listeners
    closeTabBtn.addEventListener('click', (e) => {
        e.preventDefault();
        window.close();
    });

    // Reload Extension
    const reloadBtn = document.getElementById('reload-extension-btn');
    if (reloadBtn) {
        reloadBtn.addEventListener('click', () => {
            if (chrome?.runtime?.reload) {
                showToast('Reloading extension...');
                setTimeout(() => {
                    chrome.runtime.reload();
                }, 400);
            }
        });
    }

    // Auto-save cooldown duration (delegates storage write to background script)
    cooldownSelect.addEventListener('change', () => {
        const durationMs = parseInt(cooldownSelect.value, 10);

        chrome.runtime.sendMessage({
            action: 'updateCooldownDuration',
            duration: durationMs
        }, () => {
            showToast('Cooldown duration updated');
        });
    });

    // Add Domain
    addDomainBtn.addEventListener('click', handleAddDomain);
    newDomainInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            handleAddDomain();
        }
    });

    // Export Domains
    exportBtn.addEventListener('click', () => {
        if (customDomains.length === 0) {
            showToast('No domains to export');
            return;
        }
        const domainText = customDomains.join('\n');
        navigator.clipboard.writeText(domainText).then(() => {
            showToast('Domains copied to clipboard!');
        }).catch(err => {
            console.error('Failed to copy domains:', err);
            showToast('Failed to copy to clipboard');
        });
    });

    // Import Modal Actions
    importBtn.addEventListener('click', () => {
        importTextarea.value = '';
        importModal.classList.add('active');
    });

    cancelImportBtn.addEventListener('click', () => {
        importModal.classList.remove('active');
    });

    // Close modal when clicking outside
    importModal.addEventListener('click', (e) => {
        if (e.target === importModal) {
            importModal.classList.remove('active');
        }
    });

    // Confirm Import
    confirmImportBtn.addEventListener('click', () => {
        const lines = importTextarea.value.split('\n');
        let addedCount = 0;
        const newlyAdded = [];
        
        lines.forEach(line => {
            const raw = line.trim();
            if (raw) {
                const cleanDomain = extractHostname(raw);
                if (cleanDomain && !customDomains.includes(cleanDomain)) {
                    customDomains.push(cleanDomain);
                    newlyAdded.push(cleanDomain);
                    addedCount++;
                }
            }
        });

        if (addedCount > 0) {
            saveDomains(`Imported ${addedCount} domains`);
            // Sync each imported domain to companion service (hosts file)
            newlyAdded.forEach(domain => {
                syncDomainToService('add-domain', domain);
            });
        } else {
            showToast('No new valid domains found');
        }
        importModal.classList.remove('active');
    });

    // --- Helper Functions ---

    /**
     * Load all settings and statistics from Chrome storage
     */
    async function loadSettings() {
        return new Promise((resolve) => {
            chrome.storage.local.get({
                cooldownDuration: 86400000, // 24 hours default
                cooldownActive: false,
                customDomains: [],
                stats: { totalBlocked: 0, todayBlocked: 0, weekBlocked: 0 }
            }, (data) => {
                // Set Cooldown
                if (data.cooldownDuration) {
                    cooldownSelect.value = data.cooldownDuration.toString();
                }

                // Lock cooldown selector if cooldown is currently active
                // (prevents reducing the timer mid-cooldown)
                if (data.cooldownActive) {
                    cooldownSelect.disabled = true;
                    cooldownSelect.title = 'Cannot change cooldown duration while a cooldown is active';
                    cooldownSelect.style.opacity = '0.5';
                    cooldownSelect.style.cursor = 'not-allowed';
                } else {
                    cooldownSelect.disabled = false;
                    cooldownSelect.title = '';
                    cooldownSelect.style.opacity = '';
                    cooldownSelect.style.cursor = '';
                }
                
                // Set Domains
                customDomains = data.customDomains || [];
                renderDomainList();

                // Set Stats
                if (data.stats) {
                    statTotal.textContent = data.stats.totalBlocked || 0;
                    statToday.textContent = data.stats.todayBlocked || 0;
                    statWeek.textContent = data.stats.weekBlocked || 0;
                }
                
                resolve();
            });
        });
    }

    /**
     * Handle adding a new domain from the input field
     */
    function handleAddDomain() {
        const rawInput = newDomainInput.value.trim();
        if (!rawInput) return;

        const domain = extractHostname(rawInput);
        if (!domain) {
            showToast('Invalid domain format');
            return;
        }

        if (customDomains.includes(domain)) {
            showToast('Domain already in list');
            return;
        }

        customDomains.push(domain);
        newDomainInput.value = '';
        saveDomains('Domain added successfully');

        // Sync to companion service (adds to hosts file too)
        syncDomainToService('add-domain', domain);
    }

    /**
     * Remove a domain from the list
     */
    function removeDomain(domain) {
        customDomains = customDomains.filter(d => d !== domain);
        saveDomains('Domain removed');

        // Sync to companion service (removes from hosts file too)
        syncDomainToService('remove-domain', domain);
    }

    /**
     * Save domains via background handler (single writer), then render list
     */
    function saveDomains(toastMessage) {
        chrome.runtime.sendMessage({ 
            action: 'updateCustomDomains', 
            domains: customDomains 
        }, () => {
            renderDomainList();
            if (toastMessage) {
                showToast(toastMessage);
            }
        });
    }

    /**
     * Render the domain list in the UI
     */
    function renderDomainList() {
        domainList.innerHTML = '';
        if (customDomains.length === 0) {
            const li = document.createElement('li');
            li.className = 'domain-item';
            li.textContent = 'No custom domains added yet.';
            li.style.color = 'rgba(255, 255, 255, 0.5)';
            li.style.justifyContent = 'center';
            domainList.appendChild(li);
            return;
        }

        customDomains.forEach(domain => {
            const li = document.createElement('li');
            li.className = 'domain-item';
            
            const span = document.createElement('span');
            span.textContent = domain;
            
            const btn = document.createElement('button');
            btn.className = 'btn btn-danger';
            btn.innerHTML = '&#10005;'; // X mark
            btn.setAttribute('aria-label', `Remove ${domain}`);
            btn.addEventListener('click', () => removeDomain(domain));
            
            li.appendChild(span);
            li.appendChild(btn);
            domainList.appendChild(li);
        });
    }

    /**
     * Extract hostname from a URL or string, stripping http/https/www
     */
    function extractHostname(url) {
        let hostname;
        
        // Handle full URLs
        if (url.includes('://') || url.includes('/')) {
            try {
                const urlObj = new URL(url.startsWith('http') ? url : `http://${url}`);
                hostname = urlObj.hostname;
            } catch (e) {
                hostname = url.split('/')[0];
            }
        } else {
            hostname = url;
        }

        // Strip www.
        if (hostname.startsWith('www.')) {
            hostname = hostname.substring(4);
        }

        // Clean up ports and paths, convert to lowercase
        hostname = hostname.split(':')[0].split('/')[0].toLowerCase();
        
        // Basic validation: must contain a dot and no spaces
        if (hostname.includes('.') && !hostname.includes(' ')) {
            return hostname;
        }
        return null;
    }

    /**
     * Show a toast notification
     */
    let toastTimeout;
    function showToast(message) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('show');
        
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }
});

// =====================================================================
// COMPANION SERVICE SYNC
// =====================================================================

/**
 * Sync a custom domain to the companion service (localhost:7575).
 * This adds/removes the domain from the hosts file as well.
 * Fails silently if the service is not running.
 *
 * @param {string} action — 'add-domain' or 'remove-domain'
 * @param {string} domain — the domain name
 */
function syncDomainToService(action, domain) {
    fetch(`http://127.0.0.1:7575/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
    }).catch(() => {
        // Companion service may not be running — fail silently
    });
}
