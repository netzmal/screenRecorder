# AGENTS.md

This is the central agents file for the Screen Recorder project.

## Project goal

Continuous screen recording on Windows with a UI viewer, tray recorder and idle-time OCR processing.

## Project structure

- `/shared`  
  Shared configuration, i18n files and common utilities. Configuration is handled through `electron-store`.
- `/viewer`  
  Electron application for viewing screenshots.
- `/tray`  
  Electron application running in the background/tray for capturing screenshots.
- `/screensaver`  
  Screensaver component for OCR processing while the computer is idle.

## General rules for agents

1. Keep code style, naming and structure consistent across all subprojects.
2. Ensure Windows 10+ compatibility at all times:
    - file paths
    - shell commands
    - PowerShell/CMD behavior
    - installer/startup behavior
3. Respect the shared configuration in `/shared/config.js`.
4. Use English as the main project language:
    - variables
    - function names
    - comments
    - filenames where reasonable
5. Update i18n translations whenever visible output text changes:
    - `/shared/locales/de.json`
    - `/shared/locales/en.json`
6. Avoid ultra-long source files. Split code into clear modules when files become hard to read.
7. Add readable comments:
    - at the beginning of each source file
    - above every function
    - inside complex code sections
8. Keep comments practical and useful for a new developer. Avoid obvious comments that only repeat the code. Note code fixes as comment to avoid future confusion.
9. Prefer clear, maintainable code over clever shortcuts.
10. Do not introduce dependencies unless they are clearly needed.
11. When adding dependencies, update the relevant `package.json` and document why the dependency is needed.
12. Keep shared logic in `/shared` when it is used by more than one subproject.
13. Do not duplicate configuration logic across `/viewer`, `/tray` and `/screensaver`.
14. Handle errors explicitly and provide useful log messages.
15. Avoid breaking existing user settings or stored configuration values.
16. Do not rename existing configuration keys without adding migration logic.
17. Any user-visible change must be reflected in both German and English translations.
18. Keep the tray recorder lightweight. It should not perform heavy UI work.
19. Keep OCR processing isolated in `/screensaver` where possible.
20. Test changes on Windows or keep the implementation clearly Windows-safe.

## Development expectations

Before changing code:

- Check whether the functionality already exists in `/shared`.
- Check whether visible text needs i18n updates.
- Check whether the change affects the viewer, tray app or screensaver.
- Keep file sizes reasonable.

After changing code:

- Verify that the Electron app still starts.
- Verify that Windows paths are handled correctly.
- Verify that configuration still loads from `/shared/config.js`.
- Verify that changed visible text exists in both locale files.