!macro customInit
  # Stop running instances before installation/upgrade to avoid file locks.
  # nsExec::Exec is used to suppress the console window.
  nsExec::Exec 'taskkill /F /IM "Screen Recorder.exe" /T'
!macroend

!macro customInstall
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "ScreenRecorderTray" "$\"$INSTDIR\Screen Recorder.exe$\" tray"
  
  # Create a shortcut in the common Startup folder (for all users after login).
  CreateShortCut "$SMSTARTUP\Screen Recorder Tray.lnk" "$INSTDIR\Screen Recorder.exe" "tray" "$INSTDIR\Screen Recorder.exe" 0

  # Start the tray app immediately.
  Exec "$\"$INSTDIR\Screen Recorder.exe$\" tray"
!macroend

!macro customUnInstall
  # Stop running instances before uninstalling.
  nsExec::Exec 'taskkill /F /IM "Screen Recorder.exe" /T'

  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "ScreenRecorderTray"
  
  # Remove the shortcut from the Startup folder.
  Delete "$SMSTARTUP\Screen Recorder Tray.lnk"

  # NOTE: The $APPDATA\screen-recorder-shared folder (with config.json and metadata.db)
  # is intentionally NOT deleted, so user settings and metadata are preserved during
  # updates or reinstallations.
!macroend
