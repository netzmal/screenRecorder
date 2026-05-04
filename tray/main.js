const { app, Menu, Tray, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const screenshot = require('screenshot-desktop');
const crypto = require('crypto');
const Tesseract = require('tesseract.js');
const { exec, spawn } = require('child_process');
const os = require('os');
const { getConfigDir, getInterval, getOnlyOnChanges, getOcrEnabled, getOcrLanguage, store, getScreenshotOnWindowChange, getWindowChangeDelay, getScreenshotOnDisplayChange, getDisplayChangeDelay, getSkipOnPowerSave, getOcrFastMode, getIsBatchOcrRunning, setIsBatchOcrRunning, getIsScreensaverRunning, setIsScreensaverRunning, getLanguage, getScreenshotFormat, setLastIndexingTime } = require('../shared/config');
const { saveCapture, saveCapturesBatch, initDb, getAllCaptures, deleteCapture, getPendingOcrCount } = require('../shared/db');
const i18n = require('../shared/i18n');
const { runWindowsOcrBatch } = require('../shared/ocr-helper');

// i18n initialisieren
const configLanguage = getLanguage();
i18n.init(configLanguage === 'auto' ? null : configLanguage);

// Sicherstellen, dass Batch OCR Status zurückgesetzt ist
setIsBatchOcrRunning(false);
setIsScreensaverRunning(false);

// Logging-Funktion für Debugging
function logDebug(message) {
    try {
        const logDir = path.join(getConfigDir(), 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const logFile = path.join(logDir, 'tray.log');
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
    } catch (e) {}
    console.log(message);
}

// AppUserModelId setzen für Benachrichtigungen unter Windows
if (process.platform === 'win32') {
    app.setAppUserModelId('com.screen.recorder');
}

// Startup Logging
console.log('--- Screen Recorder Tray Startup ---');
console.log('Version:', app.getVersion());
console.log('Screenshot Directory:', getConfigDir());
console.log('Interval:', getInterval());
console.log('Screenshot Format:', getScreenshotFormat());
console.log('------------------------------------');

let tray;
let recordingTimeout;
let idleCheckInterval;
let windowMonitorInterval;
let nextScreenshotTime;
let lastHashes = {}; // { displayId: hash }
let lastActiveWindowTitle = "";
let lastActiveDisplayId = null;
let windowChangeTimeout = null;
let displayChangeTimeout = null;
let ocrWorker = null;
let currentOnNewScreenshots = null;


async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;
    logDebug('Initializing Tesseract worker...');
    ocrWorker = await Tesseract.createWorker(getOcrLanguage() || 'deu+eng');
    
    // Geschwindigkeits- und Qualitäts-Optimierungen
    const fastMode = getOcrFastMode();
    const parameters = {
        tessedit_pageseg_mode: 3, // AUTO
        // Verhindert das Erkennen von extrem kleinen/unwahrscheinlichen Zeichenfolgen
        tessedit_char_whitelist: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZäöüÄÖÜß.,:;!?()[]{}@/\\- '
    };

    if (fastMode) {
        logDebug('Applying fast mode OCR parameters');
        Object.assign(parameters, {
            load_system_dawg: '0',
            load_freq_dawg: '0',
            load_punc_dawg: '0',
            load_number_dawg: '0',
            load_unambig_dawg: '0',
            load_bigram_dawg: '0',
            load_fixed_length_dawgs: '0'
        });
    }
    
    await ocrWorker.setParameters(parameters);
    
    return ocrWorker;
}

async function terminateOcrWorker() {
    if (ocrWorker) {
        logDebug('Terminating Tesseract worker...');
        await ocrWorker.terminate();
        ocrWorker = null;
    }
}

function isPowerSaving() {
    if (!getSkipOnPowerSave()) return Promise.resolve(false);
    
    return new Promise((resolve) => {
        const script = `
            $ProgressPreference = 'SilentlyContinue'
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
            Add-Type -TypeDefinition @'
            using System;
            using System.Runtime.InteropServices;
            public class Win32 {
                [DllImport("user32.dll")]
                public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
                [StructLayout(LayoutKind.Sequential)]
                public struct LASTINPUTINFO {
                    public uint cbSize;
                    public uint dwTime;
                }
                
                [DllImport("user32.dll")]
                public static extern IntPtr GetForegroundWindow();
                
                [DllImport("user32.dll")]
                public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
                [StructLayout(LayoutKind.Sequential)]
                public struct RECT {
                    public int Left, Top, Right, Bottom;
                }
            }
'@ -ErrorAction SilentlyContinue

            $isScreenSaverRunning = Get-Process | Where-Object { $_.ProcessName -like "*scrnsave*" -or $_.MainWindowTitle -like "*screensaver*" }
            if ($isScreenSaverRunning) { return $true }

            # Prüfen ob der Monitor im Standby ist (via WMI/Cim)
            # Eine einfache Methode unter Windows ist zu prüfen, ob der Monitor-Status "Power Off" ist
            try {
                $monitors = Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams
                $allOff = $true
                foreach ($m in $monitors) {
                    if ($m.Active) { $allOff = $false; break }
                }
                if ($monitors.Count -gt 0 -and $allOff) { return $true }
            } catch {}

            return $false
        `;
        const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
        exec(`powershell -NoProfile -EncodedCommand ${encodedScript}`, (error, stdout) => {
            if (error) {
                resolve(false);
                return;
            }
            resolve(stdout.trim().toLowerCase() === 'true');
        });
    });
}

function getIdleTime() {
    return new Promise((resolve) => {
        const script = `
            $ProgressPreference = 'SilentlyContinue'
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
            $code = @'
            using System;
            using System.Runtime.InteropServices;
            public class Win32 {
                [StructLayout(LayoutKind.Sequential)]
                public struct LASTINPUTINFO {
                    public uint cbSize;
                    public uint dwTime;
                }
                [DllImport("user32.dll")]
                public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
            }
'@
            Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
            $lii = New-Object Win32+LASTINPUTINFO
            $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
            if ([Win32]::GetLastInputInfo([ref]$lii)) {
                $idleTicks = [Environment]::TickCount - $lii.dwTime
                $idleTicks
            } else {
                0
            }
        `;
        const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
        exec(`powershell -NoProfile -EncodedCommand ${encodedScript}`, (error, stdout) => {
            if (error) {
                resolve(0);
                return;
            }
            resolve(parseInt(stdout.trim()) || 0);
        });
    });
}

// Maintenance für die Datenbank laufen lassen (verwaiste Einträge löschen)
async function runDatabaseMaintenance() {
    // Wenn User aktiv ist, verschieben wir die Maintenance
    const idleTimeMs = await getIdleTime();
    if (idleTimeMs < 5000) return;

    console.log('Running database maintenance...');
    try {
        const captures = getAllCaptures();
        let deletedCount = 0;

        for (const capture of captures) {
            let stillExists = false;
            const files = capture.files;
            
            // capture.files ist ein Array von Pfaden (oder ein Objekt bei älteren Versionen)
            const fileList = Array.isArray(files) ? files : Object.values(files);

            for (const filePath of fileList) {
                if (fs.existsSync(filePath)) {
                    stillExists = true;
                    break;
                }
            }

            if (!stillExists) {
                deleteCapture(capture.id);
                deletedCount++;
            }
        }
        if (deletedCount > 0) {
            console.log(`Maintenance finished: Deleted ${deletedCount} orphaned entries.`);
        }
    } catch (err) {
        console.error('Database maintenance failed', err);
    }
}


function getMetaData(includeFull = true, includeMonitors = true) {
    return new Promise((resolve) => {
        // Robusterer PowerShell-Befehl
        const script = `
            $ProgressPreference = 'SilentlyContinue'
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
            $output = @{ 
                titles = @(); 
                files = @(); 
                urls = @();
                calls = @();
                activeWindow = ""; 
                activeWindowRect = @{ Left = 0; Top = 0; Right = 0; Bottom = 0 };
                monitors = @()
            };
            
            $includeFull = ${includeFull ? '$true' : '$false'}
            $includeMonitors = ${includeMonitors ? '$true' : '$false'}

            # Aktives Fenster ermitteln (immer nötig für Monitoring)
            $code = @'
                using System;
                using System.Runtime.InteropServices;
                public class Win32 {
                    [DllImport("user32.dll")]
                    public static extern IntPtr GetForegroundWindow();
                    [DllImport("user32.dll")]
                    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
                    [StructLayout(LayoutKind.Sequential)]
                    public struct RECT {
                        public int Left, Top, Right, Bottom;
                    }
                }
'@
            try {
                Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
                $hwnd = [Win32]::GetForegroundWindow()
                $activeProc = Get-Process | Where-Object { $_.MainWindowHandle -eq $hwnd }
                if ($activeProc) {
                    $output.activeWindow = $activeProc.MainWindowTitle
                    if ($output.activeWindow) {
                        $output.titles += $output.activeWindow
                    }
                    $rect = New-Object Win32+RECT
                    if ([Win32]::GetWindowRect($hwnd, [ref]$rect)) {
                        $output.activeWindowRect.Left = $rect.Left
                        $output.activeWindowRect.Top = $rect.Top
                        $output.activeWindowRect.Right = $rect.Right
                        $output.activeWindowRect.Bottom = $rect.Bottom
                    }
                }
            } catch {}

            if ($includeFull) {
                # Browser URLs ermitteln (Chrome & Edge) via UIAutomation
                try {
                    if ($null -eq [System.Windows.Automation.AutomationElement]) {
                        Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
                        Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
                    }
                    
                    function Get-BrowserUrls {
                        param([string]$processName)
                        $urls = @()
                        try {
                            $procs = Get-Process $processName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
                            foreach ($proc in $procs) {
                                try {
                                    $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
                                    
                                    # 1. Versuche über AutomationId (Chromium & Firefox Standards)
                                    $idCondition = [System.Windows.Automation.OrCondition]::New(
                                        [System.Windows.Automation.PropertyCondition]::New([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "address-edit-box"),
                                        [System.Windows.Automation.PropertyCondition]::New([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "urlbar")
                                    )
                                    $editElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $idCondition)
                                    
                                    # 2. Fallback: Suche nach Edit Controls mit Namen (lokalisiert)
                                    if (-not $editElement) {
                                        $names = @("Address and search bar", "Adress- und Suchleiste", "Address edit box", "Search or enter web address", "URL-Leiste", "Adressleiste")
                                        foreach ($name in $names) {
                                            $nameCondition = [System.Windows.Automation.AndCondition]::New(
                                                [System.Windows.Automation.PropertyCondition]::New([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit),
                                                [System.Windows.Automation.PropertyCondition]::New([System.Windows.Automation.AutomationElement]::NameProperty, $name)
                                            )
                                            $editElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
                                            if ($editElement) { break }
                                        }
                                    }

                                    # 3. Fallback: Suche einfach nach dem ersten Edit Control
                                    if (-not $editElement) {
                                        $editCondition = [System.Windows.Automation.PropertyCondition]::New(
                                            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, 
                                            [System.Windows.Automation.ControlType]::Edit
                                        )
                                        $editElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
                                    }
                                    
                                    if ($editElement) {
                                        $val = ""
                                        try {
                                            $pattern = $editElement.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                                            $val = $pattern.Current.Value
                                        } catch {
                                            $val = $editElement.Current.Name
                                        }
                                        # Einfache Heuristik: Muss Punkt, Slash oder Doppelpunkt enthalten und kein reiner Platzhalter sein
                                        if ($val -and $val.Length -gt 3 -and $val -match "(\.|/|:)") {
                                            $urls += $val
                                        }
                                    }
                                } catch {}
                            }
                        } catch {}
                        return $urls | Select-Object -Unique
                    }
                    
                    $chromeUrls = Get-BrowserUrls "chrome"
                    if ($chromeUrls) { $output.urls += $chromeUrls }
                    $edgeUrls = Get-BrowserUrls "msedge"
                    if ($edgeUrls) { $output.urls += $edgeUrls }
                    $firefoxUrls = Get-BrowserUrls "firefox"
                    if ($firefoxUrls) { $output.urls += $firefoxUrls }

                    # Textextraktion aus dem aktiven Fenster via UIAutomation (DOM-artig)
                    if ($hwnd -ne 0) {
                        try {
                            $activeRoot = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
                            $textElements = $activeRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
                            $extractedTexts = @()
                            foreach ($el in $textElements) {
                                if ($el.Current.ControlType.ProgrammaticName -match "Text|Edit|Document|List|ListItem|Header") {
                                    $val = ""
                                    try {
                                        $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                                        $val = $p.Current.Value
                                    } catch {
                                        $val = $el.Current.Name
                                    }
                                    if ($val -and $val.Length -gt 3 -and $val.Length -lt 2000) {
                                        $extractedTexts += $val.Trim()
                                    }
                                }
                            }
                            if ($extractedTexts.Count -gt 0) {
                                $output.ocrText += [char]10 + "--- UI Extracted Text (Active Window) ---" + [char]10
                                $output.ocrText += ($extractedTexts | Select-Object -Unique) -join [char]10
                            }
                        } catch {}
                    }
                } catch {}

                # Alle Fenstertitel
                try {
                    Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $output.titles += $_.MainWindowTitle };
                } catch {}
                
                # Offene Dateien im Explorer
                try {
                    $exp = New-Object -ComObject Shell.Application;
                    $exp.Windows() | ForEach-Object {
                        try {
                            if ($_.LocationURL -like 'file://*') {
                                $path = $_.LocationURL.Replace('file:///', '').Replace('/', '\\');
                                $decodedPath = [uri]::UnescapeDataString($path);
                                $output.files += $decodedPath;
                            }
                        } catch {}
                    }
                } catch {};

                # Anrufe erkennen (3CX & Windows Phone API)
                try {
                    # 1. 3CX spezifische Erkennung via Fenstertitel (auch wenn nicht im Fokus)
                    $3cxProcs = Get-Process | Where-Object { ($_.ProcessName -match "3CX") -and $_.MainWindowTitle }
                    foreach ($p in $3cxProcs) {
                        $title = $p.MainWindowTitle
                        # Typische Muster für aktive Anrufe in 3CX
                        if ($title -match "Call with|Anruf mit|Calling|Wählt|Ringe|Ringing|Talking|Sprechen|On Call") {
                            $output.calls += "3CX: $title"
                        }
                    }
                    
                    # 2. Windows Phone API (WinRT) Check via Shell (nur wenn includeFull)
                    if ($includeFull) {
                        # Wir suchen nach Prozessen die den 'Phone' oder 'Call' Namen tragen und aktiv sind
                        $callProcs = Get-Process | Where-Object { ($_.ProcessName -match "Phone|Call") -and ($_.ProcessName -notmatch "Chrome|Edge|Explorer|3CX") -and $_.MainWindowTitle }
                        foreach ($p in $callProcs) {
                            $output.calls += "$($p.ProcessName): $($p.MainWindowTitle)"
                        }
                    }
                } catch {}
            }

            # Monitore ermitteln (nur wenn angefordert)
            if ($includeMonitors) {
                try {
                    Add-Type -AssemblyName System.Windows.Forms
                    [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
                        $output.monitors += @{
                            DeviceName = $_.DeviceName;
                            Bounds = @{
                                X = $_.Bounds.X;
                                Y = $_.Bounds.Y;
                                Width = $_.Bounds.Width;
                                Height = $_.Bounds.Height
                            };
                            Primary = $_.Primary
                        }
                    }
                } catch {}
            }
            $output | ConvertTo-Json -Depth 4
        `;
        const tempScriptPath = path.join(os.tmpdir(), `sr-metadata-${Date.now()}-${Math.random().toString(36).substring(7)}.ps1`);
        
        try {
            // Skript mit UTF-8 BOM speichern, damit PowerShell Umlaute korrekt erkennt
            fs.writeFileSync(tempScriptPath, '\ufeff' + script, 'utf8');
        } catch (err) {
            logDebug(`Failed to write temp script: ${err.message}`);
            resolve({ titles: [], files: [], activeWindow: "" });
            return;
        }

        const psProcess = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tempScriptPath]);
        
        let stdout = '';
        psProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        psProcess.stderr.on('data', (data) => {
            const errorMsg = data.toString();
            // Ignoriere typische PowerShell-Initialisierungsmeldungen oder CLIXML-Header
            if (errorMsg.includes('<Objs') || errorMsg.includes('#< CLIXML') || errorMsg.includes('Module werden vorbereitet')) {
                return;
            }
            logDebug(`PowerShell Error: ${errorMsg}`);
        });

        psProcess.on('close', (code) => {
            // Temp-Datei löschen
            try {
                if (fs.existsSync(tempScriptPath)) fs.unlinkSync(tempScriptPath);
            } catch (e) {
                logDebug(`Failed to delete temp script: ${e.message}`);
            }

            if (code !== 0) {
                logDebug(`PowerShell exited with code ${code}`);
                resolve({ titles: [], files: [], activeWindow: "" });
                return;
            }
            try {
                const data = JSON.parse(stdout);
                const titles = Array.isArray(data.titles) ? data.titles : (data.titles ? [data.titles] : []);
                const files = Array.isArray(data.files) ? data.files : (data.files ? [data.files] : []);
                const urls = Array.isArray(data.urls) ? data.urls : (data.urls ? [data.urls] : []);
                const calls = Array.isArray(data.calls) ? data.calls : (data.calls ? [data.calls] : []);
                const activeWindow = data.activeWindow || "";
                const activeWindowRect = data.activeWindowRect;
                const monitors = Array.isArray(data.monitors) ? data.monitors : (data.monitors ? [data.monitors] : []);
                
                // Debug-Log für Metadaten
                if (urls.length > 0 || calls.length > 0) {
                    logDebug(`Metadaten erfasst - URLs: ${urls.length}, Calls: ${calls.length}`);
                }
                
        // Eindeutige Werte und leere Einträge filtern
        const result = { 
            activeWindow: activeWindow,
            activeWindowRect: activeWindowRect,
            monitors: monitors,
            titles: [...new Set(titles)].filter(t => t && typeof t === 'string' && t.trim() !== ''), 
            files: [...new Set(files)].filter(f => f && typeof f === 'string' && f.trim() !== ''),
            urls: [...new Set(urls)].filter(u => u && typeof u === 'string' && u.trim() !== ''),
            calls: [...new Set(calls)].filter(c => c && typeof c === 'string' && c.trim() !== '')
        };

        if (includeFull) {
            logDebug(`getMetaData - titles: ${result.titles.length}, files: ${result.files.length}, urls: ${result.urls.length}, calls: ${result.calls.length}`);
            
            // Debugging: Liste der ersten 3 Titel loggen
            if (result.titles.length > 0) {
                logDebug(`Erste 3 Titel: ${result.titles.slice(0, 3).join(', ')}`);
            } else {
                logDebug(`WARNUNG: Keine Titel erfasst!`);
            }
        }
        
        resolve(result);
            } catch (e) {
                console.error('Metadata parsing failed', e, stdout);
                resolve({ titles: [], files: [], activeWindow: "" });
            }
        });
    });
}

