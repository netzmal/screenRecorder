# Screen Recorder - Installer

This module is responsible for creating the Windows installer.

## Technology
It uses **electron-builder** to bundle the different components (`viewer`, `tray`, `shared`) into an installable package.

## Build Process
The build can be started from the repository root:
```bash
npm run build:installer
```

Or from this directory:
```bash
npm install
npm run build
```

The result is written to the `dist/` folder.

## Data Safety
During updates or uninstallations, user data (configuration and SQLite metadata) under `%APPDATA%\screen-recorder-shared` is preserved. This is configured in `installer.nsh` to prevent data loss.
