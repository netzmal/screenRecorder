// Manages one persistent PowerShell worker process for tray metadata calls.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 12000;
const METADATA_TIMEOUT_MS = 30000;

// Creates the persistent PowerShell service used by the tray recorder.
function createPowerShellService(options) {
    const workerScriptPath = options.workerScriptPath;
    const logDebug = options.logDebug || (() => {});
    const queue = [];

    let workerProcess = null;
    let activeRequest = null;
    let nextRequestId = 1;
    let stdoutBuffer = '';
    let tempWorkerPath = null;
    let isStopping = false;

    // Copies the worker script to a real temporary file so packaged asar builds work.
    function prepareWorkerScript() {
        cleanupStaleWorkerScripts();

        const script = fs.readFileSync(workerScriptPath, 'utf8');
        const targetPath = path.join(os.tmpdir(), `screen-recorder-powershell-worker-${process.pid}.ps1`);
        fs.writeFileSync(targetPath, script, 'utf8');
        tempWorkerPath = targetPath;
        return targetPath;
    }

    // Removes worker scripts left by previous runs when Windows no longer locks them.
    function cleanupStaleWorkerScripts() {
        try {
            const tempDir = os.tmpdir();
            const staleBeforeMs = Date.now() - 60 * 60 * 1000;
            fs.readdirSync(tempDir)
                .filter(fileName => /^screen-recorder-powershell-worker-\d+\.ps1$/i.test(fileName))
                .forEach(fileName => {
                    try {
                        const filePath = path.join(tempDir, fileName);
                        if (fs.statSync(filePath).mtimeMs < staleBeforeMs) {
                            fs.unlinkSync(filePath);
                        }
                    } catch {}
                });
        } catch {}
    }

    // Starts the worker process when there is no healthy process available.
    function ensureProcess() {
        if (workerProcess && !workerProcess.killed) {
            return workerProcess;
        }

        isStopping = false;
        stdoutBuffer = '';

        const runnableScriptPath = prepareWorkerScript();
        const processRef = spawn('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            runnableScriptPath
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        workerProcess = processRef;

        processRef.stdout.on('data', chunk => handleStdout(processRef, chunk));
        processRef.stderr.on('data', chunk => handleStderr(processRef, chunk));
        processRef.on('error', err => handleProcessError(processRef, err));
        processRef.on('close', code => handleProcessClose(processRef, code));

        logDebug('Started persistent PowerShell worker.');
        return processRef;
    }

    // Sends the next queued request to the worker.
    function processQueue() {
        if (activeRequest || queue.length === 0 || isStopping) {
            return;
        }
        if (workerProcess && workerProcess.killed) {
            return;
        }

        const request = queue.shift();
        activeRequest = request;

        let processRef;
        try {
            processRef = ensureProcess();
            const payload = JSON.stringify({
                id: request.id,
                command: request.command,
                params: request.params || {}
            });

            request.timeout = setTimeout(() => {
                const message = `PowerShell worker timed out while running ${request.command}.`;
                logDebug(message);
                rejectActiveRequest(new Error(message));
                restartProcess();
            }, request.timeoutMs);

            processRef.stdin.write(`${payload}\n`, 'utf8');
        } catch (err) {
            rejectActiveRequest(err);
            restartProcess();
        }
    }

    // Buffers stdout chunks and dispatches complete JSON response lines.
    function handleStdout(processRef, chunk) {
        if (processRef !== workerProcess) {
            return;
        }

        stdoutBuffer += chunk.toString('utf8');

        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex !== -1) {
            const line = stdoutBuffer.slice(0, newlineIndex).trim();
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            if (line) {
                handleResponseLine(line);
            }
            newlineIndex = stdoutBuffer.indexOf('\n');
        }
    }

    // Logs relevant stderr output from the worker.
    function handleStderr(processRef, chunk) {
        if (processRef !== workerProcess) {
            return;
        }

        const message = chunk.toString('utf8').trim();
        if (!message || message.includes('<Objs') || message.includes('#< CLIXML')) {
            return;
        }

        logDebug(`PowerShell worker stderr: ${message}`);
    }

    // Resolves or rejects the active request from one worker response line.
    function handleResponseLine(line) {
        let response;
        try {
            response = JSON.parse(line);
        } catch (err) {
            logDebug(`Invalid PowerShell worker response: ${line}`);
            return;
        }

        if (!activeRequest) {
            if (!isStopping) {
                logDebug(`Unexpected PowerShell worker response id: ${response.id}`);
            }
            return;
        }

        if (response.id !== activeRequest.id) {
            logDebug(`Unexpected PowerShell worker response id: ${response.id}`);
            return;
        }

        const request = activeRequest;
        clearTimeout(request.timeout);
        activeRequest = null;

        if (response.ok) {
            request.resolve(response.data);
        } else {
            request.reject(new Error(response.error || 'PowerShell worker request failed.'));
        }

        processQueue();
    }

    // Handles startup and runtime errors from the worker process.
    function handleProcessError(processRef, err) {
        if (processRef !== workerProcess) {
            return;
        }

        logDebug(`PowerShell worker error: ${err.message}`);
        rejectActiveRequest(err);
    }

    // Handles worker exit and lets the next request start a fresh worker.
    function handleProcessClose(processRef, code) {
        const wasStopping = isStopping;
        const isCurrentProcess = processRef === workerProcess;

        if (isCurrentProcess) {
            workerProcess = null;
            stdoutBuffer = '';
            cleanupTempScript();
        }

        if (!wasStopping && isCurrentProcess) {
            logDebug(`PowerShell worker exited with code ${code}.`);
            rejectActiveRequest(new Error(`PowerShell worker exited with code ${code}.`));
            processQueue();
        }
    }

    // Rejects the active request and clears its timeout.
    function rejectActiveRequest(err) {
        if (!activeRequest) {
            return;
        }

        clearTimeout(activeRequest.timeout);
        activeRequest.reject(err);
        activeRequest = null;
    }

    // Stops the current worker after a failed request so the next request gets a clean process.
    function restartProcess() {
        if (!workerProcess) {
            cleanupTempScript();
            processQueue();
            return;
        }

        try {
            workerProcess.kill();
        } catch {}
    }

    // Removes the temporary worker script after PowerShell has released it.
    function cleanupTempScript() {
        if (!tempWorkerPath) {
            return;
        }

        try {
            fs.unlinkSync(tempWorkerPath);
        } catch {}
        tempWorkerPath = null;
    }

    // Queues a command for the persistent PowerShell worker.
    function request(command, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            queue.push({
                id: nextRequestId++,
                command,
                params,
                timeoutMs,
                resolve,
                reject,
                timeout: null
            });
            processQueue();
        });
    }

    // Returns the system idle time in milliseconds.
    function getIdleTime() {
        return request('getIdleTime', {}, DEFAULT_TIMEOUT_MS);
    }

    // Returns whether screenshots should be skipped for power-saving state.
    function isPowerSaving() {
        return request('isPowerSaving', {}, DEFAULT_TIMEOUT_MS);
    }

    // Returns the current Windows metadata snapshot.
    function getMetaData(includeFull, includeMonitors) {
        return request('getMetaData', { includeFull, includeMonitors }, METADATA_TIMEOUT_MS);
    }

    // Stops the worker and removes the temporary runnable script.
    function stop() {
        isStopping = true;
        queue.splice(0).forEach(item => item.reject(new Error('PowerShell worker stopped.')));
        rejectActiveRequest(new Error('PowerShell worker stopped.'));

        if (workerProcess) {
            const processRef = workerProcess;
            try {
                processRef.stdin.write(`${JSON.stringify({ id: nextRequestId++, command: 'shutdown', params: {} })}\n`, 'utf8');
                processRef.stdin.end();
            } catch {}

            try {
                processRef.kill();
            } catch {}
        } else {
            cleanupTempScript();
        }
    }

    return {
        getIdleTime,
        getMetaData,
        isPowerSaving,
        stop
    };
}

module.exports = {
    createPowerShellService
};
