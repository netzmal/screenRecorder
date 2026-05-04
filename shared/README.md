# Screen Recorder - Shared

This module contains the shared logic and data storage used by both the **tray recorder** and the **viewer**.

## Components

### 1. SQLite Database (`db.js`)
*   **Purpose**: Central storage for all metadata (window titles, URLs, file paths, OCR texts).
*   **Technology**: `better-sqlite3`.
*   **Features**:
    *   **Automated migrations**: A versioned patch system keeps the database schema up to date automatically during updates.
    *   **Full-text search**: Uses SQLite indexes to search screenshots efficiently by content.
    *   **Data integrity**: All recorder writes and viewer reads go through this interface.

### 2. Configuration (`config.js`)
*   **Purpose**: Manages user settings (storage paths, intervals, API keys).
*   **Technology**: `electron-store`.
*   **Central settings**:
    *   `screenshotDir`: Where images are stored.
    *   `ocrEnabled`: Text recognition settings.
    *   `chatGptApiKey`: API key for AI analysis.
*   **Important paths**: Configuration and database are stored in the Windows-compliant path `%APPDATA%\screen-recorder-shared`.

## Data Storage

Data is deliberately stored separately from the program code, but centrally for all components:

1.  **Screenshots**: Stored chronologically in folders (`YYYY-MM-DD`).
2.  **Metadata**: The `metadata.db` file is stored centrally in the AppData directory (`%APPDATA%\screen-recorder-shared`). This ensures metadata remains consistent even if the screenshot directory is moved.
