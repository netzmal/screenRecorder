const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let currentLocale = 'en';
let translations = {};

/**
 * Initializes i18n.
 * @param {string} forcedLocale - Optional language override.
 */
function init(forcedLocale = null) {
  // Determine language: forced > app.getLocale() > 'en'.
  let locale = forcedLocale;
  
  if (!locale) {
    try {
      // Electron app.getLocale() returns the system language.
      // In the renderer process, check whether app is available.
      const electron = require('electron');
      let appObj = electron.app;
      
      // Fallback for the renderer process (remote is deprecated, but may still exist).
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

  if (locale === currentLocale && Object.keys(translations).length > 0) {
    return;
  }

  currentLocale = locale;
  loadTranslations(locale);
}

/**
 * Loads the translation file.
 */
function loadTranslations(locale) {
  try {
    const localePath = path.join(__dirname, 'locales', `${locale}.json`);
    if (fs.existsSync(localePath)) {
      const content = fs.readFileSync(localePath, 'utf8');
      translations = JSON.parse(content);
    } else {
      console.error(`Translation file not found: ${localePath}`);
      // Fall back to English if that has not already happened.
      if (locale !== 'en') {
        loadTranslations('en');
      }
    }
  } catch (e) {
    console.error('Error loading translations:', e);
  }
}

/**
 * Gets a translation from a path (for example 'viewer.tabs.titles').
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
      return keyPath; // Fallback: return the key path itself.
    }
  }

  if (typeof result !== 'string') return keyPath;

  // Replace placeholders {key}.
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
