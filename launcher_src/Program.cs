using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace FingerprintGuard.Launcher
{
    static class Program
    {
        private static Process serverProcess = null;
        private static NotifyIcon trayIcon = null;
        private static string projectDir = "";
        private static string nodePath = "";

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            projectDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');

            // Single instance check
            bool isNewInstance = false;
            using (Mutex mutex = new Mutex(true, "FingerprintGuard_Launcher_SingleInstance_Mutex_7842", out isNewInstance))
            {
                if (!isNewInstance)
                {
                    try
                    {
                        Process.Start("http://127.0.0.1:7842");
                    }
                    catch { }
                    return;
                }

                // Locate Node.js
                nodePath = FindNodeExecutable();
                if (string.IsNullOrEmpty(nodePath))
                {
                    DialogResult dr = MessageBox.Show(
                        "未在系统中检测到 Node.js 运行环境！\n\nFingerprintGuard 需要 Node.js (推荐 v18+) 才能运行。\n是否立即打开 Node.js 官方网站进行下载安装？",
                        "FingerprintGuard 启动提示",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Warning);

                    if (dr == DialogResult.Yes)
                    {
                        try { Process.Start("https://nodejs.org/"); } catch { }
                    }
                    return;
                }

                // Generate Tray Icon
                Icon appIcon = CreateShieldIcon();

                // Setup Tray Icon & Menu
                trayIcon = new NotifyIcon();
                trayIcon.Icon = appIcon;
                trayIcon.Text = "FingerprintGuard 指纹伪装系统";
                trayIcon.Visible = true;

                ContextMenu menu = new ContextMenu();
                MenuItem itemOpen = new MenuItem("🌐 打开控制面板", (s, e) => OpenDashboard());
                MenuItem itemRestart = new MenuItem("🔄 重启服务", (s, e) => RestartServer());
                MenuItem itemDir = new MenuItem("📁 打开程序目录", (s, e) => OpenProjectDir());
                MenuItem itemSep = new MenuItem("-");
                MenuItem itemExit = new MenuItem("❌ 退出 FingerprintGuard", (s, e) => ExitApplication());

                menu.MenuItems.Add(itemOpen);
                menu.MenuItems.Add(itemRestart);
                menu.MenuItems.Add(itemDir);
                menu.MenuItems.Add(itemSep);
                menu.MenuItems.Add(itemExit);

                trayIcon.ContextMenu = menu;
                trayIcon.DoubleClick += (s, e) => OpenDashboard();

                // Start node server process
                StartServer();

                // Show startup notification
                trayIcon.ShowBalloonTip(
                    3000,
                    "FingerprintGuard 已就绪",
                    "控制面板正在后台运行：http://127.0.0.1:7842\n双击托盘图标或右键菜单可随时唤出界面。",
                    ToolTipIcon.Info);

                // Handle application exit
                Application.ApplicationExit += (s, e) => StopServer();
                AppDomain.CurrentDomain.ProcessExit += (s, e) => StopServer();

                Application.Run();
            }
        }

        private static string FindNodeExecutable()
        {
            // 1. Check PATH directories
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            string[] paths = pathEnv.Split(';');
            foreach (string p in paths)
            {
                if (string.IsNullOrWhiteSpace(p)) continue;
                try
                {
                    string full = Path.Combine(p.Trim(), "node.exe");
                    if (File.Exists(full)) return full;
                }
                catch { }
            }

            // 2. Check well-known locations
            string[] candidates = new string[]
            {
                @"D:\a\nodejs\node.exe",
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\node\node.exe")
            };

            foreach (string cand in candidates)
            {
                if (File.Exists(cand)) return cand;
            }

            return null;
        }

        private static void StartServer()
        {
            try
            {
                string scriptPath = Path.Combine(projectDir, "gui_server.js");
                if (!File.Exists(scriptPath))
                {
                    MessageBox.Show(
                        string.Format("未找到核心服务文件 gui_server.js！\n路径: {0}", scriptPath),
                        "FingerprintGuard 错误",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return;
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodePath;
                psi.Arguments = string.Format("\"{0}\"", scriptPath);
                psi.WorkingDirectory = projectDir;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;

                serverProcess = Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    string.Format("启动服务失败: {0}", ex.Message),
                    "FingerprintGuard 错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        private static void StopServer()
        {
            try
            {
                if (serverProcess != null && !serverProcess.HasExited)
                {
                    // Kill process tree
                    ProcessStartInfo psi = new ProcessStartInfo("taskkill", string.Format("/PID {0} /T /F", serverProcess.Id));
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    Process.Start(psi).WaitForExit(2000);
                }
            }
            catch { }
            finally
            {
                serverProcess = null;
            }
        }

        private static void RestartServer()
        {
            StopServer();
            Thread.Sleep(500);
            StartServer();
            if (trayIcon != null)
            {
                trayIcon.ShowBalloonTip(2000, "服务已重启", "FingerprintGuard 服务已重新加载并启动。", ToolTipIcon.Info);
            }
        }

        private static void OpenDashboard()
        {
            try
            {
                Process.Start("http://127.0.0.1:7842");
            }
            catch { }
        }

        private static void OpenProjectDir()
        {
            try
            {
                Process.Start("explorer.exe", projectDir);
            }
            catch { }
        }

        private static void ExitApplication()
        {
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
                trayIcon = null;
            }
            StopServer();
            Application.Exit();
        }

        private static Icon CreateShieldIcon()
        {
            try
            {
                string iconPath = Path.Combine(projectDir, "app.ico");
                if (File.Exists(iconPath))
                {
                    return new Icon(iconPath);
                }
                Icon exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (exeIcon != null) return exeIcon;
            }
            catch { }

            try
            {
                // Draw a 32x32 shield icon
                using (Bitmap bmp = new Bitmap(32, 32))
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);

                    // Shield contour path
                    using (GraphicsPath path = new GraphicsPath())
                    {
                        path.AddLine(16, 2, 28, 6);
                        path.AddBezier(28, 6, 28, 16, 22, 24, 16, 29);
                        path.AddBezier(16, 29, 10, 24, 4, 16, 4, 6);
                        path.CloseFigure();

                        // Fill gradient (Cyan to Deep Blue)
                        using (LinearGradientBrush brush = new LinearGradientBrush(
                            new Rectangle(0, 0, 32, 32),
                            Color.FromArgb(14, 165, 233), // Sky blue
                            Color.FromArgb(30, 58, 138),  // Dark blue
                            LinearGradientMode.Vertical))
                        {
                            g.FillPath(brush, path);
                        }

                        // Shield border
                        using (Pen borderPen = new Pen(Color.FromArgb(224, 242, 254), 1.5f))
                        {
                            g.DrawPath(borderPen, path);
                        }
                    }

                    // Draw inner checkmark or "FG"
                    using (Pen checkPen = new Pen(Color.White, 2.5f))
                    {
                        checkPen.StartCap = LineCap.Round;
                        checkPen.EndCap = LineCap.Round;
                        g.DrawLines(checkPen, new Point[] {
                            new Point(10, 15),
                            new Point(14, 19),
                            new Point(22, 10)
                        });
                    }

                    IntPtr hIcon = bmp.GetHicon();
                    return Icon.FromHandle(hIcon);
                }
            }
            catch
            {
                return SystemIcons.Shield;
            }
        }
    }
}
