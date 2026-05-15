!macro customInit
  # Stop running instances before installation/upgrade to avoid file locks.
  # nsExec::Exec is used to suppress the console window.
  nsExec::Exec 'taskkill /F /IM "Screen Recorder.exe" /T'
!macroend

!macro customInstall
  # Older builds used HKLM\Run in addition to a Startup shortcut. Remove it
  # so Windows does not start two tray processes at login.
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "ScreenRecorderTray"

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

  # Windows screensavers are launched as .scr executables. Keep the .scr next
  # to the installed Electron resources; a copied EXE in AppData cannot find
  # app.asar and exits silently when Windows starts the screensaver.
  Delete "$INSTDIR\ScreenRecorder.scr"
  nsExec::ExecToLog 'cmd /c mklink /H "$INSTDIR\ScreenRecorder.scr" "$INSTDIR\Screen Recorder.exe"'
  IfErrors 0 +2
    CopyFiles /SILENT "$INSTDIR\Screen Recorder.exe" "$INSTDIR\ScreenRecorder.scr"

  # Remove the broken fallback from older builds and repair registry values
  # that still point to it.
  Delete "$APPDATA\ScreenRecorder\ScreenRecorder.scr"
  RMDir "$APPDATA\ScreenRecorder"
  ReadRegStr $0 HKCU "Control Panel\Desktop" "SCRNSAVE.EXE"
  StrCmp $0 "$APPDATA\ScreenRecorder\ScreenRecorder.scr" 0 +3
    WriteRegStr HKCU "Control Panel\Desktop" "SCRNSAVE.EXE" "$INSTDIR\ScreenRecorder.scr"
    Goto repairDesktopScreensaverDone
  StrCmp $0 "$INSTDIR\Screen Recorder.exe" 0 repairDesktopScreensaverDone
    WriteRegStr HKCU "Control Panel\Desktop" "SCRNSAVE.EXE" "$INSTDIR\ScreenRecorder.scr"
  repairDesktopScreensaverDone:
  ReadRegStr $0 HKCU "Software\Policies\Microsoft\Windows\Control Panel\Desktop" "SCRNSAVE.EXE"
  StrCmp $0 "$APPDATA\ScreenRecorder\ScreenRecorder.scr" 0 +3
    WriteRegStr HKCU "Software\Policies\Microsoft\Windows\Control Panel\Desktop" "SCRNSAVE.EXE" "$INSTDIR\ScreenRecorder.scr"
    Goto repairPolicyScreensaverDone
  StrCmp $0 "$INSTDIR\Screen Recorder.exe" 0 repairPolicyScreensaverDone
    WriteRegStr HKCU "Software\Policies\Microsoft\Windows\Control Panel\Desktop" "SCRNSAVE.EXE" "$INSTDIR\ScreenRecorder.scr"
  repairPolicyScreensaverDone:
  
  # Use the current user's Startup folder because settings and screenshots are
  # stored per user and the viewer can manage this location without elevation.
  Delete "$SMSTARTUP\Screen Recorder Tray.lnk"
  CreateDirectory "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
  CreateShortCut "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Screen Recorder Tray.lnk" "$INSTDIR\Screen Recorder.exe" "tray" "$INSTDIR\resources\viewer\assets\icon.ico" 0
  WinShell::SetLnkAUMI "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Screen Recorder Tray.lnk" "com.screen.recorder.tray"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'

  # Start the tray app immediately.
  Exec "$\"$INSTDIR\Screen Recorder.exe$\" tray"
!macroend

!macro customUnInstall
  # Stop running instances before uninstalling.
  nsExec::Exec 'taskkill /F /IM "Screen Recorder.exe" /T'

  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "ScreenRecorderTray"
  
  # Remove old common and current per-user startup shortcuts.
  Delete "$SMSTARTUP\Screen Recorder Tray.lnk"
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Screen Recorder Tray.lnk"
  Delete "$INSTDIR\ScreenRecorder.scr"

  # NOTE: The $APPDATA\screen-recorder-shared folder (with config.json and metadata.db)
  # is intentionally NOT deleted, so user settings and metadata are preserved during
  # updates or reinstallations.
!macroend
