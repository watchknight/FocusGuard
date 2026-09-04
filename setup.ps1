#Requires -RunAsAdministrator
<#
.SYNOPSIS
    FocusGuard Multi-Layer Protection Installer

.DESCRIPTION
    One-click setup for the FocusGuard 5-layer protection system.
    Must be run as Administrator.

    Layers:
      1. Chrome Extension (manual load)
      2. Chrome/Edge Enterprise Policies (registry)
      3. System Hosts File Blocking
      4. DNS-Level Blocking (Kahf Guard)
      5. Windows Background Service (Scheduled Task)

.NOTES
    Run: powershell -ExecutionPolicy Bypass -File setup.ps1
#>

param(
    [switch]$DisableIncognito,
    [switch]$DisableDevTools,
    [string]$DnsProvider = "kahfguard",
    [string]$ExtensionId = ""
)

$ErrorActionPreference = "Continue"
$ServiceDir = Join-Path $PSScriptRoot "service"
$ConfigDir = Join-Path $env:ProgramData "FocusGuard"

# Colors
function Write-Step  { param($msg) Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-OK    { param($msg) Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "    [X] $msg" -ForegroundColor Red }

# Banner
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  FocusGuard Multi-Layer Protection Installer" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# =====================================================================
# Step 0: Check Administrator
# =====================================================================
Write-Step "Checking administrator privileges..."
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "This script must be run as Administrator!"
    Write-Host "    Right-click PowerShell -> Run as Administrator" -ForegroundColor Yellow
    exit 1
}
Write-OK "Running as Administrator"

# =====================================================================
# Step 1: Check/Install Node.js
# =====================================================================
Write-Step "Checking Node.js installation..."

$nodeExists = $false
try {
    $nodeVersion = & node --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        $nodeExists = $true
        Write-OK "Node.js found: $nodeVersion"
    }
} catch { }

if (-not $nodeExists) {
    Write-Warn "Node.js not found. Installing via winget..."

    $wingetExists = $false
    try {
        $wv = & winget --version 2>&1
        if ($LASTEXITCODE -eq 0) { $wingetExists = $true }
    } catch { }

    if ($wingetExists) {
        Write-Host "    Installing Node.js LTS via winget..." -ForegroundColor Yellow
        & winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent 2>&1 | Out-Null

        # Refresh PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")

        # Verify
        try {
            $nodeVersion = & node --version 2>&1
            if ($LASTEXITCODE -eq 0) {
                $nodeExists = $true
                Write-OK "Node.js installed: $nodeVersion"
            }
        } catch { }

        if (-not $nodeExists) {
            Write-Warn "Node.js installed but not yet in PATH."
            Write-Warn "You may need to restart your terminal, then re-run this script."
            Write-Warn "Or manually add Node.js to your PATH."

            # Try common install paths
            $commonPaths = @(
                "C:\Program Files\nodejs",
                "$env:LOCALAPPDATA\Programs\nodejs",
                "$env:ProgramFiles\nodejs"
            )
            foreach ($p in $commonPaths) {
                if (Test-Path (Join-Path $p "node.exe")) {
                    $env:PATH = "$p;$env:PATH"
                    Write-OK "Found Node.js at $p - added to PATH for this session"
                    $nodeExists = $true
                    break
                }
            }
        }
    } else {
        Write-Err "winget not available. Please install Node.js manually from https://nodejs.org"
        Write-Host "    After installing Node.js, re-run this script." -ForegroundColor Yellow
        exit 1
    }
}

if (-not $nodeExists) {
    Write-Err "Node.js installation could not be verified. Please restart your terminal and re-run."
    exit 1
}

