using System;
using System.Runtime.InteropServices;

namespace KsInfo.ModernizeProData.UI;

internal static class NativeMethods
{
    /// <summary>
    /// 현재 process 의 AppUserModelID 지정. Windows 7+. taskbar 그룹화 / jump list /
    /// 우클릭 메뉴의 브랜드 표시에 사용. Edge child window 와 달리 우리 host process
    /// 이므로 이 호출이 그대로 반영된다.
    /// </summary>
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    public static extern void SetCurrentProcessExplicitAppUserModelID(
        [MarshalAs(UnmanagedType.LPWStr)] string AppID);

    /// <summary>
    /// DWM API — title bar / border / text color override (Windows 11 22000+).
    /// 회색 default → brand navy.
    /// </summary>
    [DllImport("dwmapi.dll", PreserveSig = true)]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    public const int DWMWA_BORDER_COLOR  = 34;
    public const int DWMWA_CAPTION_COLOR = 35;
    public const int DWMWA_TEXT_COLOR    = 36;

    /// <summary>WM_SETICON — title bar / taskbar 아이콘을 window 에 강제 지정.</summary>
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    public const int WM_SETICON = 0x0080;
    public const int ICON_SMALL = 0;
    public const int ICON_BIG   = 1;

    /// <summary>Convert System.Drawing.Color → COLORREF (0x00BBGGRR).</summary>
    public static int ToColorRef(System.Drawing.Color c) =>
        (c.B << 16) | (c.G << 8) | c.R;
}
