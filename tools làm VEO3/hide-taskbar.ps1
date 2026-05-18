param(
    [Parameter(Mandatory=$true)]
    [int]$ProcessId
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
"@

$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x00000080
$WS_EX_APPWINDOW = 0x00040000

for ($i = 0; $i -lt 15; $i++) {
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) {
        $hWnd = $proc.MainWindowHandle
        $style = [Win]::GetWindowLong($hWnd, $GWL_EXSTYLE)
        
        # Thêm thuộc tính ToolWindow và bỏ thuộc tính AppWindow để ẩn khỏi taskbar
        $style = $style -bor $WS_EX_TOOLWINDOW
        $style = $style -band (-bnot $WS_EX_APPWINDOW)
        
        [Win]::SetWindowLong($hWnd, $GWL_EXSTYLE, $style)
        Write-Host "Taskbar icon hidden successfully."
        exit 0
    }
    Start-Sleep -Milliseconds 500
}
Write-Host "Could not find Chrome window handle within the timeout."
exit 1
