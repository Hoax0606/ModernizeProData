using System;
using System.Windows.Forms;

namespace KsInfo.ModernizeProData.UI;

internal static class Program
{
    /// <summary>
    /// CLI args:
    ///   --url=&lt;http://localhost:8080&gt;
    ///   --profile=&lt;edge-app-coordinator&gt;       user-data dir 의 subdir 이름.
    ///   --title=&lt;ModernizeProData&gt;             window 제목.
    ///   --app-id=&lt;com.ksinfo.ModernizeProData&gt;  AppUserModelID (taskbar 그룹화 / brand).
    /// </summary>
    [STAThread]
    static int Main(string[] args)
    {
        var opts = HostOptions.Parse(args);

        // 명시적 AUMID 지정 — taskbar 그룹화를 .exe path(단일파일 self-extract 시 temp 경로라
        // 불안정)가 아니라 안정적인 brand ID 로 고정. taskbar 아이콘은 이 AUMID 그룹의 window
        // 아이콘(MainForm 이 embedded mpd.ico 를 Form.Icon + WM_SETICON 으로 세팅)을 사용한다.
        // (2026-06-02 에 AUMID 를 뺐던 건 그 시점 Form.Icon 이 비어 group 아이콘 lookup 이
        //  비었기 때문. 이제 embedded multi-size icon 으로 window 아이콘이 항상 있으므로 OK.)
        try { NativeMethods.SetCurrentProcessExplicitAppUserModelID(opts.AppId); } catch { /* best-effort */ }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(opts));
        return 0;
    }
}

internal sealed record HostOptions(string Url, string Profile, string Title, string AppId)
{
    public static HostOptions Parse(string[] args)
    {
        string url = "http://localhost:8080";
        string profile = "edge-app-coordinator";
        string title = "ModernizeProData";
        string appId = "KsInfo.ModernizeProData";

        foreach (var a in args)
        {
            if (a.StartsWith("--url=", StringComparison.Ordinal))     url     = a["--url=".Length..];
            else if (a.StartsWith("--profile=", StringComparison.Ordinal)) profile = a["--profile=".Length..];
            else if (a.StartsWith("--title=", StringComparison.Ordinal))   title   = a["--title=".Length..];
            else if (a.StartsWith("--app-id=", StringComparison.Ordinal))  appId   = a["--app-id=".Length..];
        }
        return new HostOptions(url, profile, title, appId);
    }
}
