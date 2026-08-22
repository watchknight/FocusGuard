#Requires -RunAsAdministrator
<#
.SYNOPSIS
    FocusGuard Multi-Layer Protection Uninstaller

.DESCRIPTION
    Removes all FocusGuard protection layers.
    COOLDOWN PROTECTED: Refuses to uninstall if a cooldown is active.
    Must be run as Administrator.

.NOTES
    Run: powershell -ExecutionPolicy Bypass -File uninstall.ps1
#>

param(
    [switch]$Force  # Skip cooldown check (emergency override)
)

$ErrorActionPreference = "Continue"
$ConfigDir = Join-Path $env:ProgramData "FocusGuard"
$ConfigFile = Join-Path $ConfigDir "config.json"

function Write-Step  { param($msg) Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-OK    { param($msg) Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "    [X] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "============================================================" -ForegroundColor Red
Write-Host "  FocusGuard Uninstaller" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Red
Write-Host ""

# =====================================================================
# Check Administrator
# =====================================================================
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "This script must be run as Administrator!"
    exit 1
}

# =====================================================================
# Cooldown Check - REFUSES to uninstall during active cooldown
# =====================================================================
if (-not $Force) {
    Write-Step "Checking cooldown status..."

    if (Test-Path $ConfigFile) {
        try {
            $config = Get-Content $ConfigFile -Raw | ConvertFrom-Json

            if ($config.cooldownActive -eq $true -and $config.cooldownEndTime -gt 0) {
                $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                $remaining = $config.cooldownEndTime - $now

                if ($remaining -gt 0) {
                    $hours = [Math]::Floor($remaining / 3600000)
                    $minutes = [Math]::Floor(($remaining % 3600000) / 60000)

                    Write-Host ""
                    Write-Host "  ============================================" -ForegroundColor Red
                    Write-Host "    COOLDOWN ACTIVE - UNINSTALL BLOCKED" -ForegroundColor Red
                    Write-Host "  ============================================" -ForegroundColor Red
                    Write-Host ""
                    Write-Host "  Remaining: ${hours}h ${minutes}m" -ForegroundColor Yellow
                    Write-Host ""
                    Write-Host "  You set up this protection for a reason." -ForegroundColor White
                    Write-Host "  The cooldown must expire before uninstalling." -ForegroundColor White
                    Write-Host ""
                    Write-Host "  Stay strong." -ForegroundColor Green
                    Write-Host ""
                    exit 1
                }
            }

            if ($config.protectionEnabled -eq $true) {
                Write-Warn "Protection is currently ENABLED."
                Write-Host "    You must first start and wait through a cooldown period" -ForegroundColor Yellow
                Write-Host "    before uninstalling. Use the extension popup to start one." -ForegroundColor Yellow
                Write-Host ""
                $confirm = Read-Host "    Type 'UNINSTALL' to proceed anyway (protection will be removed)"
                if ($confirm -ne "UNINSTALL") {
                    Write-Host "    Uninstall cancelled." -ForegroundColor Green
                    exit 0
                }
            }
        } catch {
            Write-Warn "Could not read config file: $($_.Exception.Message)"
        }
    } else {
        Write-OK "No config file found - proceeding"
    }
} else {
    Write-Warn "Force mode - skipping cooldown check"
}

# =====================================================================
# Step 1: Stop and remove Scheduled Task (Layer 5)
# =====================================================================
Write-Step "Removing Scheduled Task (Layer 5)..."

$taskName = "FocusGuardService"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-OK "Scheduled Task '$taskName' removed"
} else {
    Write-OK "Scheduled Task not found (already removed)"
}

# Also kill any running node server.js processes
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match "server\.js"
} | Stop-Process -Force -ErrorAction SilentlyContinue

# =====================================================================
# Step 2: Revert DNS settings (Layer 4)
# =====================================================================
Write-Step "Reverting DNS settings (Layer 4)..."

$adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
foreach ($adapter in $adapters) {
    try {
        Set-DnsClientServerAddress -InterfaceAlias $adapter.Name -ResetServerAddresses -ErrorAction Stop
        Write-OK "DNS reset for adapter: $($adapter.Name)"
    } catch {
        Write-Warn "Failed to reset DNS for $($adapter.Name): $($_.Exception.Message)"
    }
}

# =====================================================================
# Step 3: Remove hosts file entries (Layer 3)
# =====================================================================
Write-Step "Removing hosts file entries (Layer 3)..."

