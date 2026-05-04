const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getConfigDir, getBaseDir } = require('./config');
const i18n = require('./i18n');

let db;

/**
 * Macht Pfade in einem Objekt (Files JSON) relativ zum konfigurierten Screenshot-Verzeichnis.
 */
function parseMetadata(str) {
    if (!str) return [];
    if (typeof str !== 'string') return [];
    if (str.startsWith('[') && str.endsWith(']')) {
        try {
            return JSON.parse(str);
        } catch (e) {
            return str.split(' | ');
        }
    }
    return str.split(' | ');
}

function makePathsRelative(files) {
    if (!files) return {};
    const configDir = getConfigDir();
    const isArray = Array.isArray(files);
    const result = isArray ? [] : {};
    
    Object.keys(files).forEach(key => {
        const value = files[key];
        if (value && typeof value === 'string' && path.isAbsolute(value)) {
            result[key] = path.relative(configDir, value);
        } else {
            result[key] = value;
        }
    });
    return result;
}

/**
 * Macht Pfade in einem Objekt (Files JSON) absolut basierend auf dem konfigurierten Screenshot-Verzeichnis.
 */
function makePathsAbsolute(files) {
    if (!files) return {};
    const configDir = getConfigDir();
    const isArray = Array.isArray(files);
    const result = isArray ? [] : {};
    
    Object.keys(files).forEach(key => {
        const value = files[key];
        if (value && typeof value === 'string' && !path.isAbsolute(value)) {
            result[key] = path.join(configDir, value);
        } else {
            result[key] = value;
        }
    });
    return result;
}

