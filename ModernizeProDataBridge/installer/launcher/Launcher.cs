// ModernizeProDataBridge installer launcher.
//
// Pops a single setup dialog asking for:
//   - UI language (en/ko/ja)
//   - Current PC's hardware fingerprint (read from
//     HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid -- the same value the
//     installed backend reads, so a license issued for this PC matches)
//   - Optional .lic file to install at the same time
//
// On OK it runs msiexec for the matching per-language .msi, then -- if the
// user picked a .lic -- copies it into %LOCALAPPDATA%\ModernizeProDataBridge\
// license.lic. The backend's LicenseStartupLoader picks that file up on the
// first boot and imports it.
//
// Compile: build-launcher.ps1 -> csc.exe (.NET Framework 4.x).

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        using (var dialog = new SetupDialog())
        {
            if (dialog.ShowDialog() != DialogResult.OK)
            {
                return 1;
            }

            string lang = dialog.SelectedLanguage;
            string mode = dialog.SelectedMode;

            string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? ".";
            // role 별 msi prefix. worker 만 별 jpackage build (build.ps1 -Role worker).
            // standalone = coordinator 와 동일 jar / 동일 msi — 첫 boot 시 APP_MODE 로 분기.
            string msiPrefix = mode == "worker" ? "ModernizeProDataBridge-Worker-" : "ModernizeProDataBridge-";
            // ProductVersion 이 매 빌드 bump (1.0.<counter>) — 고정 file 이름 hardcode
            // 안 됨. wildcard 검색 + 최신 mtime 의 msi 사용.
            // Coordinator pattern 은 worker prefix 와 충돌 — 명시적으로 'Worker-' 포함
            // 여부로 필터링.
            string[] allMsis = Directory.GetFiles(exeDir, "ModernizeProDataBridge-*-" + lang + "-*.msi");
            string[] candidates;
            if (mode == "worker") {
                candidates = Array.FindAll(allMsis, f => Path.GetFileName(f).StartsWith("ModernizeProDataBridge-Worker-", StringComparison.OrdinalIgnoreCase));
            } else {
                // Coordinator / standalone — exclude Worker variants explicitly.
                candidates = Array.FindAll(allMsis, f => !Path.GetFileName(f).StartsWith("ModernizeProDataBridge-Worker-", StringComparison.OrdinalIgnoreCase));
                // Coord 의 정확한 이름은 'ModernizeProDataBridge-<lang>-<ver>.msi' (segment 3) 라
                // 위 glob 가 매치 안 함. 별 glob 로 다시 잡음.
                candidates = Directory.GetFiles(exeDir, msiPrefix + lang + "-*.msi");
            }
            if (candidates.Length == 0) {
                MessageBox.Show(
                    "Localized installer not found next to Launcher.exe.\n\nExpected pattern:\n" + Path.Combine(exeDir, msiPrefix + lang + "-*.msi"),
                    "ModernizeProDataBridge",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 2;
            }
            Array.Sort(candidates, (a, b) => File.GetLastWriteTime(b).CompareTo(File.GetLastWriteTime(a)));
            string msi = candidates[0];

            string logPath = Path.Combine(exeDir, "install-" + lang + ".log");
            string arguments = "/i \"" + msi + "\" APP_LANG=" + lang + " APP_MODE=" + mode + " /l*v \"" + logPath + "\"";
            var psi = new ProcessStartInfo("msiexec.exe", arguments)
            {
                UseShellExecute = true
            };

            int exitCode;
            try
            {
                using (var proc = Process.Start(psi))
                {
                    proc.WaitForExit();
                    exitCode = proc.ExitCode;
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Failed to start the installer:\n\n" + ex.Message,
                    "ModernizeProDataBridge",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 3;
            }

            // install 성공 (exit 0) 시 msi 사본을 영구 위치에 보존.
            // 이유: Add/Remove Programs uninstall 시 Windows Installer 가 install 시점
            // 의 dist 경로에서 msi 검색. dist 가 정리되거나 다음 빌드로 PackageCode 다른
            // msi 로 덮이면 1612 (Source out of sync). dist 와 무관한 영구 위치에
            // 사본 두면 사용자가 dialog 의 Browse 로 거기 지정 → 통과.
            //
            // 위치: install dir 밖 (%LOCALAPPDATA%\ModernizeProDataBridgeInstallCache\) —
            // install dir 안에 두면 uninstall 시 같이 사라져 무용. permission 불필요
            // (LocalAppData = user-writable).
            if (exitCode == 0)
            {
                PreserveInstallSource(msi);
            }

            // License + Coordinator URL are no longer collected at install
            // time -- those are entered in-app on first boot.
            return exitCode;
        }
    }

    private static void PreserveInstallSource(string msiPath)
    {
        try
        {
            string cacheDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ModernizeProDataBridgeInstallCache");
            Directory.CreateDirectory(cacheDir);
            string preserved = Path.Combine(cacheDir, Path.GetFileName(msiPath));
            File.Copy(msiPath, preserved, true);

            MessageBox.Show(
                "Installation complete.\n\n" +
                "MSI source preserved at:\n" + preserved + "\n\n" +
                "If Windows asks for installation media during uninstall,\n" +
                "click Browse and select this file.",
                "ModernizeProDataBridge",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            // 보존 실패는 install 자체와 무관 — 경고만. uninstall 시 사용자가 직접
            // dist 또는 setup.zip 의 msi 를 Browse 로 지정해야.
            MessageBox.Show(
                "Note: MSI source preservation failed.\n\n" + ex.Message +
                "\n\nKeep the setup.zip handy for future uninstall.",
                "ModernizeProDataBridge",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private static int LangCodeFor(string lang)
    {
        switch (lang)
        {
            case "ko": return 1042;
            case "ja": return 1041;
            default:   return 1033;
        }
    }
}


internal sealed class SetupDialog : Form
{
    public string SelectedLanguage { get; private set; }
    public string SelectedMode { get; private set; }

    private readonly ComboBox _langCombo;
    private readonly ComboBox _modeCombo;
    private readonly TextBox _hwBox;

    // Hoax Mono JP across the dialog so it matches the React UI.
    private static readonly System.Drawing.Font BodyFont =
        new System.Drawing.Font("Hoax Mono JP", 9.0F);
    private static readonly System.Drawing.Font SectionFont =
        new System.Drawing.Font("Hoax Mono JP", 8.5F, System.Drawing.FontStyle.Bold);
    private static readonly System.Drawing.Font HintFont =
        new System.Drawing.Font("Hoax Mono JP", 8.0F);
    private static readonly System.Drawing.Font TitleFont =
        new System.Drawing.Font("Hoax Mono JP", 12F, System.Drawing.FontStyle.Bold);

    // Match the WiX wizard chrome: native white background, dark navy
    // accent for headings/buttons, neutral gray hints/borders.
    private static readonly System.Drawing.Color Accent =
        System.Drawing.Color.FromArgb(28, 61, 90);     // #1c3d5a deep navy
    private static readonly System.Drawing.Color AccentHover =
        System.Drawing.Color.FromArgb(44, 84, 122);    // lighter navy on hover
    private static readonly System.Drawing.Color HairLine =
        System.Drawing.Color.FromArgb(216, 222, 224);  // #d8dee0
    private static readonly System.Drawing.Color TextMuted =
        System.Drawing.Color.FromArgb(110, 117, 122);  // #6e757a
    private static readonly System.Drawing.Color FieldBg =
        System.Drawing.Color.White;

    public SetupDialog()
    {
        SelectedLanguage = "en";
        SelectedMode = "coordinator";

        Text = "ModernizeProDataBridge Setup";
        Width = 520;
        Height = 420;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = true;
        Font = BodyFont;
        BackColor = System.Drawing.Color.White;

        int padLeft = 28;
        int width = 444;

        // ---- Title strip (no accent bar; match WiX wizard's plain white header) ----
        var title = new Label
        {
            Text = "ModernizeProDataBridge",
            Top = 18, Left = padLeft, Width = width, Height = 24,
            Font = TitleFont,
            ForeColor = Accent
        };
        Controls.Add(title);

        var subtitle = new Label
        {
            Text = "Setup",
            Top = 42, Left = padLeft, Width = width, Height = 16,
            Font = HintFont,
            ForeColor = TextMuted
        };
        Controls.Add(subtitle);

        var divider = new Panel
        {
            Top = 68, Left = padLeft, Width = width, Height = 1,
            BackColor = HairLine
        };
        Controls.Add(divider);

        int y = 86;
        int sectionGap = 16;

        // ---- 1. Language ----
        AddSection(padLeft, ref y, width, "1.  Language", "Sets the installer wizard and the app's default language.");

        _langCombo = MakeCombo(padLeft, y, width);
        _langCombo.Items.Add("한국어 (Korean)");
        _langCombo.Items.Add("日本語 (Japanese)");
        _langCombo.Items.Add("English");
        _langCombo.SelectedIndex = SystemDefaultIndex();
        _langCombo.DrawItem += (s, e) => DrawComboItem(_langCombo, e);
        Controls.Add(_langCombo);
        y += 24 + sectionGap;

        // ---- 2. Role ----
        AddSection(padLeft, ref y, width, "2.  Role", "Coordinator runs the meta DB; Worker connects to a Coordinator; Standalone is a single PC.");

        _modeCombo = MakeCombo(padLeft, y, width);
        _modeCombo.Items.Add("Coordinator (HQ)");
        _modeCombo.Items.Add("Worker (field)");
        _modeCombo.Items.Add("Standalone (single PC)");
        _modeCombo.SelectedIndex = 0;
        _modeCombo.DrawItem += (s, e) => DrawComboItem(_modeCombo, e);
        Controls.Add(_modeCombo);
        y += 24 + sectionGap;

        // ---- 3. Hardware ID ----
        AddSection(padLeft, ref y, width, "3.  Hardware ID", "Paste this into the issuer to bind a license to this PC.");

        string hwId = ReadMachineGuid() ?? "(could not read MachineGuid)";
        _hwBox = new TextBox
        {
            Top = y, Left = padLeft, Width = width - 76, Height = 24,
            Text = hwId,
            ReadOnly = true,
            BackColor = FieldBg,
            BorderStyle = BorderStyle.FixedSingle,
            Font = BodyFont
        };
        Controls.Add(_hwBox);

        var copyBtn = MakeFlatButton("Copy", Accent);
        copyBtn.Top = y - 1;
        copyBtn.Left = padLeft + width - 70;
        copyBtn.Width = 70;
        copyBtn.Height = 26;
        copyBtn.Click += (s, e) =>
        {
            try { Clipboard.SetText(_hwBox.Text); } catch { /* clipboard busy */ }
            copyBtn.Text = "Copied";
            var t = new Timer { Interval = 1200 };
            t.Tick += (s2, e2) => { copyBtn.Text = "Copy"; t.Stop(); t.Dispose(); };
            t.Start();
        };
        Controls.Add(copyBtn);
        y += 24 + sectionGap;

        // License + Worker connection sections moved to in-app first-boot.

        // ---- Bottom action row ----
        var actionDivider = new Panel
        {
            Top = ClientSize.Height - 60, Left = padLeft, Width = width, Height = 1,
            BackColor = HairLine
        };
        Controls.Add(actionDivider);

        var cancelBtn = MakeFlatButton("Cancel", TextMuted);
        cancelBtn.Top = ClientSize.Height - 45;
        cancelBtn.Left = padLeft + width - 156;
        cancelBtn.Width = 72;
        cancelBtn.Height = 30;
        cancelBtn.DialogResult = DialogResult.Cancel;
        Controls.Add(cancelBtn);

        var okBtn = MakeFlatButton("Install", Accent, primary: true);
        okBtn.Top = ClientSize.Height - 45;
        okBtn.Left = padLeft + width - 80;
        okBtn.Width = 80;
        okBtn.Height = 30;
        okBtn.DialogResult = DialogResult.OK;
        okBtn.Click += (s, e) =>
        {
            switch (_langCombo.SelectedIndex)
            {
                case 0: SelectedLanguage = "ko"; break;
                case 1: SelectedLanguage = "ja"; break;
                default: SelectedLanguage = "en"; break;
            }
            switch (_modeCombo.SelectedIndex)
            {
                case 1: SelectedMode = "worker"; break;
                case 2: SelectedMode = "standalone"; break;
                default: SelectedMode = "coordinator"; break;
            }
        };
        Controls.Add(okBtn);

        AcceptButton = okBtn;
        CancelButton = cancelBtn;
    }

    private void AddSection(int x, ref int y, int width, string title, string hint)
    {
        var lbl = new Label
        {
            Text = title,
            Top = y, Left = x, Width = width, Height = 16,
            Font = SectionFont,
            ForeColor = Accent
        };
        Controls.Add(lbl);
        y += 17;

        var hintLbl = new Label
        {
            Text = hint,
            Top = y, Left = x, Width = width, Height = 14,
            Font = HintFont,
            ForeColor = TextMuted
        };
        Controls.Add(hintLbl);
        y += 17;
    }

    private static Button MakeFlatButton(string text, System.Drawing.Color color, bool primary = false)
    {
        var b = new Button
        {
            Text = text,
            FlatStyle = FlatStyle.Flat,
            UseVisualStyleBackColor = false,
            Font = BodyFont
        };
        b.FlatAppearance.BorderColor = primary ? color : HairLine;
        b.FlatAppearance.BorderSize = 1;
        if (primary)
        {
            b.BackColor = color;
            b.ForeColor = System.Drawing.Color.White;
            b.FlatAppearance.MouseOverBackColor = AccentHover;
        }
        else
        {
            b.BackColor = System.Drawing.Color.White;
            b.ForeColor = color;
            b.FlatAppearance.MouseOverBackColor = System.Drawing.Color.FromArgb(245, 246, 247);
        }
        return b;
    }

    private static ComboBox MakeCombo(int x, int y, int width)
    {
        return new ComboBox
        {
            Top = y, Left = x, Width = width, Height = 24,
            DropDownStyle = ComboBoxStyle.DropDownList,
            DrawMode = DrawMode.OwnerDrawFixed,
            ItemHeight = 22,
            FlatStyle = FlatStyle.Flat,
            Font = BodyFont,
            BackColor = FieldBg
        };
    }

    private static void DrawComboItem(ComboBox combo, DrawItemEventArgs e)
    {
        e.DrawBackground();
        if (e.Index < 0) return;
        string text = combo.Items[e.Index].ToString();
        using (var brush = new System.Drawing.SolidBrush(e.ForeColor))
        {
            var bounds = e.Bounds;
            bounds.X += 6;
            var size = e.Graphics.MeasureString(text, BodyFont);
            float yText = bounds.Y + (bounds.Height - size.Height) / 2;
            e.Graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            e.Graphics.DrawString(text, BodyFont, brush, bounds.X, yText);
        }
        e.DrawFocusRectangle();
    }

    private static int SystemDefaultIndex()
    {
        string culture = System.Globalization.CultureInfo.InstalledUICulture.TwoLetterISOLanguageName;
        switch (culture)
        {
            case "ko": return 0;
            case "ja": return 1;
            default:   return 2;
        }
    }

    /// <summary>
    /// Read HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid -- same value the
    /// backend reads via reg.exe so the two agree on what this PC is.
    /// </summary>
    private static string ReadMachineGuid()
    {
        try
        {
            // 64-bit view explicitly; default registry view on a 32-bit launcher
            // would otherwise be redirected to WoW6432Node which lacks this key.
            using (var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (var key = hklm.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography"))
            {
                if (key == null) return null;
                return (string)key.GetValue("MachineGuid");
            }
        }
        catch { return null; }
    }
}
