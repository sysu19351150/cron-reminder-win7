# Win7 定时提醒 - 系统托盘助手
# 由 server.js 以隐藏窗口方式启动，负责：
#   1) 隐藏主程序的控制台窗口（仅打包 exe 且控制台独占时）
#   2) 在通知区显示托盘图标，提供「打开提醒配置 / 全局设置 / 退出程序」
# 兼容性要求：必须能在 Windows 7 自带的 PowerShell 2.0 上运行，
# 不能使用 PS3+ 语法（如 [ordered]、ConvertFrom-Json、Get-CimInstance 等）。

param(
  [int]$ServerPid = 0,
  [int]$Port = 28765,
  [string]$ExePath = '',
  [string]$StopFile = '',
  [int]$HideConsole = 0
)

$ErrorActionPreference = 'Continue'

$script:serverPid = $ServerPid
$script:port = $Port
$script:stopFile = $StopFile
$script:notify = $null
$script:consoleHidden = $false

# ---------- 托盘图标与右键菜单 ----------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object -TypeName System.Windows.Forms.NotifyIcon

$icon = $null
if ($ExePath -ne '' -and (Test-Path -LiteralPath $ExePath)) {
  try { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($ExePath) } catch { $icon = $null }
}
if ($null -eq $icon) { $icon = [System.Drawing.SystemIcons]::Application }
$notify.Icon = $icon
$notify.Text = '定时提醒 - 后台运行中'

function Open-ReminderPage([string]$path) {
  $url = 'http://localhost:' + $script:port + $path
  try {
    Start-Process $url
  } catch {
    try { [System.Diagnostics.Process]::Start($url) | Out-Null } catch { }
  }
}

function Close-Tray {
  try {
    $script:notify.Visible = $false
    $script:notify.Dispose()
  } catch { }
  [System.Windows.Forms.Application]::Exit()
}

# 用户在设置页关闭托盘时，把之前藏起来的控制台重新显示出来，
# 否则控制台会一直隐藏到下次重启，看起来像程序无界面在跑
function Show-ServerConsole {
  try {
    # 打包模式启动时已经编译过 ReminderConsole（隐藏控制台用），直接复用；
    # 只有源码模式（控制台本来就没藏）才需要临时编译一个最小版本
    if ($null -ne ('ReminderConsole' -as [type])) {
      [ReminderConsole]::ShowConsoleOf([uint32]$script:serverPid) | Out-Null
      return
    }
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ReminderConsoleShow
{
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    public static bool ShowConsoleOf(uint pid)
    {
        FreeConsole();
        if (!AttachConsole(pid)) return false;
        IntPtr h = GetConsoleWindow();
        bool shown = false;
        if (h != IntPtr.Zero) shown = ShowWindow(h, 5);
        FreeConsole();
        return shown;
    }
}
"@ -ErrorAction Stop
    [ReminderConsoleShow]::ShowConsoleOf([uint32]$script:serverPid) | Out-Null
  } catch {
    # 显示失败不影响退出流程
  }
}

$menu = New-Object -TypeName System.Windows.Forms.ContextMenuStrip

$itemMain = New-Object -TypeName System.Windows.Forms.ToolStripMenuItem -ArgumentList '打开提醒配置'
$itemMain.add_Click({ Open-ReminderPage '/' })

$itemConfig = New-Object -TypeName System.Windows.Forms.ToolStripMenuItem -ArgumentList '全局设置'
$itemConfig.add_Click({ Open-ReminderPage '/config' })

$separator = New-Object -TypeName System.Windows.Forms.ToolStripSeparator

$itemExit = New-Object -TypeName System.Windows.Forms.ToolStripMenuItem -ArgumentList '退出程序'
$itemExit.add_Click({
  try { Stop-Process -Id $script:serverPid -Force -ErrorAction SilentlyContinue } catch { }
  Close-Tray
})

[void]$menu.Items.Add($itemMain)
[void]$menu.Items.Add($itemConfig)
[void]$menu.Items.Add($separator)
[void]$menu.Items.Add($itemExit)