function updateTrayStatus() {
    // Hier können zukünftige Status-Aktualisierungen rein (z.B. Icons blinken bei Aufnahme)
}


function openViewer() {
    if (app.isPackaged) {
        // In der installierten App nutzen wir den eigenen Executable-Pfad ohne Argumente
        spawn(process.execPath, [], {
            detached: true,
            stdio: 'ignore'
        }).unref();
    } else {
        // Im Entwicklungsmodus nutzen wir electron aus den node_modules
        const path = require('path');
        const viewerPath = path.join(__dirname, '..', 'viewer');
        const electronPath = require('electron');
        spawn(electronPath, [viewerPath], {
            detached: true,
            stdio: 'ignore'
        }).unref();
    }
}

function startScreensaver() {
    if (app.isPackaged) {
        // In der installierten App nutzen wir den eigenen Executable-Pfad mit "screensaver" Argument
        spawn(process.execPath, ['screensaver'], {
            detached: true,
            stdio: 'ignore'
        }).unref();
    } else {
        // Im Entwicklungsmodus nutzen wir electron aus den node_modules
        const path = require('path');
        const screensaverPath = path.join(__dirname, '..', 'screensaver');
        const electronPath = require('electron');
        spawn(electronPath, [screensaverPath], {
            detached: true,
            stdio: 'ignore'
        }).unref();
    }
}