function initDb() {
    if (db) return db;

    const appDataDir = getBaseDir();
    const dbPath = path.join(appDataDir, 'metadata.db');

    // Logging für Fehlersuche (wird in Electron-Konsole sichtbar)
    console.log(`Initializing database at: ${dbPath}`);

    // Sicherstellen, dass der Ordner existiert
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    // Migration der DB aus dem Bilder-Verzeichnis (falls sie noch dort liegt)
    const screenshotDir = getConfigDir();
    const oldDbPathInPictures = path.join(screenshotDir, 'screenRecorder', 'metadata.db');
    const oldDbPathInPicturesRoot = path.join(screenshotDir, 'metadata.db');

    [oldDbPathInPictures, oldDbPathInPicturesRoot].forEach(oldPath => {
        if (fs.existsSync(oldPath) && !fs.existsSync(dbPath)) {
            try {
                console.log(`Migrating database from ${oldPath} to ${dbPath}`);
                fs.copyFileSync(oldPath, dbPath);
                try {
                    // Wir löschen die alte Datei, da sie jetzt im AppData liegen soll
                    fs.unlinkSync(oldPath);
                } catch (e) {
                    console.error(`Konnte alte DB unter ${oldPath} nicht löschen:`, e);
                }
            } catch (e) {
                console.error(`Fehler bei der DB-Migration von ${oldPath}:`, e);
            }
        }
    });

    // Migration aus anderen möglichen AppData-Orten (tray/viewer) - zur Sicherheit behalten
    const otherDbPaths = [
        path.join(appDataDir, '..', 'screen-recorder-tray', 'metadata.db'),
        path.join(appDataDir, '..', 'screen-recorder-viewer', 'metadata.db')
    ];
    otherDbPaths.forEach(otherPath => {
        if (fs.existsSync(otherPath) && !fs.existsSync(dbPath)) {
            try {
                console.log(`Migrating database from ${otherPath} to ${dbPath}`);
                fs.copyFileSync(otherPath, dbPath);
                try {
                    fs.unlinkSync(otherPath);
                } catch (e) {}
            } catch (e) {}
        } else if (fs.existsSync(otherPath) && fs.existsSync(dbPath)) {
            try {
                fs.unlinkSync(otherPath);
            } catch (e) {}
        }
    });

    db = new Database(dbPath);

    // Initialisiere Einstellungen/Versionierung
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);

    // Basis-Tabelle erstellen falls sie noch nicht existiert (muss vor Migrationen geschehen!)
    db.exec(`
        CREATE TABLE IF NOT EXISTS captures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT,          -- YYYY-MM-DD
            time TEXT,          -- HH-mm-ss
            timestamp INTEGER,   -- Unix Timestamp für Sortierung
            titles TEXT,        -- Fenstertitel (kommagetrennt oder JSON)
            activeWindow TEXT,   -- Aktives Fenster
            openFiles TEXT,      -- Offene Dateien (Explorer)
            urls TEXT,           -- Browser URLs
            calls TEXT,          -- Anrufinformationen (3CX, Windows Phone API)
            ocrText TEXT,       -- Erkannter Text
            files JSON,         -- Pfade zu den Bildern { "0": "...", "1": "..." }
            UNIQUE(date, time)
        );
        CREATE INDEX IF NOT EXISTS idx_captures_date ON captures(date);
        CREATE INDEX IF NOT EXISTS idx_captures_timestamp ON captures(timestamp);
    `);

    // Aktuelle Version abrufen
    let currentVersion = 0;
    const versionRow = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
    if (versionRow) {
        currentVersion = parseInt(versionRow.value);
    } else {
        // Wir prüfen welche Spalten da sind um die Startversion zu raten
        const tableInfo = db.prepare("PRAGMA table_info(captures)").all();
        const columns = tableInfo.map(c => c.name);
        if (columns.includes('urls')) {
            currentVersion = 2; // Hat bereits openFiles und urls
        } else if (columns.includes('openFiles')) {
            currentVersion = 1; // Hat nur openFiles
        } else {
            currentVersion = 0; // Basis
        }
        db.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', ?)").run(currentVersion.toString());
    }

    // Definition der Migrationen
    const migrations = [
        {
            version: 1,
            description: "Add openFiles column",
            run: (db) => {
                const tableInfo = db.prepare("PRAGMA table_info(captures)").all();
                if (!tableInfo.map(c => c.name).includes('openFiles')) {
                    db.exec("ALTER TABLE captures ADD COLUMN openFiles TEXT");
                }
            }
        },
        {
            version: 2,
            description: "Add urls column",
            run: (db) => {
                const tableInfo = db.prepare("PRAGMA table_info(captures)").all();
                if (!tableInfo.map(c => c.name).includes('urls')) {
                    db.exec("ALTER TABLE captures ADD COLUMN urls TEXT");
                }
            }
        },
        {
            version: 3,
            description: "Ensure search index is up to date",
            run: (db) => {
                db.exec(`
                    DROP INDEX IF EXISTS idx_captures_search;
                    CREATE INDEX idx_captures_search ON captures(titles, activeWindow, ocrText, openFiles, urls);
                `);
            }
        },
        {
            version: 4,
            description: "Add calls column",
            run: (db) => {
                const tableInfo = db.prepare("PRAGMA table_info(captures)").all();
                if (!tableInfo.map(c => c.name).includes('calls')) {
                    db.exec("ALTER TABLE captures ADD COLUMN calls TEXT");
                    // Index aktualisieren
                    db.exec(`
                        DROP INDEX IF EXISTS idx_captures_search;
                        CREATE INDEX idx_captures_search ON captures(titles, activeWindow, ocrText, openFiles, urls, calls);
                    `);
                }
            }
        },
        {
            version: 5,
            description: "Reset empty OCR text to NULL for re-processing",
            run: (db) => {
                db.exec("UPDATE captures SET ocrText = NULL WHERE ocrText = ''");
            }
        },
        {
            version: 6,
            description: "Reset failed OCR headers from broken path matching",
            run: (db) => {
                // Setzt alle Einträge zurück, die nur aus Headern ohne echten Text bestehen (Länge < 100 Zeichen und Header-Pattern)
                // Das bereinigt den Fehler, bei dem Pfad-Mismatches zu leeren Ergebnissen führten
                db.exec("UPDATE captures SET ocrText = NULL WHERE length(ocrText) < 100 AND (ocrText LIKE '--- Screen %' OR ocrText LIKE '--- Display %')");
            }
        },
        {
            version: 7,
            description: "Convert absolute file paths to relative paths",
            run: (db) => {
                const configDir = getConfigDir();
                const rows = db.prepare("SELECT id, files FROM captures").all();
                const updateStmt = db.prepare("UPDATE captures SET files = ? WHERE id = ?");
                
                rows.forEach(row => {
                    try {
                        const files = JSON.parse(row.files);
                        let changed = false;
                        const isArray = Array.isArray(files);
                        const newFiles = isArray ? [] : {};

                        Object.keys(files).forEach(key => {
                            const value = files[key];
                            if (value && typeof value === 'string' && path.isAbsolute(value)) {
                                newFiles[key] = path.relative(configDir, value);
                                changed = true;
                            } else {
                                newFiles[key] = value;
                            }
                        });
                        
                        if (changed) {
                            updateStmt.run(JSON.stringify(newFiles), row.id);
                        }
                    } catch (e) {
                        console.error(`Failed to migrate paths for row ${row.id}:`, e);
                    }
                });
            }
        },
        {
            version: 8,
            description: "Repair broken file paths from previous migrations",
            run: (db) => {
                const configDir = getConfigDir();
                const rows = db.prepare("SELECT id, files FROM captures").all();
                const updateStmt = db.prepare("UPDATE captures SET files = ? WHERE id = ?");
                
                rows.forEach(row => {
                    try {
                        const files = JSON.parse(row.files || '{}');
                        let changed = false;
                        const newFiles = Array.isArray(files) ? [] : {};

                        Object.keys(files).forEach(key => {
                            const val = files[key];
                            if (!val || typeof val !== 'string') {
                                newFiles[key] = val;
                                return;
                            }

                            // Prüfe ob Datei existiert
                            let absPath = path.isAbsolute(val) ? val : path.join(configDir, val);
                            
                            if (!fs.existsSync(absPath)) {
                                const basename = path.basename(val);
                                
                                // Extrahiere YYYY/MM/DD/screenX
                                const match = val.match(/(\d{4})[\\/](\d{2})[\\/](\d{2})[\\/](screen\d+)/);
                                if (match) {
                                    const [_, year, month, day, screen] = match;
                                    
                                    // Strategie 1: Pfad mit 'screenRecorder' Präfix
                                    const expectedRelPath = path.join('screenRecorder', year, month, day, screen, basename);
                                    if (fs.existsSync(path.join(configDir, expectedRelPath))) {
                                        newFiles[key] = expectedRelPath;
                                        changed = true;
                                        return;
                                    }

                                    // Strategie 2: Pfad ohne 'screenRecorder' Präfix
                                    const expectedRelPath2 = path.join(year, month, day, screen, basename);
                                    if (fs.existsSync(path.join(configDir, expectedRelPath2))) {
                                        newFiles[key] = expectedRelPath2;
                                        changed = true;
                                        return;
                                    }
                                }
                            }
                            newFiles[key] = val;
                        });
                        
                        if (changed) {
                            updateStmt.run(JSON.stringify(newFiles), row.id);
                        }
                    } catch (e) {
                        console.error(`Failed to repair paths for row ${row.id}:`, e);
                    }
                });
            }
        }
    ];

    // Migrationen anwenden
    migrations.sort((a, b) => a.version - b.version).forEach(m => {
        if (m.version > currentVersion) {
            console.log(`Applying migration v${m.version}: ${m.description}`);
            try {
                db.transaction(() => {
                    m.run(db);
                    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)").run(m.version.toString());
                })();
                currentVersion = m.version;
            } catch (e) {
                console.error(`Migration v${m.version} failed:`, e);
                throw e; // Abbrechen bei Fehler
            }
        }
    });

    // Falls die Version noch 0 ist, auf aktuellste Version setzen
    if (currentVersion === 0) {
        const latestVersion = migrations.length > 0 ? Math.max(...migrations.map(m => m.version)) : 0;
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)").run(latestVersion.toString());
    }

    return db;
}

