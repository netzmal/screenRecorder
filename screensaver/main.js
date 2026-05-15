const { app, BrowserWindow, screen, ipcMain, powerSaveBlocker } = require('electron');
const path = require('path');
// Keep standalone screensaver runs on the same shared config/database path while
// still using a separate Electron process identity for the screensaver lock.
if (app) {
    try {
        app.name = 'screen-recorder-shared';
        if (!global.realUserData) {
            global.realUserData = app.getPath('userData');
            app.setPath('userData', path.join(global.realUserData, 'screensaver-proc'));
        }
    } catch (err) {
        console.error('Screensaver: Failed to configure shared userData path:', err);
    }
}

const hasScreensaverInstanceLock = app.requestSingleInstanceLock({ role: 'screensaver' });
if (!hasScreensaverInstanceLock) {
    // We cannot log to our file yet as initOcrLog is not called.
    // But we can try to log to console.
    console.log('Another screensaver instance is already running. Exiting duplicate process.');
    app.quit();
}

const fs = require('fs');
const { execFile } = require('child_process');
const Tesseract = require('tesseract.js');
const { initDb, getPendingOcrCaptures, updateOcrText, getAllCaptures, getOcrImageStats, getRandomOcrCaptures, resetOcrStatus } = require('../shared/db');
const { getConfigDir, setIsScreensaverRunning, getOcrLanguage, getOcrFastMode, getOcrEnabled } = require('../shared/config');
const { runWindowsOcrBatch, isOcrErrorText } = require('../shared/ocr-helper');

// --- OCR Logging ---
let _logPath = null;
let _lastLoggedProcessed = -1;

function initOcrLog() {
    try {
        const dir = getConfigDir();
        _logPath = path.join(dir, 'screensaver-ocr.log');
        ocrLog('');
        ocrLog('='.repeat(70));
        ocrLog(`SESSION START  ${new Date().toLocaleString('de-DE')}`);
        ocrLog('='.repeat(70));
    } catch (e) {
        console.error('OCR-Log init failed:', e.message);
    }
}

function ocrLog(msg) {
    const ts = new Date().toTimeString().substring(0, 8);
    const line = `${ts} ${msg}`;
    console.log(line);
    if (_logPath) {
        try { fs.appendFileSync(_logPath, line + '\n', 'utf8'); } catch (_) {}
    }
}
// -------------------

let mainWindows = [];
let isClosing = false;
let isOcrRunning = false;
let ocrTimer = null;
let ocrRetryTimeout = null;
let psbDisplayId = null;
let psbSuspendId = null;
let tesseractWorker = null;
let quittingAfterCleanup = false;
let sessionStartTime = Date.now();
const previewParentHandle = getScreensaverPreviewParentHandle(process.argv);
const isPreviewMode = process.argv.some(isScreensaverPreviewSwitch);

// Detects the Windows screensaver preview switch.
function isScreensaverPreviewSwitch(arg) {
    if (!arg) return false;
    const value = String(arg).toLowerCase();
    return value === '/p' || value.startsWith('/p:');
}

// Reads the optional parent HWND used by the Windows screensaver settings dialog.
function getScreensaverPreviewParentHandle(argv) {
    for (let i = 0; i < argv.length; i++) {
        const value = String(argv[i] || '').trim();
        const lower = value.toLowerCase();
        if (lower.startsWith('/p:')) {
            return normalizeWindowHandle(value.slice(3));
        }
        if (lower === '/p' && argv[i + 1]) {
            return normalizeWindowHandle(argv[i + 1]);
        }
    }

    return null;
}

// Normalizes a Windows HWND argument into a decimal string.
function normalizeWindowHandle(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim().replace(/^"|"$/g, '');
    return /^\d+$/.test(normalized) ? normalized : null;
}