function setupTray() {
    let iconPath = path.join(__dirname, 'assets', 'icon.png');
    if (process.platform === 'win32') {
        const icoPath = path.join(__dirname, 'assets', 'icon.ico');
        if (fs.existsSync(icoPath)) iconPath = icoPath;
    }

    let icon;
    if (fs.existsSync(iconPath)) {
        // Unter Windows für den Tray bevorzugt nativeImage aus ICO laden
        icon = nativeImage.createFromPath(iconPath);
        if (icon.isEmpty()) {
            console.error('Tray icon failed to load from:', iconPath);
        } else {
            console.log('Tray icon loaded from:', iconPath, 'Size:', icon.getSize());
        }
    } else {
        console.error('Tray icon file not found:', iconPath);
        icon = nativeImage.createEmpty();
    }
    
    if (process.platform === 'win32') {
        tray = new Tray(iconPath);
    } else {
        tray = new Tray(icon);
    }
    
    const contextMenu = Menu.buildFromTemplate([
        { label: i18n.t('tray.menu.show_viewer'), click: () => openViewer() },
        { type: 'separator' },
        { label: i18n.t('tray.menu.quit'), click: () => app.quit() }
    ]);
    tray.setToolTip(`${i18n.t('tray.tooltip')} v${app.getVersion()}`);
    tray.setContextMenu(contextMenu);

    // DB initialisieren
    initDb();
    
    // Store events überwachen
    if (store && typeof store.onDidChange === 'function') {
        store.onDidChange('ocrEnabled', (newValue) => {
            logDebug(`Config changed: ocrEnabled = ${newValue}`);
            // Tooltip sofort aktualisieren
            updateTrayStatus();
        });
        // Auch auf andere relevante Änderungen reagieren
        store.onDidChange('interval', (newValue) => {
            logDebug(`Config changed: interval = ${newValue}`);
            updateTrayStatus();
        });
    }

    logDebug(`Tray setup complete. OCR enabled: ${getOcrEnabled()}`);

    setInterval(updateTrayStatus, 1000);
}