function saveCapture(data) {
    const db = initDb();
    
    // Wir prüfen welche Felder übergeben wurden, um Teil-Updates (z.B. nur OCR) zu ermöglichen
    const hasTitles = data.titles !== undefined;
    const hasActiveWindow = data.activeWindow !== undefined;
    const hasOpenFiles = data.openFiles !== undefined;
    const hasUrls = data.urls !== undefined;
    const hasCalls = data.calls !== undefined;
    const hasOcrText = data.ocrText !== undefined && data.ocrText !== null;
    const hasFiles = data.files !== undefined;

    const titles = hasTitles ? (Array.isArray(data.titles) ? data.titles.join(' | ') : data.titles) : '';
    const activeWindow = hasActiveWindow ? data.activeWindow : '';
    const openFiles = hasOpenFiles ? (Array.isArray(data.openFiles) ? data.openFiles.join(' | ') : data.openFiles) : '';
    const urls = hasUrls ? (Array.isArray(data.urls) ? data.urls.join(' | ') : data.urls) : '';
    const calls = hasCalls ? (Array.isArray(data.calls) ? data.calls.join(' | ') : data.calls) : '';
    const ocrText = hasOcrText ? data.ocrText : null;
    
    // Pfade relativ speichern
    let filesToSave = data.files || {};
    if (hasFiles) {
        filesToSave = makePathsRelative(filesToSave);
    }
    const filesJson = hasFiles ? JSON.stringify(filesToSave) : '{}';
    
    const timestamp = data.timestamp || Date.now();

    const sql = `
        INSERT OR IGNORE INTO captures (date, time, timestamp, titles, activeWindow, openFiles, urls, calls, ocrText, files)
        VALUES (@date, @time, @timestamp, @titles, @activeWindow, @openFiles, @urls, @calls, @ocrText, @files)
    `;
    console.log(`[SQL] ${sql}`);
    const insert = db.prepare(sql);

    const bindParams = {
        date: data.date,
        time: data.time,
        timestamp: timestamp,
        titles: titles,
        activeWindow: activeWindow,
        openFiles: openFiles,
        urls: urls,
        calls: calls,
        ocrText: ocrText,
        files: filesJson
    };

    const result = insert.run(bindParams);

    if (result.changes === 0) {
        // Falls bereits existiert, prüfen ob Update nötig
        const existingSql = 'SELECT titles, activeWindow, openFiles, urls, calls, ocrText, files FROM captures WHERE date = ? AND time = ?';
        const existing = db.prepare(existingSql).get(data.date, data.time);
        
        if (existing) {
            let needsUpdate = false;
            const updateParams = { ...bindParams };

            // Nur Felder updaten, die im data-Objekt enthalten sind UND sich geändert haben
            if (hasTitles && existing.titles !== titles) { needsUpdate = true; } else { updateParams.titles = existing.titles; }
            if (hasActiveWindow && existing.activeWindow !== activeWindow) { needsUpdate = true; } else { updateParams.activeWindow = existing.activeWindow; }
            if (hasOpenFiles && existing.openFiles !== openFiles) { needsUpdate = true; } else { updateParams.openFiles = existing.openFiles; }
            if (hasUrls && existing.urls !== urls) { needsUpdate = true; } else { updateParams.urls = existing.urls; }
            if (hasCalls && existing.calls !== calls) { needsUpdate = true; } else { updateParams.calls = existing.calls; }
            if (hasOcrText && existing.ocrText !== ocrText) { needsUpdate = true; } else { updateParams.ocrText = existing.ocrText; }
            if (hasFiles && existing.files !== filesJson) { needsUpdate = true; } else { updateParams.files = existing.files; }

            if (needsUpdate) {
                const updateSql = `
                    UPDATE captures 
                    SET titles = @titles, 
                        activeWindow = @activeWindow, 
                        openFiles = @openFiles,
                        urls = @urls,
                        calls = @calls,
                        ocrText = @ocrText, 
                        files = @files,
                        timestamp = @timestamp
                    WHERE date = @date AND time = @time
                `;
                console.log(`[SQL] ${updateSql}`);
                const update = db.prepare(updateSql);
                return update.run(updateParams);
            } else {
                return { changes: 0, reason: 'No change detected or no update required' };
            }
        }
    }
    return result;
}

