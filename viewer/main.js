const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard, screen, Notification, net, powerSaveBlocker, nativeImage } = require('electron');
const path = require('path');

// --- Single Instance Lock & Argument Handling ---
// Dies muss so früh wie möglich geschehen, noch vor dem Laden der Config-Module
const isScreensaverPreview = process.argv.find(arg => arg.toLowerCase().startsWith('/p'));
const isScreensaverStartArg = process.argv.includes('screensaver') || process.argv.find(arg => arg.toLowerCase().startsWith('/s'));

if (isScreensaverPreview) {
    app.quit();
    process.exit(0);
    return;
}

if (isScreensaverStartArg) {
    // app.name vorab setzen (identisch zu config.js), damit global.realUserData den selben
    // Pfad wie Tray/Viewer zeigt – andernfalls würden sie unterschiedliche Datenbanken nutzen.
    app.name = 'screen-recorder-shared';
    global.realUserData = app.getPath('userData');
    // Eigenes Unterverzeichnis für den Screensaver, um den Single-Instance-Lock zu umgehen
    app.setPath('userData', path.join(global.realUserData, 'screensaver-proc'));
} else {
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
        app.quit();
        return;
    }
}
// ------------------------------------------------

const fs = require('fs');
const os = require('os');
const Tesseract = require('tesseract.js');
const { migrateConfig, setConfigDir, getConfigDir, setIntervalTime, getInterval, setOnlyOnChanges, getOnlyOnChanges, setScaleMode, getScaleMode, getDefaultMode, setDefaultMode, getStartView, setStartView, setOcrEnabled, getOcrEnabled, setOcrLanguage, getOcrLanguage, setScreenshotOnWindowChange, getScreenshotOnWindowChange, setWindowChangeDelay, getWindowChangeDelay, setScreenshotOnDisplayChange, getScreenshotOnDisplayChange, setDisplayChangeDelay, getDisplayChangeDelay, setSkipOnPowerSave, getSkipOnPowerSave, getAutostart, setAutostart, getChatGptApiKey, setChatGptApiKey, getIsBatchOcrRunning, setIsBatchOcrRunning, getOcrFastMode, setOcrFastMode, getLanguage, setLanguage, getScreenshotFormat, setScreenshotFormat, getLastIndexingTime, setLastIndexingTime, getScreensaverSystemEnabled, setScreensaverSystemEnabled, getScreensaverTimeout, setScreensaverTimeout, getScreensaverRequirePassword, setScreensaverRequirePassword } = require('../shared/config');
const { searchCaptures, initDb, saveCapture, saveCapturesBatch, getCaptureByDateTime, getDaySummary, getDayUrls, getDayCalls, getDayCaptures } = require('../shared/db');
const i18n = require('../shared/i18n');
const { runWindowsOcrBatch } = require('../shared/ocr-helper');
const { exec, spawn } = require('child_process');

// AppUserModelId setzen für Benachrichtigungen unter Windows
if (process.platform === 'win32') {
    app.setAppUserModelId('com.screen.recorder');
}

let mainWindow;
let configWindow;
let isTrayRunning = false;

// Single Instance Event Handler (nur wenn wir der Primär-Prozess sind)
app.on('second-instance', (event, commandLine, workingDirectory) => {
    const args = commandLine;
    const isScreensaverConfig = args.find(arg => arg.toLowerCase().startsWith('/c'));
    const isTray = args.includes('tray');

    if (isScreensaverConfig) {
        // Konfiguration in dieser Instanz öffnen
        if (!mainWindow) {
            createMainWindow();
            setTimeout(() => {
                if (mainWindow) {
                    mainWindow.webContents.send('open-tab', 'ocr');
                    createConfigWindow();
                }
            }, 1000);
        } else {
            mainWindow.webContents.send('open-tab', 'ocr');
            createConfigWindow();
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    } else if (isTray) {
        // Tray-Logik laden
        isTrayRunning = true;
        require('../tray/main.js');
    } else {
        // Normaler Viewer-Start
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        } else {
            createMainWindow();
        }
    }
});

// Config Migration durchführen
migrateConfig();

// Sicherstellen, dass Batch OCR Status zurückgesetzt ist
setIsBatchOcrRunning(false);

// i18n initialisieren
const configLanguage = getLanguage();
i18n.init(configLanguage === 'auto' ? null : configLanguage);

// Startup Logging
const screenshotDir = getConfigDir();
const actualScreenshotDir = path.join(screenshotDir, 'screenRecorder');
console.log('--- Screen Recorder Viewer Startup ---');
console.log('Version:', app.getVersion());
console.log('UserData Path:', app.getPath('userData'));
console.log('Configured Screenshot Directory:', screenshotDir);
console.log('Actual Screenshot Directory:', actualScreenshotDir);
console.log('Screenshot Directory Exists:', fs.existsSync(actualScreenshotDir));
console.log('Language:', configLanguage);
console.log('Interval:', getInterval());
console.log('Only on Changes:', getOnlyOnChanges());
console.log('OCR Enabled:', getOcrEnabled());
console.log('OCR Language:', getOcrLanguage());
console.log('Screenshot on Window Change:', getScreenshotOnWindowChange());
console.log('Screenshot on Display Change:', getScreenshotOnDisplayChange());
console.log('Skip on Power Save:', getSkipOnPowerSave());
console.log('Screenshot Format:', getScreenshotFormat());
console.log('Autostart Enabled:', getAutostart());
console.log('--------------------------------------');

