# electron-builder generates temporary files then tells NSIS to generate the
# installer. These files will have unreliable modification times which NSIS
# will save by default, resulting in the installer changing each time it is
# generated. We disable that so that to improve reproducibility.
SetDateSave off

# Offer Plus Desktop in Open With without replacing the user's default editor.
!define PLUS_PROJECT_PROGID "TurboWarpPlusDesktop.Project"
!macro plusRegisterProjectType EXT LABEL
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PLUS_PROJECT_PROGID}.${EXT}" "" "${LABEL}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\${PLUS_PROJECT_PROGID}.${EXT}" "AllowSilentDefaultTakeOver"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PLUS_PROJECT_PROGID}.${EXT}\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PLUS_PROJECT_PROGID}.${EXT}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PLUS_PROJECT_PROGID}.${EXT}"
!macroend

!macro plusUnregisterProjectType EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PLUS_PROJECT_PROGID}.${EXT}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${PLUS_PROJECT_PROGID}.${EXT}"
!macroend

!macro customInstall
  !insertmacro plusRegisterProjectType "sb3" "Scratch 3 Project (TurboWarp Plus Desktop)"
  !insertmacro plusRegisterProjectType "sb2" "Scratch 2 Project (TurboWarp Plus Desktop)"
  !insertmacro plusRegisterProjectType "sb" "Scratch 1 Project (TurboWarp Plus Desktop)"
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

!macro customUnInstall
  !insertmacro plusUnregisterProjectType "sb3"
  !insertmacro plusUnregisterProjectType "sb2"
  !insertmacro plusUnregisterProjectType "sb"
!macroend
