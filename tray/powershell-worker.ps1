# Persistent PowerShell worker for Windows metadata checks used by the tray app.

$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$win32Code = @'
using System;
using System.Runtime.InteropServices;

public class ScreenRecorderWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);
}
'@

try {
    Add-Type -TypeDefinition $win32Code -ErrorAction SilentlyContinue
} catch {}

$uiAutomationLoaded = $false
$windowsFormsLoaded = $false

# Writes one compact JSON response line for the Node process.
function Write-JsonResponse {
    param(
        [Parameter(Mandatory = $true)] [object] $Id,
        [Parameter(Mandatory = $true)] [bool] $Ok,
        [object] $Data = $null,
        [string] $ErrorMessage = $null
    )

    $response = [ordered]@{
        id = $Id
        ok = $Ok
        data = $Data
        error = $ErrorMessage
    }

    [Console]::WriteLine(($response | ConvertTo-Json -Depth 8 -Compress))
}

# Loads UIAutomation assemblies once for browser and active-window metadata.
function Ensure-UiAutomation {
    if ($script:uiAutomationLoaded) {
        return
    }

    try {
        Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
        Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
        $script:uiAutomationLoaded = $true
    } catch {}
}

# Loads Windows Forms once for monitor metadata.
function Ensure-WindowsForms {
    if ($script:windowsFormsLoaded) {
        return
    }

    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
        $script:windowsFormsLoaded = $true
    } catch {}
}

# Returns the idle time in milliseconds using the Win32 last-input timestamp.
function Get-IdleTimeValue {
    try {
        $lii = New-Object ScreenRecorderWin32+LASTINPUTINFO
        $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
        if ([ScreenRecorderWin32]::GetLastInputInfo([ref]$lii)) {
            return ([Environment]::TickCount - $lii.dwTime)
        }
    } catch {}

    return 0
}

# Returns true when Windows appears to be in screensaver or monitor-off mode.
function Test-PowerSaving {
    try {
        $screenSaverProcess = Get-Process | Where-Object {
            $_.ProcessName -like "*scrnsave*" -or $_.MainWindowTitle -like "*screensaver*"
        } | Select-Object -First 1
        if ($screenSaverProcess) {
            return $true
        }
    } catch {}

    try {
        $monitors = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams)
        $allOff = $true
        foreach ($monitor in $monitors) {
            if ($monitor.Active) {
                $allOff = $false
                break
            }
        }

        if ($monitors.Count -gt 0 -and $allOff) {
            return $true
        }
    } catch {}

    return $false
}

