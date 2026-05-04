# Screen Recorder - Bildschirmschoner

Der Bildschirmschoner ist ein interaktives OCR-Dashboard, das die Leerlaufzeiten des Systems nutzt, um die Texterkennung (OCR) der aufgenommenen Screenshots im Hintergrund voranzutreiben.

## Funktionen

*   **Interaktives Dashboard**: Visualisiert den Fortschritt der OCR-Verarbeitung in Echtzeit.
*   **Duale Status-Anzeige**:
    *   **Linker Ordner**: Symbolisiert den Posteingang mit Bildern, die noch auf die Verarbeitung warten.
    *   **Rechter Bereich**: Zeigt die Fortschritts-Statistiken der aktuellen Sitzung.
*   **Fokus-Animation**: Dokumente fliegen aus dem Ordner prominent in den Fokus, verweilen dort während der Texterkennung und verschwinden anschließend räumlich "nach hinten".
*   **Privatsphäre & Datenschutz**: Statt echter Screenshots werden transparente Dokument-Icons verwendet, um sensible Inhalte zu schützen.
*   **Multi-Monitor Support**: 
    *   Das Dashboard wird nur auf dem Hauptbildschirm angezeigt.
    *   Alle anderen angeschlossenen Monitore werden komplett abgedunkelt (Blackout), um Ablenkungen zu minimieren.
*   **Energiespar-Sperre**: Nutzt den Electron `powerSaveBlocker`, um das Ausschalten des Monitors und den Standby-Modus während der aktiven OCR-Phase zu verhindern.
*   **Intelligente Beendigung**: Schließt sich automatisch bei jeder Benutzerinteraktion (Mausbewegung, Tastatur).

## Technik

*   **Runtime**: Electron (eigenständiger Prozess).
*   **Datenabfrage**: Nutzt `shared/db.js` zur Ermittlung der OCR-Statistiken (`getPendingOcrCaptures`, `updateOcrText`).
*   **Hintergrund-Verarbeitung**: Führt die OCR-Logik parallel zur Visualisierung aus, ohne die Hauptanwendung zu belasten.
*   **Prozess-Steuerung**: Kommuniziert den Status `isScreensaverRunning` an den Tray-Recorder, damit dieser die Neuaufnahmen pausiert.

## Starten

Aus dem Hauptverzeichnis:
```bash
npm run start:screensaver
```
Der Bildschirmschoner kann auch manuell über den Viewer (OCR-Tab) oder das Tray-Menü gestartet werden.
