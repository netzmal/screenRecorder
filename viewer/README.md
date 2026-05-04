# Screen Recorder - Viewer

The viewer is the application's control center. It is used to analyze recorded data, search screenshots, and configure the system.

## Features

*   **Visual history**: Browse screenshots from all monitors with a timeline and calendar navigation.
*   **Full-text search**: OCR indexing makes screenshots searchable by text content.
*   **AI daily summary**:
    *   Generates structured reports about a day's activities.
    *   Uses window titles, file paths, URLs, and OCR snippets for precise analysis.
    *   Optimized for **invoicing**: Shows working time per project/application.
    *   Built-in Markdown preview for readable reports.
    *   "Copy for ChatGPT" function for manual analyses.
*   **URL tracking view**: A dedicated tab lists all visited websites for the day in chronological order.
*   **Extensive configuration**:
    *   **General**: Storage path, intervals, autostart.
    *   **Events**: Enable/disable screenshots on window or monitor changes.
    *   **OCR**: Activation, language selection, idle-mode parameters, and control of the **integrated screensaver**.
    *   **AI**: Store the OpenAI API key for the integrated analysis.

## Technology

*   **Frontend**: HTML5/CSS3 with dynamic Markdown rendering (regex-based).
*   **Backend**: Electron (main process) for file system access, IPC communication, and API requests.
*   **Data access**: Uses the shared SQLite interface (`shared/db.js`) for fast searches and metadata aggregation.
*   **API**: OpenAI API integration (`gpt-4o-mini`) via Electron's `net` API.

## Starting

From the repository root:
```bash
npm run start:viewer
```
Or directly from this directory:
```bash
npm start
```
