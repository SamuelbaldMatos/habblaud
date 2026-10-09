param(
  [ValidateSet("Start", "Stop", "Install", "Uninstall", "Watch")]
  [string]$Action = "Start"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $env:LOCALAPPDATA "Habblaud\wallpaper"
$stateFile = Join-Path $stateDir "state.json"
$logFile = Join-Path $stateDir "wallpaper.log"
$startupLink = Join-Path ([Environment]::GetFolderPath("Startup")) "Habblaud Wallpaper.lnk"
$wallpaperUrl = if ($env:HABBLAUD_WALLPAPER_URL) {
  $env:HABBLAUD_WALLPAPER_URL
} else {
  "http://127.0.0.1:4747/?wallpaper=1"
}

function Write-WallpaperLog([string]$Message) {
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Get-EdgePath {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  $command = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "Microsoft Edge nao foi encontrado."
}

function Wait-Habblaud {
  $uri = [Uri]$wallpaperUrl
  $healthUrl = "{0}://{1}:{2}/api/health" -f $uri.Scheme, $uri.Host, $uri.Port
  $deadline = (Get-Date).AddSeconds(120)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
    } catch {
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $uri.GetLeftPart("Authority") -TimeoutSec 3
        if ($response.StatusCode -eq 200) { return }
      } catch {}
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "Habblaud nao respondeu em $($uri.GetLeftPart('Authority')) depois de 120 segundos."
}

function Initialize-NativeApi {
  if ("HabblaudWallpaper.Native" -as [type]) { return }
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace HabblaudWallpaper {
  public static class Native {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr child);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hwnd, int index);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hwnd, int index, int value);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr handle);

    public static IntPtr FindWallpaperHost() {
      IntPtr progman = FindWindow("Progman", null);
      IntPtr result;
      if (progman != IntPtr.Zero) {
        SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(1), 0, 1000, out result);
        SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out result);
      }
      IntPtr host = IntPtr.Zero;
      EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
        IntPtr view = FindWindowEx(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (view != IntPtr.Zero) {
          IntPtr worker = FindWindowEx(IntPtr.Zero, hwnd, "WorkerW", null);
          if (worker != IntPtr.Zero) host = worker;
        }
        return true;
      }, IntPtr.Zero);
      return host != IntPtr.Zero ? host : progman;
    }

    public static IntPtr FindDesktopView() {
      IntPtr view = IntPtr.Zero;
      EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
        IntPtr child = FindWindowEx(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (child != IntPtr.Zero) view = child;
        return true;
      }, IntPtr.Zero);
      return view;
    }
  }
}
"@
}

function Get-WallpaperHost {
  Initialize-NativeApi
  return [HabblaudWallpaper.Native]::FindWallpaperHost()
}

function Find-EdgeWindow([datetime]$StartedAfter) {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $window = Get-Process msedge -ErrorAction SilentlyContinue |
      Where-Object {
        $_.MainWindowHandle -ne 0 -and
        $_.MainWindowTitle -like "*Habblaud*"
      } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
    if ($window) { return $window }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "A janela do Habblaud nao apareceu no Edge."
}

function Attach-Wallpaper([IntPtr]$WindowHandle) {
  Initialize-NativeApi
  $hostHandle = Get-WallpaperHost
  if ($hostHandle -eq [IntPtr]::Zero) { throw "A camada do papel de parede do Windows nao foi encontrada." }

  $GWL_STYLE = -16
  $GWL_EXSTYLE = -20
  $WS_CHILD = 0x40000000
  $WS_CAPTION = 0x00C00000
  $WS_THICKFRAME = 0x00040000
  $WS_EX_APPWINDOW = 0x00040000
  $WS_EX_TOOLWINDOW = 0x00000080
  $WS_EX_NOACTIVATE = 0x08000000
  $style = [HabblaudWallpaper.Native]::GetWindowLong($WindowHandle, $GWL_STYLE)
  $style = ($style -band (-bnot ($WS_CAPTION -bor $WS_THICKFRAME))) -bor $WS_CHILD
  [void][HabblaudWallpaper.Native]::SetWindowLong($WindowHandle, $GWL_STYLE, $style)
  $exStyle = [HabblaudWallpaper.Native]::GetWindowLong($WindowHandle, $GWL_EXSTYLE)
  $exStyle = ($exStyle -band (-bnot $WS_EX_APPWINDOW)) -bor $WS_EX_TOOLWINDOW -bor $WS_EX_NOACTIVATE
  [void][HabblaudWallpaper.Native]::SetWindowLong($WindowHandle, $GWL_EXSTYLE, $exStyle)
  [void][HabblaudWallpaper.Native]::SetParent($WindowHandle, $hostHandle)

  Add-Type -AssemblyName System.Windows.Forms
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $insertAfter = [IntPtr]1
  $desktopView = [HabblaudWallpaper.Native]::FindDesktopView()
  if ($desktopView -ne [IntPtr]::Zero -and [HabblaudWallpaper.Native]::GetParent($desktopView) -eq $hostHandle) {
    # Mesmo pai: fica imediatamente abaixo dos ícones, mas acima da imagem estática.
    $insertAfter = $desktopView
  }
  [void][HabblaudWallpaper.Native]::SetWindowPos(
    $WindowHandle, $insertAfter, 0, 0, $bounds.Width, $bounds.Height, 0x0040
  )
  [void][HabblaudWallpaper.Native]::ShowWindow($WindowHandle, 5)
  return $hostHandle
}

