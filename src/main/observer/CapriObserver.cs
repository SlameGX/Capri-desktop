using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace Capri.Observer
{
    public class CapriObserver
    {
        #region Win32 API
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll")]
        public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc,
            WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);

        [DllImport("user32.dll")]
        public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

        [DllImport("user32.dll")]
        public static extern sbyte GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        public static extern bool TranslateMessage([In] ref MSG lpMsg);

        [DllImport("user32.dll")]
        public static extern IntPtr DispatchMessage([In] ref MSG lpMsg);

        [DllImport("user32.dll")]
        public static extern bool PostThreadMessage(uint idThread, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        public delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
            int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public int pt_x;
            public int pt_y;
        }

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);
        private const int SM_CXSCREEN = 0;
        private const int SM_CYSCREEN = 1;

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

        [DllImport("user32.dll")]
        public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TOOLWINDOW = 0x80;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int DWMWA_CLOAKED = 14;

        private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
        private const uint WINEVENT_OUTOFPROCESS = 0x0000;
        private const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
        private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        private const uint WM_QUIT = 0x0012;
        private const uint WM_GETOBJECT = 0x003D;
        private const int OBJID_CLIENT = unchecked((int)0xFFFFFFFC);
        private const uint SMTO_ABORTIFHUNG = 0x0002;
        #endregion

        private static IntPtr _hook = IntPtr.Zero;
        private static WinEventDelegate _hookDelegate;
        private static uint _msgThreadId = 0;
        private static IntPtr _lastForegroundHwnd = IntPtr.Zero;
        private static readonly object _stdoutLock = new object();
        private static volatile bool _cancelling = false;
        private static long _elementCounter = 0;
        private static long _selfHwnd = 0;
        private static int _parentPid = 0;

        public static void Main(string[] args)
        {
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = Encoding.UTF8;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--self" && i + 1 < args.Length)
                {
                    long.TryParse(args[i + 1], out _selfHwnd);
                }
                else if (args[i] == "--parent" && i + 1 < args.Length)
                {
                    int.TryParse(args[i + 1], out _parentPid);
                }
            }

            try
            {
                SetProcessDpiAwarenessContext(new IntPtr(-4)); // Per-monitor V2 DPI awareness
            }
            catch { }

            // Start message loop thread for WinEventHook (foreground detection)
            Thread hookThread = new Thread(RunHookLoop)
            {
                IsBackground = true,
                Name = "CapriWinEventHook"
            };
            hookThread.Start();

            // Emit ready signal
            SendEvent("ready", "{\"version\":\"1.0.0\",\"pid\":" + Process.GetCurrentProcess().Id + "}");

            // Process commands from stdin
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (string.IsNullOrEmpty(line)) continue;
                try
                {
                    ProcessCommand(line);
                }
                catch (Exception ex)
                {
                    int reqId = ExtractInt(line, "reqId", 0);
                    SendResponse(reqId, false, "{\"error\":\"Observer internal error: " + EscapeJson(ex.Message) + "\"}");
                }
            }

            // Cleanup when stdin closes
            Cleanup();
        }

        private static void RunHookLoop()
        {
            _msgThreadId = GetCurrentThreadId();
            _hookDelegate = new WinEventDelegate(OnWinEvent);
            _hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
                IntPtr.Zero, _hookDelegate, 0, 0,
                WINEVENT_OUTOFPROCESS | WINEVENT_SKIPOWNPROCESS
            );

            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }

            if (_hook != IntPtr.Zero)
            {
                UnhookWinEvent(_hook);
                _hook = IntPtr.Zero;
            }
        }

        private static void OnWinEvent(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
            int idObject, int idChild, uint dwEventThread, uint dwmsEventTime)
        {
            if (eventType == EVENT_SYSTEM_FOREGROUND && hwnd != IntPtr.Zero && hwnd != _lastForegroundHwnd)
            {
                _lastForegroundHwnd = hwnd;
                WindowInfo win = GetWindowInfo(hwnd);
                if (win != null && !string.IsNullOrEmpty(win.Title))
                {
                    SendEvent("foreground_changed", win.ToJson());
                }
            }
        }

        private static void ProcessCommand(string json)
        {
            int reqId = ExtractInt(json, "reqId", 0);
            string cmd = ExtractString(json, "cmd", "").ToLowerInvariant();

            if (cmd == "ping")
            {
                SendResponse(reqId, true, "{\"pong\":true}");
                return;
            }

            if (cmd == "cancel")
            {
                _cancelling = true;
                SendResponse(reqId, true, "{\"cancelled\":true}");
                return;
            }

            if (cmd == "foreground")
            {
                IntPtr fg = ResolveTargetHwnd(0);
                WindowInfo win = GetWindowInfo(fg);
                if (win != null)
                {
                    SendResponse(reqId, true, win.ToJson());
                }
                else
                {
                    SendResponse(reqId, false, "{\"error\":\"No active foreground window found\"}");
                }
                return;
            }

            if (cmd == "observe")
            {
                long targetHwndVal = ExtractLong(json, "hwnd", 0);
                string scope = ExtractString(json, "scope", "auto").ToLowerInvariant();
                int maxDepth = ExtractInt(json, "maxDepth", 24);
                int maxElements = ExtractInt(json, "maxElements", 800);
                int timeoutMs = ExtractInt(json, "timeoutMs", 6000);

                _cancelling = false;
                Stopwatch sw = Stopwatch.StartNew();

                List<ElementData> elements = new List<ElementData>();
                List<string> limitations = new List<string>();
                _elementCounter = 0;

                int screenW = GetSystemMetrics(SM_CXSCREEN);
                int screenH = GetSystemMetrics(SM_CYSCREEN);
                if (screenW <= 0) screenW = 1920;
                if (screenH <= 0) screenH = 1080;

                WindowInfo win = null;
                IntPtr targetHwnd = IntPtr.Zero;

                if (targetHwndVal != 0)
                {
                    targetHwnd = new IntPtr(targetHwndVal);
                    if (!IsWindow(targetHwnd)) targetHwnd = IntPtr.Zero;
                }

                IntPtr fg = GetForegroundWindow();

                if (targetHwnd == IntPtr.Zero)
                {
                    if (scope == "desktop")
                    {
                        targetHwnd = GetDesktopFolderViewHwnd();
                    }
                    else
                    {
                        if (fg != IntPtr.Zero && IsWindow(fg))
                        {
                            if (_selfHwnd != 0 && fg.ToInt64() == _selfHwnd)
                            {
                                targetHwnd = GetTopVisibleWindow();
                            }
                            else if (_parentPid != 0)
                            {
                                uint pid;
                                GetWindowThreadProcessId(fg, out pid);
                                if (pid != _parentPid) targetHwnd = fg;
                                else targetHwnd = GetTopVisibleWindow();
                            }
                            else
                            {
                                targetHwnd = fg;
                            }
                        }
                        else
                        {
                            targetHwnd = GetTopVisibleWindow();
                        }
                    }
                }

                bool isDesktop = (targetHwnd == IntPtr.Zero) || IsDesktopWindow(targetHwnd) || (scope == "desktop");

                if (isDesktop)
                {
                    targetHwnd = GetDesktopFolderViewHwnd();
                    win = new WindowInfo
                    {
                        Title = "Windows Desktop",
                        ProcessName = "explorer",
                        ProcessId = GetExplorerPid(),
                        IsVisible = true,
                        X = 0,
                        Y = 0,
                        Width = screenW,
                        Height = screenH,
                    };
                }
                else
                {
                    win = GetWindowInfo(targetHwnd);
                    if (win == null)
                    {
                        win = new WindowInfo
                        {
                            Title = "Active Window",
                            ProcessName = "Unknown",
                            ProcessId = 0,
                            IsVisible = true,
                            X = 0,
                            Y = 0,
                            Width = screenW,
                            Height = screenH,
                        };
                    }
                }

                // 1. If an active application window is targeted (e.g. YouTube in Chrome, VS Code, etc.):
                if (!isDesktop && targetHwnd != IntPtr.Zero)
                {
                    IntPtr rendererHwnd = FindWebRendererHwnd(targetHwnd);
                    if (rendererHwnd != IntPtr.Zero)
                    {
                        WakeChromiumAccessibility(rendererHwnd);
                    }

                    try
                    {
                        AutomationElement appEl = AutomationElement.FromHandle(targetHwnd);
                        if (appEl != null)
                        {
                            TraverseTree(appEl, null, "window-control", 0, maxDepth, maxElements, timeoutMs, sw, elements, limitations);
                        }
                    }
                    catch (Exception ex)
                    {
                        limitations.Add("Active window traversal error: " + ex.Message);
                    }

                    // Deep Web Content Penetration:
                    // If target hosts a web renderer (Chrome, Edge, Firefox), directly traverse the renderer root
                    // to ensure YouTube video cards, headings, and links are fully captured regardless of browser frame depth
                    if (rendererHwnd != IntPtr.Zero && elements.Count < maxElements && sw.ElapsedMilliseconds < timeoutMs && !_cancelling)
                    {
                        int webItems = 0;
                        for (int i = 0; i < elements.Count; i++)
                        {
                            if (elements[i].Type == "Heading" || elements[i].Type == "Document" || elements[i].Category == "web-content")
                                webItems++;
                        }

                        if (webItems < 8)
                        {
                            try
                            {
                                AutomationElement rendEl = AutomationElement.FromHandle(rendererHwnd);
                                if (rendEl != null)
                                {
                                    TraverseTree(rendEl, null, "web-content", 0, 26, maxElements, timeoutMs, sw, elements, limitations);
                                }
                            }
                            catch (Exception ex)
                            {
                                limitations.Add("Web renderer traversal error: " + ex.Message);
                            }
                        }
                    }

                    // Ensure active document/editor content is captured for IDEs and text editors:
                    bool hasDocContent = false;
                    for (int i = 0; i < elements.Count; i++)
                    {
                        if ((elements[i].Type == "Document" || elements[i].Category == "document-content") && !string.IsNullOrEmpty(elements[i].Value))
                        {
                            hasDocContent = true;
                            break;
                        }
                    }

                    if (!hasDocContent && elements.Count < maxElements && sw.ElapsedMilliseconds < timeoutMs)
                    {
                        try
                        {
                            AutomationElement appEl = AutomationElement.FromHandle(targetHwnd);
                            if (appEl != null)
                            {
                                AutomationElement docEl = appEl.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                                if (docEl != null)
                                {
                                    ElementData d = ExtractElementData(docEl, null);
                                    if (d != null && !ContainsElement(elements, d))
                                    {
                                        d.Category = "document-content";
                                        elements.Insert(0, d);
                                    }
                                }
                            }
                        }
                        catch { }
                    }

                    // If screen-wide scope was requested, also append taskbar context
                    if (scope == "screen" || scope == "fullscreen")
                    {
                        IntPtr taskbar = GetTaskbarHwnd();
                        if (taskbar != IntPtr.Zero && elements.Count < maxElements && sw.ElapsedMilliseconds < timeoutMs)
                        {
                            try
                            {
                                AutomationElement tbEl = AutomationElement.FromHandle(taskbar);
                                if (tbEl != null)
                                {
                                    TraverseTree(tbEl, null, "taskbar", 0, 3, maxElements, timeoutMs, sw, elements, limitations);
                                }
                            }
                            catch { }
                        }
                    }
                }
                else
                {
                    // Target is Desktop
                    IntPtr folderView = GetDesktopFolderViewHwnd();
                    if (folderView != IntPtr.Zero)
                    {
                        try
                        {
                            AutomationElement fvEl = AutomationElement.FromHandle(folderView);
                            if (fvEl != null)
                            {
                                TraverseTree(fvEl, null, "desktop-icon", 0, maxDepth, maxElements, timeoutMs, sw, elements, limitations);
                            }
                        }
                        catch (Exception ex)
                        {
                            limitations.Add("Desktop FolderView traversal error: " + ex.Message);
                        }
                    }

                    IntPtr taskbar = GetTaskbarHwnd();
                    if (taskbar != IntPtr.Zero && elements.Count < maxElements && sw.ElapsedMilliseconds < timeoutMs)
                    {
                        try
                        {
                            AutomationElement tbEl = AutomationElement.FromHandle(taskbar);
                            if (tbEl != null)
                            {
                                TraverseTree(tbEl, null, "taskbar", 0, 3, maxElements, timeoutMs, sw, elements, limitations);
                            }
                        }
                        catch (Exception ex)
                        {
                            limitations.Add("Taskbar traversal error: " + ex.Message);
                        }
                    }
                }

                sw.Stop();

                StringBuilder sb = new StringBuilder();
                sb.Append("{\"activeWindow\":").Append(win.ToJson())
                  .Append(",\"observationSource\":\"windows-ui-automation\"")
                  .Append(",\"observedAt\":\"").Append(DateTime.UtcNow.ToString("o")).Append("\"")
                  .Append(",\"durationMs\":").Append(sw.ElapsedMilliseconds)
                  .Append(",\"elementCount\":").Append(elements.Count)
                  .Append(",\"elements\":[");

                for (int i = 0; i < elements.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append(elements[i].ToJson());
                }

                sb.Append("],\"limitations\":[");
                for (int i = 0; i < limitations.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append('"').Append(EscapeJson(limitations[i])).Append('"');
                }
                sb.Append("]}");

                SendResponse(reqId, true, sb.ToString());
                return;
            }

            if (cmd == "quit")
            {
                Cleanup();
                Environment.Exit(0);
                return;
            }

            SendResponse(reqId, false, "{\"error\":\"Unknown command: " + EscapeJson(cmd) + "\"}");
        }

        private static bool IsMeaningfulElement(ElementData d)
        {
            if (d == null) return false;
            if (!string.IsNullOrEmpty(d.Name) || !string.IsNullOrEmpty(d.Value)) return true;

            string t = d.Type;
            if (t == "Edit" || t == "Button" || t == "Hyperlink" || t == "TabItem" ||
                t == "Document" || t == "ListItem" || t == "TreeItem" || t == "MenuItem" ||
                t == "CheckBox" || t == "RadioButton" || t == "ComboBox" || t == "ProgressBar" ||
                t == "Slider" || t == "Heading")
            {
                return true;
            }

            if (d.Patterns != null && d.Patterns.Count > 0) return true;
            return false;
        }

        private static void TraverseTree(
            AutomationElement element,
            string parentId,
            string defaultCategory,
            int currentDepth,
            int maxDepth,
            int maxElements,
            int timeoutMs,
            Stopwatch sw,
            List<ElementData> results,
            List<string> limitations)
        {
            if (_cancelling)
            {
                limitations.Add("Observation cancelled by user or caller");
                return;
            }

            if (sw.ElapsedMilliseconds >= timeoutMs)
            {
                limitations.Add("Observation timed out at " + timeoutMs + "ms");
                return;
            }

            if (results.Count >= maxElements)
            {
                if (!limitations.Contains("Element count limit reached (" + maxElements + ")"))
                {
                    limitations.Add("Element count limit reached (" + maxElements + ")");
                }
                return;
            }

            ElementData data = ExtractElementData(element, parentId);
            string thisId = parentId;
            if (data != null)
            {
                thisId = data.Id;
                if (string.IsNullOrEmpty(data.Category)) data.Category = defaultCategory;

                // Only store meaningful elements and avoid duplicates
                if (IsMeaningfulElement(data) && !ContainsElement(results, data))
                {
                    results.Add(data);
                }

                // PERFORMANCE OPTIMIZATION FOR DESKTOP LIST ITEMS & SIDEBAR TREE ITEMS:
                if ((data.Type == "ListItem" || data.Type == "TreeItem") && (defaultCategory == "desktop-icon" || !string.IsNullOrEmpty(data.Name)))
                {
                    return;
                }
            }

            if (currentDepth >= maxDepth)
            {
                if (results.Count < 10 && !limitations.Contains("Max depth limit reached (" + maxDepth + ")"))
                {
                    limitations.Add("Max depth limit reached (" + maxDepth + ")");
                }
                return;
            }

            AutomationElement sibling = null;
            try
            {
                TreeWalker walker = TreeWalker.ControlViewWalker;
                AutomationElement child = walker.GetFirstChild(element);
                int childCount = 0;

                while (child != null && results.Count < maxElements && !_cancelling && sw.ElapsedMilliseconds < timeoutMs)
                {
                    childCount++;
                    TraverseTree(child, thisId, defaultCategory, currentDepth + 1, maxDepth, maxElements, timeoutMs, sw, results, limitations);
                    sibling = walker.GetNextSibling(child);
                    child = sibling;
                }
                if (data != null) data.ChildrenCount = childCount;
            }
            catch (ElementNotAvailableException)
            {
                limitations.Add("Element became unavailable during traversal");
            }
            catch (Exception ex)
            {
                limitations.Add("Child traversal error: " + ex.Message);
            }
        }

        private static ElementData ExtractElementData(AutomationElement el, string parentId)
        {
            try
            {
                ElementData d = new ElementData();
                _elementCounter++;

                string autoId = "";
                try { autoId = el.Current.AutomationId ?? ""; } catch { }
                d.AutomationId = autoId;
                d.Id = !string.IsNullOrEmpty(autoId) ? autoId + "_" + _elementCounter : "el_" + _elementCounter;
                d.ParentId = parentId;

                try
                {
                    ControlType ct = el.Current.ControlType;
                    d.Type = (ct != null && ct.ProgrammaticName != null) ? ct.ProgrammaticName.Replace("ControlType.", "") : "Unknown";
                }
                catch
                {
                    d.Type = "Unknown";
                }

                try { d.Name = el.Current.Name ?? ""; } catch { d.Name = ""; }
                try { d.ClassName = el.Current.ClassName ?? ""; } catch { d.ClassName = ""; }
                try { d.IsEnabled = el.Current.IsEnabled; } catch { d.IsEnabled = true; }
                try { d.IsOffscreen = el.Current.IsOffscreen; } catch { d.IsOffscreen = false; }
                try { d.HasKeyboardFocus = el.Current.HasKeyboardFocus; } catch { d.HasKeyboardFocus = false; }

                try
                {
                    System.Windows.Rect r = el.Current.BoundingRectangle;
                    if (!r.IsEmpty)
                    {
                        d.X = (int)r.X;
                        d.Y = (int)r.Y;
                        d.Width = (int)r.Width;
                        d.Height = (int)r.Height;
                    }
                }
                catch { }

                // Inspect common readable control patterns
                List<string> patternNames = new List<string>();

                // 1. TextPattern (Documents, rich text, editor views) - check FIRST for comprehensive document content
                object tpObj;
                if (el.TryGetCurrentPattern(TextPattern.Pattern, out tpObj))
                {
                    patternNames.Add("Text");
                    try
                    {
                        TextPattern tp = (TextPattern)tpObj;
                        string txt = tp.DocumentRange.GetText(8000) ?? "";
                        if (!string.IsNullOrEmpty(txt))
                        {
                            d.Value = txt;
                            if (d.Type == "Document" || d.ClassName.Contains("editor") || d.ClassName.Contains("monaco") || d.ClassName.Contains("view-line"))
                            {
                                d.Category = "document-content";
                            }
                        }
                    }
                    catch { }
                }

                // 2. ValuePattern (Edit controls, inputs)
                object vpObj;
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vpObj))
                {
                    patternNames.Add("Value");
                    try
                    {
                        ValuePattern vp = (ValuePattern)vpObj;
                        if (string.IsNullOrEmpty(d.Value))
                        {
                            d.Value = vp.Current.Value ?? "";
                        }
                        d.IsReadOnly = vp.Current.IsReadOnly;
                    }
                    catch { }
                }

                // 3. TogglePattern (Checkboxes, switches)
                object tgObj;
                if (el.TryGetCurrentPattern(TogglePattern.Pattern, out tgObj))
                {
                    patternNames.Add("Toggle");
                    try
                    {
                        TogglePattern tg = (TogglePattern)tgObj;
                        d.ToggleState = tg.Current.ToggleState.ToString();
                    }
                    catch { }
                }

                // 4. SelectionItemPattern (Tabs, list items, radio buttons)
                object spObj;
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out spObj))
                {
                    patternNames.Add("SelectionItem");
                    try
                    {
                        SelectionItemPattern sp = (SelectionItemPattern)spObj;
                        d.IsSelected = sp.Current.IsSelected;
                    }
                    catch { }
                }

                // 5. RangeValuePattern (Sliders, progress bars)
                object rpObj;
                if (el.TryGetCurrentPattern(RangeValuePattern.Pattern, out rpObj))
                {
                    patternNames.Add("RangeValue");
                    try
                    {
                        RangeValuePattern rp = (RangeValuePattern)rpObj;
                        d.RangeValue = rp.Current.Value;
                        d.RangeMax = rp.Current.Maximum;
                    }
                    catch { }
                }

                // Record pattern list
                d.Patterns = patternNames;

                return d;
            }
            catch (ElementNotAvailableException)
            {
                return null;
            }
            catch
            {
                return null;
            }
        }

        private static WindowInfo GetWindowInfo(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return null;

            WindowInfo win = new WindowInfo();
            win.Hwnd = hwnd.ToInt64();

            StringBuilder sb = new StringBuilder(512);
            GetWindowText(hwnd, sb, 512);
            win.Title = sb.ToString();

            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            win.ProcessId = (int)pid;

            try
            {
                Process proc = Process.GetProcessById((int)pid);
                win.ProcessName = proc.ProcessName;
                try
                {
                    ProcessModule mod = proc.MainModule;
                    win.ExecutablePath = mod != null ? (mod.FileName ?? "") : "";
                }
                catch { }
            }
            catch
            {
                win.ProcessName = "Unknown";
            }

            win.IsVisible = IsWindowVisible(hwnd);
            win.IsMinimized = IsIconic(hwnd);
            win.IsMaximized = IsZoomed(hwnd);

            RECT r;
            if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0)
            {
                win.X = r.Left;
                win.Y = r.Top;
                win.Width = r.Right - r.Left;
                win.Height = r.Bottom - r.Top;
            }
            else if (GetWindowRect(hwnd, out r))
            {
                win.X = r.Left;
                win.Y = r.Top;
                win.Width = r.Right - r.Left;
                win.Height = r.Bottom - r.Top;
            }

            return win;
        }

        private static IntPtr ResolveTargetHwnd(long requested)
        {
            if (requested != 0)
            {
                IntPtr h = new IntPtr(requested);
                if (IsWindow(h)) return h;
            }

            IntPtr fg = GetForegroundWindow();
            if (fg != IntPtr.Zero && IsWindow(fg))
            {
                if (_selfHwnd != 0 && fg.ToInt64() == _selfHwnd)
                {
                    // Fall back to top visible application window
                }
                else if (_parentPid != 0)
                {
                    uint pid;
                    GetWindowThreadProcessId(fg, out pid);
                    if (pid != _parentPid) return fg;
                }
                else
                {
                    return fg;
                }
            }

            return GetTopVisibleWindow();
        }

        private static IntPtr GetTopVisibleWindow()
        {
            IntPtr top = IntPtr.Zero;
            EnumWindows(delegate(IntPtr hwnd, IntPtr l)
            {
                if (_selfHwnd != 0 && hwnd.ToInt64() == _selfHwnd) return true;
                if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;

                int ex = GetWindowLong(hwnd, GWL_EXSTYLE);
                if ((ex & WS_EX_TOOLWINDOW) != 0 || (ex & WS_EX_NOACTIVATE) != 0) return true;

                int cloaked;
                if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;

                StringBuilder cls = new StringBuilder(64);
                GetClassName(hwnd, cls, 64);
                string c = cls.ToString();
                if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return true;

                if (_parentPid != 0)
                {
                    uint pid;
                    GetWindowThreadProcessId(hwnd, out pid);
                    if (pid == _parentPid) return true;
                }

                RECT r;
                if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0)
                {
                    if (!GetWindowRect(hwnd, out r)) return true;
                }

                if (r.Right - r.Left < 200 || r.Bottom - r.Top < 120) return true;

                top = hwnd;
                return false; // Stop on first visible top-level window
            }, IntPtr.Zero);

            return top;
        }

        private static int GetExplorerPid()
        {
            try
            {
                Process[] procs = Process.GetProcessesByName("explorer");
                if (procs != null && procs.Length > 0) return procs[0].Id;
            }
            catch { }
            return Process.GetCurrentProcess().Id;
        }

        public static IntPtr GetDesktopFolderViewHwnd()
        {
            IntPtr progman = FindWindow("Progman", null);
            IntPtr folderView = IntPtr.Zero;

            if (progman != IntPtr.Zero)
            {
                IntPtr shellView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (shellView != IntPtr.Zero)
                {
                    folderView = FindWindowEx(shellView, IntPtr.Zero, "SysListView32", null);
                    if (folderView != IntPtr.Zero) return folderView;
                }
            }

            EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
            {
                StringBuilder cls = new StringBuilder(64);
                GetClassName(hwnd, cls, 64);
                if (cls.ToString() == "WorkerW")
                {
                    IntPtr shellView = FindWindowEx(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null);
                    if (shellView != IntPtr.Zero)
                    {
                        IntPtr fv = FindWindowEx(shellView, IntPtr.Zero, "SysListView32", null);
                        if (fv != IntPtr.Zero)
                        {
                            folderView = fv;
                            return false;
                        }
                    }
                }
                return true;
            }, IntPtr.Zero);

            return folderView;
        }

        public static IntPtr FindWebRendererHwnd(IntPtr parentHwnd)
        {
            if (parentHwnd == IntPtr.Zero) return IntPtr.Zero;
            IntPtr found = IntPtr.Zero;
            EnumChildWindows(parentHwnd, delegate(IntPtr hwnd, IntPtr lParam)
            {
                StringBuilder cls = new StringBuilder(64);
                GetClassName(hwnd, cls, 64);
                string c = cls.ToString();
                if (c == "Chrome_RenderWidgetHostHWND" || c == "MozillaContentWindowClass")
                {
                    found = hwnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        public static void WakeChromiumAccessibility(IntPtr rendererHwnd)
        {
            if (rendererHwnd == IntPtr.Zero) return;
            try
            {
                IntPtr result;
                SendMessageTimeout(rendererHwnd, WM_GETOBJECT, IntPtr.Zero, new IntPtr(OBJID_CLIENT), SMTO_ABORTIFHUNG, 1000, out result);
                Thread.Sleep(80);
            }
            catch { }
        }

        private static bool ContainsElement(List<ElementData> list, ElementData item)
        {
            if (item == null) return false;
            for (int i = 0; i < list.Count; i++)
            {
                ElementData e = list[i];
                if (e.Type == item.Type && e.Name == item.Name && e.X == item.X && e.Y == item.Y)
                {
                    return true;
                }
            }
            return false;
        }

        public static IntPtr GetTaskbarHwnd()
        {
            return FindWindow("Shell_TrayWnd", null);
        }

        public static bool IsDesktopWindow(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            StringBuilder cls = new StringBuilder(64);
            GetClassName(hwnd, cls, 64);
            string c = cls.ToString();
            return c == "Progman" || c == "WorkerW" || c == "SHELLDLL_DefView" || c == "SysListView32";
        }

        private static void SendResponse(int reqId, bool ok, string payload)
        {
            lock (_stdoutLock)
            {
                Console.WriteLine("{\"type\":\"response\",\"reqId\":" + reqId + ",\"ok\":" + (ok ? "true" : "false") + ",\"payload\":" + payload + "}");
                Console.Out.Flush();
            }
        }

        private static void SendEvent(string eventName, string dataJson)
        {
            lock (_stdoutLock)
            {
                Console.WriteLine("{\"type\":\"event\",\"name\":\"" + eventName + "\",\"data\":" + dataJson + "}");
                Console.Out.Flush();
            }
        }

        private static void Cleanup()
        {
            if (_msgThreadId != 0)
            {
                PostThreadMessage(_msgThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            }
        }

        #region Helper Classes
        public class WindowInfo
        {
            public long Hwnd;
            public string Title = "";
            public string ProcessName = "";
            public int ProcessId;
            public string ExecutablePath = "";
            public bool IsVisible;
            public bool IsMinimized;
            public bool IsMaximized;
            public int X, Y, Width, Height;

            public string ToJson()
            {
                return "{\"hwnd\":" + Hwnd +
                    ",\"title\":\"" + EscapeJson(Title) + "\"" +
                    ",\"processName\":\"" + EscapeJson(ProcessName) + "\"" +
                    ",\"processId\":" + ProcessId +
                    ",\"executablePath\":\"" + EscapeJson(ExecutablePath) + "\"" +
                    ",\"isVisible\":" + (IsVisible ? "true" : "false") +
                    ",\"isMinimized\":" + (IsMinimized ? "true" : "false") +
                    ",\"isMaximized\":" + (IsMaximized ? "true" : "false") +
                    ",\"bounds\":{\"x\":" + X + ",\"y\":" + Y + ",\"width\":" + Width + ",\"height\":" + Height + "}}";
            }
        }

        public class ElementData
        {
            public string Id = "";
            public string ParentId = null;
            public string Type = "";
            public string Name = "";
            public string Value = null;
            public string ClassName = "";
            public string AutomationId = "";
            public string Category = null;
            public bool IsEnabled = true;
            public bool IsOffscreen = false;
            public bool HasKeyboardFocus = false;
            public int X, Y, Width, Height;
            public bool? IsReadOnly = null;
            public string ToggleState = null;
            public bool? IsSelected = null;
            public double? RangeValue = null;
            public double? RangeMax = null;
            public int ChildrenCount = 0;
            public List<string> Patterns = new List<string>();

            public string ToJson()
            {
                StringBuilder sb = new StringBuilder();
                sb.Append("{\"id\":\"").Append(EscapeJson(Id)).Append("\"");
                if (!string.IsNullOrEmpty(ParentId))
                    sb.Append(",\"parentId\":\"").Append(EscapeJson(ParentId)).Append("\"");
                sb.Append(",\"type\":\"").Append(EscapeJson(Type)).Append("\"")
                  .Append(",\"name\":\"").Append(EscapeJson(Name)).Append("\"");

                if (!string.IsNullOrEmpty(Category))
                    sb.Append(",\"category\":\"").Append(EscapeJson(Category)).Append("\"");

                if (Value != null)
                    sb.Append(",\"value\":\"").Append(EscapeJson(Value)).Append("\"");

                if (!string.IsNullOrEmpty(AutomationId))
                    sb.Append(",\"automationId\":\"").Append(EscapeJson(AutomationId)).Append("\"");

                if (!string.IsNullOrEmpty(ClassName))
                    sb.Append(",\"className\":\"").Append(EscapeJson(ClassName)).Append("\"");

                sb.Append(",\"visible\":").Append((!IsOffscreen && IsEnabled) ? "true" : "false")
                  .Append(",\"isOffscreen\":").Append(IsOffscreen ? "true" : "false")
                  .Append(",\"isEnabled\":").Append(IsEnabled ? "true" : "false")
                  .Append(",\"isFocused\":").Append(HasKeyboardFocus ? "true" : "false")
                  .Append(",\"bounds\":{\"x\":").Append(X).Append(",\"y\":").Append(Y)
                  .Append(",\"width\":").Append(Width).Append(",\"height\":").Append(Height).Append("}");

                if (IsReadOnly.HasValue)
                    sb.Append(",\"isReadOnly\":").Append(IsReadOnly.Value ? "true" : "false");

                if (ToggleState != null)
                    sb.Append(",\"toggleState\":\"").Append(EscapeJson(ToggleState)).Append("\"");

                if (IsSelected.HasValue)
                    sb.Append(",\"isSelected\":").Append(IsSelected.Value ? "true" : "false");

                if (RangeValue.HasValue)
                    sb.Append(",\"rangeValue\":").Append(RangeValue.Value);

                if (ChildrenCount > 0)
                    sb.Append(",\"childrenCount\":").Append(ChildrenCount);

                sb.Append(",\"patterns\":[");
                for (int i = 0; i < Patterns.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append('"').Append(EscapeJson(Patterns[i])).Append('"');
                }
                sb.Append("]}");

                return sb.ToString();
            }
        }
        #endregion

        #region JSON Parser & Escaping Helpers
        public static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            StringBuilder sb = new StringBuilder(s.Length + 4);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ')
                        {
                            sb.AppendFormat("\\u{0:x4}", (int)c);
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            return sb.ToString();
        }

        private static string ExtractString(string json, string key, string fallback)
        {
            try
            {
                string pattern = "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"";
                System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(json, pattern);
                return m.Success ? m.Groups[1].Value : fallback;
            }
            catch { return fallback; }
        }

        private static int ExtractInt(string json, string key, int fallback)
        {
            try
            {
                string pattern = "\"" + key + "\"\\s*:\\s*(-?\\d+)";
                System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(json, pattern);
                return m.Success ? int.Parse(m.Groups[1].Value) : fallback;
            }
            catch { return fallback; }
        }

        private static long ExtractLong(string json, string key, long fallback)
        {
            try
            {
                string pattern = "\"" + key + "\"\\s*:\\s*(-?\\d+)";
                System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(json, pattern);
                return m.Success ? long.Parse(m.Groups[1].Value) : fallback;
            }
            catch { return fallback; }
        }
        #endregion
    }
}
