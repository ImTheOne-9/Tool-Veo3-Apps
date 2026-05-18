Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""& { $env:Path += ';C:\Program Files\nodejs'; node server.js }""", 0, False