function Read-State {
  if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
  try { return Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json } catch { return $null }
}

function Stop-Wallpaper {
  $state = Read-State
  if ($state -and $state.windowHandle) {
    Initialize-NativeApi
    [void][HabblaudWallpaper.Native]::PostMessage([IntPtr]$state.windowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 800
  }
  if ($state -and $state.pid) {
    $process = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
    if ($process) { Stop-Process -Id $state.pid -Force }
  }
  $edgeProfile = Join-Path $stateDir "edge-profile"
  Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$edgeProfile*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
  Write-WallpaperLog "Papel de parede encerrado."
}

function Get-HabblaudBaseUrl {
  return ([Uri]$wallpaperUrl).GetLeftPart("Authority")
}

function Open-HabblaudSettings {
  $edgePath = Get-EdgePath
  $settingsData = Join-Path $stateDir "settings-profile"
  New-Item -ItemType Directory -Force -Path $settingsData | Out-Null
  $settingsUrl = "$(Get-HabblaudBaseUrl)/?settings=1"
  $arguments = @(
    "--app=$settingsUrl",
    "--user-data-dir=$settingsData",
    "--no-first-run",
    "--disable-background-mode"
  )
  Start-Process -FilePath $edgePath -ArgumentList $arguments | Out-Null
}

function Set-HabblaudTheme([string]$Theme) {
  $body = @{ theme = $Theme } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$(Get-HabblaudBaseUrl)/api/theme" -ContentType "application/json" -Body $body -TimeoutSec 5 | Out-Null
}

function Sync-TrayTheme($ThemeMenu) {
  try {
    $current = (Invoke-RestMethod -Uri "$(Get-HabblaudBaseUrl)/api/theme" -TimeoutSec 3).theme
    foreach ($item in $ThemeMenu.DropDownItems) {
      $item.Checked = ([string]$item.Tag -eq [string]$current)
    }
  } catch {}
}

function New-HabblaudTray {
  Initialize-NativeApi
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $tray = New-Object System.Windows.Forms.NotifyIcon
  $tray.Text = "Habblaud - papel de parede ativo"
  $iconPath = Join-Path $projectRoot "client\public\assets\brand\icon-192.png"
  $icon = $null
  if (Test-Path -LiteralPath $iconPath) {
    $bitmap = [System.Drawing.Bitmap]::FromFile($iconPath)
    $iconHandle = $bitmap.GetHicon()
    $icon = [System.Drawing.Icon]([System.Drawing.Icon]::FromHandle($iconHandle).Clone())
    [void][HabblaudWallpaper.Native]::DestroyIcon($iconHandle)
    $bitmap.Dispose()
  } else {
    $icon = [System.Drawing.SystemIcons]::Application
  }
  $tray.Icon = $icon

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = $menu.Items.Add("Abrir configuracoes")
  $openItem.Font = [System.Drawing.Font]::new($openItem.Font, [System.Drawing.FontStyle]::Bold)
  $openItem.Add_Click({ Open-HabblaudSettings })
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $themeMenu = New-Object System.Windows.Forms.ToolStripMenuItem("Tema")
  $themes = [ordered]@{
    "Original" = "original"
    "Medieval" = "medieval"
    "Terror" = "horror"
    "Extraterrestre" = "alien"
  }
  foreach ($label in $themes.Keys) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem($label)
    $item.Tag = $themes[$label]
    $item.Add_Click({
      param($sender)
      try {
        Set-HabblaudTheme ([string]$sender.Tag)
        foreach ($themeItem in $sender.Owner.Items) {
          $themeItem.Checked = ($themeItem -eq $sender)
        }
      } catch {
        Write-WallpaperLog "Nao foi possivel trocar o tema pela bandeja: $($_.Exception.Message)"
      }
    })
    [void]$themeMenu.DropDownItems.Add($item)
  }
  [void]$menu.Items.Add($themeMenu)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $exitItem = $menu.Items.Add("Encerrar Habblaud")
  $exitItem.Add_Click({ Stop-Wallpaper })
  $tray.ContextMenuStrip = $menu
  $tray.Add_DoubleClick({ Open-HabblaudSettings })
  $tray.Visible = $true
  Sync-TrayTheme $themeMenu
  Write-WallpaperLog "Widget da bandeja iniciado."

  return [pscustomobject]@{ Notify = $tray; Menu = $menu; ThemeMenu = $themeMenu; Icon = $icon }
}

