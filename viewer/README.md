# Screen Recorder - Viewer

Der Viewer ist das Kontrollzentrum der Anwendung. Er dient zur Analyse der aufgezeichneten Daten, zur Suche in Screenshots und zur Konfiguration des Systems.

## Funktionen

*   **Visuelle Historie**: Durchsuchen der Screenshots aller Monitore mit Zeitleiste und Kalender-Navigation.
*   **Volltextsuche**: Dank der OCR-Indizierung können Screenshots nach Textinhalten durchsucht werden.
*   **KI-Tageszusammenfassung**: 
    *   Generiert strukturierte Berichte über die Aktivitäten eines Tages.
    *   Nutzt Fenstertitel, Dateipfade, URLs und OCR-Schnipsel für eine präzise Analyse.
    *   Optimiert für die **Rechnungsstellung**: Zeigt Arbeitszeiten pro Projekt/Applikation an.
    *   Eingebaute Markdown-Vorschau für übersichtliche Berichte.
    *   "Copy for ChatGPT" Funktion für manuelle Analysen.
*   **URL-Tracking-Ansicht**: Ein spezieller Tab listet alle besuchten Webseiten des Tages chronologisch auf.
*   **Umfangreiche Konfiguration**:
    *   **Allgemein**: Speicherpfad, Intervalle, Autostart.
    *   **Ereignisse**: Screenshots bei Fenster- oder Monitorwechsel aktivieren/deaktivieren.
    *   **OCR**: Aktivierung, Sprachwahl, Idle-Modus-Parameter und Steuerung des **integrierten Bildschirmschoners**.
    *   **KI**: Hinterlegen des OpenAI API-Keys für die integrierte Analyse.

## Technik

*   **Frontend**: HTML5/CSS3 mit dynamischem Markdown-Rendering (Regex-basiert).
*   **Backend**: Electron (Main-Prozess) für Dateisystemzugriff, IPC-Kommunikation und API-Anfragen.
*   **Datenabfrage**: Nutzt die gemeinsame SQLite-Schnittstelle (`shared/db.js`) für performante Suchen und Metadaten-Aggregation.
*   **API**: Integration der OpenAI API (`gpt-4o-mini`) via Electron `net` API.

## Starten

Aus dem Hauptverzeichnis:
```bash
npm run start:viewer
```
Oder direkt aus diesem Verzeichnis:
```bash
npm start
```
