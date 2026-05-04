# Screen Recorder - Installer

Dieses Modul ist für die Erstellung des Windows-Installers zuständig.

## Technik
Es wird **electron-builder** verwendet, um die verschiedenen Komponenten (`viewer`, `tray`, `shared`) zu einem installierbaren Paket zu bündeln.

## Build-Prozess
Der Build kann direkt aus dem Hauptverzeichnis gestartet werden:
```bash
npm run build:installer
```

Oder in diesem Verzeichnis:
```bash
npm install
npm run build
```

Das Ergebnis findet sich im Ordner `dist/`.

## Datensicherheit
Bei Updates oder einer Deinstallation bleiben die Benutzerdaten (Konfiguration und SQLite-Metadaten) unter `%APPDATA%\screen-recorder-shared` erhalten. Dies ist in `installer.nsh` so konfiguriert, um Datenverlust zu vermeiden.