$hostsFile = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$hostsBackup = "$hostsFile.focusguard.bak"
$startMarker = "# === FOCUSGUARD START ==="
$endMarker = "# === FOCUSGUARD END ==="

if (Test-Path $hostsBackup) {
    # Restore from backup
    Copy-Item $hostsBackup $hostsFile -Force
    Remove-Item $hostsBackup -Force -ErrorAction SilentlyContinue
    Write-OK "Hosts file restored from backup"
} else {
    # Strip FocusGuard section manually
    $hostsContent = Get-Content $hostsFile -Raw -Encoding UTF8
    if ($hostsContent -match [regex]::Escape($startMarker)) {
        $hostsContent = $hostsContent -replace "(?s)$([regex]::Escape($startMarker)).*?$([regex]::Escape($endMarker))", ""
        $hostsContent = $hostsContent.TrimEnd() + "`n"
        if (Test-Path $hostsFile) {
            Set-ItemProperty -Path $hostsFile -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue
        }
        [System.IO.File]::WriteAllText($hostsFile, $hostsContent, [System.Text.Encoding]::UTF8)
        Write-OK "FocusGuard entries removed from hosts file"
    } else {
        Write-OK "No FocusGuard entries found in hosts file"
    }
}

# Flush DNS
& ipconfig /flushdns 2>&1 | Out-Null
Write-OK "DNS cache flushed"

# =====================================================================
# Step 4: Remove Chrome/Edge Enterprise Policies (Layer 2)
# =====================================================================
Write-Step "Removing Chrome/Edge Enterprise Policies (Layer 2)..."

$browsers = @(
    @{ Name = "Chrome"; Path = "HKLM:\SOFTWARE\Policies\Google\Chrome" },
    @{ Name = "Edge";   Path = "HKLM:\SOFTWARE\Policies\Microsoft\Edge" }
)

foreach ($browser in $browsers) {
    if (Test-Path $browser.Path) {
        # Remove specific FocusGuard policies
        Remove-ItemProperty -Path $browser.Path -Name "DnsOverHttpsMode" -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path $browser.Path -Name "IncognitoModeAvailability" -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path $browser.Path -Name "DeveloperToolsAvailability" -ErrorAction SilentlyContinue

        $forcelistPath = Join-Path $browser.Path "ExtensionInstallForcelist"
        if (Test-Path $forcelistPath) {
            Remove-Item $forcelistPath -Recurse -Force -ErrorAction SilentlyContinue
        }

        $sourcesPath = Join-Path $browser.Path "ExtensionInstallSources"
        if (Test-Path $sourcesPath) {
            Remove-Item $sourcesPath -Recurse -Force -ErrorAction SilentlyContinue
        }

        Write-OK "$($browser.Name) policies removed"
    } else {
        Write-OK "$($browser.Name) policies not found (already clean)"
    }
}

# =====================================================================
# Step 5: Clean up config (optional)
# =====================================================================
Write-Step "Cleaning up config directory..."

if (Test-Path $ConfigDir) {
    $cleanConfig = Read-Host "    Remove FocusGuard config and logs? (y/N)"
    if ($cleanConfig -eq 'y' -or $cleanConfig -eq 'Y') {
        Remove-Item $ConfigDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-OK "Config directory removed: $ConfigDir"
    } else {
        Write-OK "Config directory preserved: $ConfigDir"
    }
} else {
    Write-OK "Config directory not found"
}

# =====================================================================
# Done!
# =====================================================================
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  FocusGuard Uninstall Complete" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  All protection layers have been removed:" -ForegroundColor White
Write-Host "    - Scheduled Task stopped and removed" -ForegroundColor Gray
Write-Host "    - DNS reverted to DHCP/automatic" -ForegroundColor Gray
Write-Host "    - Hosts file restored" -ForegroundColor Gray
Write-Host "    - Chrome/Edge policies removed" -ForegroundColor Gray
Write-Host ""
Write-Host "  To remove the Chrome extension:" -ForegroundColor Yellow
Write-Host "    1. Open chrome://extensions/" -ForegroundColor Gray
Write-Host "    2. Find FocusGuard and click Remove" -ForegroundColor Gray
Write-Host ""
Write-Host "  You may need to restart Chrome/Edge for policy" -ForegroundColor Gray
Write-Host "  changes to take full effect." -ForegroundColor Gray
Write-Host ""