function createMainWindow() {
    let iconPath = path.join(__dirname, 'assets', 'icon.png');
    if (process.platform === 'win32') {
        const icoPath = path.join(__dirname, 'assets', 'icon.ico');
        if (fs.existsSync(icoPath)) iconPath = icoPath;
    }

    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
        console.error('Failed to load icon from:', iconPath);
    } else {
        console.log('Icon loaded successfully from:', iconPath, 'Size:', icon.getSize());
    }

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: icon,
        title: `${i18n.t('viewer.title')} - v${app.getVersion()}`,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Explizit das Icon setzen (manchmal nötig unter Windows)
    if (process.platform === 'win32') {
        mainWindow.setIcon(icon);
    }

    mainWindow.loadFile(path.join(__dirname, 'viewer.html'));

    // Remove application menu
    Menu.setApplicationMenu(null);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // DB initialisieren
    initDb();
}

ipcMain.on('test-notification', (event) => {
    if (Notification.isSupported()) {
        let iconPath = path.join(__dirname, 'assets', 'icon.png');
        if (process.platform === 'win32') {
            const icoPath = path.join(__dirname, 'assets', 'icon.ico');
            if (fs.existsSync(icoPath)) iconPath = icoPath;
        }

        new Notification({
            title: 'Test Benachrichtigung',
            body: 'Wenn du dies siehst, funktionieren die Benachrichtigungen korrekt.',
            icon: iconPath
        }).show();
    }
});

// Beende die App, wenn alle Fenster geschlossen sind (nur im Viewer-Modus)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !isTrayRunning) {
        app.quit();
    }
});

