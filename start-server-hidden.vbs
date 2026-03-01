Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d ""C:\Users\Ken\Desktop\claude-corpus\server"" && node index.js", 0, False
