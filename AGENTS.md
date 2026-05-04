Dies ist die zentrale Agents-Datei für das Screen Recorder Projekt.

Projektziel: Kontinuierliche Bildschirmaufzeichnung unter Windows mit UI-Viewer und Tray-Recorder.

Struktur:
- /shared: Gemeinsame Konfiguration (electron-store).
- /viewer: Electron-Anwendung zur Ansicht der Screenshots.
- /tray: Electron-Anwendung (Hintergrunddienst) zur Aufnahme der Screenshots.

Allgemeine Regeln für Agents:
1. Code-Konsistenz über die Teilprojekte hinweg wahren.
2. Windows-Kompatibilität sicherstellen (Pfade, Shell-Kommandos).
3. Gemeinsame Konfiguration in /shared/config.js respektieren.