async function performOCR(imagePaths) {
    if (!getOcrEnabled()) return null;
    if (imagePaths.length === 0) return "";
    
    const isWindows = process.platform === 'win32';
    const useWindowsOcr = isWindows; // Auf Windows bevorzugen wir die native API

    const lang = getOcrLanguage() || 'deu+eng';
    let combinedText = '';

    try {
        if (useWindowsOcr) {
            logDebug(`Using Windows native OCR for ${imagePaths.length} images`);
            let scriptPath = path.join(__dirname, '..', 'shared', 'win-ocr.ps1');
            if (app.isPackaged) {
                scriptPath = scriptPath.replace('app.asar', 'app.asar.unpacked');
            }
            const ocrResults = await runWindowsOcrBatch(imagePaths, scriptPath);
            
            imagePaths.forEach((img, i) => {
                const normalizedPath = path.normalize(img).toLowerCase();
                const text = ocrResults[normalizedPath] || '';
                const filteredText = filterOcrText(text);
                combinedText += `--- Display ${i} ---\n${filteredText}\n\n`;
            });
        } else {
            const worker = await getOcrWorker();
            const fastMode = getOcrFastMode();
            
            for (let i = 0; i < imagePaths.length; i++) {
                try {
                    let imageInput = imagePaths[i];
                    
                    // Bildskalierung für mehr Geschwindigkeit im Fast Mode
                    if (fastMode) {
                        try {
                            const originalImage = nativeImage.createFromPath(imagePaths[i]);
                            if (!originalImage.isEmpty()) {
                                const size = originalImage.getSize();
                                // Auf 50% skalieren
                                const resizedImage = originalImage.resize({
                                    width: Math.round(size.width * 0.5),
                                    height: Math.round(size.height * 0.5),
                                    quality: 'better'
                                });
                                imageInput = resizedImage.toPNG();
                                logDebug(`OCR: Resized image for faster processing (${size.width}x${size.height} -> 50%)`);
                            }
                        } catch (resizeErr) {
                            logDebug(`Image resizing failed, using original: ${resizeErr.message}`);
                        }
                    }

                    const { data: { text } } = await worker.recognize(imageInput);
                    const filteredText = filterOcrText(text);
                    combinedText += `--- Display ${i} ---\n${filteredText}\n\n`;
                } catch (err) {
                    console.error(`OCR failed for ${imagePaths[i]}`, err);
                    combinedText += `--- Display ${i} ---\n[Fehler bei der Texterkennung: ${err.message}]\n\n`;
                }
            }
        }
    } finally {
        // Aufräumarbeiten falls nötig
    }
    return combinedText;
}