// Reads Electron's native window handle in the format expected by Win32 calls.
function getNativeWindowHandle(win) {
    if (process.platform !== 'win32') return null;

    const handleBuffer = win.getNativeWindowHandle();
    if (!handleBuffer || handleBuffer.length < 4) return null;

    if (handleBuffer.length >= 8) {
        return handleBuffer.readBigUInt64LE(0).toString();
    }

    return handleBuffer.readUInt32LE(0).toString();
}

// Embeds the preview window into the Windows screensaver settings preview host.
function attachPreviewWindowToParent(win, parentHandle) {
    return new Promise((resolve) => {
        const childHandle = getNativeWindowHandle(win);
        if (!childHandle || !parentHandle) {
            resolve(false);
            return;
        }

        const script = `
$ProgressPreference = 'SilentlyContinue'
$ChildHandle = '${childHandle}'
$ParentHandle = '${parentHandle}'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeScreensaverPreview {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtr", SetLastError=true)]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtr", SetLastError=true)]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
}
"@
$child = [IntPtr]::new([Int64]$ChildHandle)
$parent = [IntPtr]::new([Int64]$ParentHandle)
$gwlStyle = -16
$wsChild = [Int64]0x40000000
$wsVisible = [Int64]0x10000000
$wsCaption = [Int64]0x00C00000
$wsPopup = [Int64]0x80000000
$style = [NativeScreensaverPreview]::GetWindowLongPtr($child, $gwlStyle).ToInt64()
$newStyle = (($style -bor $wsChild -bor $wsVisible) -band (-bnot $wsPopup) -band (-bnot $wsCaption))
[NativeScreensaverPreview]::SetWindowLongPtr($child, $gwlStyle, [IntPtr]::new($newStyle)) | Out-Null
[NativeScreensaverPreview]::SetParent($child, $parent) | Out-Null
$rect = New-Object NativeScreensaverPreview+RECT
[NativeScreensaverPreview]::GetClientRect($parent, [ref]$rect) | Out-Null
$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)
[NativeScreensaverPreview]::MoveWindow($child, 0, 0, $width, $height, $true) | Out-Null
`;

        const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
        execFile('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            encodedScript
        ], (error) => {
            if (error) {
                console.error('Screensaver: Failed to attach preview window:', error.message);
                resolve(false);
                return;
            }

            resolve(true);
        });
    });
}

