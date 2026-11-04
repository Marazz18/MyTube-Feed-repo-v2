@echo off
rem Zkopíruje soubory feedu z kořene repozitáře do assets Android aplikace
set A=%~dp0app\src\main\assets
for %%f in (feed.html feed.js feed.css shared.js sync.js nostr.bundle.js addlink.js) do copy /Y "%~dp0..\%%f" "%A%\" >nul
echo Hotovo - assets zkopirovany.