/**
 * Filtert OCR Text um Rauschen zu reduzieren.
 * @param {string} text 
 * @returns {string}
 */
function filterOcrText(text) {
    if (!text) return "";
    const lines = text.split('\n');
    const filteredLines = lines.map(line => {
        // Wörter filtern: Behalte nur Wörter mit mindestens 2 Zeichen oder sinnvolle Einzelzeichen
        const words = line.split(/\s+/);
        const filteredWords = words.filter(word => {
            // Sonderzeichen-Strings filtern (z.B. "!!!", "---")
            if (/^[^a-zA-Z0-9äöüÄÖÜß]{2,}$/.test(word)) return false;
            // Einzelne Sonderzeichen filtern
            if (word.length === 1 && !/[a-zA-Z0-9äöüÄÖÜß]/.test(word)) return false;
            // Einzelne Zahlen behalten wir meist, aber einzelne Buchstaben nur wenn sie im Kontext stehen?
            if (word.length < 2 && !/[0-9]/.test(word)) return false;
            return true;
        });
        return filteredWords.join(' ');
    }).filter(line => line.trim().length > 0);

    return filteredLines.join('\n');
}

async function takeScreenshots(onNewScreenshots) {
    if (onNewScreenshots) currentOnNewScreenshots = onNewScreenshots;
    
    // Check if we should skip screenshots during batch OCR or if screensaver is active
    const isBatchRunning = getIsBatchOcrRunning();
    const isScreensaverRunning = getIsScreensaverRunning();
    
    if (isScreensaverRunning || isBatchRunning) {
        if (isScreensaverRunning) {
            logDebug('Skipping screenshot because screensaver is active.');
        } else {
            logDebug('Skipping screenshot because batch OCR in viewer is active.');
        }
        const intervalSeconds = getInterval();
        nextScreenshotTime = Date.now() + intervalSeconds * 1000;
        updateTrayStatus();
        scheduleNextScreenshot();
        return;
    }

    // Bestehenden Timeout löschen, falls vorhanden (wichtig bei manuellem/event Trigger)
    if (recordingTimeout) clearTimeout(recordingTimeout);

    if (await isPowerSaving()) {
        console.log('Skipping screenshot because power saving mode is active (ScreenSaver/Monitor Off).');
        // Verschiebe die Zeit für den nächsten regulären Screenshot trotzdem, 
        // damit wir nicht sofort wieder hier landen
        const intervalSeconds = getInterval();
        nextScreenshotTime = Date.now() + intervalSeconds * 1000;
        updateTrayStatus();
        
        // Timer für den nächsten Versuch planen
        scheduleNextScreenshot();
        return;
    }

    const dir = getConfigDir();
    const onlyOnChanges = getOnlyOnChanges();
    const intervalSeconds = getInterval();
    
    // Setze die Zeit für den nächsten Screenshot
    nextScreenshotTime = Date.now() + intervalSeconds * 1000;
    updateTrayStatus();

    logDebug(`Taking screenshot. OCR enabled: ${getOcrEnabled()}`);

    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const timeStr = now.getHours().toString().padStart(2, '0') + '-' + now.getMinutes().toString().padStart(2, '0');
    const secondsStr = now.getSeconds().toString().padStart(2, '0');
    
    const appSubDir = 'screenRecorder';
    const baseDir = path.join(dir, appSubDir, year, month, day);
    
    const format = getScreenshotFormat();
    
    try {
        const displays = await screenshot.listDisplays();
        const displayBuffers = [];
        const displayHashes = [];
        let anyNew = false;

        // Zuerst alle Buffer und Hashes holen
        for (let i = 0; i < displays.length; i++) {
            const buffer = await screenshot({ screen: displays[i].id, format: format });
            const currentHash = crypto.createHash('md5').update(buffer).digest('hex');
            displayBuffers.push(buffer);
            displayHashes.push(currentHash);
            
            if (!onlyOnChanges || lastHashes[displays[i].id] !== currentHash) {
                anyNew = true;
            }
        }

        if (anyNew) {
            const capturedFiles = [];
            for (let i = 0; i < displays.length; i++) {
                const display = displays[i];
                const buffer = displayBuffers[i];
                const currentHash = displayHashes[i];

                lastHashes[display.id] = currentHash;

                const screenDir = path.join(baseDir, `screen${i}`);
                if (!fs.existsSync(screenDir)) fs.mkdirSync(screenDir, { recursive: true });

                const fileName = `${timeStr}-${secondsStr}.${format}`;
                const filePath = path.join(screenDir, fileName);
                fs.writeFileSync(filePath, buffer);
                capturedFiles.push(filePath);
            }

            const meta = await getMetaData(true);
            logDebug(`Metadaten erfasst: ${meta.titles.length} Titel, ${meta.files.length} Dateien, ${meta.urls.length} URLs, ${meta.calls.length} Anrufe`);
            
            // In DB speichern
            saveCapture({
                date: `${year}-${month}-${day}`,
                time: `${timeStr}-${secondsStr}`,
                timestamp: now.getTime(),
                titles: meta.titles || [],
                activeWindow: meta.activeWindow || "",
                openFiles: meta.files || [],
                urls: meta.urls || [],
                calls: meta.calls || [],
                ocrText: meta.ocrText || null,
                files: capturedFiles
            });

            const pendingCount = updatePendingOcrCount();
            logDebug(`Capture saved to DB: ${year}-${month}-${day} ${timeStr}-${secondsStr}. Pending OCR: ${pendingCount}`);

            if (currentOnNewScreenshots) {
                currentOnNewScreenshots({ baseDir, displaysCount: displays.length });
            }
        }
    } catch (err) {
        console.error('Screenshot failed', err);
    } finally {
        // Egal ob Erfolg oder Fehler, den nächsten Screenshot planen
        scheduleNextScreenshot();
    }
}

