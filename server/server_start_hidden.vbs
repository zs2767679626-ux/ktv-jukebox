' KTV server launcher: starts the jukebox server hidden (no window).
' Logs to server_out.log. Pure ASCII only - no Chinese comments allowed.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c node --env-file-if-exists=.env bin/server.js >> server_out.log 2>&1", 0, False
