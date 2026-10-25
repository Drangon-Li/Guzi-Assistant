!macro RemoveGuziCaptureVerb Extension
  ReadRegStr $R0 HKCU "Software\Classes\SystemFileAssociations\${Extension}\shell\GuziAssistant.Capture\command" ""
  ${If} $R0 == '$\"$INSTDIR\GuziAssistant.exe$\" --guzi-capture-file $\"%1$\"'
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${Extension}\shell\GuziAssistant.Capture"
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    !insertmacro RemoveGuziCaptureVerb ".png"
    !insertmacro RemoveGuziCaptureVerb ".jpg"
    !insertmacro RemoveGuziCaptureVerb ".jpeg"
    !insertmacro RemoveGuziCaptureVerb ".webp"
    !insertmacro RemoveGuziCaptureVerb ".gif"
    !insertmacro RemoveGuziCaptureVerb ".bmp"
    !insertmacro RemoveGuziCaptureVerb ".txt"
    !insertmacro RemoveGuziCaptureVerb ".md"
    !insertmacro RemoveGuziCaptureVerb ".eml"
    !insertmacro RemoveGuziCaptureVerb ".csv"
    !insertmacro RemoveGuziCaptureVerb ".log"
    !insertmacro RemoveGuziCaptureVerb ".pdf"
    !insertmacro RemoveGuziCaptureVerb ".docx"
  ${EndIf}
!macroend
