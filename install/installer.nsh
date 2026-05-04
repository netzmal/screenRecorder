!macro customInit
  # Beende laufende Instanzen vor der Installation/Upgrade, um Dateisperren zu vermeiden
  # nsExec::Exec wird verwendet, um das Konsolenfenster zu unterdrücken
  nsExec::Exec 'taskkill /F /IM "Screen Recorder.exe" /T'
!macroend

!macro customInstall
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "ScreenRecorderTray" "$\"$INSTDIR\Screen Recorder.exe$\" tray"
  
  # Verknüpfung im Common Startup Ordner erstellen (für alle User nach Login)
  CreateShortCut "$SMSTARTUP\Screen Recorder Tray.lnk" "$INSTDIR\Screen Recorder.exe" "tray" "$INSTDIR\Screen Recorder.exe" 0

  # Tray App sofort starten
  Exec "$\"$INSTDIR\Screen Recorder.exe$\" tray"
!macroend

!macro customUnInstall
  # Beende laufende Instanzen vor der Deinstallation
  nsExec::Exec 'taskkill /F /IM "Screen Recorder.exe" /T'

  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "ScreenRecorderTray"
  
  # Verknüpfung aus dem Startup Ordner entfernen
  Delete "$SMSTARTUP\Screen Recorder Tray.lnk"

  # HINWEIS: Der Ordner $APPDATA\screen-recorder-shared (mit config.json und metadata.db)
  # wird bewusst NICHT gelöscht, um Benutzereinstellungen und Metadaten bei
  # Updates oder Neuinstallationen zu erhalten.
!macroend