function scheduleNextScreenshot() {
    if (recordingTimeout) clearTimeout(recordingTimeout);
    
    const intervalSeconds = getInterval();
    const delay = Math.max(0, nextScreenshotTime - Date.now());
    
    recordingTimeout = setTimeout(() => {
        takeScreenshots(currentOnNewScreenshots);
    }, delay);
}

function startRecording(onNewScreenshots) {
    if (recordingTimeout) clearTimeout(recordingTimeout);
    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (windowMonitorInterval) clearInterval(windowMonitorInterval);
    
    if (onNewScreenshots) currentOnNewScreenshots = onNewScreenshots;
    
    // Datenbank Maintenance alle 15 Minuten prüfen
    idleCheckInterval = setInterval(runDatabaseMaintenance, 15 * 60 * 1000);
    
    // Fensterwechsel-Überwachung alle 2 Sekunden
    windowMonitorInterval = setInterval(async () => {
        const checkWindowChange = getScreenshotOnWindowChange();
        const checkDisplayChange = getScreenshotOnDisplayChange();
        
        if (!checkWindowChange && !checkDisplayChange) return;
        
        try {
            // Nur minimal Metadaten für das Monitoring abrufen
            // Monitordaten nur wenn checkDisplayChange aktiv ist
            const meta = await getMetaData(false, checkDisplayChange);
            
            // 1. Fensterwechsel prüfen
            if (checkWindowChange && meta.activeWindow && meta.activeWindow !== lastActiveWindowTitle) {
                console.log(`Window changed: ${lastActiveWindowTitle} -> ${meta.activeWindow}`);
                lastActiveWindowTitle = meta.activeWindow;
                
                // Screenshot verzögert auslösen
                if (windowChangeTimeout) clearTimeout(windowChangeTimeout);
                
                const delay = getWindowChangeDelay();
                console.log(`Scheduling out-of-turn screenshot in ${delay}s due to window change`);
                windowChangeTimeout = setTimeout(() => {
                    takeScreenshots(currentOnNewScreenshots);
                }, delay * 1000);
            }

            // 2. Monitorwechsel prüfen (Monitor des aktiven Fensters)
            if (checkDisplayChange && meta.activeWindowRect && meta.monitors && meta.monitors.length > 0) {
                // Mitte des Fensters berechnen
                const centerX = meta.activeWindowRect.Left + (meta.activeWindowRect.Right - meta.activeWindowRect.Left) / 2;
                const centerY = meta.activeWindowRect.Top + (meta.activeWindowRect.Bottom - meta.activeWindowRect.Top) / 2;
                
                // Finden, auf welchem Monitor sich die Mitte befindet
                let currentDisplayId = null;
                for (const m of meta.monitors) {
                    const b = m.Bounds;
                    if (centerX >= b.X && centerX <= (b.X + b.Width) &&
                        centerY >= b.Y && centerY <= (b.Y + b.Height)) {
                        currentDisplayId = m.DeviceName;
                        break;
                    }
                }

                if (currentDisplayId && currentDisplayId !== lastActiveDisplayId) {
                    console.log(`Display focus changed: ${lastActiveDisplayId} -> ${currentDisplayId}`);
                    const isFirstCheck = lastActiveDisplayId === null;
                    lastActiveDisplayId = currentDisplayId;
                    
                    if (!isFirstCheck) {
                        // Screenshot verzögert auslösen
                        if (displayChangeTimeout) clearTimeout(displayChangeTimeout);
                        
                        const delay = getDisplayChangeDelay();
                        console.log(`Scheduling out-of-turn screenshot in ${delay}s due to display focus change`);
                        displayChangeTimeout = setTimeout(() => {
                            takeScreenshots(currentOnNewScreenshots);
                        }, delay * 1000);
                    }
                }
            }
        } catch (e) {
            console.error('Window monitoring failed', e);
        }
    }, 2000);
    
    takeScreenshots(currentOnNewScreenshots); // Sofort starten
}