async function getTesseractWorker() {
    if (tesseractWorker) return tesseractWorker;
    console.log('Screensaver: Initializing Tesseract worker...');
    
    // Use local traineddata from shared assets
    const langPath = path.join(__dirname, '..', 'shared', 'assets', 'ocr');
    tesseractWorker = await Tesseract.createWorker(getOcrLanguage() || 'deu+eng', 1, {
        langPath: langPath,
        cacheMethod: 'none' // Don't try to cache in userData, use our local files
    });
    
    const fastMode = getOcrFastMode();
    const parameters = {
        tessedit_pageseg_mode: 3,
        tessedit_char_whitelist: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZäöüÄÖÜß.,:;!?()[]{}@/\\- '
    };
    if (fastMode) {
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
    await tesseractWorker.setParameters(parameters);
    return tesseractWorker;
}

async function terminateTesseractWorker() {
    if (tesseractWorker) {
        console.log('Screensaver: Terminating Tesseract worker...');
        await tesseractWorker.terminate();
        tesseractWorker = null;
    }
}

function createWindows() {
    if (isPreviewMode) {
        return createPreviewWindow();
    }

    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    const loadPromises = [];
    
    // Enable the power save blocker.
    if (psbDisplayId === null) {
        psbDisplayId = powerSaveBlocker.start('prevent-display-sleep');
        console.log('Screensaver: PowerSaveBlocker started (prevent-display-sleep)');
    }
    if (psbSuspendId === null) {
        psbSuspendId = powerSaveBlocker.start('prevent-app-suspension');
        console.log('Screensaver: PowerSaveBlocker started (prevent-app-suspension)');
    }

    displays.forEach((display) => {
        const isPrimary = display.id === primaryDisplay.id;
        
        const win = new BrowserWindow({
            x: display.bounds.x,
            y: display.bounds.y,
            width: display.bounds.width,
            height: display.bounds.height,
            title: 'Screen Recorder Screensaver' + (isPrimary ? '' : ' (Black)'),
            fullscreen: true,
            frame: false,
            resizable: false,
            hasShadow: false,
            backgroundColor: '#000000',
            transparent: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            cursor: 'none',
            autoHideMenuBar: true,
            show: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });

        // Always load index.html, but pass a parameter for non-primary displays.
        win.loadFile(path.join(__dirname, 'index.html'), {
            query: { black: isPrimary ? '0' : '1' }
        });

        loadPromises.push(new Promise(resolve => {
            win.webContents.once('did-finish-load', resolve);
            win.webContents.once('did-fail-load', resolve);
        }));

        win.once('ready-to-show', () => {
            if (win.isDestroyed()) return;
            win.setBounds(display.bounds);
            win.setFullScreen(true);
            win.setAlwaysOnTop(true, 'screen-saver');
            win.show();
            ocrLog(`[MAIN] Window shown for display ${display.id}`);
        });
        
        // Exit on interaction (keyboard).
        win.webContents.on('before-input-event', (event, input) => {
            if (isPreviewMode) return;
            // Ignore events in the first 2 seconds to avoid jitter-exit.
            if (Date.now() - sessionStartTime < 2000) return;
            
            if (input.type === 'keyDown') {
                ocrLog(`[MAIN] Exit triggered by keyboard: ${input.key}`);
                void closeScreensaver('keyboard');
            }
        });

        mainWindows.push(win);
    });

    return Promise.all(loadPromises);
}

// Creates the lightweight preview used by the Windows screensaver settings dialog.
function createPreviewWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const fallbackWidth = 480;
    const fallbackHeight = 270;
    const x = Math.round(primaryDisplay.bounds.x + (primaryDisplay.bounds.width - fallbackWidth) / 2);
    const y = Math.round(primaryDisplay.bounds.y + (primaryDisplay.bounds.height - fallbackHeight) / 2);

    const win = new BrowserWindow({
        x,
        y,
        width: fallbackWidth,
        height: fallbackHeight,
        title: 'Screen Recorder Screensaver Preview',
        fullscreen: false,
        frame: false,
        resizable: false,
        hasShadow: false,
        backgroundColor: '#000000',
        transparent: false,
        alwaysOnTop: false,
        skipTaskbar: true,
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadFile(path.join(__dirname, 'index.html'), {
        query: { black: '0', preview: '1' }
    });

    const loadPromise = new Promise(resolve => {
        win.webContents.once('did-finish-load', resolve);
        win.webContents.once('did-fail-load', resolve);
    });

    win.once('ready-to-show', async () => {
        if (win.isDestroyed()) return;

        if (previewParentHandle && process.platform === 'win32') {
            const attached = await attachPreviewWindowToParent(win, previewParentHandle);
            if (win.isDestroyed()) return;
            if (attached) {
                win.showInactive();
                return;
            }
        }

        win.show();
    });

    mainWindows.push(win);
    return loadPromise;
}

async function closeScreensaver(reason = 'unknown') {
    if (!hasScreensaverInstanceLock) return;
    if (isClosing) return;
    ocrLog(`[MAIN] closeScreensaver called. Reason: ${reason}`);
    isClosing = true;
    quittingAfterCleanup = true;
    
    if (!isPreviewMode) {
        try {
            setIsScreensaverRunning(false);
        } catch (err) {
            console.error('Screensaver: Failed to clear running state:', err);
        }
    }

    if (ocrTimer) {
        clearInterval(ocrTimer);
        ocrTimer = null;
    }
    if (ocrRetryTimeout) {
        clearTimeout(ocrRetryTimeout);
        ocrRetryTimeout = null;
    }

    if (psbDisplayId !== null) {
        try {
            powerSaveBlocker.stop(psbDisplayId);
        } catch (err) {
            console.error('Screensaver: Failed to stop display PowerSaveBlocker:', err);
        }
        psbDisplayId = null;
    }
    if (psbSuspendId !== null) {
        try {
            powerSaveBlocker.stop(psbSuspendId);
        } catch (err) {
            console.error('Screensaver: Failed to stop suspend PowerSaveBlocker:', err);
        }
        psbSuspendId = null;
    }
    console.log('Screensaver: PowerSaveBlockers stopped');

    try {
        await terminateTesseractWorker();
    } catch (err) {
        console.error('Screensaver: Failed to terminate Tesseract worker:', err);
    }

    mainWindows.forEach(win => {
        if (!win.isDestroyed()) win.close();
    });
    app.quit();
}

async function runOcrBackground() {
    if (isOcrRunning || isClosing) return;
    isOcrRunning = true;

    try {
        if (!getOcrEnabled()) {
            ocrLog('[INFO] OCR in Config deaktiviert â€“ Ã¼bersprungen');
            isOcrRunning = false;
            return;
        }

        const pending = getPendingOcrCaptures(50);

        if (pending.length === 0) {
            ocrLog('[INFO] Keine ausstehenden OCR-Aufgaben');
            isOcrRunning = false;
            return;
        }

        let scriptPath = path.join(__dirname, '..', 'shared', 'win-ocr.ps1');
        if (app.isPackaged) {
            scriptPath = scriptPath.replace('app.asar', 'app.asar.unpacked');
        }
        ocrLog(`[INFO] Skript: ${scriptPath} | existiert: ${fs.existsSync(scriptPath)}`);

        const imagePaths = [];
        const capturePathsById = {};

        pending.forEach(capture => {
            if (capture.files) {
                Object.values(capture.files).forEach(p => {
                    const normalizedPath = path.normalize(p).toLowerCase();
                    imagePaths.push(p);
                    if (!capturePathsById[capture.id]) capturePathsById[capture.id] = [];
                    capturePathsById[capture.id].push(normalizedPath);
                });
            }
        });

        const missing = imagePaths.filter(p => !fs.existsSync(p));
        const stats = getOcrImageStats();
        ocrLog(`[START] ${pending.length} Captures, ${imagePaths.length} Bilder im Lauf, gesamt ausstehend: ${stats.pending} Bilder, erledigt: ${stats.processed} Bilder (${stats.processedPercent}%)`);
        ocrLog(`[INFO] Bilder gesamt: ${imagePaths.length}, davon fehlend: ${missing.length}`);

        mainWindows.forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('ocr-status', {
                    status: 'processing',
                    count: pending.length,
                    totalPending: stats.pending,
                    totalImages: imagePaths.length,
                    engine: 'Windows OCR',
                    processed: 0,
                    appVersion: app.getVersion()
                });
            }
        });

        if (imagePaths.length > 0) {
            let batchT = Date.now();
            let batchNum = 0;
            const ocrResults = {};
            const savedCaptureIds = new Set();
            let totalSavedOk = 0;
            let totalSavedEmpty = 0;

            const saveCompletedCaptures = (options = {}) => {
                const allowErrors = options.allowErrors === true;
                let savedOk = 0;
                let savedEmpty = 0;

                Object.keys(capturePathsById).forEach(id => {
                    if (savedCaptureIds.has(id)) return;

                    const paths = capturePathsById[id];
                    const allFinished = paths.every(p => {
                        const result = ocrResults[p];
                        if (result === undefined) return false;
                        return allowErrors || !isOcrErrorText(result);
                    });
                    if (!allFinished) return;

                    const combinedText = paths.map(p => ocrResults[p] || '').join('\n\n');
                    if (combinedText.trim()) {
                        updateOcrText(parseInt(id), combinedText);
                        savedOk++;
                        totalSavedOk++;
                    } else {
                        updateOcrText(parseInt(id), '');
                        savedEmpty++;
                        totalSavedEmpty++;
                    }
                    savedCaptureIds.add(id);
                });

                return { savedOk, savedEmpty };
            };

            const results = await runWindowsOcrBatch(imagePaths, scriptPath, (progress) => {
                const currentStats = getOcrImageStats();

                if (progress.results) {
                    Object.assign(ocrResults, progress.results);
                    // "After" callback: batch finished, evaluate results.
                    const elapsed = ((Date.now() - batchT) / 1000).toFixed(1);
                    batchNum++;
                    const ok    = Object.values(progress.results).filter(t => t && !isOcrErrorText(t) && t.trim() !== '').length;
                    const empty = Object.values(progress.results).filter(t => t !== undefined && t.trim() === '').length;
                    const err   = Object.values(progress.results).filter(t => isOcrErrorText(t)).length;
                    const lastFile = progress.paths && progress.paths.length > 0 ? path.basename(progress.paths[progress.paths.length - 1]) : '';
                    ocrLog(`[WIN]  Batch ${batchNum} (${progress.batchSize} Bilder): OK=${ok} leer=${empty} Fehler=${err} | ${elapsed}s | letzte: ${lastFile}`);

                    saveCompletedCaptures();
                } else {
                    // "Before" callback: batch starts.
                    batchT = Date.now();
                }

                // Send intermediate status to the renderer.
                mainWindows.forEach(win => {
                    if (!win.isDestroyed()) {
                        const lastPath = progress.paths && progress.paths.length > 0 ? path.normalize(progress.paths[progress.paths.length - 1]).toLowerCase() : null;
                        let result = null;
                        if (progress.results && lastPath) {
                            const text = progress.results[lastPath];
                            if (text !== undefined) {
                                if (isOcrErrorText(text)) result = 'failed';
                                else if (text.trim() === '') result = 'empty';
                                else result = 'success';
                            }
                        }
                        const displayFile = progress.paths && progress.paths.length > 0 ? path.basename(progress.paths[progress.paths.length - 1]) : null;
                        const statusLine = `Windows OCR: ${progress.current}/${imagePaths.length} Bilder${displayFile ? ' - ' + displayFile : ''}`;
                        if (progress.results) ocrLog(`[STAT] ${statusLine}${result ? ' (' + result + ')' : ''}`);

                        win.webContents.send('ocr-status', {
                            status: 'processing',
                            count: pending.length,
                            totalPending: currentStats.pending,
                            totalImages: imagePaths.length,
                            engine: 'Windows OCR',
                            processed: progress.current,
                            currentBatch: progress.batchSize,
                            file: displayFile,
                            result: result,
                            appVersion: app.getVersion()
                        });
                    }
                });
            });
            Object.assign(ocrResults, results);

            // Mark non-existent files as completed.
            const nonExistent = imagePaths.filter(p => !fs.existsSync(p));
            if (nonExistent.length > 0) {
                ocrLog(`[INFO] ${nonExistent.length} fehlende Bilder als erledigt (leer) markiert`);
                nonExistent.forEach(p => {
                    const key = path.normalize(p).toLowerCase();
                    ocrResults[key] = '';
                });
                saveCompletedCaptures();
            }

            // Tesseract fallback only for existing images with Windows OCR errors.
            const failedPaths = imagePaths.filter(p => {
                if (!fs.existsSync(p)) return false;
                const key = path.normalize(p).toLowerCase();
                const r = ocrResults[key];
                return r === undefined || isOcrErrorText(r);
            });

            ocrLog(`[WIN]  Gesamt-Ergebnis: ${Object.keys(ocrResults).length} Ergebnisse, ${failedPaths.length} fÃ¼r Tesseract-Fallback`);

            if (failedPaths.length > 0) {
                ocrLog(`[TESS] Starte Tesseract-Fallback: ${failedPaths.length} Bilder`);

                try {
                    const worker = await getTesseractWorker();
                    let tessProcessed = 0;

                    for (const p of failedPaths) {
                        if (isClosing) break;

                        tessProcessed++;
                        const tessT = Date.now();

                        try {
                            const key = path.normalize(p).toLowerCase();
                            const { data: { text } } = await worker.recognize(p);
                            const hasText = text && text.trim();
                            const elapsed = ((Date.now() - tessT) / 1000).toFixed(1);
                            const currentStats = getOcrImageStats();

                            ocrLog(`[TESS] ${path.basename(p)} â†’ ${hasText ? 'OK (' + text.trim().length + ' Zeichen)' : 'leer'} | ${elapsed}s`);

                            if (hasText) {
                                ocrResults[key] = text.trim();
                            } else {
                                ocrResults[key] = '';
                            }
                            saveCompletedCaptures({ allowErrors: true });

                            const statusLine = `Tesseract OCR: ${imagePaths.length - failedPaths.length + tessProcessed}/${imagePaths.length} Bilder - ${path.basename(p)}`;
                            ocrLog(`[STAT] ${statusLine} (${hasText ? 'OK' : 'leer'})`);

                            mainWindows.forEach(win => {
                                if (!win.isDestroyed()) {
                                    win.webContents.send('ocr-status', {
                                        status: 'processing',
                                        count: pending.length,
                                        totalPending: currentStats.pending,
                                        totalImages: imagePaths.length,
                                        engine: 'Tesseract OCR',
                                        processed: imagePaths.length - failedPaths.length + tessProcessed,
                                        currentBatch: 1,
                                        file: path.basename(p),
                                        result: hasText ? 'success' : 'empty',
                                        appVersion: app.getVersion()
                                    });
                                }
                            });
                        } catch (tessErr) {
                            const elapsed = ((Date.now() - tessT) / 1000).toFixed(1);
                            ocrLog(`[ERR]  Tesseract ${path.basename(p)}: ${tessErr.message} | ${elapsed}s`);
                            const currentStats = getOcrImageStats();
                            const key = path.normalize(p).toLowerCase();
                            ocrResults[key] = `Error: ${tessErr.message}`;
                            saveCompletedCaptures({ allowErrors: true });
                            mainWindows.forEach(win => {
                                if (!win.isDestroyed()) {
                                    win.webContents.send('ocr-status', {
                                        status: 'processing',
                                        count: pending.length,
                                        totalPending: currentStats.pending,
                                        totalImages: imagePaths.length,
                                        engine: 'Tesseract OCR',
                                        processed: imagePaths.length - failedPaths.length + tessProcessed,
                                        currentBatch: 1,
                                        file: path.basename(p),
                                        result: 'failed',
                                        appVersion: app.getVersion()
                                    });
                                }
                            });
                        }
                    }
                } catch (err) {
                    ocrLog(`[ERR]  Tesseract-Worker-Init: ${err.message}`);
                    failedPaths.forEach(p => {
                        const key = path.normalize(p).toLowerCase();
                        if (ocrResults[key] === undefined || isOcrErrorText(ocrResults[key])) {
                            ocrResults[key] = `Error: Tesseract fallback failed: ${err.message}`;
                        }
                    });
                    saveCompletedCaptures({ allowErrors: true });
                }
            }

            saveCompletedCaptures({ allowErrors: true });

            const afterStats = getOcrImageStats();
            ocrLog(`[SAVE] ${totalSavedOk} mit Text, ${totalSavedEmpty} leer gespeichert | Erledigt gesamt: ${afterStats.processed} (${afterStats.processedPercent}%)`);
            ocrLog(`[DISP] Oben rechts: ${afterStats.processed - (stats.processed)} neue Bilder | ${afterStats.processedPercent}% erledigt`);
        } else {
            ocrLog(`[WARN] ${pending.length} ausstehende Captures ohne Bildpfade als erledigt markiert`);
            pending.forEach(capture => updateOcrText(capture.id, ''));
        }

        mainWindows.forEach(win => {
            if (!win.isDestroyed()) win.webContents.send('ocr-status', { status: 'idle' });
        });

        isOcrRunning = false;
        const nextPending = getPendingOcrCaptures(1);
        if (nextPending.length > 0 && !isClosing) {
            ocrRetryTimeout = setTimeout(() => {
                ocrRetryTimeout = null;
                runOcrBackground();
            }, 1000);
        }
    } catch (err) {
        ocrLog(`[ERR]  runOcrBackground: ${err.message}\n${err.stack}`);
        isOcrRunning = false;
    }
}