function createConfigWindow() {
    if (configWindow) {
        configWindow.focus();
        return;
    }

    let iconPath = path.join(__dirname, 'assets', 'icon.png');
    if (process.platform === 'win32') {
        const icoPath = path.join(__dirname, 'assets', 'icon.ico');
        if (fs.existsSync(icoPath)) iconPath = icoPath;
    }

    const icon = nativeImage.createFromPath(iconPath);

    configWindow = new BrowserWindow({
        width: 800,
        height: 600,
        parent: mainWindow,
        modal: true,
        title: `${i18n.t('config.title')} - v${app.getVersion()}`,
        icon: icon,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Explizit das Icon setzen
    if (process.platform === 'win32') {
        configWindow.setIcon(icon);
    }

    configWindow.loadFile(path.join(__dirname, 'config.html'));
    configWindow.setMenu(null); // No menu for config window

    configWindow.on('closed', () => {
        configWindow = null;
    });
}

app.whenReady().then(() => {
    const isScreensaverStart = process.argv.includes('screensaver') || 
                              process.argv.find(arg => arg.toLowerCase().startsWith('/s'));
    const isScreensaverConfig = process.argv.find(arg => arg.toLowerCase().startsWith('/c'));

    // Wenn als "tray" gestartet, Tray-Logik laden, sonst Viewer
    if (process.argv.includes('tray')) {
        // Sicherstellen, dass die Migration auch im Tray-Modus läuft, falls es der erste Start ist
        migrateConfig();
        isTrayRunning = true;
        require('../tray/main.js');
    } else if (isScreensaverStart) {
        require('../screensaver/main.js');
    } else if (isScreensaverConfig) {
        // Wenn der Screensaver konfiguriert werden soll, öffnen wir direkt das Config-Fenster
        createMainWindow();
        setTimeout(() => {
            if (mainWindow) {
                mainWindow.webContents.send('open-tab', 'ocr');
                createConfigWindow();
            }
        }, 1000);
    } else {
        createMainWindow();
    }
});

ipcMain.on('update-screensaver-settings', (event, { enabled, timeoutSeconds, requirePassword }) => {
    // Wenn gepackt, liegt shared außerhalb der asar oder in der asar.
    // Wir nutzen path.join(__dirname, '..', 'shared', 'screensaver-helper.ps1')
    // Electron asar extrahiert Dateien normalerweise nicht automatisch für exec.
    // Aber .ps1 Dateien sollten lesbar sein.
    let scriptPath = path.join(__dirname, '..', 'shared', 'screensaver-helper.ps1');
    if (app.isPackaged) {
        scriptPath = scriptPath.replace('app.asar', 'app.asar.unpacked');
    }
    const exePath = process.execPath;
    
    // In PowerShell müssen wir den Pfad zum Skript korrekt quoten
    const secureArg = requirePassword ? '-secure' : '';
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -exePath "${exePath}" -timeoutSeconds ${timeoutSeconds} ${secureArg} ${enabled ? '-enable' : ''}`;
    
    console.log('Running screensaver update command:', cmd);
    
    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            console.error('Failed to update screensaver settings:', error);
            event.reply('screensaver-settings-updated', { success: false, error: stderr || error.message });
        } else {
            console.log('Screensaver settings updated:', stdout);
            setScreensaverSystemEnabled(enabled);
            setScreensaverTimeout(timeoutSeconds);
            setScreensaverRequirePassword(!!requirePassword);
            event.reply('screensaver-settings-updated', { success: true, message: stdout, enabled });
        }
    });
});

ipcMain.on('test-screensaver', (event) => {
    // Startet den Screensaver sofort für einen Test
    if (app.isPackaged) {
        spawn(process.execPath, ['screensaver'], {
            detached: true,
            stdio: 'ignore'
        }).unref();
    } else {
        const screensaverPath = path.join(__dirname, '..', 'screensaver');
        const electronPath = require('electron');
        spawn(electronPath, [screensaverPath], {
            detached: true,
            stdio: 'ignore'
        }).unref();
    }
});

ipcMain.on('open-windows-energy-settings', () => {
    exec('control powercfg.cpl');
});

ipcMain.on('open-windows-screensaver-settings', () => {
    exec('control desk.cpl,,@screensaver');
});

ipcMain.on('get-config', async (event) => {
    const translations = {
        common: {
            loading: i18n.t('common.loading'),
            error: i18n.t('common.error'),
            ok: i18n.t('common.ok'),
            cancel: i18n.t('common.cancel'),
            save: i18n.t('common.save')
        },
            viewer: {
                title: i18n.t('viewer.title'),
                loading_calendar: i18n.t('viewer.loading_calendar'),
                tray_warning: i18n.t('viewer.tray_warning'),
                no_captures: i18n.t('viewer.no_captures'),
                search_placeholder: i18n.t('viewer.search_placeholder'),
                tabs: {
                    screenshot: i18n.t('viewer.tabs.screenshot'),
                    titles: i18n.t('viewer.tabs.titles'),
                    files: i18n.t('viewer.tabs.files'),
                    urls: i18n.t('viewer.tabs.urls'),
                    calls: i18n.t('viewer.tabs.calls'),
                    ocr: i18n.t('viewer.tabs.ocr'),
                    summary: i18n.t('viewer.tabs.summary')
                },
                meta: {
                    loading_meta: i18n.t('viewer.meta.loading_meta'),
                    loading_data: i18n.t('viewer.meta.loading_data'),
                    loading_urls: i18n.t('viewer.meta.loading_urls'),
                    loading_ocr: i18n.t('viewer.meta.loading_ocr'),
                    no_ocr: i18n.t('viewer.meta.no_ocr'),
                    no_titles: i18n.t('viewer.meta.no_titles'),
                    no_titles_list: i18n.t('viewer.meta.no_titles_list'),
                    no_files: i18n.t('viewer.meta.no_files'),
                    no_urls: i18n.t('viewer.meta.no_urls'),
                    no_calls: i18n.t('viewer.meta.no_calls'),
                    not_found: i18n.t('viewer.meta.not_found'),
                    no_more_data: i18n.t('viewer.meta.no_more_data'),
                    no_screenshot_at_time: i18n.t('viewer.meta.no_screenshot_at_time'),
                    col_time: i18n.t('viewer.meta.col_time'),
                    col_window: i18n.t('viewer.meta.col_window'),
                    col_url: i18n.t('viewer.meta.col_url'),
                    col_title: i18n.t('viewer.meta.col_title'),
                    col_file: i18n.t('viewer.meta.col_file'),
                    col_call: i18n.t('viewer.meta.col_call')
                },
                ai: {
                    title: i18n.t('viewer.ai.title'),
                    desc: i18n.t('viewer.ai.desc'),
                    status_loading: i18n.t('viewer.ai.status_loading'),
                    generate_btn: i18n.t('viewer.ai.generate_btn'),
                    tab_prompt: i18n.t('viewer.ai.tab_prompt'),
                    tab_result: i18n.t('viewer.ai.tab_result'),
                    prompt_title: i18n.t('viewer.ai.prompt_title'),
                    prompt_desc: i18n.t('viewer.ai.prompt_desc'),
                    result_title: i18n.t('viewer.ai.result_title'),
                    result_placeholder: i18n.t('viewer.ai.result_placeholder'),
                    copy: i18n.t('viewer.ai.copy')
                },
                searching: {
                    active: i18n.t('viewer.searching.active'),
                    results: i18n.t('viewer.searching.results'),
                    error: i18n.t('viewer.searching.error')
                },
                calendar: {
                    error: i18n.t('viewer.calendar.error'),
                    no_data: i18n.t('viewer.calendar.no_data'),
                    days: {
                        mo: i18n.t('viewer.calendar.days.mo'),
                        tu: i18n.t('viewer.calendar.days.tu'),
                        we: i18n.t('viewer.calendar.days.we'),
                        th: i18n.t('viewer.calendar.days.th'),
                        fr: i18n.t('viewer.calendar.days.fr'),
                        sa: i18n.t('viewer.calendar.days.sa'),
                        su: i18n.t('viewer.calendar.days.su')
                    }
                },
                modes: {
                fit: i18n.t('viewer.modes.fit'),
                grid: i18n.t('viewer.modes.grid'),
                list: i18n.t('viewer.modes.list'),
                heat: i18n.t('viewer.modes.heat')
            },
            heatmap: {
                activity: i18n.t('viewer.heatmap.activity')
            },
            controls: {
                prev: i18n.t('viewer.controls.prev'),
                next: i18n.t('viewer.controls.next'),
                play: i18n.t('viewer.controls.play'),
                pause: i18n.t('viewer.controls.pause')
            },
            keyboard_info: i18n.t('viewer.keyboard_info'),
            migration: {
                scanning: i18n.t('viewer.migration.scanning'),
                migrating: i18n.t('viewer.migration.migrating'),
                migrating_progress: i18n.t('viewer.migration.migrating_progress'),
                done: i18n.t('viewer.migration.done')
            }
        },
        config: {
            title: i18n.t('config.title'),
            general: {
                title: i18n.t('config.general.title'),
                language: i18n.t('config.general.language'),
                default_mode: i18n.t('config.general.default_mode'),
                start_view: i18n.t('config.general.start_view'),
                latest: i18n.t('config.general.latest'),
                earliest: i18n.t('config.general.earliest'),
                test_notifications: i18n.t('config.general.test_notifications'),
                test_notifications_help: i18n.t('config.general.test_notifications_help'),
                test_notifications_btn: i18n.t('config.general.test_notifications_btn')
            },
            storage: {
                title: i18n.t('config.storage.title'),
                path: i18n.t('config.storage.path'),
                browse: i18n.t('config.storage.browse')
            },
            recording: {
                title: i18n.t('config.recording.title'),
                interval: i18n.t('config.recording.interval'),
                only_on_changes: i18n.t('config.recording.only_on_changes'),
                window_change: i18n.t('config.recording.window_change'),
                window_change_delay: i18n.t('config.recording.window_change_delay'),
                display_change: i18n.t('config.recording.display_change'),
                display_change_delay: i18n.t('config.recording.display_change_delay'),
                skip_on_powersave: i18n.t('config.recording.skip_on_powersave'),
                format: i18n.t('config.recording.format'),
                shortcut: i18n.t('config.recording.shortcut')
            },
            ocr: {
                title: i18n.t('config.ocr.title'),
                enabled: i18n.t('config.ocr.enabled'),
                language: i18n.t('config.ocr.language'),
                language_help: i18n.t('config.ocr.language_help'),
                fast_mode: i18n.t('config.ocr.fast_mode'),
                fast_mode_help: i18n.t('config.ocr.fast_mode_help'),
                maintenance: i18n.t('config.ocr.maintenance'),
                maintenance_help: i18n.t('config.ocr.maintenance_help'),
                maintenance_btn: i18n.t('config.ocr.maintenance_btn'),
                screensaver_title: i18n.t('config.ocr.screensaver_title'),
                screensaver_help: i18n.t('config.ocr.screensaver_help'),
                screensaver_system_enable: i18n.t('config.ocr.screensaver_system_enable'),
                screensaver_enable_btn: i18n.t('config.ocr.screensaver_enable_btn'),
                screensaver_disable_btn: i18n.t('config.ocr.screensaver_disable_btn'),
                screensaver_timeout: i18n.t('config.ocr.screensaver_timeout'),
                screensaver_require_password: i18n.t('config.ocr.screensaver_require_password'),
                screensaver_require_password_help: i18n.t('config.ocr.screensaver_require_password_help'),
                screensaver_test: i18n.t('config.ocr.screensaver_test'),
                win_energy_settings: i18n.t('config.ocr.win_energy_settings_btn'),
                win_screensaver_settings: i18n.t('config.ocr.win_screensaver_settings_btn')
            },
            ai: {
                title: i18n.t('config.ai.title'),
                api_key: i18n.t('config.ai.api_key'),
                help: i18n.t('config.ai.help')
            },
            system: {
                title: i18n.t('config.system.title'),
                autostart: i18n.t('config.system.autostart'),
                autostart_help: i18n.t('config.system.autostart_help')
            },
            batch_ocr: {
                title: i18n.t('config.batch_ocr.title'),
                abort: i18n.t('config.batch_ocr.abort')
            }
        }
    };

    const displays = screen.getAllDisplays().map(d => ({
        id: d.id,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor
    }));

    event.reply('config-data', { 
        dir: getConfigDir(),
        interval: getInterval(),
        onlyOnChanges: getOnlyOnChanges(),
        scaleMode: getScaleMode(),
        defaultMode: getDefaultMode(),
        startView: getStartView(),
        ocrEnabled: getOcrEnabled(),
        ocrLanguage: getOcrLanguage(),
        ocrFastMode: getOcrFastMode(),
        screenshotOnWindowChange: getScreenshotOnWindowChange(),
        windowChangeDelay: getWindowChangeDelay(),
        screenshotOnDisplayChange: getScreenshotOnDisplayChange(),
        displayChangeDelay: getDisplayChangeDelay(),
        skipOnPowerSave: getSkipOnPowerSave(),
        screenshotFormat: getScreenshotFormat(),
        autostart: getAutostart(),
        chatGptApiKey: getChatGptApiKey(),
        language: getLanguage(),
        screensaverSystemEnabled: getScreensaverSystemEnabled(),
        screensaverTimeout: getScreensaverTimeout(),
        screensaverRequirePassword: getScreensaverRequirePassword(),
        translations: translations,
        version: app.getVersion()
    });
});

ipcMain.handle('is-tray-running', async () => {
    return new Promise((resolve) => {
        // Wir suchen nach "Screen Recorder.exe" im Prozess-Baum
        // Da der Viewer und Tray die gleiche EXE sind, müssen wir nach dem "tray" Argument suchen, 
        // oder wir verlassen uns auf den Fenstertitel (Tray hat kein Fenster, aber wir können tasklist nutzen)
        // Einfacher: Wir prüfen tasklist auf "Screen Recorder.exe" und zählen die Instanzen.
        // Wenn > 1, läuft wahrscheinlich der Tray (oder ein zweiter Viewer).
        // Eleganter: PowerShell Abfrage der Commandline
        const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*tray*' } | Select-Object -ExpandProperty ProcessId"`;
        exec(cmd, (err, stdout) => {
            if (err || !stdout.trim()) {
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
});

ipcMain.on('set-autostart', (event, enabled) => {
    setAutostart(enabled);
    if (process.platform !== 'win32') return;

    const startupPath = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Screen Recorder Tray.lnk');
    const commonStartupPath = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Screen Recorder Tray.lnk';
    
    // Wir versuchen den LNK im Common Startup zu verwalten (benötigt ggf. Admin-Rechte, falls vom User getriggert)
    // Wenn das fehlschlägt, nutzen wir den User-Startup.
    
    const exePath = process.execPath;
    const args = 'tray';
    
    if (enabled) {
        // PowerShell nutzen um LNK zu erstellen (da wir kein natives Modul dafür haben)
        // Wir nutzen EncodedCommand um Quoting-Probleme mit Pfaden zu vermeiden
        const script = [
            `$WshShell = New-Object -ComObject WScript.Shell`,
            `$Shortcut = $WshShell.CreateShortcut('${startupPath.replace(/'/g, "''")}')`,
            `$Shortcut.TargetPath = '${exePath.replace(/'/g, "''")}'`,
            `$Shortcut.Arguments = '${args}'`,
            `$Shortcut.Save()`
        ].join('; ');

        const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
        exec(`powershell -NoProfile -EncodedCommand ${encodedScript}`, (err) => {
            if (err) console.error('Failed to create autostart link', err);
        });
    } else {
        // Link entfernen (beide Orte prüfen zur Sicherheit)
        if (fs.existsSync(startupPath)) fs.unlinkSync(startupPath);
        // Common Startup erfordert meist Admin, wir versuchen es trotzdem mal
        try {
            if (fs.existsSync(commonStartupPath)) fs.unlinkSync(commonStartupPath);
        } catch (e) {}
    }
});

ipcMain.handle('get-capture-meta', async (event, { date, time }) => {
    return getCaptureByDateTime(date, time);
});

ipcMain.handle('get-day-urls', async (event, date) => {
    return getDayUrls(date);
});

ipcMain.handle('get-day-calls', async (event, date) => {
    return getDayCalls(date);
});

ipcMain.handle('get-day-summary', async (event, date) => {
    return getDaySummary(date, i18n.getLocale());
});

ipcMain.handle('get-day-captures', async (event, date) => {
    return getDayCaptures(date);
});

ipcMain.handle('generate-ai-summary', async (event, promptText) => {
    const apiKey = getChatGptApiKey();
    if (!apiKey) {
        throw new Error(i18n.t('viewer.ai.error_no_key'));
    }

    return new Promise((resolve, reject) => {
        const request = net.request({
            method: 'POST',
            protocol: 'https:',
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            }
        });

        const body = JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: i18n.t('viewer.ai.system_prompt')
                },
                {
                    role: 'user',
                    content: promptText
                }
            ],
            temperature: 0.7
        });

        request.on('response', (response) => {
            let data = '';
            response.on('data', (chunk) => {
                data += chunk;
            });
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.choices[0].message.content);
                    } catch (e) {
                        reject(new Error(i18n.t('viewer.ai.error_parse')));
                    }
                } else {
                    try {
                        const json = JSON.parse(data);
                        reject(new Error(i18n.t('viewer.ai.error_api', { message: json.error.message })));
                    } catch (e) {
                        reject(new Error(i18n.t('viewer.ai.error_api_status', { status: response.statusCode })));
                    }
                }
            });
        });

        request.on('error', (error) => {
            reject(new Error(i18n.t('viewer.ai.error_network', { message: error.message })));
        });

        request.write(body);
        request.end();
    });
});