// Watch for config changes
store.onDidAnyChange((newValue, oldValue) => {
    // Wenn sich wichtige Parameter geändert haben, Timer neu starten
    if (newValue.interval !== oldValue.interval || 
        newValue.screenshotOnWindowChange !== oldValue.screenshotOnWindowChange ||
        newValue.screenshotOnDisplayChange !== oldValue.screenshotOnDisplayChange) {
        startRecording();
    }
});

// Hintergrund-Indizierung (Synchronisation Dateisystem -> Datenbank)
async function runBackgroundIndexing() {
    logDebug('Starting background indexing...');
    const configDir = getConfigDir();
    const baseDir = path.join(configDir, 'screenRecorder');
    
    let totalItems = 0;
    let items = [];

    // Nur neue Struktur scannen (alte Struktur wird meist nur einmal migriert)
    if (fs.existsSync(baseDir)) {
        try {
            const years = fs.readdirSync(baseDir).filter(y => /^\d{4}$/.test(y));
            for (const year of years) {
                const yearDir = path.join(baseDir, year);
                const months = fs.readdirSync(yearDir).filter(m => /^\d{2}$/.test(m));
                for (const month of months) {
                    const monthDir = path.join(yearDir, month);
                    const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
                    for (const day of days) {
                        const dayDir = path.join(monthDir, day);
                        const dateStr = `${year}-${month}-${day}`;
                        const files = fs.readdirSync(dayDir);
                        const timeGroups = {};

                        files.forEach(file => {
                            if (file.startsWith('screen')) {
                                const screenIdx = file.replace('screen', '');
                                const screenDir = path.join(dayDir, file);
                                if (fs.statSync(screenDir).isDirectory()) {
                                    const images = fs.readdirSync(screenDir);
                                    images.forEach(img => {
                                        const timeMatch = img.match(/^(\d{2}-\d{2}-\d{2})\.(jpg|jpeg|png)$/i);
                                        if (timeMatch) {
                                            const time = timeMatch[1];
                                            if (!timeGroups[time]) timeGroups[time] = { time, files: {}, date: dateStr };
                                            timeGroups[time].files[screenIdx] = path.join(screenDir, img);
                                        }
                                    });
                                }
                            }
                        });

                        for (const time in timeGroups) {
                            const group = timeGroups[time];
                            items.push({
                                date: group.date,
                                time: group.time,
                                timestamp: new Date(`${group.date}T${group.time.replace(/-/g, ':')}`).getTime(),
                                files: group.files
                            });

                            if (items.length >= 500) {
                                const result = saveCapturesBatch(items);
                                totalItems += items.length;
                                items = [];
                                // Kurz warten um System nicht zu stark zu belasten
                                await new Promise(r => setTimeout(r, 100));
                            }
                        }
                    }
                }
            }
            if (items.length > 0) {
                saveCapturesBatch(items);
                totalItems += items.length;
            }
            logDebug(`Background indexing finished. Processed ${totalItems} potential items.`);
            setLastIndexingTime(Date.now());
        } catch (err) {
            logDebug(`Background indexing error: ${err.message}`);
        }
    }
}

// Alle 60 Minuten Indizierung laufen lassen
setInterval(runBackgroundIndexing, 60 * 60 * 1000);
// Auch einmalig 10 Sekunden nach Start
setTimeout(runBackgroundIndexing, 10000);

app.whenReady().then(() => {
    setupTray();
    startRecording();
});

app.on('window-all-closed', (e) => {
    // Tray app bleibt offen
    e.preventDefault();
});
