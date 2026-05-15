const { app } = require('electron');
const path = require('path');

// Set the app name as early as possible so electron-store uses the correct path.
if (app) {
    try {
        // The name determines the folder under AppData.
        if (app.name !== 'screen-recorder-shared') {
            app.name = 'screen-recorder-shared';
        }
    } catch (e) {
        console.error('Failed to set app.name:', e);
    }
}

// Robust electron-store loading (CJS/ESM interop).
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

    // If app.getPath('userData') is unavailable (for example in some environments),
    // use the process name or environment variables as a fallback.
    let baseDir;
    if (global.realUserData) {
        baseDir = global.realUserData;
    } else if (app && app.isReady()) {
        baseDir = app.getPath('userData');
    } else {
        // Fallback logic for path resolution.
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
    // If we are outside Electron or store loading failed.
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
        // Fallback for Node.js without the Electron app.
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
    // Backward compatibility for 'auto' -> 'list'.
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

// Reads the last timestamp written by the tray recorder process.
const getTrayHeartbeat = () => store.get('trayHeartbeat', 0);
// Stores the current tray recorder heartbeat timestamp.
const setTrayHeartbeat = (timestamp) => store.set('trayHeartbeat', timestamp);

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

const getAiSummaryModel = () => store.get('aiSummaryModel', 'gpt-4.1');
const setAiSummaryModel = (value) => store.set('aiSummaryModel', value || 'gpt-4.1');

// Keeps the AI summary prompt limit inside the usable context window.
const normalizeAiSummaryMaxPromptTokens = (value) => {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 60000;
    return Math.max(1000, Math.min(120000, parsed));
};

const getAiSummaryMaxPromptTokens = () => normalizeAiSummaryMaxPromptTokens(store.get('aiSummaryMaxPromptTokens', 60000));
const setAiSummaryMaxPromptTokens = (value) => store.set('aiSummaryMaxPromptTokens', normalizeAiSummaryMaxPromptTokens(value));

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

        // If the new config already exists and is not almost empty, keep it.
        if (fs.existsSync(newConfigFilePath)) {
            try {
                const stats = fs.statSync(newConfigFilePath);
                if (stats.size > 10) return;
            } catch (e) {}
        }

        const migrationSources = [
            { path: path.join(app.getPath('appData'), 'screen-recorder-viewer', 'screen-recorder-shared-config.json'), label: 'old viewer' },
            { path: path.join(app.getPath('appData'), 'screen-recorder-tray', 'screen-recorder-shared-config.json'), label: 'old tray' },
            { path: path.join(app.getPath('appData'), 'Screen Recorder', 'config.json'), label: 'default product' },
            { path: path.join(app.getPath('appData'), 'screen-recorder', 'config.json'), label: 'default name' }
        ];

        const validSources = migrationSources
            .filter(source => fs.existsSync(source.path))
            .map(source => ({ ...source, mtimeMs: fs.statSync(source.path).mtimeMs }))
            .sort((a, b) => a.mtimeMs - b.mtimeMs);

        const mergedConfig = {};
        const usedSources = [];

        validSources.forEach(source => {
            try {
                const content = JSON.parse(fs.readFileSync(source.path, 'utf8'));
                if (content && typeof content === 'object' && !Array.isArray(content)) {
                    Object.assign(mergedConfig, content);
                    usedSources.push(source.label);
                }
            } catch (e) {
                console.error(`Config migration source ${source.label} could not be read`, e);
            }
        });

        if (usedSources.length > 0) {
            if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
            fs.writeFileSync(newConfigFilePath, JSON.stringify(mergedConfig, null, '\t'), 'utf8');
            console.log(`Config migration successful from: ${usedSources.join(', ')}`);
        }
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
    getTrayHeartbeat,
    setTrayHeartbeat,
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
    getAiSummaryModel,
    setAiSummaryModel,
    getAiSummaryMaxPromptTokens,
    setAiSummaryMaxPromptTokens,
    getLanguage,
    setLanguage,
    getScreenshotFormat,
    setScreenshotFormat,
    getBaseDir
};

