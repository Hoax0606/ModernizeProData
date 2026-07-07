using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace KsInfo.ModernizeProDataBridge.UI;

/// <summary>
/// WebView2 호스트 폼. Edge `--app=URL` 대체.
///
/// 비활성화 항목 (chromeless 일관성):
///   - 기본 context menu (우클릭)
///   - DevTools (필요 시 옵션화)
///   - 다운로드 UI (브라우저 chrome 의 download bubble 자체가 없음 → 의미 X.
///     다운로드 자체는 onDownloadStarting 에서 우리가 결정)
///   - 새 창 / pop-up (router 안에서 처리, 외부 도메인은 OS 기본 브라우저로 분리)
///
/// taskbar 표시:
///   - process 가 우리이므로 AUMID = HostOptions.AppId 가 그대로 적용됨 (Program.cs 에서 set).
/// </summary>
internal sealed class MainForm : Form
{
    private readonly HostOptions _opts;
    private readonly WebView2 _web;

    public MainForm(HostOptions opts)
    {
        _opts = opts;
        Text = opts.Title;
        // 화면 working area 의 65% × 75% — 어떤 해상도 / DPI 에서도 적절한 size.
        // primary screen 없으면 1280x800 fallback. Hoax 해상도 2880x1880 → 약 1872×1410.
        var work = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        ClientSize = new Size(
            Math.Max(900, (int)(work.Width  * 0.65)),
            Math.Max(600, (int)(work.Height * 0.75)));
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(900, 600);
        // FormBorderStyle = Sizable 유지 (사용자가 resize / move 가능). 완전 borderless
        // 는 운영 정책 정해진 후 옵션화.

        // taskbar 항목 강제. WinForms default 가 true 지만 명시해 회귀 방지.
        ShowInTaskbar = true;

        // Form icon — embedded mpd.ico (멀티해상도) 를 직접 로드. ExtractAssociatedIcon 은
        // 단일 32px small icon 만 줘서 고DPI/다중 모니터의 taskbar 가 적정 크기를 못 찾아
        // 아이콘이 비거나 placeholder 로 뜨던 문제가 있었다. 멀티사이즈 .ico 를 통째로 넘기면
        // Windows 가 모니터 DPI 별 최적 크기를 골라 title bar / taskbar 모두 선명하게 표시.
        try
        {
            using var icoStream = typeof(MainForm).Assembly.GetManifestResourceStream("mpd.ico");
            if (icoStream != null)
            {
                Icon = new Icon(icoStream);
            }
            else
            {
                // embedded resource 못 찾으면 exe 연결 아이콘으로 폴백.
                string? exePath = Environment.ProcessPath;
                if (!string.IsNullOrEmpty(exePath))
                {
                    Icon? ico = Icon.ExtractAssociatedIcon(exePath);
                    if (ico != null) Icon = ico;
                }
            }
        }
        catch { /* icon 로드 실패 silent — 기본 OS icon 표시 */ }

        _web = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(_web);

        HandleCreated += (_, _) => { ApplyBrandTitleBar(); ForceWindowIcon(); };
        // Shown = window 가 실제 표시됨 = taskbar 버튼 생성 완료 시점 → 아이콘 재적용
        // (HandleCreated 시점엔 taskbar 버튼이 아직 없어 WM_SETICON 이 헛돌 수 있었음).
        Shown += async (_, _) => { ForceWindowIcon(); await InitWebViewAsync(); };
        FormClosing += (_, _) =>
        {
            // host 종료 시 backend Java 프로세스도 자연 stop — Java 의 SwingGuiApp 가
            // host process exit 를 watch 한다.
        };
    }

