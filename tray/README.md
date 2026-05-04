# Screen Recorder - Tray (Recorder)

The tray recorder is a background service responsible for recording screen activity and indexing it.

## Features

*   **Background operation**: Runs minimized in the system tray and reports actions via tooltips.
*   **Screenshot engine**: Regularly captures images of all connected monitors.
*   **Smart metadata tracking**:
    *   Captures window titles of all active applications.
    *   Extracts current **browser URLs** from Chrome and Microsoft Edge via UIAutomation.
    *   Detects **open file paths** from Windows Explorer windows.
*   **OCR processing (text recognition)**:
    *   Primarily uses the **native Windows OCR API** (via PowerShell) for maximum speed.
    *   Falls back to `tesseract.js` when needed.
    *   Runs in **idle mode** by default to preserve system resources while working.
    *   **Batch optimization**: Groups multiple recognition tasks to minimize overhead.
    *   **Fast mode**: Optional 50% image scaling for faster recognition with lower CPU load.
*   **Dynamic timers**:
    *   Screenshot intervals are configurable.
    *   Immediate screenshots can be triggered by window changes or monitor focus changes (with configurable delay).
*   **State monitoring**:
    *   Automatically pauses in power-save mode or during intensive OCR phases.
    *   **Screensaver integration**: Automatically pauses recording when the integrated screensaver is active, freeing resources for background OCR.

## Technology

*   **Runtime**: Electron (tray & IPC).
*   **Metadata**: An embedded PowerShell script uses `UIAutomation` and `Shell.Application` to collect system information without external dependencies.
*   **Data storage**: Writes directly and exclusively to the central SQLite database (`shared/db.js`). No JSON metadata files are stored on the file system anymore.
*   **OCR**: Persistent Tesseract worker to avoid the overhead of repeatedly loading language data.

## Starting

From the repository root:
```bash
npm run start:tray
```
Or directly from this directory:
```bash
npm start
```
