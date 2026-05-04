const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let currentLocale = 'en';
let translations = {};

/**
 * Initialisiert i18n
 * @param {string} forcedLocale - Optionaler Override der Sprache
 */
function init(forcedLocale = null) {
  // Bestimme Sprache: forced > app.getLocale() > 'en'
  let locale = forcedLocale;
  
  if (!locale) {
    try {
      // Electron app.getLocale() gibt Systemsprache zurück
      // Im Renderer-Prozess müssen wir prüfen, ob app verfügbar ist
      const electron = require('electron');
      let appObj = electron.app;
      
      // Fallback für Renderer-Prozess (remote ist veraltet, aber falls vorhanden)
      if (!appObj && electron.remote) {
        try {
          appObj = electron.remote.app;
        } catch (remoteErr) {
          // remote module not enabled or not accessible
        }
      }
      
      let systemLocale = 'en';
      if (appObj) {
        systemLocale = appObj.getLocale().split('-')[0];
      }
      
      if (['en', 'de'].includes(systemLocale)) {
        locale = systemLocale;
      } else {
        locale = 'en';
      }
    } catch (e) {
      locale = 'en';
    }
  }

  currentLocale = locale;
  loadTranslations(locale);
}

/**
 * Lädt die Übersetzungsdatei
 */
function loadTranslations(locale) {
  try {
    const localePath = path.join(__dirname, 'locales', `${locale}.json`);
    if (fs.existsSync(localePath)) {
      const content = fs.readFileSync(localePath, 'utf8');
      translations = JSON.parse(content);
    } else {
      console.error(`Translation file not found: ${localePath}`);
      // Fallback auf Englisch, falls nicht bereits geschehen
      if (locale !== 'en') {
        loadTranslations('en');
      }
    }
  } catch (e) {
    console.error('Error loading translations:', e);
  }
}

/**
 * Holt eine Übersetzung anhand eines Pfads (z.B. 'viewer.tabs.titles')
 * @param {string} keyPath 
 * @param {Object} data - Platzhalter-Daten (z.B. {count: 5})
 */
function t(keyPath, data = {}) {
  const keys = keyPath.split('.');
  let result = translations;

  for (const key of keys) {
    if (result && result[key]) {
      result = result[key];
    } else {
      return keyPath; // Fallback: Key-Pfad selbst zurückgeben
    }
  }

  if (typeof result !== 'string') return keyPath;

  // Platzhalter ersetzen {key}
  let translated = result;
  for (const [key, value] of Object.entries(data)) {
    translated = translated.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }

  return translated;
}

function getLocale() {
  return currentLocale;
}

module.exports = {
  init,
  t,
  getLocale
};