$notify.ContextMenuStrip = $menu
$notify.add_DoubleClick({ Open-ReminderPage '/' })
$notify.Visible = $true
$script:notify = $notify

# ---------- 隐藏主程序的控制台窗口 ----------
# 用 AttachConsole 挂到主进程的控制台再 ShowWindow(SW_HIDE)。
# 如果控制台里还挂着别的进程（例如用户从 cmd 里启动 exe），说明是共享控制台，
# 此时不能隐藏，否则会把用户的命令行窗口一起藏掉。
if ($HideConsole -eq 1 -and $ServerPid -gt 0) {
  try {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ReminderConsole
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll")]
    public static extern uint GetConsoleProcessList(uint[] lpdwProcessList, uint dwProcessCount);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    public static bool HideConsoleOf(uint pid, uint selfPid)
    {
        FreeConsole();
        if (!AttachConsole(pid)) return false;
        uint[] list = new uint[16];
        uint count = GetConsoleProcessList(list, (uint)list.Length);
        bool onlyServerAndSelf = true;
        for (uint i = 0; i < count && i < (uint)list.Length; i++)
        {
            uint p = list[i];
            if (p != 0 && p != pid && p != selfPid)
            {
                onlyServerAndSelf = false;
                break;
            }
        }
        bool performed = false;
        if (onlyServerAndSelf)
        {
            IntPtr h = GetConsoleWindow();
            if (h != IntPtr.Zero)
            {
                ShowWindow(h, 0);
                performed = true; // 即使本来已隐藏，也算接管成功
            }
        }
        FreeConsole();
        return performed;
    }

    // 与 HideConsoleOf 共用同一个已编译类型，关闭托盘时无需再临时编译
    public static bool ShowConsoleOf(uint pid)
    {
        FreeConsole();
        if (!AttachConsole(pid)) return false;
        IntPtr h = GetConsoleWindow();
        bool shown = false;
        if (h != IntPtr.Zero) shown = ShowWindow(h, 5);
        FreeConsole();
        return shown;
    }
}
"@ -ErrorAction Stop

    if ([ReminderConsole]::HideConsoleOf([uint32]$ServerPid, [uint32]$PID)) {
      $script:consoleHidden = $true
    }
  } catch {
    # 隐藏失败不影响托盘本身，控制台会继续保持可见
  }
}

# 第一次出现时提示一下，避免控制台被隐藏后用户以为程序没启动
try {
  $notify.ShowBalloonTip(4000, '定时提醒', '服务已在后台运行，双击托盘图标打开配置页', [System.Windows.Forms.ToolTipIcon]::Info)
} catch { }

# ---------- 监控主程序 ----------
# 主程序退出或收到停止标记时，托盘图标一起消失，避免残留幽灵图标
$script:timer = New-Object -TypeName System.Windows.Forms.Timer
# 1 秒轮询：主程序被强杀或用户关闭托盘时能更快收掉图标/恢复控制台
$script:timer.Interval = 1000
$script:timer.add_Tick({
  $serverAlive = $false
  try {
    $proc = [System.Diagnostics.Process]::GetProcessById($script:serverPid)
    if (-not $proc.HasExited) { $serverAlive = $true }
  } catch { $serverAlive = $false }

  if (-not $serverAlive) {
    $script:timer.Stop()
    Close-Tray
    return
  }

  if ($script:stopFile -ne '' -and (Test-Path -LiteralPath $script:stopFile)) {
    $command = ''
    try { $command = [System.IO.File]::ReadAllText($script:stopFile).Trim() } catch { }
    $script:timer.Stop()
    if ($command -eq 'show' -and $script:consoleHidden) { Show-ServerConsole }
    Close-Tray
  }
})
$script:timer.Start()

[System.Windows.Forms.Application]::Run()

# 退出前兜底清理
try {
  if ($null -ne $script:notify) {
    $script:notify.Visible = $false
    $script:notify.Dispose()
  }
} catch { }
