# Screen Recorder

A modular system for continuously recording screen content on Windows, optimized for documenting work activity and simplifying customer invoice preparation.

## Main Features

*   **Continuous recording**: Automatically captures screenshots of all monitors at configured intervals (60 seconds by default).
*   **Event-based screenshots**: Triggers screenshots on window changes or focus changes.
*   **Smart metadata capture**: Stores window titles, open Explorer files, and browser URLs (Chrome/Edge) for each screenshot.
*   **Screensaver OCR (text recognition)**: Indexes text in screenshots in the background (idle mode or via screensaver) so they become searchable.
*   **AI summary**: Uses the OpenAI API (ChatGPT) to generate structured daily reports from captured activity.
*   **Efficiency**: Detects idle phases, pauses recording during power-save or screensaver operation, and can filter unchanged screen content.
*   **i18n**: Supports multiple languages (Currently english and german), source code is in english.

## Project Structure

The project consists of four main areas:

*   **[Tray (Recorder)](./tray/README.md)**: The background service. It handles screenshot capture and metadata collection via PowerShell.
*   **[Viewer](./viewer/README.md)**: The user interface. It supports history browsing, AI analysis, and configuration.
*   **[Screensaver](./screensaver/README.md)**: An interactive OCR dashboard that visualizes text recognition during work breaks.
*   **[Shared](./shared/README.md)**: Shared logic for the SQLite database (`metadata.db`) and central configuration (`electron-store`).

## Communication & Data Storage

### Data Flow
1.  The **tray recorder** captures screenshots and collects metadata (window titles, URLs, paths) via PowerShell. These are saved directly to the database.
2.  Metadata is managed centrally in a **SQLite database** (`metadata.db`) inside the shared application data directory (`%APPDATA%\screen-recorder-shared`).
3.  During idle mode, the screensaver runs **OCR** on new screenshots and updates the search index in the database.
4.  The **viewer** reads screenshots from the file system and metadata from the SQLite database.
5.  For the **AI summary**, the viewer sends aggregated metadata to the OpenAI API.

### Storage Locations
*   **Screenshots**: By default, in the Windows Pictures folder under `ScreenRecorder_Captures`.
*   **Database**: Stored in the AppData directory (`%APPDATA%\screen-recorder-shared\metadata.db`). It contains all metadata (titles, URLs, OCR text), which greatly reduces file count compared with JSON-based systems.
*   **Configuration**: Managed via `electron-store` in the same AppData directory (`%APPDATA%\screen-recorder-shared`).

## Requirements

*   **Node.js**: Version 16 or newer recommended.
*   **Windows OS**: The application uses Windows-specific APIs (PowerShell UIAutomation, `screenshot-desktop`).

## Installation

1.  Clone or download the repository.
2.  Install dependencies in the repository root:
    ```bash
    npm install
    ```

## Starting the Application

*   **Start everything (tray + viewer)**: `npm run start:all`
*   **Viewer only**: `npm run start:viewer`
*   **Recorder only (tray)**: `npm run start:tray`
*   **Screensaver only**: `npm run start:screensaver`
*   **Build installer**: `npm run build:installer`

The installer (NSIS) bundles both components into a single Windows package.