function saveCapturesBatch(dataArray) {
    const db = initDb();
    const batch = db.transaction((items) => {
        let totalChanges = 0;
        for (const item of items) {
            const result = saveCapture(item);
            if (result.changes) totalChanges += result.changes;
        }
        return totalChanges;
    });
    return { changes: batch(dataArray) };
}

function searchCaptures(query) {
    const db = initDb();
    const sqlQuery = `%${query}%`;
    const sql = `
        SELECT * FROM captures 
        WHERE titles LIKE ? 
           OR activeWindow LIKE ? 
           OR ocrText LIKE ?
           OR openFiles LIKE ?
           OR urls LIKE ?
           OR calls LIKE ?
        ORDER BY timestamp DESC
    `;
    console.log(`[SQL] ${sql}`);
    const search = db.prepare(sql);
    
    return search.all(sqlQuery, sqlQuery, sqlQuery, sqlQuery, sqlQuery, sqlQuery).map(row => {
        const parsedFiles = JSON.parse(row.files || '{}');
        return {
            ...row,
            files: makePathsAbsolute(parsedFiles),
            // Mapping für Viewer Kompatibilität
            meta: {
                titles: parseMetadata(row.titles),
                activeWindow: row.activeWindow,
                openFiles: parseMetadata(row.openFiles),
                urls: parseMetadata(row.urls),
                calls: parseMetadata(row.calls),
                ocrText: row.ocrText
            }
        };
    });
}

