!macro customInit
  # Stop running instances before installation/upgrade to avoid file locks.
  # nsExec::Exec is used to suppress the console window.
  nsExec::Exec 'taskkill /F /IM "Screen Recorder.exe" /T'
!macroend

!macro customInstall
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "ScreenRecorderTray" "$\"$INSTDIR\Screen Recorder.exe$\" tray"

  # Remove stale per-user shortcuts left by older builds. They can keep an old
  # icon/AppUserModelID association even after the per-machine shortcut is fixed.
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Screen Recorder.lnk"
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Screen Recorder Tray.lnk"

  # Rewrite the visible start menu shortcut with the external icon file. This
  # avoids stale shell icon-cache entries tied to the EXE path.
  CreateShortCut "$SMPROGRAMS\Screen Recorder.lnk" "$INSTDIR\Screen Recorder.exe" "viewer" "$INSTDIR\resources\viewer\assets\icon.ico" 0
  WinShell::SetLnkAUMI "$SMPROGRAMS\Screen Recorder.lnk" "com.screen.recorder.viewer"
  CreateShortCut "$DESKTOP\Screen Recorder.lnk" "$INSTDIR\Screen Recorder.exe" "viewer" "$INSTDIR\resources\viewer\assets\icon.ico" 0
  WinShell::SetLnkAUMI "$DESKTOP\Screen Recorder.lnk" "com.screen.recorder.viewer"
  
  # Create a shortcut in the common Startup folder (for all users after login).
  CreateShortCut "$SMSTARTUP\Screen Recorder Tray.lnk" "$INSTDIR\Screen Recorder.exe" "tray" "$INSTDIR\resources\viewer\assets\icon.ico" 0
  WinShell::SetLnkAUMI "$SMSTARTUP\Screen Recorder Tray.lnk" "com.screen.recorder.tray"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'

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
