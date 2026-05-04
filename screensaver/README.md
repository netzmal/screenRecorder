# Screen Recorder - Screensaver

The screensaver is an interactive OCR dashboard that uses system idle time to advance text recognition (OCR) for captured screenshots in the background.

## Features

*   **Interactive dashboard**: Visualizes OCR processing progress in real time.
*   **Dual status display**:
    *   **Left folder**: Represents the inbox of images waiting for processing.
    *   **Right area**: Shows progress statistics for the current session.
*   **Focus animation**: Documents fly out of the folder into focus, remain there during text recognition, and then disappear spatially into the background.
*   **Privacy & data protection**: Transparent document icons are used instead of real screenshots to protect sensitive content.
*   **Multi-monitor support**:
    *   The dashboard is shown only on the primary display.
    *   All other connected monitors are completely darkened (blackout) to minimize distractions.
*   **Power-save blocker**: Uses Electron's `powerSaveBlocker` to prevent monitor sleep and system standby during the active OCR phase.
*   **Smart exit**: Closes automatically on any user interaction (mouse movement, keyboard).

## Technology

*   **Runtime**: Electron (standalone process).
*   **Data access**: Uses `shared/db.js` to retrieve OCR statistics (`getPendingOcrCaptures`, `updateOcrText`).
*   **Background processing**: Runs OCR logic alongside the visualization without burdening the main application.
*   **Process control**: Communicates the `isScreensaverRunning` status to the tray recorder so it can pause new captures.

## Starting

From the repository root:
```bash
npm run start:screensaver
```
The screensaver can also be started manually from the viewer (OCR tab) or the tray menu.
