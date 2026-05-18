Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition "
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class WindowWrapper : IWin32Window {
    public IntPtr Handle { get; private set; }
    public WindowWrapper(IntPtr handle) { Handle = handle; }
}

public class Win32 {
    [DllImport(\"user32.dll\")]
    public static extern IntPtr GetForegroundWindow();
}
"

$hwnd = [Win32]::GetForegroundWindow()
$parent = New-Object WindowWrapper($hwnd)

$dlg = New-Object System.Windows.Forms.SaveFileDialog
$dlg.Title = 'Chon thu muc luu - Go duong dan vao o File name'
$dlg.FileName = 'Chon thu muc nay'
$dlg.Filter = 'Thu muc|*.this.directory'
$dlg.OverwritePrompt = $false
$dlg.CheckFileExists = $false
$dlg.CheckPathExists = $true
$dlg.ValidateNames = $false
$dlg.InitialDirectory = [Environment]::GetFolderPath('MyPictures')

$result = $dlg.ShowDialog($parent)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output ([System.IO.Path]::GetDirectoryName($dlg.FileName))
}