# Extracts visible browser URLs from Chromium and Firefox windows.
function Get-BrowserUrls {
    param([string] $ProcessName, [IntPtr] $ActiveHwnd = [IntPtr]::Zero)

    $urls = @()
    try {
        $processes = Get-Process $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
        foreach ($process in $processes) {
            try {
                $hwnd = $process.MainWindowHandle
                
                # Skip minimized windows (unless it's the active window, which shouldn't happen anyway)
                if ($hwnd -ne $ActiveHwnd -and [ScreenRecorderWin32]::IsIconic($hwnd)) {
                    continue
                }

                $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

                $idCondition = [System.Windows.Automation.OrCondition]::New(
                    [System.Windows.Automation.PropertyCondition]::New([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "address-edit-box"),
                    [System.Windows.Automation.PropertyCondition]::New([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "urlbar")
                )
                $editElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $idCondition)

                if (-not $editElement) {
                    $names = @("Address and search bar", "Adress- und Suchleiste", "Address edit box", "Search or enter web address", "URL-Leiste", "Adressleiste")
                    foreach ($name in $names) {
                        $nameCondition = [System.Windows.Automation.AndCondition]::New(
                            [System.Windows.Automation.PropertyCondition]::New([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit),
                            [System.Windows.Automation.PropertyCondition]::New([System.Windows.Automation.AutomationElement]::NameProperty, $name)
                        )
                        $editElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
                        if ($editElement) {
                            break
                        }
                    }
                }

                if (-not $editElement) {
                    $editCondition = [System.Windows.Automation.PropertyCondition]::New(
                        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                        [System.Windows.Automation.ControlType]::Edit
                    )
                    $editElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
                }

                if ($editElement) {
                    $value = ""
                    try {
                        $pattern = $editElement.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                        $value = $pattern.Current.Value
                    } catch {
                        $value = $editElement.Current.Name
                    }

                    if ($value -and $value.Length -gt 3 -and $value -match "(\.|/|:)") {
                        $urls += $value
                    }
                }
            } catch {}
        }
    } catch {}

    return $urls | Select-Object -Unique
}

# Extracts UI text from the currently active window where Windows exposes it.
function Get-ActiveWindowText {
    param([IntPtr] $Hwnd)

    $texts = @()
    if ($Hwnd -eq [IntPtr]::Zero) {
        return $texts
    }

    try {
        $activeRoot = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
        $textElements = $activeRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($element in $textElements) {
            if ($element.Current.ControlType.ProgrammaticName -match "Text|Edit|Document|List|ListItem|Header") {
                $value = ""
                try {
                    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    $value = $pattern.Current.Value
                } catch {
                    $value = $element.Current.Name
                }

                if ($value -and $value.Length -gt 3 -and $value.Length -lt 2000) {
                    $texts += $value.Trim()
                }
            }
        }
    } catch {}

    return $texts | Select-Object -Unique
}

# Collects window, browser, Explorer, call and monitor metadata for a capture.
function Get-ScreenRecorderMetadata {
    param(
        [bool] $IncludeFull = $true,
        [bool] $IncludeMonitors = $true
    )

    $output = [ordered]@{
        titles = @()
        files = @()
        urls = @()
        calls = @()
        activeWindow = ""
        activeWindowRect = [ordered]@{ Left = 0; Top = 0; Right = 0; Bottom = 0 }
        monitors = @()
        uiText = $null
    }

    $hwnd = [IntPtr]::Zero
    $activeProcessName = ""
    try {
        $hwnd = [ScreenRecorderWin32]::GetForegroundWindow()
        $activeProcess = Get-Process | Where-Object { $_.MainWindowHandle -eq $hwnd } | Select-Object -First 1
        if ($activeProcess) {
            $activeProcessName = $activeProcess.ProcessName
            $output.activeWindow = $activeProcess.MainWindowTitle
            if ($output.activeWindow) {
                $output.titles += $output.activeWindow
            }

            $rect = New-Object ScreenRecorderWin32+RECT
            if ([ScreenRecorderWin32]::GetWindowRect($hwnd, [ref]$rect)) {
                $output.activeWindowRect.Left = $rect.Left
                $output.activeWindowRect.Top = $rect.Top
                $output.activeWindowRect.Right = $rect.Right
                $output.activeWindowRect.Bottom = $rect.Bottom
            }
        }
    } catch {}

    if ($IncludeFull) {
        Ensure-UiAutomation

        try {
            $chromeUrls = Get-BrowserUrls "chrome" $hwnd
            if ($chromeUrls) {
                $output.urls += $chromeUrls
            }

            $edgeUrls = Get-BrowserUrls "msedge" $hwnd
            if ($edgeUrls) {
                $output.urls += $edgeUrls
            }

            $firefoxUrls = Get-BrowserUrls "firefox" $hwnd
            if ($firefoxUrls) {
                $output.urls += $firefoxUrls
            }

            # Prioritize the active window's URL if it's a browser.
            if ($activeProcessName -match "chrome|msedge|firefox" -and $output.urls.Count -gt 1) {
                # We try to find the URL of the active window and put it at the top.
                # Actually, Get-BrowserUrls already collected it if it was visible.
                # To be absolutely sure, we could re-run it just for $hwnd but it's already included.
                # Let's just make sure the result is unique but preserves order as much as possible.
                $output.urls = $output.urls | Select-Object -Unique
            }

            $activeWindowTexts = Get-ActiveWindowText $hwnd
            if ($activeWindowTexts.Count -gt 0) {
                $output.uiText = "--- UI Extracted Text (Active Window) ---`n" + (($activeWindowTexts | Select-Object -Unique) -join "`n")
            }
        } catch {}

        try {
            Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object {
                $output.titles += $_.MainWindowTitle
            }
        } catch {}

        try {
            $explorer = New-Object -ComObject Shell.Application
            $explorer.Windows() | ForEach-Object {
                try {
                    if ($_.LocationURL -like 'file://*') {
                        $uri = New-Object System.Uri($_.LocationURL)
                        $output.files += $uri.LocalPath
                    }
                } catch {}
            }
        } catch {}

        try {
            $threeCxProcesses = Get-Process | Where-Object { ($_.ProcessName -match "3CX") -and $_.MainWindowTitle }
            foreach ($process in $threeCxProcesses) {
                $title = $process.MainWindowTitle
                if ($title -match "Call with|Anruf mit|Calling|Ringe|Ringing|Talking|Sprechen|On Call") {
                    $output.calls += "3CX: $title"
                }
            }

            $callProcesses = Get-Process | Where-Object {
                ($_.ProcessName -match "Phone|Call") -and
                ($_.ProcessName -notmatch "Chrome|Edge|Explorer|3CX") -and
                $_.MainWindowTitle
            }
            foreach ($process in $callProcesses) {
                $output.calls += "$($process.ProcessName): $($process.MainWindowTitle)"
            }
        } catch {}
    }

    if ($IncludeMonitors) {
        Ensure-WindowsForms

        try {
            [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
                $output.monitors += [ordered]@{
                    DeviceName = $_.DeviceName
                    Bounds = [ordered]@{
                        X = $_.Bounds.X
                        Y = $_.Bounds.Y
                        Width = $_.Bounds.Width
                        Height = $_.Bounds.Height
                    }
                    Primary = $_.Primary
                }
            }
        } catch {}
    }

    return $output
}

# Handles one JSON request from Node and writes exactly one JSON response line.
function Invoke-WorkerRequest {
    param([object] $Request)

    switch ($Request.command) {
        "ping" {
            return "pong"
        }
        "shutdown" {
            return "shutdown"
        }
        "getIdleTime" {
            return Get-IdleTimeValue
        }
        "isPowerSaving" {
            return Test-PowerSaving
        }
        "getMetaData" {
            $includeFull = $true
            $includeMonitors = $true

            if ($null -ne $Request.params) {
                if ($null -ne $Request.params.includeFull) {
                    $includeFull = [bool] $Request.params.includeFull
                }
                if ($null -ne $Request.params.includeMonitors) {
                    $includeMonitors = [bool] $Request.params.includeMonitors
                }
            }

            return Get-ScreenRecorderMetadata -IncludeFull $includeFull -IncludeMonitors $includeMonitors
        }
        default {
            throw "Unknown PowerShell worker command: $($Request.command)"
        }
    }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) {
        break
    }
    if ([string]::IsNullOrWhiteSpace($line)) {
        continue
    }

    $requestId = $null
    try {
        $request = $line | ConvertFrom-Json
        $requestId = $request.id
        $data = Invoke-WorkerRequest $request
        Write-JsonResponse -Id $requestId -Ok $true -Data $data

        if ($request.command -eq "shutdown") {
            break
        }
    } catch {
        Write-JsonResponse -Id $requestId -Ok $false -ErrorMessage $_.Exception.Message
    }
}
