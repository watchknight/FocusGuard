# 🛡️ FocusGuard — Multi-Layer Protection System

A 5-layer tamper-resistant system that blocks adult/pornographic websites with a mandatory cooldown period before disabling. Similar to Pluckeye, Cold Turkey, and ScreenZen — but with OS-level enforcement.

## Architecture

```
Layer 5: Windows Service (Watchdog)
  ├── Monitors all layers every 60s
  ├── Re-applies tampered protections
  └── Independent cooldown timer

Layer 4: DNS-Level Blocking
  └── Kahf Guard family-safe DNS (203.190.10.116)

Layer 3: System Hosts File
  └── 571+ domains → 0.0.0.0 (all browsers)

Layer 2: Chrome/Edge Enterprise Policies
  ├── Force-install extension (can't remove)
  ├── Disable DNS-over-HTTPS (can't bypass DNS)
  └── Optional: Disable Incognito, DevTools

Layer 1: Chrome Extension
  ├── declarativeNetRequest blocking (571 domains + 67 keywords)
  ├── SafeSearch enforcement (Google, Bing, DuckDuckGo)
  ├── Cooldown timer with live countdown
  ├── Custom domain management
  └── Motivational blocked page with stats
```

## Quick Start

### Prerequisites
- Windows 10/11
- Chrome or Edge browser
- Administrator access

### Installation

```powershell
# Run as Administrator
powershell -ExecutionPolicy Bypass -File setup.ps1
```

This will:
1. ✅ Install Node.js (if not present) via winget
2. ✅ Apply Chrome/Edge enterprise policies
3. ✅ Write 571+ domains to the hosts file
4. ✅ Set DNS to Kahf Guard family filter
5. ✅ Register the watchdog service as a Scheduled Task

Then load the Chrome extension:
1. Open `chrome://extensions/`
2. Enable **Developer Mode**
3. Click **Load unpacked** → select this folder
4. Note the extension ID shown

### Lock Down (Optional)

After loading the extension, re-run setup with the extension ID to force-install it:

```powershell
# Replace <ID> with your extension ID from chrome://extensions/
powershell -ExecutionPolicy Bypass -File setup.ps1 -ExtensionId "<ID>"
```

Optional flags:
```powershell
# Disable incognito mode and DevTools (aggressive — affects all browsing)
.\setup.ps1 -ExtensionId "<ID>" -DisableIncognito -DisableDevTools
```

### Uninstallation

```powershell
# Run as Administrator — BLOCKED during active cooldown!
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

## Bypass Resistance

| Attack | Result |
|--------|--------|
| Remove extension from chrome://extensions | ❌ Blocked by Enterprise Policy (Remove button grayed out) |
| Force-delete extension folder | Hosts file + DNS still block in ALL browsers |
| Edit hosts file manually | ⏱️ Watchdog re-applies within 60 seconds |
| Change DNS settings | ⏱️ Watchdog re-applies within 60 seconds |
| Kill the Node.js service | 🔄 Scheduled Task auto-restarts it |
| Delete config.json | 🔒 Service recreates with protection ON (fail-safe) |
| Reinstall Chrome | 🔒 Enterprise policies persist in registry |
| Use a different browser | 🔒 Hosts file + DNS block at OS level |
| Use Incognito mode | ❌ Disabled by policy (optional) |
| Use DevTools to bypass | ❌ Disabled by policy (optional) |
| Use DNS-over-HTTPS | ❌ Disabled by Chrome policy |
| Run uninstall.ps1 | ⏱️ Blocked during active cooldown |

## Companion Service API

The watchdog runs on `localhost:7575`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Protection state, cooldown info, layer health |
| `/heartbeat` | POST | Extension liveness ping |
| `/request-disable` | POST | Start cooldown timer |
| `/cancel-disable` | POST | Cancel cooldown |
| `/enable` | POST | Re-enable protection |
| `/add-domain` | POST | Add custom domain (body: `{"domain":"..."}`) |
| `/remove-domain` | POST | Remove custom domain |
| `/stats` | GET | Block statistics |
| `/verify` | POST | Force re-check all layers |

## File Structure

```
D:\Projects\Blocker\
├── Extension (Layer 1)
│   ├── manifest.json
│   ├── background.js          ← heartbeat + service sync + SafeSearch
│   ├── blocklist.js            ← 571 domains + 67 keywords
│   ├── rules.json              ← static declarativeNetRequest rules
│   ├── popup.html/css/js       ← extension popup UI
│   ├── settings.html/css/js    ← settings page + domain sync
│   ├── blocked.html/css/js     ← motivational blocked page
│   └── icons/                  ← shield icons (16/32/48/128px)
├── service/                     Companion Service (Layers 2-5)
│   ├── package.json
│   ├── server.js               ← REST API on localhost:7575
│   ├── watchdog.js             ← 60s verification loop
│   ├── hosts-manager.js        ← Layer 3: hosts file
│   ├── dns-manager.js          ← Layer 4: DNS settings
│   ├── policies.js             ← Layer 2: enterprise policies
│   ├── cooldown-manager.js     ← persistent cooldown state
│   └── blocklist.js            ← bridge to extension blocklist
├── setup.ps1                    One-click installer (admin)
├── uninstall.ps1                Cooldown-protected uninstaller
└── README.md                    This file
```

## Data Locations

| What | Where |
|------|-------|
| Service config | `C:\ProgramData\FocusGuard\config.json` |
| Tamper log | `C:\ProgramData\FocusGuard\tamper.log` |
| Hosts backup | `C:\Windows\System32\drivers\etc\hosts.focusguard.bak` |
| Chrome policies | `HKLM\SOFTWARE\Policies\Google\Chrome` |
| Edge policies | `HKLM\SOFTWARE\Policies\Microsoft\Edge` |
| Scheduled Task | `FocusGuardService` in Task Scheduler |

## DNS Provider Options

Default: **Kahf Guard Medium** (family filter)

| Provider | Primary | Secondary | Setup Flag |
|----------|---------|-----------|------------|
| Kahf Guard (Medium) | 203.190.10.116 | 203.190.10.125 | `-DnsProvider kahfguard` |
| Kahf Guard (High) | 203.190.10.118 | 203.190.10.126 | `-DnsProvider kahfguard_high` |
| CleanBrowsing Family | 185.228.168.168 | 185.228.169.168 | `-DnsProvider cleanbrowsing` |
| Cloudflare Family | 1.1.1.3 | 1.0.0.3 | `-DnsProvider cloudflare` |
| OpenDNS FamilyShield | 208.67.222.123 | 208.67.220.123 | `-DnsProvider opendns` |
| AdGuard Family | 94.140.14.15 | 94.140.15.16 | `-DnsProvider adguard` |

## Troubleshooting

**Service not starting?**
```powershell
# Check task status
Get-ScheduledTask -TaskName FocusGuardService | Select-Object State

# Start manually
node service\server.js

# Check API
Invoke-RestMethod http://127.0.0.1:7575/status
```

**Extension not connecting to service?**
- Check that the service is running: `http://127.0.0.1:7575/status`
- The extension fails silently if the service is down — blocking still works via Layer 1

**DNS not applied?**
```powershell
Get-DnsClientServerAddress -AddressFamily IPv4
# Should show 203.190.10.116 for Kahf Guard
```

**Hosts file not blocking?**
```powershell
type C:\Windows\System32\drivers\etc\hosts | findstr FOCUSGUARD
# Should show the START/END markers
```

## License

MIT