    /// <summary>
    /// Brand title bar (Windows 11 22000+). 회색 default → navy + white text.
    /// 이전 Windows / 실패 시 silent (Form 정상 작동).
    /// </summary>
    /// <summary>
    /// Form.Icon 외에 WM_SETICON 으로 top-level window 에 아이콘을 한 번 더 강제 지정.
    /// WebView2 child control 이 부모 window 아이콘 표시를 방해하는 경우 taskbar 아이콘이
    /// 비어 보이던 것을 회피 (#63). Form.Icon 이 null 이면 no-op.
    /// </summary>
    private void ForceWindowIcon()
    {
        try
        {
            if (!IsHandleCreated || Icon == null) return;
            IntPtr h = Icon.Handle;
            NativeMethods.SendMessage(Handle, NativeMethods.WM_SETICON, (IntPtr)NativeMethods.ICON_BIG, h);
            NativeMethods.SendMessage(Handle, NativeMethods.WM_SETICON, (IntPtr)NativeMethods.ICON_SMALL, h);
        }
        catch { /* best-effort */ }
    }

    private void ApplyBrandTitleBar()
    {
        // Brand mint/teal #0e7268 (React 의 --navy 변수와 동일 brand). border 는
        // 살짝 더 진한 톤 (--navy-700) 으로 윤곽 강조.
        var caption = Color.FromArgb(0x0e, 0x72, 0x68);
        var border  = Color.FromArgb(0x0a, 0x58, 0x50);
        var text    = Color.White;
        try
        {
            int captionCr = NativeMethods.ToColorRef(caption);
            NativeMethods.DwmSetWindowAttribute(Handle, NativeMethods.DWMWA_CAPTION_COLOR, ref captionCr, sizeof(int));
            int borderCr = NativeMethods.ToColorRef(border);
            NativeMethods.DwmSetWindowAttribute(Handle, NativeMethods.DWMWA_BORDER_COLOR, ref borderCr, sizeof(int));
            int textCr = NativeMethods.ToColorRef(text);
            NativeMethods.DwmSetWindowAttribute(Handle, NativeMethods.DWMWA_TEXT_COLOR, ref textCr, sizeof(int));
        }
        catch { /* old Windows / DWM 부재 — silent */ }
    }

    private async Task InitWebViewAsync()
    {
        // user-data dir = LOCALAPPDATA\ModernizeProDataBridge\webview2\<profile> .
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string userDataDir = Path.Combine(localAppData, "ModernizeProDataBridge", "webview2", _opts.Profile);
        Directory.CreateDirectory(userDataDir);

        var env = await CoreWebView2Environment.CreateAsync(null, userDataDir, null);
        await _web.EnsureCoreWebView2Async(env);

        // WebView2 초기화가 window 의 rendering surface 를 재생성하면서 top-level 아이콘이
        // 리셋돼 taskbar 아이콘이 간헐적으로 비던 문제 (2026-06-11). init 완료 후 한 번 더 강제.
        ForceWindowIcon();

        var settings = _web.CoreWebView2.Settings;
        settings.AreDefaultContextMenusEnabled = false;   // 우클릭 메뉴 X
        settings.AreDevToolsEnabled = false;              // F12 X (운영 build)
        settings.IsStatusBarEnabled = false;              // 하단 URL preview X
        settings.IsZoomControlEnabled = true;
        settings.AreBrowserAcceleratorKeysEnabled = false; // Ctrl+P / Ctrl+S / Ctrl+R etc.
        settings.IsBuiltInErrorPageEnabled = true;

        // 외부 domain link / target=_blank → OS 기본 브라우저로 분리. 도구 내부 navigation
        // (localhost:8080) 만 host 안에서 처리.
        _web.CoreWebView2.NewWindowRequested += (s, e) =>
        {
            e.Handled = true;
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = e.Uri,
                    UseShellExecute = true
                });
            }
            catch { /* shell open 실패 silent */ }
        };

        // 다운로드 = 도구 안에서 의도된 export 만 발생. browser 의 download bubble 자체가
        // 없는 host 라 user-visible UI 영향 0. blob → <a download> 클릭 흐름은 그대로 작동.

        _web.CoreWebView2.Navigate(_opts.Url);
    }
}
