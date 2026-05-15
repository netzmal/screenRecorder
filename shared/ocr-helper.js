const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function quotePowerShellString(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function isOcrErrorText(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    return trimmed.startsWith('Error:') || trimmed.startsWith('OCR Error:');
}

function normalizeOcrError(text) {
    const trimmed = String(text || '').trim();
    return trimmed.startsWith('Error:') ? trimmed : `Error: ${trimmed}`;
}

function normalizePathKey(filePath) {
    return path.normalize(filePath).toLowerCase();
}

function markPathsAsError(paths, message, results, batchResults = null) {
    const errorText = normalizeOcrError(message);
    paths.forEach(filePath => {
        const key = normalizePathKey(filePath);
        if (results[key] !== undefined) return;
        results[key] = errorText;
        if (batchResults) batchResults[key] = errorText;
    });
}

/**
 * Runs Windows native OCR through PowerShell.
 * @param {string[]} imagePaths
 * @param {string} scriptPath Path to win-ocr.ps1
 * @param {function} onProgress Optional progress callback
 * @returns {Promise<Object>} Map from normalized path to text or Error:...
 */
async function runWindowsOcrBatch(imagePaths, scriptPath, onProgress = null) {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve({});
            return;
        }

        const results = {};
        const batchSize = 20;
        let processedCount = 0;

        const processNextBatch = async () => {
            if (processedCount >= imagePaths.length) {
                resolve(results);
                return;
            }

            const currentBatch = imagePaths.slice(processedCount, processedCount + batchSize);
            const validPaths = currentBatch.filter(p => fs.existsSync(p));
            const missingPaths = currentBatch.filter(p => !fs.existsSync(p));

            if (onProgress) {
                onProgress({
                    current: processedCount,
                    total: imagePaths.length,
                    batchSize: currentBatch.length,
                    validCount: validPaths.length,
                    paths: currentBatch
                });
            }

            if (validPaths.length === 0) {
                markPathsAsError(missingPaths, 'File not found', results);
                processedCount += batchSize;
                processNextBatch();
                return;
            }

            const listFile = path.join(os.tmpdir(), `ocr-paths-${crypto.randomBytes(4).toString('hex')}.txt`);
            try {
                fs.writeFileSync(listFile, validPaths.join('\r\n'), 'utf8');
                
                const command = `PowerShell -NoProfile -ExecutionPolicy Bypass -Command "& ${quotePowerShellString(scriptPath)} -listFile ${quotePowerShellString(listFile)}"`;

                const batchTimeoutMs = Math.max(120000, currentBatch.length * 15000);
                exec(command, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: batchTimeoutMs }, (error, stdout, stderr) => {
                    // Cleanup temp file.
                    try { 
                        if (fs.existsSync(listFile)) {
                            fs.unlinkSync(listFile); 
                        }
                    } catch (e) {
                        console.warn('Failed to cleanup OCR list file:', e);
                    }

                    if (error) {
                        console.error('Windows OCR Batch Error:', error);
                        if (stderr) console.error('Windows OCR Stderr:', stderr);
                    }

                    const batchResults = {};
                    markPathsAsError(missingPaths, 'File not found', results, batchResults);
                    if (stdout) {
                        const sections = stdout.split('---START---');
                        sections.forEach(section => {
                            if (section.includes('---END---')) {
                                const pathMatch = section.match(/PATH:(.*)/);
                                const textMatch = section.match(/TEXT:([\s\S]*?)---END---/);
                                const errorMatch = section.match(/ERROR:(.*)/);

                                if (pathMatch) {
                                    const p = normalizePathKey(pathMatch[1].trim());
                                    if (textMatch) {
                                        const text = textMatch[1].trim();
                                        const value = isOcrErrorText(text) ? normalizeOcrError(text) : text;
                                        results[p] = value;
                                        batchResults[p] = value;
                                    } else if (errorMatch) {
                                        const err = `Error: ${errorMatch[1].trim()}`;
                                        results[p] = err;
                                        batchResults[p] = err;
                                        console.warn(`OCR Error for ${p}:`, errorMatch[1].trim());
                                    }
                                }
                            }
                        });
                    }

                    if (error) {
                        const message = stderr || error.message || 'Windows OCR failed';
                        markPathsAsError(validPaths, message, results, batchResults);
                    }

                    processedCount += batchSize;

                    if (onProgress) {
                        onProgress({
                            current: processedCount,
                            total: imagePaths.length,
                            batchSize: currentBatch.length,
                            validCount: validPaths.length,
                            paths: currentBatch,
                            results: batchResults
                        });
                    }

                    processNextBatch();
                });
            } catch (err) {
                console.error('Failed to create OCR list file or execute PowerShell:', err);
                try { 
                    if (fs.existsSync(listFile)) {
                        fs.unlinkSync(listFile); 
                    }
                } catch (e) {}
                markPathsAsError(validPaths, err.message || 'Windows OCR could not be started', results);
                markPathsAsError(missingPaths, 'File not found', results);
                processedCount += batchSize;
                processNextBatch();
            }
        };

        processNextBatch();
    });
}

module.exports = {
    runWindowsOcrBatch,
    isOcrErrorText
};