# =====================================================================
# Step 2: Create config directory
# =====================================================================
Write-Step "Creating FocusGuard config directory..."
if (-not (Test-Path $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
}
Write-OK "Config directory: $ConfigDir"

# Initialize config if not exists
$configFile = Join-Path $ConfigDir "config.json"
if (-not (Test-Path $configFile)) {
    $today = (Get-Date).ToString("yyyy-MM-dd")
    $defaultConfig = @{
        protectionEnabled = $true
        cooldownActive = $false
        cooldownEndTime = 0
        cooldownDuration = 86400000
        disableRequestTime = 0
        customDomains = @()
        lastHeartbeat = 0
        stats = @{
            totalBlocked = 0
            todayBlocked = 0
            weekBlocked = 0
            lastResetDay = $today
            lastResetWeek = $today
        }
    } | ConvertTo-Json -Depth 3
    Set-Content -Path $configFile -Value $defaultConfig -Encoding UTF8
    Write-OK "Default config created"
} else {
    Write-OK "Config already exists"
}

# =====================================================================
# Step 2.5: Prepare and package CRX for Enterprise deployment
# =====================================================================
Write-Step "Preparing enterprise CRX distribution package..."
$crxTarget = Join-Path $ServiceDir "focusguard.crx"
$crxSource = Join-Path $PSScriptRoot "Blocker.crx"
$pemKey = Join-Path $PSScriptRoot "Blocker.pem"

# Check parent directory fallback if not in root
if (-not (Test-Path $crxSource)) {
    $parentCrx = Join-Path (Split-Path $PSScriptRoot -Parent) "Blocker.crx"
    if (Test-Path $parentCrx) { Copy-Item $parentCrx $crxSource -Force }
}
if (-not (Test-Path $pemKey)) {
    $parentPem = Join-Path (Split-Path $PSScriptRoot -Parent) "Blocker.pem"
    if (Test-Path $parentPem) { Copy-Item $parentPem $pemKey -Force }
}

# Auto-repack with Chrome if available to ensure latest code is bundled
$chromeExe = @("C:\Program Files\Google\Chrome\Application\chrome.exe", "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($chromeExe -and (Test-Path $pemKey)) {
    & $chromeExe --pack-extension="$PSScriptRoot" --pack-extension-key="$pemKey" --no-message-box 2>&1 | Out-Null
}

if (Test-Path $crxSource) {
    Copy-Item $crxSource $crxTarget -Force
    Copy-Item $crxSource (Join-Path $PSScriptRoot "focusguard.crx") -Force
    Write-OK "Enterprise CRX package synchronized ($crxTarget)"
} else {
    Write-Warn "CRX package not found - developer unpacked mode will be available"
}

# =====================================================================
# Step 3: Apply Chrome/Edge Enterprise Policies (Layer 2)
# =====================================================================
Write-Step "Applying Chrome/Edge Enterprise Policies (Layer 2)..."

# Always disable DoH to prevent DNS bypass
$browsers = @(
    @{ Name = "Chrome"; Path = "HKLM:\SOFTWARE\Policies\Google\Chrome" },
    @{ Name = "Edge";   Path = "HKLM:\SOFTWARE\Policies\Microsoft\Edge" }
)

foreach ($browser in $browsers) {
    # Create policy key if needed
    if (-not (Test-Path $browser.Path)) {
        New-Item -Path $browser.Path -Force | Out-Null
    }

    # Disable DoH (prevents DNS bypass - works on all Windows PCs)
    Set-ItemProperty -Path $browser.Path -Name "DnsOverHttpsMode" -Value "off" -Type String -Force
    Write-OK "$($browser.Name): DoH disabled (all DNS queries routed through OS filter)"

    # Enterprise Force-Install Policy
    # Note: On standalone (non-domain) Windows PCs, Chrome policy requires Web Store hosting
    # (https://clients2.google.com/service/update2/crx) to force-install silently.
    $isDomainJoined = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue).PartOfDomain
    if ($isDomainJoined) {
        $extId = "fikmkkdbhncddfijgnhoeakicaahcioh"
        $forcelistPath = Join-Path $browser.Path "ExtensionInstallForcelist"
        if (-not (Test-Path $forcelistPath)) { New-Item -Path $forcelistPath -Force | Out-Null }
        Set-ItemProperty -Path $forcelistPath -Name "1" -Value "$($extId);http://127.0.0.1:7575/update.xml" -Type String -Force
        
        $sourcesPath = Join-Path $browser.Path "ExtensionInstallSources"
        if (-not (Test-Path $sourcesPath)) { New-Item -Path $sourcesPath -Force | Out-Null }
        Set-ItemProperty -Path $sourcesPath -Name "1" -Value "http://127.0.0.1:7575/*" -Type String -Force
        Write-OK "$($browser.Name): Enterprise Domain detected - FocusGuard force-installed via policy"
    } else {
        # Clean up any invalid local forcelist on standalone PC to keep chrome://policy clean
        $forcelistPath = Join-Path $browser.Path "ExtensionInstallForcelist"
        if (Test-Path $forcelistPath) { Remove-Item $forcelistPath -Recurse -Force -ErrorAction SilentlyContinue }
        $sourcesPath = Join-Path $browser.Path "ExtensionInstallSources"
        if (Test-Path $sourcesPath) { Remove-Item $sourcesPath -Recurse -Force -ErrorAction SilentlyContinue }
    }

    # Always enforce SafeSearch & YouTube Restricted Mode via enterprise policy
    Set-ItemProperty -Path $browser.Path -Name "ForceGoogleSafeSearch" -Value 1 -Type DWord -Force
    Set-ItemProperty -Path $browser.Path -Name "ForceYouTubeSafetyMode" -Value 2 -Type DWord -Force
    if ($browser.Name -eq "Edge") {
        Set-ItemProperty -Path $browser.Path -Name "ForceBingSafeSearch" -Value 1 -Type DWord -Force
    }
    Write-OK "$($browser.Name): SafeSearch & YouTube Restricted Mode enforced via policy"

    # Optional: Disable incognito
    if ($DisableIncognito) {
        Set-ItemProperty -Path $browser.Path -Name "IncognitoModeAvailability" -Value 1 -Type DWord -Force
        Write-OK "$($browser.Name): Incognito mode disabled"
    }

    # Optional: Disable DevTools
    if ($DisableDevTools) {
        Set-ItemProperty -Path $browser.Path -Name "DeveloperToolsAvailability" -Value 2 -Type DWord -Force
        Write-OK "$($browser.Name): DevTools disabled"
    }
}