function Remove-HabblaudTray($TrayState) {
  if (-not $TrayState) { return }
  $TrayState.Notify.Visible = $false
  $TrayState.Notify.Dispose()
  $TrayState.Menu.Dispose()
  if ($TrayState.Icon -and $TrayState.Icon -ne [System.Drawing.SystemIcons]::Application) {
    $TrayState.Icon.Dispose()
  }
}

function Watch-Wallpaper {
  $edge = $null
  $trayState = $null
  try {
    Wait-Habblaud
    $edgePath = Get-EdgePath
    $edgeData = Join-Path $stateDir "edge-profile"
    New-Item -ItemType Directory -Force -Path $edgeData | Out-Null
    $startedAt = Get-Date
    $arguments = @(
      "--app=$wallpaperUrl",
      "--start-fullscreen",
      "--user-data-dir=$edgeData",
      "--no-first-run",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--autoplay-policy=no-user-gesture-required"
    )
    Start-Process -FilePath $edgePath -ArgumentList $arguments | Out-Null
    $edge = Find-EdgeWindow $startedAt
    $handle = [IntPtr]$edge.MainWindowHandle
    $wallpaperParent = Attach-Wallpaper $handle
  } catch {
    if ($edge) {
      [void][HabblaudWallpaper.Native]::PostMessage([IntPtr]$edge.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    }
    throw
  }
  $startedStateAt = (Get-Date).ToString("o")
  @{ pid = $edge.Id; windowHandle = $handle.ToInt64(); hostHandle = $wallpaperParent.ToInt64(); startedAt = $startedStateAt } |
    ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
  Write-WallpaperLog "Papel de parede iniciado (PID $($edge.Id))."

  try {
    $trayState = New-HabblaudTray
    while (Test-Path -LiteralPath $stateFile) {
      for ($tick = 0; $tick -lt 50 -and (Test-Path -LiteralPath $stateFile); $tick++) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 100
      }
      if (-not (Test-Path -LiteralPath $stateFile)) { break }
      Sync-TrayTheme $trayState.ThemeMenu
      $process = Get-Process -Id $edge.Id -ErrorAction SilentlyContinue
      if (-not $process) { break }
      $liveWindow = Get-Process msedge -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*Habblaud*" } |
        Select-Object -First 1
      if ($liveWindow -and [IntPtr]$liveWindow.MainWindowHandle -ne $handle) {
        $edge = $liveWindow
        $handle = [IntPtr]$liveWindow.MainWindowHandle
        $wallpaperParent = Attach-Wallpaper $handle
        @{ pid = $edge.Id; windowHandle = $handle.ToInt64(); hostHandle = $wallpaperParent.ToInt64(); startedAt = $startedStateAt } |
          ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
        Write-WallpaperLog "Novo handle do Edge reconectado ($($handle.ToInt64()))."
      }
      $currentHost = Get-WallpaperHost
      if ($currentHost -ne $wallpaperParent) {
        $wallpaperParent = Attach-Wallpaper $handle
        Write-WallpaperLog "Janela reconectada depois da reinicializacao do Explorer."
      }
    }
  } finally {
    Remove-HabblaudTray $trayState
    Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
  }
}

function Start-Wallpaper {
  $state = Read-State
  if ($state -and (Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) {
    Write-Output "O papel de parede do Habblaud ja esta ativo."
    return
  }
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $powershell = (Get-Process -Id $PID).Path
  $args = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", "`"$PSCommandPath`"", "-Action", "Watch"
  )
  Start-Process -FilePath $powershell -ArgumentList $args -WindowStyle Hidden | Out-Null
  Write-Output "Habblaud esta iniciando como papel de parede."
}

function Install-Startup {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($startupLink)
  $shortcut.TargetPath = (Get-Process -Id $PID).Path
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Action Start"
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.WindowStyle = 7
  $shortcut.Description = "Inicia o escritorio Habblaud como papel de parede"
  $shortcut.Save()
  Write-Output "Inicializacao automatica ativada."
  Start-Wallpaper
}

function Uninstall-Startup {
  Remove-Item -LiteralPath $startupLink -Force -ErrorAction SilentlyContinue
  Stop-Wallpaper
  Write-Output "Inicializacao automatica removida."
}

try {
  switch ($Action) {
    "Start" { Start-Wallpaper }
    "Stop" { Stop-Wallpaper }
    "Install" { Install-Startup }
    "Uninstall" { Uninstall-Startup }
    "Watch" { Watch-Wallpaper }
  }
} catch {
  Write-WallpaperLog "ERRO: $($_.Exception.Message)"
  Write-Error $_.Exception.Message
  exit 1
}
