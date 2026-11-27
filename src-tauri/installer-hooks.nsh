; Instalaciones anteriores de Sloth hechas con Electron: se desinstala el programa viejo antes de instalar
; este, para que no queden dos Sloth ni accesos directos repetidos. Los datos (%APPDATA%\Sloth) no se tocan:
; la versión nueva sigue usando la misma carpeta.
!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$LOCALAPPDATA\Programs\Sloth\Uninstall Sloth.exe" 0 +4
    ExecWait '"$LOCALAPPDATA\Programs\Sloth\Uninstall Sloth.exe" /currentuser /S _?=$LOCALAPPDATA\Programs\Sloth'
    RMDir /r "$LOCALAPPDATA\Programs\Sloth"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\0169b5fe-df85-51bc-8c3c-54b3276a08d2"
!macroend

; electron-updater lanza el instalador con --force-run y espera que la app vuelva a abrirse sola.
!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  ${GetParameters} $R1
  ${GetOptions} $R1 "--force-run" $R0
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${EndIf}
!macroend
