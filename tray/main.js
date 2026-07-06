const { app, Menu, Tray, nativeImage, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Set the app name as early as possible so electron-store and other modules use the same path.
if (app) {
    app.name = 'screen-recorder-shared';
}

const screenshot = require('screenshot-desktop');
const crypto = require('crypto');
const Tesseract = require('tesseract.js');
const { spawn } = require('child_process');
const { getConfigDir, getInterval, getOnlyOnChanges, getOcrEnabled, getOcrLanguage, store, getScreenshotOnWindowChange, getWindowChangeDelay, getScreenshotOnDisplayChange, getDisplayChangeDelay, getSkipOnPowerSave, getOcrFastMode, getIsBatchOcrRunning, getIsScreensaverRunning, setIsScreensaverRunning, getScreensaverHeartbeat, setScreensaverHeartbeat, getLanguage, getScreenshotFormat, setLastIndexingTime, setTrayHeartbeat } = require('../shared/config');
const { saveCapture, saveCapturesBatch, initDb, getAllCaptures, deleteCapture, getPendingOcrCount } = require('../shared/db');
const i18n = require('../shared/i18n');
const { runWindowsOcrBatch } = require('../shared/ocr-helper');
const { createPowerShellService } = require('./powershell-service');
const { createPauseController } = require('./pause-controller');

const hasTrayInstanceLock = app.requestSingleInstanceLock({ role: 'tray' });
if (!hasTrayInstanceLock) {
    console.log('Another tray instance is already running. Exiting duplicate tray process.');
    app.quit();
}

// Initialize i18n.
const configLanguage = getLanguage();
i18n.init(configLanguage === 'auto' ? null : configLanguage);

// Logging function for debugging.
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

const powershellService = hasTrayInstanceLock ? createPowerShellService({
    workerScriptPath: path.join(__dirname, 'powershell-worker.ps1'),
    logDebug
}) : null;

// Set AppUserModelId for notifications on Windows.
if (process.platform === 'win32') {
    app.setAppUserModelId('com.screen.recorder.tray');
}

// Startup Logging
console.log('--- Screen Recorder Tray Startup ---');
console.log('Version:', app.getVersion());
console.log('Screenshot Directory:', getConfigDir());
console.log('Interval:', getInterval());
console.log('Screenshot Format:', getScreenshotFormat());
console.log('------------------------------------');

let cachedMetaData = { 
    titles: [], 
    files: [], 
    urls: [], 
    calls: [], 
    activeWindow: "", 
    monitors: [], 
    uiText: null,
    ocrText: null,
    lastCheck: null,
    timestamps: {
        titles: null,
        files: null,
        urls: null,
        calls: null,
        monitors: null,
        uiText: null
    }
};
let metaDataInterval;
let tray;
let debugWindow = null;
let recordingTimeout;
let idleCheckInterval;
let nextScreenshotTime;
let lastHashes = {}; // { displayId: hash }
let lastActiveWindowTitle = "";
let lastActiveDisplayId = null;
let windowChangeTimeout = null;
let displayChangeTimeout = null;
let ocrWorker = null;
let currentOnNewScreenshots = null;
let windowMonitorCheckRunning = false;
let pauseController = null;
let trayHeartbeatInterval = null;
let screenshotCaptureRunning = false;
let screenshotCapturePending = false;
let loggedStaleScreensaverState = false;
const SCREENSAVER_HEARTBEAT_MAX_AGE_MS = 60000;

// Updates the shared tray heartbeat so the viewer can detect a running tray process reliably.
function updateTrayHeartbeat() {
    setTrayHeartbeat(Date.now());
}

// Returns true only while the screensaver process is actively refreshing its state.
function isScreensaverPauseActive() {
    if (!getIsScreensaverRunning()) {
        loggedStaleScreensaverState = false;
        return false;
    }

    const heartbeat = getScreensaverHeartbeat();
    const heartbeatAgeMs = Date.now() - heartbeat;
    if (heartbeat && heartbeatAgeMs >= 0 && heartbeatAgeMs < SCREENSAVER_HEARTBEAT_MAX_AGE_MS) {
        loggedStaleScreensaverState = false;
        return true;
    }

    if (!loggedStaleScreensaverState) {
        logDebug('Ignoring stale screensaver running flag because no recent screensaver heartbeat was found.');
        loggedStaleScreensaverState = true;
    }

    try {
        setIsScreensaverRunning(false);
        setScreensaverHeartbeat(0);
    } catch (err) {
        logDebug(`Failed to clear stale screensaver state: ${err.message}`);
    }

    return false;
}

async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;
    logDebug('Initializing Tesseract worker...');
    ocrWorker = await Tesseract.createWorker(getOcrLanguage() || 'deu+eng');
    
    // Speed and quality optimizations.
    const fastMode = getOcrFastMode();
    const parameters = {
        tessedit_pageseg_mode: 3, // AUTO
        // Prevent recognition of extremely small/unlikely character sequences.
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

// Checks whether Windows is in a state where captures should be skipped.
async function isPowerSaving() {
    if (!getSkipOnPowerSave()) return Promise.resolve(false);
    if (!powershellService) return false;

    try {
        return await powershellService.isPowerSaving();
    } catch (err) {
        logDebug(`Power saving check failed: ${err.message}`);
        return false;
    }
}

// Reads the system idle time through the persistent PowerShell worker.
async function getIdleTime() {
    if (!powershellService) return 0;

    try {
        return await powershellService.getIdleTime();
    } catch (err) {
        logDebug(`Idle time check failed: ${err.message}`);
        return 0;
    }
}

// Run database maintenance (delete orphaned entries).
async function runDatabaseMaintenance() {
    // If the user is active, postpone maintenance.
    const idleTimeMs = await getIdleTime();
    if (idleTimeMs < 5000) return;

    console.log('Running database maintenance...');
    try {
        const captures = getAllCaptures();
        let deletedCount = 0;

        for (const capture of captures) {
            let stillExists = false;
            const files = capture.files;
            
            // capture.files is an array of paths (or an object in older versions).
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


// Normalizes PowerShell scalar-or-array output into a unique string array.
function normalizeStringArray(value) {
    const items = Array.isArray(value) ? value : (value ? [value] : []);
    return [...new Set(items)].filter(item => item && typeof item === 'string' && item.trim() !== '');
}

// Collects and normalizes metadata from the persistent PowerShell worker.
async function getMetaDataFromWorker(includeFull, includeMonitors) {
    if (!powershellService) {
        return { titles: [], files: [], urls: [], calls: [], activeWindow: "", monitors: [], uiText: null };
    }

    try {
        const data = await powershellService.getMetaData(includeFull, includeMonitors);
        const urls = normalizeStringArray(data.urls);
        const calls = normalizeStringArray(data.calls);

        // Debug log for metadata.
        if (urls.length > 0 || calls.length > 0) {
            logDebug(`Metadaten erfasst - URLs: ${urls.length}, Calls: ${calls.length}`);
        }

        // Filter unique values and empty entries.
        const result = {
            activeWindow: data.activeWindow || "",
            activeWindowRect: data.activeWindowRect,
            monitors: Array.isArray(data.monitors) ? data.monitors : (data.monitors ? [data.monitors] : []),
            titles: normalizeStringArray(data.titles),
            files: normalizeStringArray(data.files),
            urls: urls,
            calls: calls,
            uiText: data.uiText || null
        };

        if (includeFull) {
            logDebug(`getMetaData - titles: ${result.titles.length}, files: ${result.files.length}, urls: ${result.urls.length}, calls: ${result.calls.length}, uiText: ${result.uiText ? 'yes' : 'no'}`);
            
            // Debugging: log the first 3 titles.
            if (result.titles.length > 0) {
                logDebug(`Erste 3 Titel: ${result.titles.slice(0, 3).join(', ')}`);
            } else {
                logDebug(`WARNUNG: Keine Titel erfasst!`);
            }
        }

        return result;
    } catch (e) {
        console.error('Metadata collection failed', e);
        return { titles: [], files: [], urls: [], calls: [], activeWindow: "", monitors: [], uiText: null };
    }
}

// Provides the metadata API used by screenshots and window monitoring.
// Returns the last cached metadata snapshot.
async function getMetaData(includeFull = true, includeMonitors = true) {
    return cachedMetaData;
}

// Clears pending automatic screenshot trigger timers.
function clearScheduledScreenshotTriggers() {
    if (recordingTimeout) {
        clearTimeout(recordingTimeout);
        recordingTimeout = null;
    }
    if (windowChangeTimeout) {
        clearTimeout(windowChangeTimeout);
        windowChangeTimeout = null;
    }
    if (displayChangeTimeout) {
        clearTimeout(displayChangeTimeout);
        displayChangeTimeout = null;
    }
    screenshotCapturePending = false;
}

// Creates the pause controller after the tray app has initialized its helpers.
function setupPauseController() {
    if (pauseController) return;

    pauseController = createPauseController({
        iconDir: path.join(__dirname, 'assets'),
        i18n,
        logDebug,
        clearScheduledScreenshotTriggers,
        updateTrayStatus,
        refreshTrayMenu,
        scheduleImmediateScreenshot: () => {
            nextScreenshotTime = Date.now();
            scheduleNextScreenshot();
        }
    });
}

// Updates the tray tooltip with the current recording or pause state.
function updateTrayStatus() {
    if (!tray) return;

    let tooltip = `${i18n.t('tray.tooltip')} v${app.getVersion()}`;

    if (pauseController && pauseController.isResumeDecisionActive()) {
        tooltip += `\n${i18n.t('tray.tooltip_resume_pending', {
            time: pauseController.formatPauseTime(pauseController.getResumeDecisionDeadline())
        })}`;
    } else if (pauseController && pauseController.isPauseActive()) {
        tooltip += `\n${i18n.t('tray.tooltip_paused_until', {
            time: pauseController.formatPauseTime(pauseController.getPausedUntil())
        })}`;
    }

    tray.setToolTip(tooltip);
}

// Builds the current tray menu based on the screenshot pause state.
function buildTrayMenuTemplate() {
    const template = [
        { label: i18n.t('tray.menu.show_viewer'), click: () => openViewer() },
        { type: 'separator' }
    ];

    if (pauseController && pauseController.isResumeDecisionActive()) {
        template.push(
            {
                label: i18n.t('tray.menu.pause_again_30_minutes'),
                click: () => pauseController && pauseController.pauseScreenshots()
            },
            {
                label: i18n.t('tray.menu.resume_now'),
                click: () => pauseController && pauseController.resumeScreenshots({ notify: true })
            }
        );
    } else if (pauseController && pauseController.isPauseActive()) {
        template.push({
            label: i18n.t('tray.menu.resume_now'),
            click: () => pauseController && pauseController.resumeScreenshots({ notify: true })
        });
    } else {
        template.push({
            label: i18n.t('tray.menu.pause_30_minutes'),
            click: () => pauseController && pauseController.pauseScreenshots()
        });
    }

    template.push(
        { type: 'separator' },
        { label: i18n.t('tray.menu.debug'), click: () => openDebugWindow() },
        { label: i18n.t('tray.menu.quit'), click: () => app.quit() }
    );

    return template;
}

// Rebuilds the tray context menu after pause state changes.
function refreshTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
}

// Returns true when pause state should prevent a newly scheduled capture timer.
function isCaptureSchedulingPaused() {
    return Boolean(pauseController && (
        pauseController.isPauseActive() ||
        pauseController.isResumeDecisionActive()
    ));
}


function openViewer() {
    if (app.isPackaged) {
        // Start the viewer as its own Windows app identity instead of reusing the tray context.
        spawn(process.execPath, ['viewer'], {
            detached: true,
            stdio: 'ignore'
        }).unref();
    } else {
        // In development mode, use Electron from node_modules.
        const path = require('path');
        const viewerPath = path.join(__dirname, '..', 'viewer');
        const electronPath = require('electron');
        spawn(electronPath, [viewerPath], {
            detached: true,
            stdio: 'ignore'
        }).unref();
    }
}

function openDebugWindow() {
    if (debugWindow) {
        debugWindow.focus();
        return;
    }

    debugWindow = new BrowserWindow({
        width: 600,
        height: 500,
        title: 'Screen Recorder Debug',
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    debugWindow.loadFile(path.join(__dirname, 'debug.html'));

    debugWindow.on('closed', () => {
        debugWindow = null;
    });

    // Remove menu from debug window
    debugWindow.setMenu(null);
}

// IPC listener for debug data
ipcMain.on('get-debug-data', (event) => {
    event.reply('debug-data', cachedMetaData);
});

function startScreensaver() {
    if (app.isPackaged) {
        // In the installed app, use our own executable path with the "screensaver" argument.
        spawn(process.execPath, ['screensaver'], {
            detached: true,
            stdio: 'ignore'
        }).unref();
    } else {
        // In development mode, use Electron from node_modules.
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
        // On Windows, prefer loading nativeImage from ICO for the tray.
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
    
    setupPauseController();
    updateTrayStatus();
    refreshTrayMenu();
    updateTrayHeartbeat();
    if (!trayHeartbeatInterval) {
        trayHeartbeatInterval = setInterval(updateTrayHeartbeat, 5000);
    }

    // Open viewer on double click
    tray.on('double-click', () => {
        openViewer();
    });

    // Initialize DB.
    initDb();
    
    // Watch store events.
    if (store && typeof store.onDidChange === 'function') {
        store.onDidChange('ocrEnabled', (newValue) => {
            logDebug(`Config changed: ocrEnabled = ${newValue}`);
            // Update tooltip immediately.
            updateTrayStatus();
        });
        // Also respond to other relevant changes.
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
                    
                    // Image scaling for better speed in fast mode.
                    if (fastMode) {
                        try {
                            const originalImage = nativeImage.createFromPath(imagePaths[i]);
                            if (!originalImage.isEmpty()) {
                                const size = originalImage.getSize();
                                // Scale to 50%.
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
        // Cleanup if needed.
    }
    return combinedText;
}

/**
 * Filters OCR text to reduce noise.
 * @param {string} text 
 * @returns {string}
 */
function filterOcrText(text) {
    if (!text) return "";
    const lines = text.split('\n');
    const filteredLines = lines.map(line => {
        // Filter words: keep only words with at least 2 characters or meaningful single characters.
        const words = line.split(/\s+/);
        const filteredWords = words.filter(word => {
            // Filter special-character strings (for example "!!!", "---").
            if (/^[^a-zA-Z0-9äöüÄÖÜß]{2,}$/.test(word)) return false;
            // Filter single special characters.
            if (word.length === 1 && !/[a-zA-Z0-9äöüÄÖÜß]/.test(word)) return false;
            // Usually keep single numbers, but single letters only when they have context.
            if (word.length < 2 && !/[0-9]/.test(word)) return false;
            return true;
        });
        return filteredWords.join(' ');
    }).filter(line => line.trim().length > 0);

    return filteredLines.join('\n');
}

// Captures screenshots unless recording is temporarily blocked by user or system state.
async function takeScreenshots(onNewScreenshots) {
    if (onNewScreenshots) currentOnNewScreenshots = onNewScreenshots;

    if (screenshotCaptureRunning) {
        if (!screenshotCapturePending) {
            logDebug('Screenshot capture is already running. Queued one follow-up capture.');
        }
        screenshotCapturePending = true;
        return;
    }

    screenshotCaptureRunning = true;
    let shouldScheduleNext = false;

    try {
        if (pauseController && pauseController.shouldSkipCapture()) {
            logDebug('Skipping screenshot because screenshot recording is paused.');
            updateTrayStatus();
            return;
        }

        // Check if we should skip screenshots during batch OCR or if screensaver is active.
        const isBatchRunning = getIsBatchOcrRunning();
        const isScreensaverRunning = isScreensaverPauseActive();

        if (isScreensaverRunning || isBatchRunning) {
            if (isScreensaverRunning) {
                logDebug('Skipping screenshot because screensaver is active.');
            } else {
                logDebug('Skipping screenshot because batch OCR in viewer is active.');
            }
            const intervalSeconds = getInterval();
            nextScreenshotTime = Date.now() + intervalSeconds * 1000;
            updateTrayStatus();
            shouldScheduleNext = true;
            return;
        }

        // Clear existing timeout if present (important for manual/event triggers).
        if (recordingTimeout) {
            clearTimeout(recordingTimeout);
            recordingTimeout = null;
        }

        if (await isPowerSaving()) {
            console.log('Skipping screenshot because power saving mode is active (ScreenSaver/Monitor Off).');
            // Still move the time for the next regular screenshot
            // so we do not immediately end up here again.
            const intervalSeconds = getInterval();
            nextScreenshotTime = Date.now() + intervalSeconds * 1000;
            updateTrayStatus();
            shouldScheduleNext = true;
            return;
        }

        const dir = getConfigDir();
        const onlyOnChanges = getOnlyOnChanges();
        const intervalSeconds = getInterval();
        nextScreenshotTime = Date.now() + intervalSeconds * 1000;
        updateTrayStatus();
        shouldScheduleNext = true;

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
        const displays = await screenshot.listDisplays();
        const displayBuffers = [];
        const displayHashes = [];
        let anyNew = false;

        // First get all buffers and hashes.
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
            
            // Save to DB.
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
                uiText: meta.uiText || null,
                files: capturedFiles
            });

            const pendingCount = getPendingOcrCount();
            logDebug(`Capture saved to DB: ${year}-${month}-${day} ${timeStr}-${secondsStr}. Pending OCR: ${pendingCount}`);

            if (currentOnNewScreenshots) {
                currentOnNewScreenshots({ baseDir, displaysCount: displays.length });
            }
        }
    } catch (err) {
        console.error('Screenshot failed', err);
        logDebug(`Screenshot failed: ${err.stack || err.message}`);
        const intervalSeconds = getInterval();
        if (!nextScreenshotTime || nextScreenshotTime <= Date.now()) {
            nextScreenshotTime = Date.now() + intervalSeconds * 1000;
        }
        shouldScheduleNext = true;
    } finally {
        screenshotCaptureRunning = false;

        if (screenshotCapturePending) {
            screenshotCapturePending = false;
            if (isCaptureSchedulingPaused()) return;
            nextScreenshotTime = Date.now();
            scheduleNextScreenshot();
            return;
        }

        if (shouldScheduleNext && !isCaptureSchedulingPaused()) {
            scheduleNextScreenshot();
        }
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
    clearScheduledScreenshotTriggers();
    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (metaDataInterval) clearInterval(metaDataInterval);
    
    if (onNewScreenshots) currentOnNewScreenshots = onNewScreenshots;
    
    // Check database maintenance every 15 minutes.
    idleCheckInterval = setInterval(runDatabaseMaintenance, 15 * 60 * 1000);
    
    // Combined metadata loop and window monitor.
    // This runs "relaxed" in the background as requested.
    const runMetadataLoop = async () => {
        if (windowMonitorCheckRunning) return;
        windowMonitorCheckRunning = true;
        
        try {
            const checkWindowChange = getScreenshotOnWindowChange();
            const checkDisplayChange = getScreenshotOnDisplayChange();
            
            // "Relaxed" everything query.
            // We fetch full metadata to keep the cache fresh.
            const meta = await getMetaDataFromWorker(true, true);
            const now = new Date().toISOString();
            cachedMetaData.lastCheck = now;
            
            // Update individual categories and their timestamps
            if (JSON.stringify(meta.titles) !== JSON.stringify(cachedMetaData.titles) || !cachedMetaData.timestamps.titles) {
                cachedMetaData.titles = meta.titles;
                cachedMetaData.timestamps.titles = now;
            }
            if (JSON.stringify(meta.files) !== JSON.stringify(cachedMetaData.files) || !cachedMetaData.timestamps.files) {
                cachedMetaData.files = meta.files;
                cachedMetaData.timestamps.files = now;
            }
            if (JSON.stringify(meta.urls) !== JSON.stringify(cachedMetaData.urls) || !cachedMetaData.timestamps.urls) {
                cachedMetaData.urls = meta.urls;
                cachedMetaData.timestamps.urls = now;
            }
            if (JSON.stringify(meta.calls) !== JSON.stringify(cachedMetaData.calls) || !cachedMetaData.timestamps.calls) {
                cachedMetaData.calls = meta.calls;
                cachedMetaData.timestamps.calls = now;
            }
            if (JSON.stringify(meta.monitors) !== JSON.stringify(cachedMetaData.monitors) || !cachedMetaData.timestamps.monitors) {
                cachedMetaData.monitors = meta.monitors;
                cachedMetaData.timestamps.monitors = now;
            }
            if (meta.uiText !== cachedMetaData.uiText || !cachedMetaData.timestamps.uiText) {
                cachedMetaData.uiText = meta.uiText;
                cachedMetaData.timestamps.uiText = now;
            }
            
            cachedMetaData.activeWindow = meta.activeWindow;
            cachedMetaData.activeWindowRect = meta.activeWindowRect;

            // Update debug window if open
            if (debugWindow && !debugWindow.isDestroyed()) {
                debugWindow.webContents.send('debug-data', cachedMetaData);
            }

            // 1. Check window changes.
            if (checkWindowChange && meta.activeWindow && meta.activeWindow !== lastActiveWindowTitle) {
                console.log(`Window changed: ${lastActiveWindowTitle} -> ${meta.activeWindow}`);
                lastActiveWindowTitle = meta.activeWindow;
                
                if (windowChangeTimeout) clearTimeout(windowChangeTimeout);
                const delay = getWindowChangeDelay();
                windowChangeTimeout = setTimeout(() => {
                    takeScreenshots(currentOnNewScreenshots);
                }, delay * 1000);
            }

            // 2. Check monitor changes (monitor of the active window).
            if (checkDisplayChange && meta.activeWindowRect && meta.monitors && meta.monitors.length > 0) {
                const centerX = meta.activeWindowRect.Left + (meta.activeWindowRect.Right - meta.activeWindowRect.Left) / 2;
                const centerY = meta.activeWindowRect.Top + (meta.activeWindowRect.Bottom - meta.activeWindowRect.Top) / 2;
                
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
                        if (displayChangeTimeout) clearTimeout(displayChangeTimeout);
                        const delay = getDisplayChangeDelay();
                        displayChangeTimeout = setTimeout(() => {
                            takeScreenshots(currentOnNewScreenshots);
                        }, delay * 1000);
                    }
                }
            }
        } catch (e) {
            console.error('Metadata collection failed', e);
        } finally {
            windowMonitorCheckRunning = false;
        }
    };

    // Run every 4 seconds.
    metaDataInterval = setInterval(runMetadataLoop, 4000);
    // Initial fetch.
    runMetadataLoop();
    
    takeScreenshots(currentOnNewScreenshots); // Start immediately
}

// Watch for config changes
store.onDidAnyChange((newValue, oldValue) => {
    if (!hasTrayInstanceLock) return;

    const nextConfig = newValue || {};
    const previousConfig = oldValue || {};

    // Restart timer when important parameters changed.
    if (nextConfig.interval !== previousConfig.interval ||
        nextConfig.screenshotOnWindowChange !== previousConfig.screenshotOnWindowChange ||
        nextConfig.windowChangeDelay !== previousConfig.windowChangeDelay ||
        nextConfig.screenshotOnDisplayChange !== previousConfig.screenshotOnDisplayChange ||
        nextConfig.displayChangeDelay !== previousConfig.displayChangeDelay) {
        startRecording();
    }
});

// Background indexing (file system -> database synchronization).
async function runBackgroundIndexing() {
    logDebug('Starting background indexing...');
    const configDir = getConfigDir();
    const baseDir = path.join(configDir, 'screenRecorder');
    
    let totalItems = 0;
    let items = [];

    // Scan only the new structure (the old structure is usually migrated only once).
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

                        // Zuerst Metadaten-Dateien finden.
                        files.forEach(file => {
                            const metaMatch = file.match(/^meta_(\d{2}-\d{2}-\d{2})\.json$/);
                            if (metaMatch) {
                                const time = metaMatch[1];
                                try {
                                    const meta = JSON.parse(fs.readFileSync(path.join(dayDir, file), 'utf8'));
                                    timeGroups[time] = { time, files: {}, date: dateStr, meta: meta };
                                } catch (e) {}
                            }
                        });

                        // Dann Screenshots zuordnen.
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
                                            if (!timeGroups[time]) {
                                                timeGroups[time] = { time, files: {}, date: dateStr, meta: null };
                                            }
                                            timeGroups[time].files[screenIdx] = path.join(screenDir, img);
                                        }
                                    });
                                }
                            }
                        });

                        for (const time in timeGroups) {
                            const group = timeGroups[time];
                            const item = {
                                date: group.date,
                                time: group.time,
                                timestamp: new Date(`${group.date}T${group.time.replace(/-/g, ':')}`).getTime(),
                                files: group.files
                            };

                            if (group.meta) {
                                if (group.meta.titles) item.titles = group.meta.titles;
                                if (group.meta.activeWindow) item.activeWindow = group.meta.activeWindow;
                                if (group.meta.files || group.meta.openFiles) item.openFiles = group.meta.files || group.meta.openFiles;
                                if (group.meta.urls) item.urls = group.meta.urls;
                                if (group.meta.ocrText) item.ocrText = group.meta.ocrText;
                                if (group.meta.uiText) item.uiText = group.meta.uiText;
                                if (group.meta.calls) item.calls = group.meta.calls;
                            }

                            items.push(item);

                            if (items.length >= 500) {
                                const result = saveCapturesBatch(items);
                                totalItems += items.length;
                                items = [];
                                // Wait briefly to avoid excessive system load.
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

if (hasTrayInstanceLock) {
    // Run indexing every 60 minutes.
    setInterval(runBackgroundIndexing, 60 * 60 * 1000);
    // Also run once 10 seconds after startup.
    setTimeout(runBackgroundIndexing, 10000);
}

app.whenReady().then(() => {
    if (!hasTrayInstanceLock) {
        app.quit();
        return;
    }

    setupTray();
    startRecording();
});

app.on('window-all-closed', (e) => {
    // Keep the tray app open.
    e.preventDefault();
});

app.on('before-quit', () => {
    if (!hasTrayInstanceLock) return;

    if (pauseController) pauseController.dispose();
    if (trayHeartbeatInterval) clearInterval(trayHeartbeatInterval);
    setTrayHeartbeat(0);
    if (powershellService) powershellService.stop();
});
