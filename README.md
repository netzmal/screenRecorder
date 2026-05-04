# Screen Recorder

Ein modulares System zur kontinuierlichen Aufzeichnung von Bildschirminhalten unter Windows, optimiert für die Dokumentation von Arbeitsaktivitäten und die einfache Erstellung von Kundenrechnungen.

## Hauptfunktionen

*   **Kontinuierliche Aufzeichnung**: Erstellt automatisch Screenshots aller Monitore in definierten Intervallen (standardmäßig alle 60 Sek.).
*   **Ereignisbasierte Screenshots**: Löst Screenshots bei Fensterwechseln oder Fokusänderungen aus.
*   **Intelligente Metadaten-Erfassung**: Speichert Fenstertitel, geöffnete Explorer-Dateien und Browser-URLs (Chrome/Edge) zu jedem Screenshot.
*   **OCR (Texterkennung)**: Indiziert den Text in Screenshots im Hintergrund (Idle-Modus oder via Screensaver), um sie durchsuchbar zu machen.
*   **KI-Zusammenfassung**: Generiert mithilfe der OpenAI API (ChatGPT) strukturierte Tagesberichte aus den erfassten Aktivitäten.
*   **Bildschirmschoner-Modus**: Ein dediziertes OCR-Dashboard, das während Inaktivität den Monitor-Sleep verhindert und den Verarbeitungsstatus visualisiert.
*   **Datenschutz & Effizienz**: Erkennt Idle-Phasen, pausiert Aufnahmen im Energiesparmodus oder Screensaver-Betrieb und ermöglicht die Filterung unveränderter Bildschirminhalte.

## Projektstruktur

Das Projekt besteht aus drei Hauptbereichen:

*   **[Tray (Recorder)](./tray/README.md)**: Der Hintergrunddienst. Er kümmert sich um die Screenshot-Aufnahme, die Metadaten-Erfassung via PowerShell und die OCR-Verarbeitung.
*   **[Viewer](./viewer/README.md)**: Die Benutzeroberfläche. Ermöglicht das Durchsuchen der Historie, die KI-Analyse und die Konfiguration.
*   **[Screensaver](./screensaver/README.md)**: Ein interaktives OCR-Dashboard, das in Arbeitspausen die Texterkennung visualisiert und beschleunigt.
*   **[Shared](./shared/README.md)**: Gemeinsame Logik für die SQLite-Datenbank (`metadata.db`) und die zentrale Konfiguration (`electron-store`).

## Kommunikation & Datenhaltung

### Datenfluss
1.  **Tray-Recorder** erstellt Screenshots und erfasst Metadaten (Fenstertitel, URLs, Pfade) via PowerShell. Diese werden direkt in der Datenbank gespeichert.
2.  Metadaten werden zentral in einer **SQLite-Datenbank** (`metadata.db`) im Shared-Verzeichnis in den Anwendungsdaten (`%APPDATA%\screen-recorder-shared`) verwaltet.
3.  Im Idle-Modus führt der Recorder **OCR** auf neuen Screenshots aus und aktualisiert den Suchindex in der DB.
4.  **Viewer** liest die Screenshots vom Dateisystem und die Metadaten aus der SQLite-DB.
5.  Für die **KI-Zusammenfassung** sendet der Viewer aggregierte Metadaten an die OpenAI API.

### Speicherorte
*   **Screenshots**: Standardmäßig im Windows-Bilderordner unter `ScreenRecorder_Captures`.
*   **Datenbank**: Liegt im AppData-Verzeichnis (`%APPDATA%\screen-recorder-shared\metadata.db`). Sie enthält alle Metadaten (Titel, URLs, OCR-Text), was die Dateianzahl im Vergleich zu JSON-basierten Systemen massiv reduziert.
*   **Konfiguration**: Wird via `electron-store` im gleichen AppData-Verzeichnis (`%APPDATA%\screen-recorder-shared`) verwaltet.

## Voraussetzungen

*   **Node.js**: (Version 16 oder höher empfohlen)
*   **Windows OS**: Die Anwendung nutzt Windows-spezifische APIs (PowerShell UIAutomation, `screenshot-desktop`).

## Installation

1.  Repository klonen oder herunterladen.
2.  Abhängigkeiten im Hauptverzeichnis installieren:
    ```bash
    npm install
    ```

## Starten der Anwendung

*   **Alles starten (Tray + Viewer)**: `npm run start:all`
*   **Nur Viewer**: `npm run start:viewer`
*   **Nur Recorder (Tray)**: `npm run start:tray`
*   **Nur Bildschirmschoner**: `npm run start:screensaver`
*   **Installer erzeugen**: `npm run build:installer`

Der Installer (NSIS) bündelt beide Komponenten in einem einzigen Windows-Paket.