function getAllCaptures() {
    const db = initDb();
    const sql = 'SELECT id, files FROM captures';
    console.log(`[SQL] ${sql}`);
    const stmt = db.prepare(sql);
    return stmt.all().map(row => {
        const parsedFiles = JSON.parse(row.files || '{}');
        return {
            id: row.id,
            files: makePathsAbsolute(parsedFiles)
        };
    });
}

function getRandomCaptures(limit = 100) {
    try {
        const db = initDb();
        const sql = 'SELECT id, files FROM captures ORDER BY RANDOM() LIMIT ?';
        console.log(`[SQL] ${sql} (${limit})`);
        const stmt = db.prepare(sql);
        return stmt.all(limit).map(row => {
            const parsedFiles = JSON.parse(row.files || '{}');
            return {
                id: row.id,
                files: makePathsAbsolute(parsedFiles)
            };
        });
    } catch (e) {
        console.error("Error in getRandomCaptures:", e);
        return [];
    }
}

function deleteCapture(id) {
    const db = initDb();
    const sql = 'DELETE FROM captures WHERE id = ?';
    console.log(`[SQL] ${sql}`);
    const stmt = db.prepare(sql);
    return stmt.run(id);
}

function getDayCaptures(date) {
    try {
        const db = initDb();
        const sql = 'SELECT * FROM captures WHERE date = ?';
        console.log(`[SQL] ${sql}`);
        const stmt = db.prepare(sql);
        const rows = stmt.all(date);
        return rows.map(row => {
            const parsedFiles = JSON.parse(row.files || '{}');
            
            return {
                ...row,
                files: makePathsAbsolute(parsedFiles),
                meta: {
                    titles: parseMetadata(row.titles),
                    activeWindow: row.activeWindow,
                    openFiles: parseMetadata(row.openFiles),
                    urls: parseMetadata(row.urls),
                    calls: parseMetadata(row.calls),
                    ocrText: row.ocrText
                }
            };
        });
    } catch (e) {
        console.error(`Error in getDayCaptures for ${date}:`, e);
        return [];
    }
}

function getCaptureByDateTime(date, time) {
    try {
        const db = initDb();
        const sql = 'SELECT * FROM captures WHERE date = ? AND time = ?';
        console.log(`[SQL] ${sql}`);
        const stmt = db.prepare(sql);
        const row = stmt.get(date, time);
        if (row) {
            const parsedFiles = JSON.parse(row.files || '{}');
            row.files = makePathsAbsolute(parsedFiles);
            row.meta = {
                titles: parseMetadata(row.titles),
                activeWindow: row.activeWindow,
                openFiles: parseMetadata(row.openFiles),
                urls: parseMetadata(row.urls),
                calls: parseMetadata(row.calls),
                ocrText: row.ocrText
            };
        }
        return row;
    } catch (e) {
        console.error(`Error in getCaptureByDateTime for ${date} ${time}:`, e);
        return null;
    }
}

function getPendingOcrCount() {
    try {
        const db = initDb();
        const sql = "SELECT COUNT(*) as count FROM captures WHERE (ocrText IS NULL OR ocrText = 'OCR processing...')";
        console.log(`[SQL] ${sql}`);
        const stmt = db.prepare(sql);
        const row = stmt.get();
        return row ? row.count : 0;
    } catch (e) {
        console.error("Error in getPendingOcrCount:", e);
        return 0;
    }
}

function getOcrStats() {
    try {
        const db = initDb();
        const pendingCount = db.prepare("SELECT COUNT(*) as count FROM captures WHERE (ocrText IS NULL OR ocrText = 'OCR processing...')").get().count;
        const processedCount = db.prepare("SELECT COUNT(*) as count FROM captures WHERE ocrText IS NOT NULL AND ocrText != 'OCR processing...'").get().count;
        const total = pendingCount + processedCount;
        
        return {
            pending: pendingCount,
            processed: processedCount,
            total: total,
            pendingPercent: total > 0 ? Math.round((pendingCount / total) * 100) : 0,
            processedPercent: total > 0 ? Math.round((processedCount / total) * 100) : 0
        };
    } catch (e) {
        console.error("Error in getOcrStats:", e);
        return { pending: 0, processed: 0, total: 0, pendingPercent: 0, processedPercent: 0 };
    }
}

