; Register Seeker as a web browser so it appears in Windows Settings > Default apps.
!macro customInstall
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker" "" "Seeker"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker\DefaultIcon" "" "$INSTDIR\Seeker.exe,0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker\shell\open\command" "" '"$INSTDIR\Seeker.exe"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker\Capabilities" "ApplicationName" "Seeker"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker\Capabilities" "ApplicationDescription" "Seeker Browser with download manager, Tor and AI"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker\Capabilities" "ApplicationIcon" "$INSTDIR\Seeker.exe,0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker\Capabilities\URLAssociations" "http" "SeekerURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker\Capabilities\URLAssociations" "https" "SeekerURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker\Capabilities\FileAssociations" ".htm" "SeekerHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker\Capabilities\FileAssociations" ".html" "SeekerHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker\Capabilities\FileAssociations" ".pdf" "SeekerHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Seeker\Capabilities\StartMenu" "StartMenuInternet" "Seeker"
  WriteRegStr HKCU "Software\RegisteredApplications" "Seeker" "Software\Clients\StartMenuInternet\Seeker\Capabilities"
  WriteRegStr HKCU "Software\Classes\SeekerHTML" "" "Seeker HTML Document"
  WriteRegStr HKCU "Software\Classes\SeekerHTML\DefaultIcon" "" "$INSTDIR\Seeker.exe,0"
  WriteRegStr HKCU "Software\Classes\SeekerHTML\shell\open\command" "" '"$INSTDIR\Seeker.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\SeekerURL" "" "Seeker URL"
  WriteRegStr HKCU "Software\Classes\SeekerURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\SeekerURL\DefaultIcon" "" "$INSTDIR\Seeker.exe,0"
  WriteRegStr HKCU "Software\Classes\SeekerURL\shell\open\command" "" '"$INSTDIR\Seeker.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Seeker"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Seeker"
  DeleteRegKey HKCU "Software\Classes\SeekerHTML"
  DeleteRegKey HKCU "Software\Classes\SeekerURL"
!macroend
