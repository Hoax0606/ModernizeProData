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

        // 명시적 AUMID 호출 제거 (2026-06-02) — system 에 등록 안 된 AUMID 를 박으면
        // Windows 가 그 ID 의 icon / display name 을 찾지 못해 taskbar icon 자체가
        // 누락된다 (group lookup miss). process 의 main module (.exe) 기반 자동
        // grouping 을 사용 — 이 경우 ApplicationIcon (mpd.ico) 가 taskbar 에 정상 표시.
        // 향후 AUMID 가 필요해지면 registry (HKCU\Software\Classes\AppUserModelId\<id>)
        // 에 IconUri / DisplayName 같이 등록한 뒤 다시 호출해야 한다.

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