function countCaptureFiles(files) {
    if (!files) return 1;
    try {
        const parsed = typeof files === 'string' ? JSON.parse(files) : files;
        const count = Object.values(parsed || {}).filter(Boolean).length;
        return count > 0 ? count : 1;
    } catch (e) {
        return 1;
    }
}

function getOcrImageStats() {
    try {
        const db = initDb();
        const rows = db.prepare("SELECT files, ocrText FROM captures").all();
        let pendingCount = 0;
        let processedCount = 0;

        rows.forEach(row => {
            const imageCount = countCaptureFiles(row.files);
            if (row.ocrText === null || row.ocrText === 'OCR processing...') {
                pendingCount += imageCount;
            } else {
                processedCount += imageCount;
            }
        });

        const total = pendingCount + processedCount;
        return {
            pending: pendingCount,
            processed: processedCount,
            total: total,
            pendingPercent: total > 0 ? Math.round((pendingCount / total) * 100) : 0,
            processedPercent: total > 0 ? Math.round((processedCount / total) * 100) : 0
        };
    } catch (e) {
        console.error("Error in getOcrImageStats:", e);
        return { pending: 0, processed: 0, total: 0, pendingPercent: 0, processedPercent: 0 };
    }
}

function getRandomOcrCaptures(limit = 10, processed = true) {
    try {
        const db = initDb();
        const condition = processed ? "ocrText IS NOT NULL" : "ocrText IS NULL";
        const sql = `SELECT id, files FROM captures WHERE ${condition} ORDER BY RANDOM() LIMIT ?`;
        console.log(`[SQL] ${sql} (${limit})`);
        const stmt = db.prepare(sql);
        return stmt.all(limit).map(row => {
            const parsedFiles = JSON.parse(row.files || '{}');
            return {
                id: row.id,
                files: makePathsAbsolute(parsedFiles)
            };
        });
    } catch (e) {
        console.error("Error in getRandomOcrCaptures:", e);
        return [];
    }
}

/**
 * Holt eine Liste von Captures, die noch kein OCR haben.
 * @param {number} limit 
 * @returns {Array} Liste der Captures mit absoluten Pfaden
 */
function getPendingOcrCaptures(limit = 100) {
    try {
        const db = initDb();
        const sql = "SELECT * FROM captures WHERE (ocrText IS NULL OR ocrText = 'OCR processing...') ORDER BY timestamp DESC LIMIT ?";
        console.log(`[SQL] ${sql} (${limit})`);
        const stmt = db.prepare(sql);
        const rows = stmt.all(limit);
        
        return rows.map(row => {
            if (row.files) {
                try {
                    const filesObj = JSON.parse(row.files);
                    row.files = makePathsAbsolute(filesObj);
                } catch (e) {
                    row.files = {};
                }
            }
            return row;
        });
    } catch (e) {
        console.error("Error in getPendingOcrCaptures:", e);
        return [];
    }
}

/**
 * Aktualisiert den OCR-Text eines Captures.
 */
function updateOcrText(id, ocrText) {
    try {
        const db = initDb();
        const sql = "UPDATE captures SET ocrText = ? WHERE id = ?";
        const stmt = db.prepare(sql);
        stmt.run(ocrText, id);
        return true;
    } catch (e) {
        console.error(`Error updating OCR text for ID ${id}:`, e);
        return false;
    }
}

function resetOcrStatus() {
    try {
        const db = initDb();
        const sql = "UPDATE captures SET ocrText = NULL WHERE ocrText = 'OCR processing...'";
        db.prepare(sql).run();
        return true;
    } catch (e) {
        console.error("Error resetting OCR status:", e);
        return false;
    }
}

