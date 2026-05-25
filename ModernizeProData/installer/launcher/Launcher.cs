// ModernizeProData installer launcher.
//
// Pops a tiny WinForms dialog asking for language, then invokes msiexec
// with TRANSFORMS=:<lang-code> and APP_LANG=<lang> so the .msi installs
// the matching locale strings and the installed app remembers the choice.
//
// Compile with .NET Framework's csc.exe (always present on Win10/11):
//   csc.exe /target:winexe /out:Launcher.exe ^
//           /reference:System.Windows.Forms.dll ^
//           /reference:System.Drawing.dll Launcher.cs
//
// Language targeting:
//   ko -> 1042 (ko-KR)
//   ja -> 1041 (ja-JP)
//   en -> 1033 (en-US)

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        using (var dialog = new LanguageDialog())
        {
            if (dialog.ShowDialog() != DialogResult.OK)
            {
                return 1;
            }

            string lang = dialog.SelectedLanguage;

            // Per-language .msi rather than a single transform-embedded MSI:
            // sub-storage embedding requires msitran.exe / msidb.exe which are
            // not present on this build host, so we ship three pre-built MSIs
            // and dispatch to the one matching the user's selection. The
            // ProductCode is identical across all three, so only one ever
            // installs at a time.
            string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? ".";
            string msi = Path.Combine(exeDir, "ModernizeProData-" + lang + "-1.0.0.msi");
            if (!File.Exists(msi))
            {
                MessageBox.Show(
                    "Localized installer not found next to Launcher.exe.\n\nExpected:\n" + msi,
                    "ModernizeProData",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 2;
            }

            // APP_LANG goes into the installed app's registry so React picks
            // the right UI language on first boot. /l*v captures a verbose
            // install log next to the launcher for troubleshooting.
            string logPath = Path.Combine(exeDir, "install-" + lang + ".log");
            string arguments = "/i \"" + msi + "\" APP_LANG=" + lang + " /l*v \"" + logPath + "\"";
            var psi = new ProcessStartInfo("msiexec.exe", arguments)
            {
                UseShellExecute = true   // msiexec needs shell so UAC prompts work properly.
            };

            try
            {
                using (var proc = Process.Start(psi))
                {
                    proc.WaitForExit();
                    return proc.ExitCode;
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Failed to start the installer:\n\n" + ex.Message,
                    "ModernizeProData",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 3;
            }
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



internal sealed class LanguageDialog : Form
{
    public string SelectedLanguage { get; private set; }

    private readonly ComboBox _combo;

    // Unified brand font across the launcher dialog and the React UI.
    private static readonly System.Drawing.Font BrandFont =
        new System.Drawing.Font("Hoax Mono JP", 10.5F);
    private static readonly System.Drawing.Font KoFont = BrandFont;
    private static readonly System.Drawing.Font JaFont = BrandFont;
    private static readonly System.Drawing.Font EnFont = BrandFont;

    public LanguageDialog()
    {
        SelectedLanguage = "en";
        Text = "ModernizeProData Setup";
        Width = 440;
        Height = 230;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = true;
        // Yu Gothic UI renders Latin, Hangul, and Kana cleanly in one face so
        // the mixed-script heading doesn't pick up jagged fallback glyphs.
        Font = new System.Drawing.Font("Hoax Mono JP", 9.5F);

        var heading = new Label
        {
            Text = "Select language / 언어 선택 / 言語選択",
            Top = 18,
            Left = 22,
            Width = 380,
            Height = 24,
            Font = new System.Drawing.Font("Hoax Mono JP", 11F, System.Drawing.FontStyle.Bold)
        };
        Controls.Add(heading);

        var hint = new Label
        {
            Text = "This sets the installer language and the app's default language.",
            Top = 46,
            Left = 22,
            Width = 380,
            Height = 32,
            ForeColor = System.Drawing.SystemColors.GrayText
        };
        Controls.Add(hint);

        _combo = new ComboBox
        {
            Top = 84,
            Left = 22,
            Width = 380,
            DropDownStyle = ComboBoxStyle.DropDownList,
            DrawMode = DrawMode.OwnerDrawFixed,
            ItemHeight = 26
        };
        _combo.Items.Add("한국어 (Korean)");
        _combo.Items.Add("日本語 (Japanese)");
        _combo.Items.Add("English");
        _combo.SelectedIndex = SystemDefaultIndex();
        _combo.DrawItem += ComboDrawItem;
        Controls.Add(_combo);

        var okBtn = new Button
        {
            Text = "OK",
            Top = 140,
            Left = 240,
            Width = 78,
            Height = 30,
            DialogResult = DialogResult.OK
        };
        okBtn.Click += (s, e) =>
        {
            switch (_combo.SelectedIndex)
            {
                case 0: SelectedLanguage = "ko"; break;
                case 1: SelectedLanguage = "ja"; break;
                default: SelectedLanguage = "en"; break;
            }
        };
        Controls.Add(okBtn);

        var cancelBtn = new Button
        {
            Text = "Cancel",
            Top = 140,
            Left = 324,
            Width = 78,
            Height = 30,
            DialogResult = DialogResult.Cancel
        };
        Controls.Add(cancelBtn);

        AcceptButton = okBtn;
        CancelButton = cancelBtn;
    }

    private void ComboDrawItem(object sender, DrawItemEventArgs e)
    {
        e.DrawBackground();
        if (e.Index < 0) { return; }

        System.Drawing.Font font;
        switch (e.Index)
        {
            case 0:  font = KoFont; break;
            case 1:  font = JaFont; break;
            default: font = EnFont; break;
        }

        string text = _combo.Items[e.Index].ToString();
        using (var brush = new System.Drawing.SolidBrush(e.ForeColor))
        {
            var bounds = e.Bounds;
            bounds.X += 6;
            // Vertical-center the text inside the row.
            var size = e.Graphics.MeasureString(text, font);
            float y = bounds.Y + (bounds.Height - size.Height) / 2;
            e.Graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            e.Graphics.DrawString(text, font, brush, bounds.X, y);
        }
        e.DrawFocusRectangle();
    }

    /// <summary>
    /// Default the dropdown to the OS UI culture so most users just hit OK.
    /// </summary>
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
}
