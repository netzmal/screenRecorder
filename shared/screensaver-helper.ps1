param(
    [string]$exePath,
    [int]$timeoutSeconds = 300,
    [switch]$secure,
    [switch]$enable
)

# ------------------------------------------------------------
# screensaver-helper.ps1
#
# Enables or disables the Windows screensaver for the
# current user.
#
# Important:
# If policy values are set under
# HKCU:\Software\Policies\Microsoft\Windows\Control Panel\Desktop
# then SCRNSAVE.EXE must also be set there.
#
# Otherwise Windows can read timeout/activation from the policy,
# but cannot reliably start a specific screensaver automatically.
# ------------------------------------------------------------

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($exePath) -and $enable) {
    Write-Host "ERROR: exePath fehlt." -ForegroundColor Red
    exit 1
}

$registryPath = "HKCU:\Control Panel\Desktop"
$policyPath   = "HKCU:\Software\Policies\Microsoft\Windows\Control Panel\Desktop"

# When true, the screensaver values are also set as a user policy.
# This causes values such as the wait time to be grayed out in the Windows dialog.
# In exchange, Windows applies the values more reliably.
# Default is now false to avoid locking the Windows UI.
$setPolicyValues = $false

# ------------------------------------------------------------
# Helper function: safely create a registry key.
# ------------------------------------------------------------

function Ensure-RegistryKey {
    param(
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        New-Item -Path $Path -Force | Out-Null
    }
}

# ------------------------------------------------------------
# Helper function: set a value.
# ------------------------------------------------------------

function Set-RegString {
    param(
        [string]$Path,
        [string]$Name,
        [string]$Value
    )

    Ensure-RegistryKey -Path $Path
    Set-ItemProperty -Path $Path -Name $Name -Value $Value -Type String
}

# ------------------------------------------------------------
# Helper function: check whether we can write to the EXE directory.
# ------------------------------------------------------------