app.whenReady().then(async () => {
    initOcrLog();
    ocrLog('[INFO] app.whenReady() triggered');
    
    if (!hasScreensaverInstanceLock) {
        ocrLog('[WARN] No instance lock in whenReady, quitting.');
        app.quit();
        return;
    }

    try {
        if (isPreviewMode) {
            ocrLog('[INFO] Starting in PREVIEW mode');
            await createWindows();
            return;
        }

        ocrLog('[INFO] Starting in NORMAL mode');
        setIsScreensaverRunning(true);

        try {
            await resetOcrStatus();
            ocrLog('[INFO] OCR-Status zurÃ¼ckgesetzt (in-progress â†’ pending)');
        } catch (dbErr) {
            ocrLog(`[ERR]  resetOcrStatus: ${dbErr.message}`);
        }

        // Detect mouse movement (via IPC from the renderer).
        ipcMain.on('mouse-move', () => {
            void closeScreensaver('mouse-move-ipc');
        });

        // Provide statistics and images.
        ipcMain.handle('get-ocr-stats', () => {
            try {
                const s = getOcrImageStats();
                if (s.processed !== _lastLoggedProcessed) {
                    ocrLog(`[DISP] Stats-Abfrage â†’ erledigt: ${s.processed} (${s.processedPercent}%), ausstehend: ${s.pending}`);
                    _lastLoggedProcessed = s.processed;
                }
                return s;
            } catch (err) {
                ocrLog(`[ERR]  get-ocr-stats: ${err.message}`);
                return { pending: 0, processed: 0, total: 0 };
            }
        });

        ipcMain.handle('get-random-captures', (event, limit, processed) => {
            try {
                return getRandomOcrCaptures(limit, processed);
            } catch (err) {
                console.error('Error in get-random-captures handler:', err);
                return [];
            }
        });

        await createWindows();

        // Start the OCR loop (one batch every 30 seconds).
        void runOcrBackground();
        ocrTimer = setInterval(runOcrBackground, 30000);
    } catch (err) {
        ocrLog(`[ERR]  Kritischer Startfehler: ${err.message}\n${err.stack}`);
        void closeScreensaver('critical-start-error');
    }
});

app.on('render-process-gone', (event, webContents, details) => {
    ocrLog(`[ERR]  Render process gone: ${details.reason} (${details.exitCode})`);
    void closeScreensaver('render-process-gone');
});

app.on('child-process-gone', (event, details) => {
    ocrLog(`[ERR]  Child process gone: ${details.type} ${details.reason} (${details.exitCode})`);
});

app.on('window-all-closed', () => {
    if (hasScreensaverInstanceLock && process.platform !== 'darwin' && !isClosing) {
        void closeScreensaver('window-all-closed');
    }
});

app.on('before-quit', (event) => {
    if (!hasScreensaverInstanceLock) return;
    if (quittingAfterCleanup || isClosing) return;

    event.preventDefault();
    void closeScreensaver();
});
