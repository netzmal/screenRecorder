const { app } = require('electron');
const path = require('path');

// App Name so früh wie möglich setzen, damit electron-store den richtigen Pfad nutzt
if (app) {
    try {
        // Der Name bestimmt den Ordner unter AppData
        if (app.name !== 'screen-recorder-shared') {
            app.name = 'screen-recorder-shared';
        }
    } catch (e) {
        console.error('Failed to set app.name:', e);
    }
}

// Robustes Laden von electron-store (CJS/ESM Interop)
let Store;
try {
    const electronStore = require('electron-store');
    Store = electronStore.default || electronStore;
} catch (e) {
    console.error('Failed to require electron-store:', e);
}

let store;
try {
    if (!Store) throw new Error('Store constructor is undefined');

    // Falls app.getPath('userData') nicht verfügbar ist (z.B. in manchen Umgebungen), 
    // nutzen wir den Prozess-Namen oder Umgebungsvariablen als Fallback
    let baseDir;
    if (global.realUserData) {
        baseDir = global.realUserData;
    } else if (app && app.isReady()) {
        baseDir = app.getPath('userData');
    } else {
        // Fallback-Logik für Pfad-Bestimmung
        const appData = process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME + '/.config');
        baseDir = path.join(appData, 'screen-recorder-shared');
    }
    
    console.log('Initializing electron-store in:', baseDir);
    
    store = new Store({ 
        name: 'config',
        watch: true,
        clearInvalidConfig: false,
        cwd: baseDir
    });
} catch (e) {
    console.error('Failed to initialize electron-store:', e);
    // Falls wir außerhalb von Electron sind oder Store-Laden fehlschlug
    const MockStore = class {
        constructor() { this.data = {}; }
        get(key, def) { return this.data[key] !== undefined ? this.data[key] : def; }
        set(key, val) { this.data[key] = val; }
        onDidChange(key, callback) { return () => {}; }
        onDidAnyChange(callback) { return () => {}; }
    };
    store = new MockStore();
}

const getBaseDir = () => {
    if (global.realUserData) return global.realUserData;
    if (app) return app.getPath('userData');
    return path.join(process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME + '/.config'), 'screen-recorder-shared');
};

const getConfigDir = () => {
    try {
        return store.get('screenshotDir', app.getPath('pictures'));
    } catch (e) {
        // Fallback für Node.js ohne Electron app
        return store.get('screenshotDir', process.env.USERPROFILE + '\\Pictures');
    }
};
const setConfigDir = (dir) => store.set('screenshotDir', dir);

const getInterval = () => store.get('interval', 60);
const setIntervalTime = (seconds) => store.set('interval', seconds);

const getOnlyOnChanges = () => store.get('onlyOnChanges', false);
const setOnlyOnChanges = (value) => store.set('onlyOnChanges', value);

const getScaleMode = () => store.get('scaleMode', 'fit');
const setScaleMode = (mode) => {
    // Abwärtskompatibilität für 'auto' -> 'list'
    const finalMode = mode === 'auto' ? 'list' : mode;
    store.set('scaleMode', finalMode);
};

const getDefaultMode = () => store.get('defaultMode', 'fit');
const setDefaultMode = (mode) => store.set('defaultMode', mode);

const getStartView = () => store.get('startView', 'latest');
const setStartView = (view) => store.set('startView', view);

const getOcrEnabled = () => store.get('ocrEnabled', false);
const setOcrEnabled = (value) => store.set('ocrEnabled', value);

const getOcrLanguage = () => store.get('ocrLanguage', 'deu+eng');
const setOcrLanguage = (lang) => store.set('ocrLanguage', lang);

const getOcrFastMode = () => store.get('ocrFastMode', false);
const setOcrFastMode = (value) => store.set('ocrFastMode', value);


const getIsBatchOcrRunning = () => store.get('isBatchOcrRunning', false);
const setIsBatchOcrRunning = (value) => store.set('isBatchOcrRunning', value);

const getIsScreensaverRunning = () => store.get('isScreensaverRunning', false);
const setIsScreensaverRunning = (value) => store.set('isScreensaverRunning', value);

const getScreensaverSystemEnabled = () => store.get('screensaverSystemEnabled', false);
const setScreensaverSystemEnabled = (value) => store.set('screensaverSystemEnabled', value);

const getScreensaverTimeout = () => store.get('screensaverTimeout', 300);
const setScreensaverTimeout = (seconds) => store.set('screensaverTimeout', seconds);

const getScreensaverRequirePassword = () => store.get('screensaverRequirePassword', false);
const setScreensaverRequirePassword = (value) => store.set('screensaverRequirePassword', value);


const getLastIndexingTime = () => store.get('lastIndexingTime', 0);
const setLastIndexingTime = (timestamp) => store.set('lastIndexingTime', timestamp);

const getScreenshotOnWindowChange = () => store.get('screenshotOnWindowChange', false);
const setScreenshotOnWindowChange = (value) => store.set('screenshotOnWindowChange', value);

const getWindowChangeDelay = () => store.get('windowChangeDelay', 5);
const setWindowChangeDelay = (seconds) => store.set('windowChangeDelay', seconds);

const getScreenshotOnDisplayChange = () => store.get('screenshotOnDisplayChange', false);
const setScreenshotOnDisplayChange = (value) => store.set('screenshotOnDisplayChange', value);