function getDaySummary(date, lang = null) {
    if (lang) {
        i18n.init(lang);
    }
    const db = initDb();
    const sql = `
        SELECT time, activeWindow, titles, openFiles, urls, calls, ocrText 
        FROM captures 
        WHERE date = ? 
        ORDER BY timestamp ASC
    `;
    console.log(`[SQL] ${sql}`);
    const stmt = db.prepare(sql);
    
    const rows = stmt.all(date);
    if (rows.length === 0) return i18n.t('viewer.summary_parts.no_data');

    let summary = i18n.t('viewer.summary_parts.title', { date }) + '\n';
    summary += `==========================================\n`;
    summary += i18n.t('viewer.summary_parts.prompt_intro') + '\n';
    summary += i18n.t('viewer.summary_parts.prompt_text') + '\n\n';

    let lastApp = "";
    let lastTime = "";
    let startTime = "";

    rows.forEach((row, index) => {
        const app = row.activeWindow || i18n.t('viewer.summary_parts.unknown');
        const time = row.time.replace(/-/g, ':');
        
        if (index === 0) startTime = time;

        if (app !== lastApp) {
            if (lastApp !== "") {
                summary += `   (${i18n.t('viewer.summary_parts.until')} ${time})\n`;
            }
            summary += `[${time}] ${i18n.t('viewer.summary_parts.fokus')}: ${app}\n`;
            if (row.titles && row.titles.length > 0) {
                const titles = row.titles.split(' | ');
                const activeTitle = titles.find(t => t.includes(app)) || titles[0];
                summary += `   ${i18n.t('viewer.summary_parts.window')}: ${activeTitle}\n`;
            }
            lastApp = app;
        }

        // Anrufe hinzufügen
        if (row.calls && row.calls.length > 0) {
            const calls = row.calls.split(' | ');
            calls.forEach(call => {
                summary += `   ${i18n.t('viewer.summary_parts.call')}: ${call}\n`;
            });
        }

        // URLs hinzufügen
        if (row.urls && row.urls.length > 0) {
            const urls = row.urls.split(' | ');
            urls.forEach(url => {
                summary += `   ${i18n.t('viewer.summary_parts.url')}: ${url}\n`;
            });
        }

        // Offene Dateien hinzufügen (nur wenn relevant für den Zeitstempel)
        if (row.openFiles && row.openFiles.length > 0) {
            const files = row.openFiles.split(' | ');
            files.forEach(file => {
                summary += `   ${i18n.t('viewer.summary_parts.file')}: ${file}\n`;
            });
        }
        
        // OCR Snippets hinzufügen, falls vorhanden und nicht zu lang
        if (row.ocrText && row.ocrText.length > 20) {
            const cleanOcr = row.ocrText.replace(/--- Display \d+ ---\n/g, '').substring(0, 200).replace(/\n/g, ' ');
            if (cleanOcr.trim().length > 0) {
                summary += `   ${i18n.t('viewer.summary_parts.ocr')}: ${cleanOcr}...\n`;
            }
        }
    });

    return summary;
}

function getDayUrls(date) {
    const db = initDb();
    const sql = `
        SELECT time, urls, activeWindow 
        FROM captures 
        WHERE date = ? AND urls IS NOT NULL AND urls != ''
        ORDER BY timestamp ASC
    `;
    console.log(`[SQL] ${sql}`);
    const stmt = db.prepare(sql);
    
    const rows = stmt.all(date);
    return rows.map(row => ({
        time: row.time.replace(/-/g, ':'),
        urls: row.urls ? row.urls.split(' | ') : [],
        activeWindow: row.activeWindow
    }));
}

function getDayCalls(date) {
    const db = initDb();
    const sql = `
        SELECT time, calls 
        FROM captures 
        WHERE date = ? AND calls IS NOT NULL AND calls != ''
        ORDER BY timestamp ASC
    `;
    console.log(`[SQL] ${sql}`);
    const stmt = db.prepare(sql);
    
    const rows = stmt.all(date);
    return rows.map(row => ({
        time: row.time.replace(/-/g, ':'),
        calls: row.calls ? row.calls.split(' | ') : []
    }));
}

module.exports = { 
    initDb, 
    makePathsAbsolute,
    makePathsRelative,
    saveCapture, 
    saveCapturesBatch,
    searchCaptures, 
    getAllCaptures, 
    getRandomCaptures,
    deleteCapture, 
    getCaptureByDateTime, 
    getPendingOcrCount,
    getOcrStats,
    getOcrImageStats,
    getRandomOcrCaptures,
    getPendingOcrCaptures,
    updateOcrText,
    resetOcrStatus,
    getDaySummary,
    getDayUrls,
    getDayCalls,
    getDayCaptures
};