function Test-DirectoryWritable {
    param(
        [string]$Path
    )

    try {
        $testFile = Join-Path $Path ".write_test"
        New-Item -Path $testFile -ItemType File -Force -ErrorAction Stop | Out-Null
        Remove-Item $testFile -Force -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

# ------------------------------------------------------------
# Helper function: roughly check monitor timeout through powercfg.
# ------------------------------------------------------------

function Test-MonitorTimeout {
    param(
        [int]$ScreensaverTimeoutSeconds
    )

    try {
        $powerQuery = powercfg /query SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 2>&1
        $text = $powerQuery -join "`n"

        # Works for German and English output because we search for the hex value.
        # The output typically contains:
        # Current AC power setting index: 0x00000000
        # or:
        # Current AC Power Setting Index: 0x00000000

        $acValue = $null

        foreach ($line in $powerQuery) {
            if (
                $line -match "Wechselstromeinstellung.*0x([0-9a-fA-F]+)" -or
                $line -match "AC Power Setting Index.*0x([0-9a-fA-F]+)"
            ) {
                $acValue = [Convert]::ToInt32($matches[1], 16)
                break
            }
        }

        if ($null -ne $acValue) {
            if ($acValue -gt 0 -and $acValue -le $ScreensaverTimeoutSeconds) {
                Write-Host "WARNING: Monitor-Timeout ($acValue s) ist kleiner oder gleich dem Bildschirmschoner-Timeout ($ScreensaverTimeoutSeconds s)." -ForegroundColor Yellow
                Write-Host "WARNING: Der Monitor kann ausgehen, bevor der Bildschirmschoner sichtbar startet." -ForegroundColor Yellow
            } else {
                Write-Host "Monitor-Timeout AC: $acValue Sekunden"
            }
        } else {
            Write-Host "Monitor-Timeout konnte nicht eindeutig gelesen werden."
        }
    } catch {
        Write-Host "Monitor-Timeout konnte nicht geprüft werden: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ------------------------------------------------------------
# Helper function: check powercfg /requests.
# ------------------------------------------------------------

function Test-PowerRequests {
    try {
        $requestsOutput = powercfg /requests 2>&1
        $requestsText = $requestsOutput -join "`n"

        if ($requestsText -match "Administratorrechte|elevated|requires administrator") {
            Write-Host "WARNING: powercfg /requests konnte nicht vollständig geprüft werden, weil Administratorrechte fehlen." -ForegroundColor Yellow
            return
        }

        $foundBlocking = @()
        $currentSection = ""

        foreach ($line in $requestsOutput) {
            $trimmed = $line.Trim()

            if ($trimmed -match "^(DISPLAY|SYSTEM|AWAYMODE|AUSFÜHRUNG|EXECUTION|PERFBOOST|ACTIVELOCKSCREEN):$") {
                $currentSection = $matches[1]
                continue
            }

            if ($trimmed -eq "" -or $trimmed -eq "Keine." -or $trimmed -eq "None.") {
                continue
            }

            if ($currentSection -ne "") {
                $foundBlocking += "${currentSection}: $trimmed"
            }
        }

        if ($foundBlocking.Count -gt 0) {
            Write-Host "WARNING: Folgende Energieanforderungen sind aktiv:" -ForegroundColor Yellow
            foreach ($item in $foundBlocking) {
                Write-Host "WARNING: - $item" -ForegroundColor Yellow
            }
        } else {
            Write-Host "powercfg /requests: Keine aktiven Blocker gefunden."
        }
    } catch {
        Write-Host "powercfg /requests konnte nicht geprüft werden: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ------------------------------------------------------------
# Enable.
# ------------------------------------------------------------

if ($enable) {

    $targetPath = $exePath.Trim('"')

    if (-not (Test-Path $targetPath)) {
        Write-Host "ERROR: Datei wurde nicht gefunden: $targetPath" -ForegroundColor Red
        exit 1
    }

    $exeDir = Split-Path -Path $targetPath -Parent
    $scrPath = Join-Path $exeDir "ScreenRecorder.scr"

    $canWriteInExeDir = Test-DirectoryWritable -Path $exeDir

    if (-not $canWriteInExeDir) {
        Write-Host "Directory $exeDir is not writable."
    }

    # If an .exe was provided, create a .scr from it.
    # Windows traditionally expects a .scr file for screensavers.
    if ($targetPath -like "*.exe") {
        $done = $false

        # 1. Attempt: create the .scr as a hard link or copy in the EXE directory.
        if ($canWriteInExeDir) {
            try {
                if (Test-Path $scrPath) {
                    Remove-Item $scrPath -Force -ErrorAction SilentlyContinue
                }

                New-Item -ItemType HardLink -Path $scrPath -Value $targetPath -ErrorAction Stop | Out-Null
                $targetPath = $scrPath
                $done = $true
                Write-Host "Created .scr hardlink in EXE directory."
            } catch {
                try {
                    Copy-Item -Path $targetPath -Destination $scrPath -Force -ErrorAction Stop
                    $targetPath = $scrPath
                    $done = $true
                    Write-Host "Created .scr copy in EXE directory."
                } catch {
                    Write-Host "WARNING: Failed to create .scr in EXE directory: $($_.Exception.Message)" -ForegroundColor Yellow
                }
            }
        }

        # 2. Fallback: use an existing installer-created .scr next to the EXE.
        #
        # A copied Electron EXE in AppData is not enough because Electron loads
        # its resources relative to the launched executable path. The .scr must
        # therefore live next to the installed resources folder, or Windows must
        # launch the original EXE path.
        if (-not $done) {
            if (Test-Path $scrPath) {
                $targetPath = $scrPath
                $done = $true
                Write-Host "Using existing .scr next to EXE: $targetPath"
            }
        }

        if (-not $done) {
            Write-Host "WARNING: Could not create or find .scr next to EXE. Using original .exe path." -ForegroundColor Yellow
        }
    }

    # Remove the obsolete AppData fallback created by older builds. It copied
    # only the Electron EXE without its resources and can fail silently when
    # Windows starts the screensaver.
    try {
        $oldAppDataScrPath = Join-Path $env:APPDATA "ScreenRecorder\ScreenRecorder.scr"
        if (Test-Path $oldAppDataScrPath) {
            Remove-Item $oldAppDataScrPath -Force -ErrorAction SilentlyContinue
            Write-Host "Removed obsolete AppData .scr fallback: $oldAppDataScrPath"
        }
    } catch {
        Write-Host "WARNING: Could not remove obsolete AppData .scr fallback: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    $cleanPath = $targetPath.Trim('"')
    $secureValue = if ($secure) { "1" } else { "0" }

    # ------------------------------------------------------------
    # Set normal user values.
    # ------------------------------------------------------------

    # Use the path. If it contains spaces, some Windows versions prefer quotes,
    # others (especially the screensaver dialog) prefer NO quotes.
    # Registry standard for SCRNSAVE.EXE is usually without quotes.
    $finalPath = $cleanPath
    
    Set-RegString -Path $registryPath -Name "SCRNSAVE.EXE" -Value $finalPath
    Set-RegString -Path $registryPath -Name "ScreenSaveActive" -Value "1"
    Set-RegString -Path $registryPath -Name "ScreenSaveTimeOut" -Value "$timeoutSeconds"
    Set-RegString -Path $registryPath -Name "ScreenSaverIsSecure" -Value $secureValue

    # ------------------------------------------------------------
    # Set policy values.
    #
    # Important:
    # If Active/Timeout/Secure are set in the policy,
    # SCRNSAVE.EXE must also be present in the policy.
    # Otherwise Windows can lock the dialog but still work
    # without a clean screensaver path.
    # ------------------------------------------------------------

    if ($setPolicyValues) {
        Set-RegString -Path $policyPath -Name "ScreenSaveActive" -Value "1"
        Set-RegString -Path $policyPath -Name "ScreenSaveTimeOut" -Value "$timeoutSeconds"
        Set-RegString -Path $policyPath -Name "ScreenSaverIsSecure" -Value $secureValue
        Set-RegString -Path $policyPath -Name "SCRNSAVE.EXE" -Value $cleanPath

        Write-Host "Policy values have been set, including SCRNSAVE.EXE."
    } else {
        if (Test-Path $policyPath) {
            Remove-ItemProperty -Path $policyPath -Name "ScreenSaveActive" -ErrorAction SilentlyContinue
            Remove-ItemProperty -Path $policyPath -Name "ScreenSaveTimeOut" -ErrorAction SilentlyContinue
            Remove-ItemProperty -Path $policyPath -Name "ScreenSaverIsSecure" -ErrorAction SilentlyContinue
            Remove-ItemProperty -Path $policyPath -Name "SCRNSAVE.EXE" -ErrorAction SilentlyContinue
            
            # If the key is now empty, remove it.
            $props = Get-ItemProperty -Path $policyPath -ErrorAction SilentlyContinue
            $propNames = $props.PSObject.Properties.Name | Where-Object { $_ -notmatch "PSPath|PSParentPath|PSChildName|PSDrive|PSProvider" }
            if ($null -eq $propNames -or $propNames.Count -eq 0) {
                Remove-Item -Path $policyPath -Force -ErrorAction SilentlyContinue
            }
        }

        Write-Host "Policy values have been removed (or were not set). Only normal HKCU desktop values are used."
    }

    # ------------------------------------------------------------
    # Notify Windows about changed settings.
    # ------------------------------------------------------------

    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class Win32 {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
}
"@ -ErrorAction SilentlyContinue

    # SPI_SETSCREENSAVETIMEOUT = 0x000F
    # SPI_SETSCREENSAVEACTIVE  = 0x0011
    # SPIF_UPDATEINIFILE       = 0x01
    # SPIF_SENDCHANGE          = 0x02
    #
    # Briefly disable and re-enable so Windows applies the change.

    [Win32]::SystemParametersInfo(0x0011, 0, [IntPtr]::Zero, 3) | Out-Null
    Start-Sleep -Milliseconds 100
    [Win32]::SystemParametersInfo(0x000F, [uint32]$timeoutSeconds, [IntPtr]::Zero, 3) | Out-Null
    Start-Sleep -Milliseconds 100
    [Win32]::SystemParametersInfo(0x0011, 1, [IntPtr]::Zero, 3) | Out-Null

    # ------------------------------------------------------------
    # Notes and checks.
    # ------------------------------------------------------------

    Test-MonitorTimeout -ScreensaverTimeoutSeconds $timeoutSeconds
    Test-PowerRequests

    Write-Host ""
    Write-Host "Screensaver enabled with timeout $timeoutSeconds seconds."
    Write-Host "Require sign-in on resume: $secureValue"
    Write-Host "Target: $cleanPath"

    $checkActive = Get-ItemProperty -Path $registryPath -Name "ScreenSaveActive" -ErrorAction SilentlyContinue
    $checkTimeout = Get-ItemProperty -Path $registryPath -Name "ScreenSaveTimeOut" -ErrorAction SilentlyContinue
    $checkExe = Get-ItemProperty -Path $registryPath -Name "SCRNSAVE.EXE" -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Host "Registry Check:"
    Write-Host "HKCU Active : $($checkActive.ScreenSaveActive)"
    Write-Host "HKCU Timeout: $($checkTimeout.ScreenSaveTimeOut)"
    Write-Host "HKCU Exe    : $($checkExe.'SCRNSAVE.EXE')"

    if ($setPolicyValues) {
        $policyCheck = Get-ItemProperty -Path $policyPath -ErrorAction SilentlyContinue

        Write-Host ""
        Write-Host "Policy Check:"
        Write-Host "Policy Active : $($policyCheck.ScreenSaveActive)"
        Write-Host "Policy Timeout: $($policyCheck.ScreenSaveTimeOut)"
        Write-Host "Policy Secure : $($policyCheck.ScreenSaverIsSecure)"
        Write-Host "Policy Exe    : $($policyCheck.'SCRNSAVE.EXE')"
    }

    Write-Host ""
    Write-Host "Hinweis: Wenn Windows den Wert nicht sofort übernimmt, einmal abmelden und wieder anmelden."
}

# ------------------------------------------------------------
# Disable.
# ------------------------------------------------------------

else {
    Set-RegString -Path $registryPath -Name "ScreenSaveActive" -Value "0"
    Remove-ItemProperty -Path $registryPath -Name "SCRNSAVE.EXE" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $registryPath -Name "ScreenSaverIsSecure" -ErrorAction SilentlyContinue

    if (Test-Path $policyPath) {
        Remove-ItemProperty -Path $policyPath -Name "ScreenSaveActive" -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path $policyPath -Name "ScreenSaveTimeOut" -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path $policyPath -Name "ScreenSaverIsSecure" -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path $policyPath -Name "SCRNSAVE.EXE" -ErrorAction SilentlyContinue
    }

    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class Win32 {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
}
"@ -ErrorAction SilentlyContinue

    # SPI_SETSCREENSAVEACTIVE = 0x0011
    [Win32]::SystemParametersInfo(0x0011, 0, [IntPtr]::Zero, 3) | Out-Null

    Write-Host "Screensaver disabled and entry removed."
}