const getDisplayChangeDelay = () => store.get('displayChangeDelay', 5);
const setDisplayChangeDelay = (seconds) => store.set('displayChangeDelay', seconds);

const getSkipOnPowerSave = () => store.get('skipOnPowerSave', true);
const setSkipOnPowerSave = (value) => store.set('skipOnPowerSave', value);

const getAutostart = () => store.get('autostart', true);
const setAutostart = (value) => store.set('autostart', value);

const getChatGptApiKey = () => store.get('chatGptApiKey', '');
const setChatGptApiKey = (value) => store.set('chatGptApiKey', value);

const getLanguage = () => store.get('language', 'auto');
const setLanguage = (value) => store.set('language', value);

const getScreenshotFormat = () => store.get('screenshotFormat', 'jpg');
const setScreenshotFormat = (value) => store.set('screenshotFormat', value);

const migrateConfig = () => {
    try {
        if (!app) return;
        const fs = require('fs');
        const userDataPath = app.getPath('userData');
        const newConfigFilePath = path.join(userDataPath, 'config.json');

    // Falls die neue Config schon existiert und nicht fast leer ist, überspringen wir die Migration
    if (fs.existsSync(newConfigFilePath)) {
        try {
            const stats = fs.statSync(newConfigFilePath);
            if (stats.size > 10) return; // Eine fast leere {} hat 2-3 Bytes
        } catch (e) {}
    }

    const migrationSources = [
        { path: path.join(app.getPath('appData'), 'screen-recorder-viewer', 'screen-recorder-shared-config.json'), label: 'old viewer' },
        { path: path.join(app.getPath('appData'), 'screen-recorder-tray', 'screen-recorder-shared-config.json'), label: 'old tray' },
        { path: path.join(app.getPath('appData'), 'Screen Recorder', 'config.json'), label: 'default product' },
        { path: path.join(app.getPath('appData'), 'screen-recorder', 'config.json'), label: 'default name' }
    ];

    for (const source of migrationSources) {
        if (fs.existsSync(source.path)) {
            try {
                if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
                fs.copyFileSync(source.path, newConfigFilePath);
                console.log(`Config migration from ${source.label} successful`);
                // Nach erfolgreicher Migration können wir die alten Dateien aufräumen
                // Aber wir machen das gesammelt am Ende
                break; 
            } catch (e) {
                console.error(`Config migration from ${source.label} failed`, e);
            }
        }
    }

    // Aufräumen: Alte Dateien löschen
    const cleanupPaths = [
        path.join(app.getPath('appData'), 'screen-recorder-tray', 'config.json'),
        path.join(app.getPath('appData'), 'screen-recorder-tray', 'screen-recorder-shared-config.json'),
        path.join(app.getPath('appData'), 'screen-recorder-viewer', 'screen-recorder-shared-config.json'),
        path.join(app.getPath('appData'), 'Screen Recorder', 'config.json'),
        path.join(app.getPath('appData'), 'screen-recorder', 'config.json')
    ];

    cleanupPaths.forEach(p => {
        if (fs.existsSync(p)) {
            try {
                // Wir löschen nur, wenn wir sicher sind, dass die Daten migriert wurden
                // Bei der DB prüfen wir das in initDb(). 
                // Hier löschen wir sie nur, wenn sie "alt" sind.
                // Um sicher zu gehen, löschen wir sie erst, wenn initDb() gelaufen ist.
                // Aber wir können hier zumindest die alten Config-Dateien löschen.
                if (p.endsWith('.json')) {
                    fs.unlinkSync(p);
                }
            } catch (e) {}
        }
    });
    } catch (err) {
        console.error('Fatal error during config migration:', err);
    }
};

module.exports = {
    store,
    migrateConfig,
    getConfigDir,
    setConfigDir,
    getInterval,
    setIntervalTime,
    getOnlyOnChanges,
    setOnlyOnChanges,
    getScaleMode,
    setScaleMode,
    getDefaultMode,
    setDefaultMode,
    getStartView,
    setStartView,
    getOcrEnabled,
    setOcrEnabled,
    getOcrLanguage,
    setOcrLanguage,
    getOcrFastMode,
    setOcrFastMode,
    getIsBatchOcrRunning,
    setIsBatchOcrRunning,
    getIsScreensaverRunning,
    setIsScreensaverRunning,
    getScreensaverSystemEnabled,
    setScreensaverSystemEnabled,
    getScreensaverTimeout,
    setScreensaverTimeout,
    getScreensaverRequirePassword,
    setScreensaverRequirePassword,
    getLastIndexingTime,
    setLastIndexingTime,
    getScreenshotOnWindowChange,
    setScreenshotOnWindowChange,
    getWindowChangeDelay,
    setWindowChangeDelay,
    getScreenshotOnDisplayChange,
    setScreenshotOnDisplayChange,
    getDisplayChangeDelay,
    setDisplayChangeDelay,
    getSkipOnPowerSave,
    setSkipOnPowerSave,
    getAutostart,
    setAutostart,
    getChatGptApiKey,
    setChatGptApiKey,
    getLanguage,
    setLanguage,
    getScreenshotFormat,
    setScreenshotFormat,
    getBaseDir
};
