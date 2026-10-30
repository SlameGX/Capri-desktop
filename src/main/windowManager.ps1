param(
  [string]$Action = "list",
  [long]$Hwnd = 0,
  [int]$Width = 0,
  [int]$Height = 0,
  [int]$X = -1,
  [int]$Y = -1,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class WinApi {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
  [DllImport("user32.dll")] static extern IntPtr OpenWindowStation(string name, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool SetProcessWindowStation(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool SetThreadDesktop(IntPtr h);

  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x80;
  const int WS_EX_NOACTIVATE = 0x08000000;
  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  const int DWMWA_CLOAKED = 14;

  static IntPtr currentHdesk = IntPtr.Zero;

  public static void Init() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {}
    try {
      IntPtr hwinsta = OpenWindowStation("WinSta0", false, 0x037F);
      if (hwinsta != IntPtr.Zero) {
        SetProcessWindowStation(hwinsta);
      }
      currentHdesk = OpenDesktop("default", 0, false, 0x01FF);
      if (currentHdesk != IntPtr.Zero) {
        SetThreadDesktop(currentHdesk);
      }
    } catch {}
  }

  public static string EscapeJson(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n").Replace("\t", " ");
  }

  public static string ListWindows() {
    Init();
    IntPtr fg = GetForegroundWindow();
    var sb = new StringBuilder();
    sb.Append("[");
    int count = 0;

    EnumProc callback = (h, l) => {
      bool iconic = IsIconic(h);
      if (!IsWindowVisible(h) && !iconic) return true;
      int ex = GetWindowLong(h, GWL_EXSTYLE);
      if ((ex & WS_EX_TOOLWINDOW) != 0) return true;

      int cloaked;
      if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0 && !iconic) return true;

      var cls = new StringBuilder(64);
      GetClassName(h, cls, 64);
      string c = cls.ToString();
      if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Windows.UI.Core.CoreWindow") return true;

      var tb = new StringBuilder(512);
      GetWindowText(h, tb, 512);
      string title = tb.ToString().Trim();
      if (string.IsNullOrEmpty(title)) return true;
      if (title == "Program Manager" || title == "Windows Input Experience" || title == "DesktopWindowXamlSource" || title == "Default IME" || title == "MSCTFIME UI") return true;

      uint pid;
      GetWindowThreadProcessId(h, out pid);
      string procName = "";
      try {
        procName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
      } catch {}

      bool zoomed = IsZoomed(h);

      RECT r;
      if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, 16) != 0) {
        GetWindowRect(h, out r);
      }
      int w = Math.Max(0, r.Right - r.Left);
      int height = Math.Max(0, r.Bottom - r.Top);

      if (!iconic && (w < 40 || height < 40)) return true;

      if (count > 0) sb.Append(",");
      count++;

      sb.Append("{\"hwnd\":").Append(h.ToInt64())
        .Append(",\"pid\":").Append(pid)
        .Append(",\"process\":\"").Append(EscapeJson(procName)).Append("\"")
        .Append(",\"title\":\"").Append(EscapeJson(title)).Append("\"")
        .Append(",\"minimized\":").Append(iconic ? "true" : "false")
        .Append(",\"maximized\":").Append(zoomed ? "true" : "false")
        .Append(",\"active\":").Append(h == fg ? "true" : "false")
        .Append(",\"x\":").Append(r.Left)
        .Append(",\"y\":").Append(r.Top)
        .Append(",\"w\":").Append(w)
        .Append(",\"h\":").Append(height)
        .Append("}");

      return true;
    };

    if (currentHdesk != IntPtr.Zero) {
      EnumDesktopWindows(currentHdesk, callback, IntPtr.Zero);
    } else {
      EnumDesktopWindows(IntPtr.Zero, callback, IntPtr.Zero);
    }

    sb.Append("]");
    return sb.ToString();
  }

  public static bool FocusWindow(long hwndVal) {
    Init();
    IntPtr h = new IntPtr(hwndVal);
    if (!IsWindow(h)) return false;
    if (IsIconic(h)) {
      ShowWindow(h, 9); // SW_RESTORE
    }
    IntPtr fg = GetForegroundWindow();
    if (fg == h) return true;
    uint unused;
    uint fgThread = GetWindowThreadProcessId(fg, out unused);
    uint curThread = GetCurrentThreadId();
    if (fgThread != curThread && fgThread != 0) {
      AttachThreadInput(curThread, fgThread, true);
      SetForegroundWindow(h);
      AttachThreadInput(curThread, fgThread, false);
    } else {
      SetForegroundWindow(h);
    }
    return true;
  }

  public static bool MinimizeWindow(long hwndVal) {
    Init();
    IntPtr h = new IntPtr(hwndVal);
    if (!IsWindow(h)) return false;
    return ShowWindowAsync(h, 6); // SW_MINIMIZE
  }

  public static bool MaximizeWindow(long hwndVal) {
    Init();
    IntPtr h = new IntPtr(hwndVal);
    if (!IsWindow(h)) return false;
    return ShowWindowAsync(h, 3); // SW_MAXIMIZE
  }

  public static bool RestoreWindow(long hwndVal) {
    Init();
    IntPtr h = new IntPtr(hwndVal);
    if (!IsWindow(h)) return false;
    return ShowWindowAsync(h, 9); // SW_RESTORE
  }

  public static bool ResizeWindow(long hwndVal, int w, int h, int x, int y) {
    Init();
    IntPtr hwnd = new IntPtr(hwndVal);
    if (!IsWindow(hwnd)) return false;
    if (IsZoomed(hwnd)) {
      ShowWindow(hwnd, 9);
    }
    RECT r;
    GetWindowRect(hwnd, out r);
    int posX = (x >= 0) ? x : r.Left;
    int posY = (y >= 0) ? y : r.Top;
    int width = (w > 0) ? w : (r.Right - r.Left);
    int height = (h > 0) ? h : (r.Bottom - r.Top);
    return MoveWindow(hwnd, posX, posY, width, height, true);
  }

  public static bool CloseWindow(long hwndVal) {
    Init();
    IntPtr h = new IntPtr(hwndVal);
    if (!IsWindow(h)) return false;
    PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
    return true;
  }
}
"@

