Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class TestWinsta {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  delegate bool EnumDesktopProc(string desktop, IntPtr l);
  delegate bool EnumWindowStationProc(string winsta, IntPtr l);

  [DllImport("user32.dll")] static extern bool EnumWindowStations(EnumWindowStationProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr OpenWindowStation(string name, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool SetProcessWindowStation(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool SetThreadDesktop(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);

  public static void Run() {
    Console.WriteLine("EnumWindowStations:");
    EnumWindowStations((w, l) => {
      Console.WriteLine("  Winsta: " + w);
      return true;
    }, IntPtr.Zero);

    IntPtr hwinsta = OpenWindowStation("winsta0", false, 0x037F);
    Console.WriteLine("OpenWindowStation winsta0: " + hwinsta);
    if (hwinsta != IntPtr.Zero) {
      SetProcessWindowStation(hwinsta);
    }

    IntPtr hdesk = OpenDesktop("default", 0, false, 0x01FF);
    Console.WriteLine("OpenDesktop default: " + hdesk);
    if (hdesk != IntPtr.Zero) {
      SetThreadDesktop(hdesk);
      int count = 0;
      EnumDesktopWindows(hdesk, (h, l) => {
        count++;
        var sb = new StringBuilder(256);
        GetWindowText(h, sb, 256);
        string t = sb.ToString();
        if (!string.IsNullOrEmpty(t)) {
          Console.WriteLine("    " + h.ToInt64() + " -> " + t);
        }
        return true;
      }, IntPtr.Zero);
      Console.WriteLine("Total desktop windows: " + count);
    }
  }
}
"@
[TestWinsta]::Run()

