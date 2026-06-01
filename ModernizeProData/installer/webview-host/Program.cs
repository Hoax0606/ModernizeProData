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

        // taskbar 우클릭 시 "Microsoft Edge" 대신 우리 도구로 표시되게 한다.
        // Edge `--app` 의 경우 host process = Edge 라서 OS 가 Edge 로 인식했지만,
        // 이 host = 우리 process 라 SetCurrentProcessExplicitAppUserModelID 가 효과 있음.
        try { NativeMethods.SetCurrentProcessExplicitAppUserModelID(opts.AppId); }
        catch { /* W7 미만 또는 권한 부재 */ }

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