switch ($Action.ToLower()) {
  "list" {
    [Console]::Out.WriteLine([WinApi]::ListWindows())
  }
  "focus" {
    $ok = [WinApi]::FocusWindow($Hwnd)
    if ($ok) { Write-Output '{"ok":true}' } else { Write-Output '{"ok":false}' }
  }
  "minimize" {
    $ok = [WinApi]::MinimizeWindow($Hwnd)
    if ($ok) { Write-Output '{"ok":true}' } else { Write-Output '{"ok":false}' }
  }
  "maximize" {
    $ok = [WinApi]::MaximizeWindow($Hwnd)
    if ($ok) { Write-Output '{"ok":true}' } else { Write-Output '{"ok":false}' }
  }
  "restore" {
    $ok = [WinApi]::RestoreWindow($Hwnd)
    if ($ok) { Write-Output '{"ok":true}' } else { Write-Output '{"ok":false}' }
  }
  "resize" {
    $ok = [WinApi]::ResizeWindow($Hwnd, $Width, $Height, $X, $Y)
    if ($ok) { Write-Output '{"ok":true}' } else { Write-Output '{"ok":false}' }
  }
  "close" {
    if ($Force -and $Hwnd -gt 0) {
      $raw = [WinApi]::ListWindows()
      $items = ConvertFrom-Json $raw
      $target = $items | Where-Object { $_.hwnd -eq $Hwnd }
      if ($target -and $target.pid) {
        Stop-Process -Id $target.pid -Force -ErrorAction SilentlyContinue
        Write-Output '{"ok":true}'
        exit 0
      }
    }
    $ok = [WinApi]::CloseWindow($Hwnd)
    if ($ok) { Write-Output '{"ok":true}' } else { Write-Output '{"ok":false}' }
  }
  default {
    Write-Output '{"ok":false,"error":"Unknown action"}'
  }
}