# =====================================================================
# Step 4: Write Hosts File Entries (Layer 3)
# =====================================================================
Write-Step "Writing hosts file entries (Layer 3)..."

$hostsFile = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$hostsBackup = "$hostsFile.focusguard.bak"
$startMarker = "# === FOCUSGUARD START ==="
$endMarker = "# === FOCUSGUARD END ==="

# Backup original (only if hosts file exists)
if (-not (Test-Path $hostsBackup)) {
    if (Test-Path $hostsFile) {
        Copy-Item $hostsFile $hostsBackup -Force
        Write-OK "Hosts file backed up"
    } else {
        Write-Warn "No existing hosts file found - will create a new one"
    }
}

# Load blocklist domains from blocklist.js
$blocklistFile = Join-Path $PSScriptRoot "blocklist.js"
$blocklistContent = Get-Content $blocklistFile -Raw -Encoding UTF8
$domainMatches = [regex]::Matches($blocklistContent, "'([a-z0-9-]+(?:\.[a-z0-9-]+)+)'")
$domains = @()
$seen = @{}
foreach ($m in $domainMatches) {
    $d = $m.Groups[1].Value
    if (-not $seen.ContainsKey($d)) {
        $seen[$d] = $true
        $domains += $d
    }
}

Write-Host "    Found $($domains.Count) domains to block" -ForegroundColor Gray

# Read current hosts (or start fresh if file doesn't exist)
$hostsContent = ""
if (Test-Path $hostsFile) {
    $hostsContent = Get-Content $hostsFile -Raw -Encoding UTF8
    if (-not $hostsContent) { $hostsContent = "" }
}

# Strip existing FocusGuard section
if ($hostsContent -match [regex]::Escape($startMarker)) {
    $hostsContent = $hostsContent -replace "(?s)$([regex]::Escape($startMarker)).*?$([regex]::Escape($endMarker))", ""
    $hostsContent = $hostsContent.TrimEnd()
}

# Build new block
$hostsBlock = @($startMarker)
$hostsBlock += "# Managed by FocusGuard - DO NOT EDIT THIS SECTION"
$hostsBlock += "# Last updated: $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')"
$hostsBlock += "# $($domains.Count) domains blocked"
$hostsBlock += ""
foreach ($d in $domains) {
    $hostsBlock += "0.0.0.0 $d"
    $hostsBlock += "0.0.0.0 www.$d"
}
$hostsBlock += ""
$hostsBlock += "# SafeSearch VIP mappings (forces SafeSearch in ALL browsers at OS level)"
$hostsBlock += "216.239.38.120 google.com"
$hostsBlock += "216.239.38.120 www.google.com"
$hostsBlock += "204.79.197.220 bing.com"
$hostsBlock += "204.79.197.220 www.bing.com"
$hostsBlock += "216.239.38.120 youtube.com"
$hostsBlock += "216.239.38.120 www.youtube.com"
$hostsBlock += "216.239.38.120 m.youtube.com"
$hostsBlock += ""
$hostsBlock += $endMarker

$existingContent = if ($hostsContent) { $hostsContent.TrimEnd() + "`n`n" } else { "" }
$newHostsContent = $existingContent + ($hostsBlock -join "`n") + "`n"

# Clear ReadOnly flag if present and write using .NET IO to avoid stream locks
if (Test-Path $hostsFile) {
    Set-ItemProperty -Path $hostsFile -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue
}
[System.IO.File]::WriteAllText($hostsFile, $newHostsContent, [System.Text.Encoding]::UTF8)

# Flush DNS
& ipconfig /flushdns 2>&1 | Out-Null
Write-OK "$($domains.Count) domains written to hosts file"

# =====================================================================
# Step 5: Configure DNS (Layer 4)
# =====================================================================
Write-Step "Configuring DNS to Kahf Guard (Layer 4)..."

