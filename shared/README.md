# Screen Recorder - Shared

Dieses Modul enthält die gemeinsame Logik und Datenhaltung, die sowohl vom **Tray-Recorder** als auch vom **Viewer** genutzt wird.

## Komponenten

### 1. SQLite Datenbank (`db.js`)
*   **Zweck**: Zentrale Speicherung aller Metadaten (Fenstertitel, URLs, Dateipfade, OCR-Texte).
*   **Technik**: `better-sqlite3`.
*   **Features**:
    *   **Automatisierte Migrationen**: Ein versioniertes Patch-System sorgt dafür, dass die Datenbank-Struktur bei Updates automatisch aktualisiert wird.
    *   **Volltextsuche**: Nutzt SQLite-Indizes, um Screenshots effizient nach Inhalten zu durchsuchen.
    *   **Daten-Integrität**: Alle Schreibvorgänge des Recorders und Lesevorgänge des Viewers laufen über diese Schnittstelle.

### 2. Konfiguration (`config.js`)
*   **Zweck**: Verwaltung der Benutzereinstellungen (Speicherpfade, Intervalle, API-Keys).
*   **Technik**: `electron-store`.
*   **Zentrale Einstellungen**:
    *   `screenshotDir`: Wo Bilder liegen.
    *   `ocrEnabled`: Einstellungen zur Texterkennung.
    *   `chatGptApiKey`: API-Key für die KI-Analyse.
*   **Wichtige Pfade**: Die Konfiguration und die Datenbank liegen Windows-konform in `%APPDATA%\screen-recorder-shared`.

## Datenhaltung

Die Daten werden bewusst dezentral vom Programmcode, aber zentral für die Komponenten gespeichert:

1.  **Screenshots**: Werden chronologisch in Ordnern (`YYYY-MM-DD`) abgelegt.
2.  **Metadaten**: Die Datei `metadata.db` liegt zentral im AppData-Verzeichnis (`%APPDATA%\screen-recorder-shared`). Dies stellt sicher, dass Metadaten auch dann konsistent bleiben, wenn das Screenshot-Verzeichnis verschoben wird.
