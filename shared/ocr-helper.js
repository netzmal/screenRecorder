const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

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
                processedCount += batchSize;
                processNextBatch();
                return;
            }

            const pathsArg = validPaths.map(quotePowerShellString).join(',');
            const command = `PowerShell -NoProfile -ExecutionPolicy Bypass -Command "& ${quotePowerShellString(scriptPath)} -imagePaths ${pathsArg}"`;

            const batchTimeoutMs = Math.max(120000, currentBatch.length * 15000);
            exec(command, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: batchTimeoutMs }, (error, stdout, stderr) => {
                if (error) {
                    console.error('Windows OCR Batch Error:', error);
                    if (stderr) console.error('Windows OCR Stderr:', stderr);
                }

                const batchResults = {};
                if (stdout) {
                    const sections = stdout.split('---START---');
                    sections.forEach(section => {
                        if (section.includes('---END---')) {
                            const pathMatch = section.match(/PATH:(.*)/);
                            const textMatch = section.match(/TEXT:([\s\S]*?)---END---/);
                            const errorMatch = section.match(/ERROR:(.*)/);

                            if (pathMatch) {
                                const p = path.normalize(pathMatch[1].trim()).toLowerCase();
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
        };

        processNextBatch();
    });
}

module.exports = {
    runWindowsOcrBatch,
    isOcrErrorText
};