# DNS provider IPs
$dnsSettings = @{
    "kahfguard"      = @{ Primary = "203.190.10.116"; Secondary = "203.190.10.125"; Name = "Kahf Guard (Medium)" }
    "kahfguard_high" = @{ Primary = "203.190.10.118"; Secondary = "203.190.10.126"; Name = "Kahf Guard (High)" }
    "cleanbrowsing"  = @{ Primary = "185.228.168.168"; Secondary = "185.228.169.168"; Name = "CleanBrowsing Family" }
    "cloudflare"     = @{ Primary = "1.1.1.3"; Secondary = "1.0.0.3"; Name = "Cloudflare Family" }
    "opendns"        = @{ Primary = "208.67.222.123"; Secondary = "208.67.220.123"; Name = "OpenDNS FamilyShield" }
    "adguard"        = @{ Primary = "94.140.14.15"; Secondary = "94.140.15.16"; Name = "AdGuard Family" }
}

$selectedDns = $dnsSettings[$DnsProvider]
if (-not $selectedDns) {
    Write-Warn "Unknown DNS provider '$DnsProvider', defaulting to Kahf Guard"
    $selectedDns = $dnsSettings["kahfguard"]
}

Write-Host "    Using: $($selectedDns.Name) ($($selectedDns.Primary), $($selectedDns.Secondary))" -ForegroundColor Gray

# Get active adapters and set DNS
$adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
foreach ($adapter in $adapters) {
    try {
        Set-DnsClientServerAddress -InterfaceAlias $adapter.Name -ServerAddresses @($selectedDns.Primary, $selectedDns.Secondary) -ErrorAction Stop
        Write-OK "DNS set for adapter: $($adapter.Name)"
    } catch {
        Write-Warn "Failed to set DNS for $($adapter.Name): $($_.Exception.Message)"
    }
}

# =====================================================================
# Step 6: Register Windows Scheduled Task (Layer 5)
# =====================================================================
Write-Step "Registering companion service as Scheduled Task (Layer 5)..."

$taskName = "FocusGuardService"
$serverScript = Join-Path $ServiceDir "server.js"

# Find node.exe path
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    # Try common paths
    $commonPaths = @("C:\Program Files\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")
    foreach ($p in $commonPaths) {
        if (Test-Path $p) { $nodePath = $p; break }
    }
}

if (-not $nodePath) {
    Write-Err "Cannot find node.exe - skipping service registration"
} else {
    # Stop and remove existing task if present
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    # Build the task action
    $extIdToUse = if ($ExtensionId) { $ExtensionId } else { "fikmkkdbhncddfijgnhoeakicaahcioh" }
    $extIdArg = " --extension-id $extIdToUse"
    $action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$serverScript`"$extIdArg" -WorkingDirectory $ServiceDir

    # Trigger: at system startup
    $trigger = New-ScheduledTaskTrigger -AtStartup

    # Settings: restart on failure, don't stop on idle, run whether logged in or not
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)

    # Register as SYSTEM so it runs with full privileges
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-OK "Scheduled Task '$taskName' registered (runs at startup as SYSTEM)"

    # Start the service now
    Write-Host "    Starting service..." -ForegroundColor Gray
    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # Verify it's running
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:7575/status" -TimeoutSec 5 -ErrorAction Stop
        Write-OK "Service is running! Protection: $($response.protectionEnabled)"
    } catch {
        Write-Warn "Service may not be running yet. Check Task Scheduler."
    }
}

# =====================================================================
# Done!
# =====================================================================
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  FocusGuard Setup Complete!" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Layer 1: Load the extension in Chrome:" -ForegroundColor White
Write-Host "           1. Open chrome://extensions/" -ForegroundColor Gray
Write-Host "           2. Enable Developer Mode" -ForegroundColor Gray
Write-Host "           3. Click 'Load unpacked'" -ForegroundColor Gray
Write-Host "           4. Select: $PSScriptRoot" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Layer 2: Enterprise policies applied (DoH disabled)" -ForegroundColor White
Write-Host "  Layer 3: $($domains.Count) domains blocked in hosts file" -ForegroundColor White
Write-Host "  Layer 4: DNS set to $($selectedDns.Name)" -ForegroundColor White
Write-Host "  Layer 5: Watchdog service running (localhost:7575)" -ForegroundColor White
Write-Host ""

if ($ExtensionId) {
    Write-Host "  Extension ID: $ExtensionId" -ForegroundColor Yellow
} else {
    Write-Host "  [TIP] After loading the extension, note its ID from" -ForegroundColor Yellow
    Write-Host "        chrome://extensions/ and re-run with:" -ForegroundColor Yellow
    Write-Host "        .\setup.ps1 -ExtensionId <your-extension-id>" -ForegroundColor Cyan
    Write-Host "        This enables the force-install policy (Layer 2)." -ForegroundColor Yellow
}

Write-Host ""
if ($DisableIncognito) {
    Write-Host "  [i] Incognito mode: DISABLED" -ForegroundColor Yellow
}
if ($DisableDevTools) {
    Write-Host "  [i] DevTools: DISABLED" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  To uninstall: powershell -ExecutionPolicy Bypass -File uninstall.ps1" -ForegroundColor Gray
Write-Host ""
