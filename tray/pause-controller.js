// Manages temporary screenshot pauses for the tray recorder.
const { Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_PAUSE_DURATION_MS = 30 * 60 * 1000;
const SCREENSHOT_RESUME_GRACE_MS = 2 * 60 * 1000;

// Creates the pause controller used by tray/main.js.
function createPauseController({
    iconDir,
    i18n,
    logDebug,
    clearScheduledScreenshotTriggers,
    updateTrayStatus,
    refreshTrayMenu,
    scheduleImmediateScreenshot
}) {
    let screenshotsPausedUntil = null;
    let resumeDecisionDeadline = null;
    let pauseExpiryTimeout = null;
    let resumeDecisionTimeout = null;
    let resumePromptNotification = null;
    let resumePromptToken = 0;
    let pauseStateToken = 0;

    // Escapes text inserted into Windows toast XML notifications.
    function escapeToastXml(value) {
        return String(value).replace(/[<>&'"]/g, (character) => {
            switch (character) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case "'": return '&apos;';
                case '"': return '&quot;';
                default: return character;
            }
        });
    }

    // Builds a Windows toast with action buttons because Electron's action option is macOS-only.
    function buildWindowsToastXml(title, body, actions) {
        const actionXml = actions.map((action) => {
            return `<action content="${escapeToastXml(action.text)}" arguments="${escapeToastXml(action.argument)}" activationType="foreground" />`;
        }).join('');

        return [
            '<toast>',
            '  <visual>',
            '    <binding template="ToastGeneric">',
            `      <text>${escapeToastXml(title)}</text>`,
            `      <text>${escapeToastXml(body)}</text>`,
            '    </binding>',
            '  </visual>',
            actionXml ? `  <actions>${actionXml}</actions>` : '',
            '</toast>'
        ].filter(Boolean).join('');
    }

    // Returns the tray icon path used by notifications.
    function getTrayIconPath() {
        const icoPath = path.join(iconDir, 'icon.ico');
        if (process.platform === 'win32' && fs.existsSync(icoPath)) return icoPath;
        return path.join(iconDir, 'icon.png');
    }

    // Formats a timestamp for compact tray and notification messages.
    function formatPauseTime(timestamp) {
        try {
            return new Date(timestamp).toLocaleTimeString(i18n.getLocale(), {
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (err) {
            return new Date(timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
            });
        }
    }

    // Shows a tray notification and optionally adds an action button.
    function showTrayNotification({ title, body, actions = [], timeoutType = 'default' }) {
        if (!Notification.isSupported()) {
            logDebug(`Notification skipped because desktop notifications are not supported: ${title}`);
            return null;
        }

        const notificationOptions = {
            title,
            body,
            icon: getTrayIconPath(),
            timeoutType
        };

        if (process.platform === 'win32' && actions.length > 0) {
            notificationOptions.toastXml = buildWindowsToastXml(title, body, actions);
        } else if (actions.length > 0) {
            notificationOptions.actions = actions.map(action => ({
                type: 'button',
                text: action.text
            }));
        }

        const notification = new Notification(notificationOptions);
        notification.on('failed', (event, error) => {
            logDebug(`Notification failed: ${error}`);
        });
        notification.show();
        return notification;
    }

    // Closes the resume prompt if it is still visible or stored in the Windows action center.
    function closeResumePromptNotification() {
        if (!resumePromptNotification) return;

        try {
            resumePromptNotification.close();
        } catch (err) {
            logDebug(`Failed to close resume prompt notification: ${err.message}`);
        }

        resumePromptNotification = null;
    }

    // Clears pause and resume-decision timers.
    function clearPauseTimers() {
        if (pauseExpiryTimeout) {
            clearTimeout(pauseExpiryTimeout);
            pauseExpiryTimeout = null;
        }
        if (resumeDecisionTimeout) {
            clearTimeout(resumeDecisionTimeout);
            resumeDecisionTimeout = null;
        }
    }

    // Advances the pause state generation so queued timer callbacks cannot affect a newer state.
    function createPauseStateToken() {
        pauseStateToken += 1;
        return pauseStateToken;
    }

    // Reads the action index only from Electron's structured event details.
    function getNotificationActionIndex(event) {
        if (event && typeof event.actionIndex === 'number') return event.actionIndex;
        return null;
    }

    // Returns true while the user pause is active or resume-decision window blocks screenshots.
    function isScreenshotCapturePaused() {
        const now = Date.now();
        return Boolean(
            (screenshotsPausedUntil && screenshotsPausedUntil > now) ||
            (resumeDecisionDeadline && resumeDecisionDeadline > now)
        );
    }

    // Returns true while the 30-minute user pause is active.
    function isPauseActive() {
        return Boolean(screenshotsPausedUntil && screenshotsPausedUntil > Date.now());
    }

    // Returns true while the two-minute resume decision is active.
    function isResumeDecisionActive() {
        return Boolean(resumeDecisionDeadline && resumeDecisionDeadline > Date.now());
    }

    // Returns the current pause-until timestamp for tray text.
    function getPausedUntil() {
        return screenshotsPausedUntil;
    }

    // Returns the current resume-decision deadline for tray text.
    function getResumeDecisionDeadline() {
        return resumeDecisionDeadline;
    }

    // Blocks screenshots and advances expired pause state before a capture starts.
    function shouldSkipCapture() {
        const now = Date.now();

        if (screenshotsPausedUntil && screenshotsPausedUntil <= now && !resumeDecisionDeadline) {
            startResumeDecisionPeriod();
            return true;
        }

        if (resumeDecisionDeadline && resumeDecisionDeadline <= now) {
            resumeScreenshots({ notify: true });
            return true;
        }

        return isScreenshotCapturePaused();
    }

    // Shows the notification that lets the user extend the pause before recording resumes.
    function showResumeDecisionNotification() {
        const token = ++resumePromptToken;
        const title = i18n.t('tray.notifications.resume_prompt_title');
        const body = i18n.t('tray.notifications.resume_prompt_body', { minutes: 2 });
        const actionText = i18n.t('tray.notifications.pause_again_action');

        closeResumePromptNotification();

        const notification = showTrayNotification({
            title,
            body,
            actions: [{ text: actionText, argument: 'pause-again-30-minutes' }],
            timeoutType: 'never'
        });

        if (!notification) return;

        notification.once('action', (event) => {
            const index = getNotificationActionIndex(event);
            if (
                notification !== resumePromptNotification ||
                token !== resumePromptToken ||
                index !== 0 ||
                !isResumeDecisionActive() ||
                isPauseActive()
            ) {
                logDebug(`Ignored stale or invalid resume prompt action. token=${token}, currentToken=${resumePromptToken}, actionIndex=${index}`);
                return;
            }

            resumePromptToken++;
            pauseScreenshots(SCREENSHOT_PAUSE_DURATION_MS, { notify: true });
        });

        resumePromptNotification = notification;
    }

    // Starts the two-minute window in which the user can extend an expired pause.
    function startResumeDecisionPeriod(expectedPauseStateToken = null) {
        if (expectedPauseStateToken !== null && expectedPauseStateToken !== pauseStateToken) return;
        if (resumeDecisionDeadline && resumeDecisionDeadline > Date.now()) return;

        const currentPauseStateToken = createPauseStateToken();
        screenshotsPausedUntil = null;
        resumeDecisionDeadline = Date.now() + SCREENSHOT_RESUME_GRACE_MS;

        clearPauseTimers();

        clearScheduledScreenshotTriggers();
        showResumeDecisionNotification();
        updateTrayStatus();
        refreshTrayMenu();

        resumeDecisionTimeout = setTimeout(() => {
            resumeDecisionTimeout = null;
            if (currentPauseStateToken !== pauseStateToken) return;
            if (!resumeDecisionDeadline || resumeDecisionDeadline > Date.now()) return;
            resumeScreenshots({ notify: true });
        }, SCREENSHOT_RESUME_GRACE_MS);

        logDebug(`Screenshot pause expired. Waiting for user decision until ${new Date(resumeDecisionDeadline).toISOString()}.`);
    }

    // Pauses screenshots for the requested duration and schedules the resume prompt.
    function pauseScreenshots(durationMs = SCREENSHOT_PAUSE_DURATION_MS, options = {}) {
        const currentPauseStateToken = createPauseStateToken();
        screenshotsPausedUntil = Date.now() + durationMs;
        resumeDecisionDeadline = null;
        resumePromptToken++;

        clearPauseTimers();
        closeResumePromptNotification();
        clearScheduledScreenshotTriggers();

        pauseExpiryTimeout = setTimeout(() => {
            pauseExpiryTimeout = null;
            if (currentPauseStateToken !== pauseStateToken) return;
            if (!screenshotsPausedUntil || screenshotsPausedUntil > Date.now()) return;
            startResumeDecisionPeriod(currentPauseStateToken);
        }, durationMs);

        updateTrayStatus();
        refreshTrayMenu();

        logDebug(`Screenshots paused until ${new Date(screenshotsPausedUntil).toISOString()}.`);

        if (options.notify !== false) {
            showTrayNotification({
                title: i18n.t('tray.notifications.paused'),
                body: i18n.t('tray.notifications.pause_until', {
                    time: formatPauseTime(screenshotsPausedUntil)
                })
            });
        }
    }

    // Resumes screenshots immediately and restarts the regular capture timer.
    function resumeScreenshots(options = {}) {
        const wasPaused = isScreenshotCapturePaused() || screenshotsPausedUntil || resumeDecisionDeadline;

        createPauseStateToken();
        screenshotsPausedUntil = null;
        resumeDecisionDeadline = null;
        resumePromptToken++;

        clearPauseTimers();
        closeResumePromptNotification();
        updateTrayStatus();
        refreshTrayMenu();

        if (!wasPaused && !options.force) return;

        scheduleImmediateScreenshot();
        logDebug('Screenshots resumed.');

        if (options.notify !== false) {
            showTrayNotification({
                title: i18n.t('tray.notifications.resumed'),
                body: i18n.t('tray.notifications.resume_body')
            });
        }
    }

    // Cleans up timers and notifications during app shutdown.
    function dispose() {
        createPauseStateToken();
        resumePromptToken++;
        clearPauseTimers();
        closeResumePromptNotification();
    }

    return {
        pauseScreenshots,
        resumeScreenshots,
        shouldSkipCapture,
        isPauseActive,
        isResumeDecisionActive,
        getPausedUntil,
        getResumeDecisionDeadline,
        formatPauseTime,
        dispose
    };
}

module.exports = {
    SCREENSHOT_PAUSE_DURATION_MS,
    SCREENSHOT_RESUME_GRACE_MS,
    createPauseController
};
