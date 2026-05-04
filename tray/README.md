# Screen Recorder - Tray (Recorder)

Der Tray-Recorder ist ein Hintergrunddienst, der für die Aufzeichnung von Bildschirmaktivitäten und deren Indizierung zuständig ist.

## Funktionen

*   **Hintergrundbetrieb**: Läuft minimiert im System Tray und informiert via Tooltips über Aktionen.
*   **Screenshot-Engine**: Erstellt regelmäßig Bilder aller angeschlossenen Monitore.
*   **Intelligentes Metadaten-Tracking**: 
    *   Erfasst Fenstertitel aller aktiven Applikationen.
    *   Extrahiert aktuelle **Browser-URLs** aus Chrome und Microsoft Edge via UIAutomation.
    *   Ermittelt **offene Dateipfade** aus Windows Explorer Fenstern.
*   **OCR-Verarbeitung (Texterkennung)**:
    *   Nutzt primär die **Native Windows OCR API** (via PowerShell) für maximale Geschwindigkeit.
    *   Fallback auf `tesseract.js` bei Bedarf.
    *   Läuft standardmäßig im **Idle-Modus**, um die Systemressourcen während der Arbeit zu schonen.
    *   **Batch-Optimierung**: Fasst mehrere Erkennungsaufgaben zusammen, um den Overhead zu minimieren.
    *   **Fast-Mode**: Optionale 50% Skalierung der Bilder für schnellere Erkennung bei geringerer CPU-Last.
*   **Dynamische Timer**: 
    *   Screenshot-Intervalle sind konfigurierbar.
    *   Sofortige Screenshots bei Fensterwechseln oder Monitor-Fokus-Änderungen (mit einstellbarem Delay).
*   **Zustandsüberwachung**: 
    *   Pausiert automatisch im Energiesparmodus oder während intensiver OCR-Phasen.
    *   **Screensaver-Integration**: Pausiert die Aufnahme automatisch, sobald der integrierte Bildschirmschoner aktiv ist, um Ressourcen für die Hintergrund-OCR freizugeben.

## Technik

*   **Runtime**: Electron (Tray & IPC).
*   **Metadaten**: Ein eingebettetes PowerShell-Skript nutzt `UIAutomation` und `Shell.Application`, um Systeminformationen ohne externe Abhängigkeiten zu sammeln.
*   **Datenhaltung**: Schreibt direkt und ausschließlich in die zentrale SQLite-Datenbank (`shared/db.js`). Es werden keine JSON-Metadaten-Dateien mehr auf dem Dateisystem abgelegt.
*   **OCR**: Persistenter Tesseract-Worker zur Vermeidung von Overhead durch ständiges Laden der Sprachdaten.

## Starten

Aus dem Hauptverzeichnis:
```bash
npm run start:tray
```
Oder direkt aus diesem Verzeichnis:
```bash
npm start
```
