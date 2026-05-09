const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getConfigDir, getBaseDir } = require('./config');
const i18n = require('./i18n');

let db;

/**
 * Makes paths in an object (files JSON) relative to the configured screenshot directory.
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
 * Makes paths in an object (files JSON) absolute based on the configured screenshot directory.
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

    // Logging for troubleshooting (visible in the Electron console).
    console.log(`Initializing database at: ${dbPath}`);

    // Ensure the folder exists.
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    // Migrate the DB from the Pictures directory if it is still there.
    const screenshotDir = getConfigDir();
    const oldDbPathInPictures = path.join(screenshotDir, 'screenRecorder', 'metadata.db');
    const oldDbPathInPicturesRoot = path.join(screenshotDir, 'metadata.db');

    [oldDbPathInPictures, oldDbPathInPicturesRoot].forEach(oldPath => {
        if (fs.existsSync(oldPath) && !fs.existsSync(dbPath)) {
            try {
                console.log(`Migrating database from ${oldPath} to ${dbPath}`);
                fs.copyFileSync(oldPath, dbPath);
                try {
                    // Delete the old file because it should now be in AppData.
                    fs.unlinkSync(oldPath);
                } catch (e) {
                    console.error(`Konnte alte DB unter ${oldPath} nicht löschen:`, e);
                }
            } catch (e) {
                console.error(`Fehler bei der DB-Migration von ${oldPath}:`, e);
            }
        }
    });

    // Migration from other possible AppData locations (tray/viewer), kept as a safety net.
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

    // Initialize settings/versioning.
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);

    // Create the base table if it does not exist yet (must happen before migrations).
    db.exec(`
        CREATE TABLE IF NOT EXISTS captures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT,          -- YYYY-MM-DD
            time TEXT,          -- HH-mm-ss
            timestamp INTEGER,   -- Unix timestamp for sorting
            titles TEXT,        -- Window titles (comma-separated or JSON)
            activeWindow TEXT,   -- Active window
            openFiles TEXT,      -- Open files (Explorer)
            urls TEXT,           -- Browser URLs
            calls TEXT,          -- Call information (3CX, Windows Phone API)
            ocrText TEXT,       -- Recognized text
            files JSON,         -- Paths to images { "0": "...", "1": "..." }
            UNIQUE(date, time)
        );
        CREATE INDEX IF NOT EXISTS idx_captures_date ON captures(date);
        CREATE INDEX IF NOT EXISTS idx_captures_timestamp ON captures(timestamp);
    `);

    // Get the current version.
    let currentVersion = 0;
    const versionRow = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
    if (versionRow) {
        currentVersion = parseInt(versionRow.value);
    } else {
        // Check which columns exist to infer the starting version.
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

    // Migration definitions.
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
                    // Update index.
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
                // Reset entries that only consist of headers without real text (length < 100 characters and header pattern).
                // This fixes the issue where path mismatches produced empty results.
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

                            // Check whether the file exists.
                            let absPath = path.isAbsolute(val) ? val : path.join(configDir, val);
                            
                            if (!fs.existsSync(absPath)) {
                                const basename = path.basename(val);
                                
                                // Extract YYYY/MM/DD/screenX.
                                const match = val.match(/(\d{4})[\\/](\d{2})[\\/](\d{2})[\\/](screen\d+)/);
                                if (match) {
                                    const [_, year, month, day, screen] = match;
                                    
                                    // Strategy 1: path with the 'screenRecorder' prefix.
                                    const expectedRelPath = path.join('screenRecorder', year, month, day, screen, basename);
                                    if (fs.existsSync(path.join(configDir, expectedRelPath))) {
                                        newFiles[key] = expectedRelPath;
                                        changed = true;
                                        return;
                                    }

                                    // Strategy 2: path without the 'screenRecorder' prefix.
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
        },
        {
            version: 9,
            description: "Add uiText column for UI-extracted text",
            run: (db) => {
                const tableInfo = db.prepare("PRAGMA table_info(captures)").all();
                if (!tableInfo.map(c => c.name).includes('uiText')) {
                    db.exec("ALTER TABLE captures ADD COLUMN uiText TEXT");
                    // Update index.
                    db.exec(`
                        DROP INDEX IF EXISTS idx_captures_search;
                        CREATE INDEX idx_captures_search ON captures(titles, activeWindow, ocrText, uiText, openFiles, urls, calls);
                    `);
                }
            }
        }
    ];

    // Apply migrations.
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

    // If the version is still 0, set it to the latest version.
    if (currentVersion === 0) {
        const latestVersion = migrations.length > 0 ? Math.max(...migrations.map(m => m.version)) : 0;
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)").run(latestVersion.toString());
    }

    return db;
}

function saveCapture(data) {
    const db = initDb();
    
    // Check which fields were provided to allow partial updates (for example OCR only).
    const hasTitles = data.titles !== undefined;
    const hasActiveWindow = data.activeWindow !== undefined;
    const hasOpenFiles = data.openFiles !== undefined;
    const hasUrls = data.urls !== undefined;
    const hasCalls = data.calls !== undefined;
    const hasOcrText = data.ocrText !== undefined && data.ocrText !== null;
    const hasUiText = data.uiText !== undefined && data.uiText !== null;
    const hasFiles = data.files !== undefined;

    const titles = hasTitles ? (Array.isArray(data.titles) ? JSON.stringify(data.titles) : data.titles) : '';
    const activeWindow = hasActiveWindow ? data.activeWindow : '';
    const openFiles = hasOpenFiles ? (Array.isArray(data.openFiles) ? JSON.stringify(data.openFiles) : data.openFiles) : '';
    const urls = hasUrls ? (Array.isArray(data.urls) ? JSON.stringify(data.urls) : data.urls) : '';
    const calls = hasCalls ? (Array.isArray(data.calls) ? JSON.stringify(data.calls) : data.calls) : '';
    const ocrText = hasOcrText ? data.ocrText : null;
    const uiText = hasUiText ? data.uiText : null;
    
    // Store paths as relative paths.
    let filesToSave = data.files || {};
    if (hasFiles) {
        filesToSave = makePathsRelative(filesToSave);
    }
    const filesJson = hasFiles ? JSON.stringify(filesToSave) : '{}';
    
    const timestamp = data.timestamp || Date.now();

    const sql = `
        INSERT OR IGNORE INTO captures (date, time, timestamp, titles, activeWindow, openFiles, urls, calls, ocrText, uiText, files)
        VALUES (@date, @time, @timestamp, @titles, @activeWindow, @openFiles, @urls, @calls, @ocrText, @uiText, @files)
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
        uiText: uiText,
        files: filesJson
    };

    const result = insert.run(bindParams);

    if (result.changes === 0) {
        // If it already exists, check whether an update is needed.
        const existingSql = 'SELECT titles, activeWindow, openFiles, urls, calls, ocrText, uiText, files FROM captures WHERE date = ? AND time = ?';
        const existing = db.prepare(existingSql).get(data.date, data.time);
        
        if (existing) {
            let needsUpdate = false;
            const updateParams = { ...bindParams };

            // Update only fields that are present in the data object and have changed.
            if (hasTitles && existing.titles !== titles) { needsUpdate = true; } else { updateParams.titles = existing.titles; }
            if (hasActiveWindow && existing.activeWindow !== activeWindow) { needsUpdate = true; } else { updateParams.activeWindow = existing.activeWindow; }
            if (hasOpenFiles && existing.openFiles !== openFiles) { needsUpdate = true; } else { updateParams.openFiles = existing.openFiles; }
            if (hasUrls && existing.urls !== urls) { needsUpdate = true; } else { updateParams.urls = existing.urls; }
            if (hasCalls && existing.calls !== calls) { needsUpdate = true; } else { updateParams.calls = existing.calls; }
            if (hasOcrText && existing.ocrText !== ocrText) { needsUpdate = true; } else { updateParams.ocrText = existing.ocrText; }
            if (hasUiText && existing.uiText !== uiText) { needsUpdate = true; } else { updateParams.uiText = existing.uiText; }
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
                        uiText = @uiText,
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
           OR uiText LIKE ?
           OR openFiles LIKE ?
           OR urls LIKE ?
           OR calls LIKE ?
        ORDER BY timestamp DESC
    `;
    console.log(`[SQL] ${sql}`);
    const search = db.prepare(sql);
    
    return search.all(sqlQuery, sqlQuery, sqlQuery, sqlQuery, sqlQuery, sqlQuery, sqlQuery).map(row => {
        const parsedFiles = JSON.parse(row.files || '{}');
        return {
            ...row,
            files: makePathsAbsolute(parsedFiles),
            // Mapping for viewer compatibility.
            meta: {
                titles: parseMetadata(row.titles),
                activeWindow: row.activeWindow,
                openFiles: parseMetadata(row.openFiles),
                urls: parseMetadata(row.urls),
                calls: parseMetadata(row.calls),
                ocrText: row.ocrText,
                uiText: row.uiText
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
                    ocrText: row.ocrText,
                    uiText: row.uiText
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
        console.log(`[SQL] ${sql} for date=${date}, time=${time}`);
        const stmt = db.prepare(sql);
        const row = stmt.get(date, time);
        if (row) {
            console.log(`[DB] Found capture for ${date} ${time} (ID: ${row.id})`);
            const parsedFiles = JSON.parse(row.files || '{}');
            row.files = makePathsAbsolute(parsedFiles);
            row.meta = {
                titles: parseMetadata(row.titles),
                activeWindow: row.activeWindow,
                openFiles: parseMetadata(row.openFiles),
                urls: parseMetadata(row.urls),
                calls: parseMetadata(row.calls),
                ocrText: row.ocrText,
                uiText: row.uiText
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
 * Gets a list of captures that do not have OCR yet.
 * @param {number} limit 
 * @returns {Array} List of captures with absolute paths.
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
 * Updates the OCR text of a capture.
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
        SELECT time, activeWindow, titles, openFiles, urls, calls, ocrText, uiText 
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
                const titles = parseMetadata(row.titles);
                const activeTitle = titles.find(t => t.includes(app)) || titles[0];
                summary += `   ${i18n.t('viewer.summary_parts.window')}: ${activeTitle}\n`;
            }
            lastApp = app;
        }

        // Add calls.
        if (row.calls && row.calls.length > 0) {
            const calls = parseMetadata(row.calls);
            calls.forEach(call => {
                summary += `   ${i18n.t('viewer.summary_parts.call')}: ${call}\n`;
            });
        }

        // Add URLs.
        if (row.urls && row.urls.length > 0) {
            const urls = parseMetadata(row.urls);
            urls.forEach(url => {
                summary += `   ${i18n.t('viewer.summary_parts.url')}: ${url}\n`;
            });
        }

        // Add open files (only when relevant for the timestamp).
        if (row.openFiles && row.openFiles.length > 0) {
            const files = parseMetadata(row.openFiles);
            files.forEach(file => {
                summary += `   ${i18n.t('viewer.summary_parts.file')}: ${file}\n`;
            });
        }
        
        // Add UI Text (UI Automation) - often cleaner than OCR.
        let cleanUiText = "";
        if (row.uiText && row.uiText.length > 20) {
            cleanUiText = row.uiText.substring(0, 300).replace(/\n/g, ' ').trim();
            if (cleanUiText.length > 0) {
                summary += `   ${i18n.t('viewer.summary_parts.ui_text')}: ${cleanUiText}...\n`;
            }
        }
        
        // Add OCR snippets when present and not too long, and not redundant with UI Text.
        if (row.ocrText && row.ocrText.length > 20) {
            const cleanOcr = row.ocrText.replace(/--- Display \d+ ---\n/g, '').substring(0, 200).replace(/\n/g, ' ').trim();
            
            // Basic redundancy check: if UI text already contains most of the OCR text, skip it.
            const isRedundant = cleanUiText && cleanOcr && (
                cleanUiText.includes(cleanOcr.substring(0, 50)) || 
                cleanOcr.includes(cleanUiText.substring(0, 50))
            );

            if (cleanOcr.length > 0 && !isRedundant) {
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
        urls: parseMetadata(row.urls),
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
        calls: parseMetadata(row.calls)
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