ipcMain.handle('search-metadata', async (event, query) => {
    return searchCaptures(query);
});

ipcMain.handle('get-available-dates', async (event) => {
    const db = initDb();
    const rows = db.prepare('SELECT DISTINCT date FROM captures ORDER BY date ASC').all();
    return rows.map(r => r.date);
});

ipcMain.handle('migrate-data', async (event) => {
    const lastIndexing = getLastIndexingTime();
    const oneDay = 24 * 60 * 60 * 1000;
    
    if (Date.now() - lastIndexing < oneDay) {
        console.log('Skipping migration in viewer, tray indexing is up to date.');
        return { count: 0, status: 'skipped' };
    }

    const configDir = getConfigDir();
    const baseDir = path.join(configDir, 'screenRecorder');
    const oldCapturesDir = path.join(configDir, 'ScreenRecorder_Captures');
    
    const sendProgress = (status, current, total) => {
        event.sender.send('migration-progress', { status, count: current, total: total || 0 });
    };

    sendProgress(i18n.t('viewer.migration.scanning'), 0, 0);
    
    let allItems = [];

    // 1. Scanne ALTE Struktur YYYY-MM-DD
    if (fs.existsSync(oldCapturesDir)) {
        const dates = fs.readdirSync(oldCapturesDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
        for (const date of dates) {
            sendProgress(i18n.t('viewer.migration.scanning'), allItems.length, 0);
            const dayDir = path.join(oldCapturesDir, date);
            if (!fs.statSync(dayDir).isDirectory()) continue;
            const files = fs.readdirSync(dayDir);
            const timeGroups = {};

            files.forEach(file => {
                const match = file.match(/^(display_\d+|meta)_(\d{2}-\d{2}-\d{2})\.(png|jpg|json)$/);
                if (match) {
                    const time = match[2];
                    if (!timeGroups[time]) timeGroups[time] = { time, files: {}, date, meta: null };
                    if (match[1] === 'meta') {
                        try {
                            timeGroups[time].meta = JSON.parse(fs.readFileSync(path.join(dayDir, file), 'utf8'));
                        } catch (e) {}
                    } else {
                        const displayIdx = match[1].split('_')[1];
                        timeGroups[time].files[displayIdx] = path.join(dayDir, file);
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
                    if (group.meta.calls) item.calls = group.meta.calls;
                }

                allItems.push(item);
            }
        }
    }

    // 2. Scanne neue Struktur jahr/monat/tag
    if (fs.existsSync(baseDir)) {
        const years = fs.readdirSync(baseDir).filter(y => /^\d{4}$/.test(y));
        for (const year of years) {
            const yearDir = path.join(baseDir, year);
            const months = fs.readdirSync(yearDir).filter(m => /^\d{2}$/.test(m));
            for (const month of months) {
                const monthDir = path.join(yearDir, month);
                const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
                for (const day of days) {
                    sendProgress(i18n.t('viewer.migration.scanning'), allItems.length, 0);
                    const dayDir = path.join(monthDir, day);
                    const dateStr = `${year}-${month}-${day}`;
                    const files = fs.readdirSync(dayDir);
                    const timeGroups = {};

                    // Zuerst Meta-Dateien in diesem Tag finden
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

                    // Dann Screenshots zuordnen
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
                        if (Object.keys(group.files).length > 0) {
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
                                if (group.meta.calls) item.calls = group.meta.calls;
                            }

                            allItems.push(item);
                        }
                    }
                }
            }
        }
    }

    // 3. In Batches speichern und Fortschritt melden
    const total = allItems.length;
    let processed = 0;
    
    if (total > 0) {
        for (let i = 0; i < allItems.length; i += 500) {
            const batch = allItems.slice(i, i + 500);
            saveCapturesBatch(batch);
            processed += batch.length;
            sendProgress(i18n.t('viewer.migration.migrating'), processed, total);
        }
    }

    setLastIndexingTime(Date.now());
    return { count: total };
});

ipcMain.on('open-config', () => {
    createConfigWindow();
});

ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(configWindow || mainWindow, {
        properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

ipcMain.on('save-config', (event, data) => {
    if (data) {
        if (data.dir) setConfigDir(data.dir);
        if (data.interval !== undefined) setIntervalTime(parseInt(data.interval));
        if (data.onlyOnChanges !== undefined) setOnlyOnChanges(data.onlyOnChanges);
        if (data.scaleMode !== undefined) setScaleMode(data.scaleMode);
        if (data.defaultMode !== undefined) setDefaultMode(data.defaultMode);
        if (data.startView !== undefined) setStartView(data.startView);
        if (data.ocrEnabled !== undefined) setOcrEnabled(data.ocrEnabled);
        if (data.ocrLanguage !== undefined) setOcrLanguage(data.ocrLanguage);
        if (data.ocrFastMode !== undefined) setOcrFastMode(data.ocrFastMode);
        if (data.screenshotOnWindowChange !== undefined) setScreenshotOnWindowChange(data.screenshotOnWindowChange);
        if (data.windowChangeDelay !== undefined) setWindowChangeDelay(parseInt(data.windowChangeDelay));
        if (data.screenshotOnDisplayChange !== undefined) setScreenshotOnDisplayChange(data.screenshotOnDisplayChange);
        if (data.displayChangeDelay !== undefined) setDisplayChangeDelay(parseInt(data.displayChangeDelay));
        if (data.skipOnPowerSave !== undefined) setSkipOnPowerSave(data.skipOnPowerSave);
        if (data.screenshotFormat !== undefined) setScreenshotFormat(data.screenshotFormat);
        if (data.autostart !== undefined) setAutostart(data.autostart);
        if (data.chatGptApiKey !== undefined) setChatGptApiKey(data.chatGptApiKey);
        if (data.language !== undefined) {
            setLanguage(data.language);
            i18n.init(data.language === 'auto' ? null : data.language);
        }
        if (data.screensaverSystemEnabled !== undefined) setScreensaverSystemEnabled(data.screensaverSystemEnabled);
        if (data.screensaverTimeout !== undefined) setScreensaverTimeout(parseInt(data.screensaverTimeout));
        if (data.screensaverRequirePassword !== undefined) setScreensaverRequirePassword(data.screensaverRequirePassword);
        
        if (mainWindow) {
            mainWindow.webContents.send('config-updated', data);
        }
        event.reply('config-saved', { success: true });
    }
});

ipcMain.on('copy-to-clipboard', (event, text) => {
    clipboard.writeText(text);
});

ipcMain.on('show-in-explorer', (event, filePath) => {
    if (fs.existsSync(filePath)) {
        shell.showItemInFolder(filePath);
    }
});

ipcMain.on('show-item-context-menu', (event, { filePath, x, y }) => {
    const template = [
        {
            label: i18n.t('viewer.tabs.files') === 'Files' ? 'Copy Path' : 'Pfad kopieren',
            click: () => {
                clipboard.writeText(filePath);
            }
        },
        {
            label: i18n.t('viewer.tabs.files') === 'Files' ? 'Show in Explorer' : 'Im Explorer anzeigen',
            click: () => {
                if (fs.existsSync(filePath)) {
                    shell.showItemInFolder(filePath);
                }
            }
        }
    ];
    const menu = Menu.buildFromTemplate(template);
    menu.popup(BrowserWindow.fromWebContents(event.sender));
});

// Batch OCR logic
let abortBatchOcr = false;

ipcMain.on('abort-batch-ocr', () => {
    abortBatchOcr = true;
});

ipcMain.on('start-batch-ocr', async (event) => {
    abortBatchOcr = false;
    setIsBatchOcrRunning(true);
    const baseDir = path.join(getConfigDir(), 'screenRecorder');
    const lang = getOcrLanguage() || 'deu+eng';

    try {
        if (!fs.existsSync(baseDir)) {
            setIsBatchOcrRunning(false);
            event.reply('batch-ocr-progress', { error: 'Kein Capture-Verzeichnis gefunden.' });
            return;
        }

        // Neue Struktur: Jahr / Monat / Tag / screenX / HH-mm-ss.jpg
        const tasks = [];
        
        const years = fs.readdirSync(baseDir).filter(d => /^\d{4}$/.test(d));
        for (const year of years) {
            const yearDir = path.join(baseDir, year);
            const months = fs.readdirSync(yearDir).filter(d => /^\d{2}$/.test(d));
            for (const month of months) {
                const monthDir = path.join(yearDir, month);
                const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
                for (const day of days) {
                    const dayDir = path.join(monthDir, day);
                    const dateStr = `${year}-${month}-${day}`;
                    
                    const screenDirs = fs.readdirSync(dayDir).filter(d => d.startsWith('screen'));
                    const timeGroups = {}; // { 'HH-mm-ss': [imagePaths] }

                    screenDirs.forEach(screenDirName => {
                        const screenDir = path.join(dayDir, screenDirName);
                        if (fs.existsSync(screenDir)) {
                            const files = fs.readdirSync(screenDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
                            files.forEach(f => {
                                const timePart = f.split('.')[0]; // HH-mm-ss.ext
                                if (!timeGroups[timePart]) timeGroups[timePart] = [];
                                timeGroups[timePart].push(path.join(screenDir, f));
                            });
                        }
                    });

                    for (const timePart of Object.keys(timeGroups)) {
                        // Prüfen ob bereits in DB mit OCR Text
                        const row = getCaptureByDateTime(dateStr, timePart);
                        
                        let needsOcr = true;
                        if (row && row.ocrText !== null) {
                            needsOcr = false;
                        }

                        if (needsOcr) {
                            tasks.push({
                                dateStr,
                                timePart,
                                imagePaths: timeGroups[timePart],
                                existingMetadata: row ? row.meta : null
                            });
                        }
                    }
                }
            }
        }

        if (tasks.length === 0) {
            setIsBatchOcrRunning(false);
            event.reply('batch-ocr-progress', { done: true, message: 'Alle Screenshots sind bereits verarbeitet.' });
            return;
        }

        // 2. Verarbeite Aufgaben
        const id = powerSaveBlocker.start('prevent-app-suspension');
        console.log(`Batch OCR gestartet: ${tasks.length} Aufgaben zu verarbeiten. PowerSaveBlocker ID: ${id}`);
        
        const isWindows = process.platform === 'win32';
        const useWindowsOcr = isWindows; // Auf Windows bevorzugen wir die native API

        if (useWindowsOcr) {
            let scriptPath = path.join(__dirname, '..', 'shared', 'win-ocr.ps1');
            if (app.isPackaged) {
                scriptPath = scriptPath.replace('app.asar', 'app.asar.unpacked');
            }
            const batchSize = 50; // Mehrere Zeitpunkte bündeln um PowerShell-Starts zu minimieren

            for (let i = 0; i < tasks.length; i += batchSize) {
                if (abortBatchOcr) break;

                const chunk = tasks.slice(i, i + batchSize);
                const allImages = [];
                chunk.forEach(t => allImages.push(...t.imagePaths));

                const percent = (i / tasks.length) * 100;
                const statusMsg = `Verarbeite ${chunk[0].dateStr} ${chunk[0].timePart.replace(/-/g, ':')} (${i + 1}/${tasks.length})...`;
                
                event.reply('batch-ocr-progress', { 
                    status: statusMsg,
                    percent 
                });

                if (i % 100 === 0 || i + batchSize >= tasks.length) {
                    console.log(`[OCR Progress] ${Math.min(i + batchSize, tasks.length)}/${tasks.length} (${Math.round(percent)}%)`);
                }

                try {
                    const ocrResults = await runWindowsOcrBatch(allImages, scriptPath);
                    
                    for (const task of chunk) {
                        let combinedText = '';
                        task.imagePaths.forEach((img, idx) => {
                            // Pfad normalisieren für den Match mit den Ergebnissen aus ocr-helper.js
                            const normalizedPath = path.normalize(img).toLowerCase();
                            const text = ocrResults[normalizedPath] || '';
                            combinedText += `--- Screen ${idx} ---\n${text}\n\n`;
                        });

                        saveCapture({
                            date: task.dateStr,
                            time: task.timePart,
                            ocrText: combinedText
                        });
                    }
                } catch (batchErr) {
                    console.error('Error in Windows OCR batch chunk:', batchErr);
                }
            }
        } else {
            const scheduler = Tesseract.createScheduler();
            const workerCount = Math.max(1, Math.min(4, os.cpus().length - 1));
            
            event.reply('batch-ocr-progress', { 
                status: `Initialisiere ${workerCount} OCR Worker (Tesseract)...`,
                percent: 0 
            });

            const fastMode = getOcrFastMode();
            const parameters = {
                tessedit_pageseg_mode: 3,
                tessedit_char_whitelist: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZäöüÄÖÜß.,:;!?()[]{}@/\\- '
            };

            if (fastMode) {
                console.log('Verwende Tesseract Fast-Mode');
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

            for (let i = 0; i < workerCount; i++) {
                const worker = await Tesseract.createWorker(lang, 1);
                await worker.setParameters(parameters);
                scheduler.addWorker(worker);
            }

            for (let i = 0; i < tasks.length; i++) {
                if (abortBatchOcr) break;

                const task = tasks[i];
                const percent = (i / tasks.length) * 100;
                const statusMsg = `Verarbeite ${task.dateStr} ${task.timePart.replace(/-/g, ':')} (${i + 1}/${tasks.length})...`;
                
                event.reply('batch-ocr-progress', { 
                    status: statusMsg,
                    percent 
                });

                if (i % 50 === 0 || i === tasks.length - 1) {
                    console.log(`[OCR Progress] ${i + 1}/${tasks.length} (${Math.round(percent)}%) - ${task.dateStr} ${task.timePart}`);
                }

                const results = await Promise.all(task.imagePaths.map((img, idx) => 
                    scheduler.addJob('recognize', img).then(res => ({ idx, text: res.data.text }))
                ));
                
                let combinedText = '';
                results.sort((a, b) => a.idx - b.idx).forEach(res => {
                    combinedText += `--- Screen ${res.idx} ---\n${res.text}\n\n`;
                });

                saveCapture({
                    date: task.dateStr,
                    time: task.timePart,
                    ocrText: combinedText
                });
            }
            if (scheduler) await scheduler.terminate();
        }

        if (abortBatchOcr) {
            powerSaveBlocker.stop(id);
            setIsBatchOcrRunning(false);
            event.reply('batch-ocr-progress', { done: true, message: 'Batch OCR wurde vom Benutzer abgebrochen.' });
            return;
        }

        powerSaveBlocker.stop(id);
        setIsBatchOcrRunning(false);
        console.log(`Batch OCR beendet. ${tasks.length} Zeitpunkte verarbeitet.`);
        event.reply('batch-ocr-progress', { done: true, percent: 100, message: `${tasks.length} Zeitpunkte erfolgreich verarbeitet.` });

    } catch (err) {
        console.error('Batch OCR error', err);
        setIsBatchOcrRunning(false);
        if (typeof id !== 'undefined') powerSaveBlocker.stop(id);
        event.reply('batch-ocr-progress', { error: err.message });
    }
});
