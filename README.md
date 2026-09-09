# FingerprintGuard 🛡️

FingerprintGuard 是一款强大的客户端指纹伪装与代理隔离系统，专门针对 Windows 桌面应用程序（包括原生 Win32、Chromium/Electron 以及 **WindowsApps/UWP 沙盒客户端如 Claude、ChatGPT**）设计，使其能够在不改变宿主系统真实设置的前提下，全方位伪装与目标代理 IP 严格一致的数字指纹。

---

## 🌟 核心特性

- **跨架构应用兼容**：全面支持常规 Windows 应用程序、Electron 桌面客户端（Slack、Discord 等）以及 **WindowsApps / UWP 商店应用（ChatGPT、Claude 客户端等）**。
- **三层全维度伪装机制**：Win32 底层 API Hook + WinHTTP 网络栈代理拦截 + JS CDP 运行时覆盖。
- **杜绝真实 IP 泄漏**：内置 WinHTTP 代理拦截钩子，强制接管应用网络配置，杜绝 UWP 或系统组件绕过代理直连真实 IP。
- **深度防指纹对抗**：
  - **时区与区域**：环境变量（`TZ`、`LANG`）+ 底层 Win32 时区 API + JS `Intl`/`Date` 原生对象三重覆盖。
  - **字体指纹**：采用原生原型链剥离与 WeakMap 深度拦截，智能剔除宿主特有本地字体（如中文字体），阻止反作弊脚本通过 Canvas/DOM measure 探测宿主真实地区。
  - **硬件与渲染**：WebGL Vendor/Renderer 伪造、一致性 Canvas 噪点注入、AudioContext 音频指纹扰动、屏幕分辨率与硬件并发数伪装。
  - **网络与通信**：WebRTC 真实 IP 候选过滤，彻底防范 WebRTC 穿透泄漏。
- **现代化 Web 控制面板**：
  - 一键 IP 地理位置探测与指纹模板智能匹配。
  - 支持免密与带账号密码的 SOCKS5 / HTTP 代理，内置无感知代理中转服务。
  - 实例完全多开隔离（独立进程、独立数据目录 `--user-data-dir`、独立 PID 配置文件）。

---

## 🏗️ 架构原理解析

```
┌─────────────────────────────────────────────────────────────┐
│                    FingerprintGuard 控制中心                │
│             (Web GUI: http://127.0.0.1:7842)                │
└──────────────┬──────────────────────────────┬───────────────┘
               │ 1. 动态生成 PID 专属配置     │ 2. 进程挂钩与控制
               ▼                              ▼
┌──────────────────────────────┐ ┌────────────────────────────┐
│      Win32 & Electron 应用   │ │    UWP / WindowsApps 应用  │
│  (Chrome / Edge / 桌面软件)  │ │   (Claude.exe, ChatGPT)    │
└──────────────┬───────────────┘ └────────────┬───────────────┘
               │                              │
               │                              ▼
               │                dll_attach.ps1 (远程线程注入)
               │                              │
               ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       FGHook.dll (MinHook)                  │
├─────────────────────────────────────────────────────────────┤
│ • 时区与区域: GetTimeZoneInformation, GetLocaleInfoW        │
│ • 字体列表拦截: EnumFontFamiliesExW                         │
│ • 环境变量伪装: TZ, LANG, LC_ALL                            │
│ • WinHTTP 代理劫持: WinHttpGetIEProxyConfigForCurrentUser   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│               JS CDP 运行时注入 (fingerprint_override.js)   │
├─────────────────────────────────────────────────────────────┤
│ • Intl.DateTimeFormat, Date, Navigator (UA, Platform, Lang) │
│ • Canvas 2D 字体测量劫持 (WeakMap 隔离，移除本地特征字体)   │
│ • WebGL Vendor/Renderer, WebRTC IP 泄漏防御, AudioContext   │
└─────────────────────────────────────────────────────────────┘
```

### 1. Win32 API Hook 层 (`hook-dll`)
- 拦截底层 `GetTimeZoneInformation`, `GetLocaleInfoW`, `EnumFontFamiliesExW`, `GetSystemMetrics` 等系统 API。
- 注入环境变量（`TZ`, `LANG`, `LC_ALL`），从进程源头欺骗 V8 引擎与 ICU 国际化库。
- **WinHTTP 代理拦截 (`proxy_hook.cpp`)**：拦截 `WinHttpGetIEProxyConfigForCurrentUser`，将用户设定的代理服务器强制喂给应用底层 HTTP 客户端，确保桌面应用即使绕过 Chromium 参数也能走指定代理通道。
- **Node.js 后端代理集成**：自动将 `http_proxy`、`https_proxy` 环境变量注入口令层，确保 Electron 应用（如 Claude）底层的原生 Node.js 请求强制走指定代理。

### 2. UWP 沙盒动态注入 (`dll_attach.ps1`)
- 针对受 WindowsApps 沙盒与权限保护的应用，优先采用 `shell:AppsFolder` 原生沙盒激活机制。
- 携带代理与调试端口参数 (`-ArgumentList`) 动态拉起进程，实现无缝传递。
- 启动应用后自动轮询目标进程 PID，并通过 PowerShell 采用基于 `CreateRemoteThread` + `LoadLibraryW` 的跨进程注入机制下发独立配置与 DLL。

### 3. JS CDP 注入层 (`js-inject`)
- 针对 Chromium / Electron 页面，在任何业务代码运行前通过 Chrome DevTools Protocol 注入 `fingerprint_override.js`。
- 全面覆盖 `Intl`、`Date`、`navigator`、`screen`、`WebGL` 与 `Canvas`，实现无死角指纹一致性。

---

## 🚀 快速上手

### 环境要求

- **操作系统**: Windows 10 / 11 (64-bit)
- **Node.js**: v18+ (推荐)
- **编译器 (若需自编译 DLL)**: CMake 3.15+ 与 Visual Studio 2019/2022 (MSVC C++17)

### 1. 一键启动方式 (任选其一)

#### **方式 A: 桌面托盘原生小程序 (推荐 🌟)**
双击运行根目录下的 **`FingerprintGuard.exe`**：
- **无黑色 CMD 命令行窗口**，完全后台静默运行。
- 在 Windows 任务栏右下角生成 **🛡️ 托盘图标**。
- 自动调起系统默认浏览器打开控制面板 (`http://127.0.0.1:7842`)。
- 右键点击托盘图标可随时进行 **“打开控制面板”**、**“重启服务”**、**“打开程序目录”** 或 **“退出程序”**。
- *（可选）双击运行 **`创建桌面快捷方式.bat`**，即可直接在 Windows 桌面上创建专属图标，后续双击桌面图标即可直接启动！*

#### **方式 B: 双击批处理脚本**
双击根目录下的 **`一键启动.bat`**，脚本将自动检测 Node.js 环境并唤起启动程序。

#### **方式 C: 命令行启动**
在项目根目录下直接运行：
```bash
node gui_server.js
```

### 2. 界面操作指南

#### **应用启动与配置**
1. **目标应用程序**:
   - **普通应用**: 点击“浏览”或填入目标路径，如 Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`)。
   - **UWP / Windows 应用**: 直接填入 WindowsApps 应用路径（如 Claude 桌面版、ChatGPT 客户端），系统会自动激活 UWP 专用注入流。
2. **代理配置**:
   - 支持 **SOCKS5** 与 **HTTP** 代理。
   - **支持带密码认证**：可直接填写用户名与密码，FingerprintGuard 会自动在本地启动安全的无密转接通道，解决原生 Chromium 不支持代理凭据注入的难题。
3. **选择地区模板**:
   - 从 12+ 个预设国家/地区模板中选择（涵盖美、英、日、德、新、韩等），右侧指纹预览会实时展示该地区的语言、时区与配置参数。
4. **一键智能启动**:
   - 点击 **“自动检测 IP 并启动”**：程序将自动检测当前出口 IP 的归属地，秒级匹配最契合的国家模板并启动实例。

#### **多实例管理**
- 每一个启动的应用都会在列表中作为一个独立实例展示。
- 各实例拥有独立的调试端口、数据隔离目录和进程生命周期。
- 支持单个实例查看控制台输出、状态跟踪、一键终止与删除。

---

## 🛠️ 高级配置与扩展

### 自定义指纹模板

指纹模板存放于 `shared/profiles/` 目录，以 JSON 格式存储。可以自由添加或调整模板属性：

```json
{
  "country": "US",
  "country_name": "United States",
  "timezone_iana": "America/New_York",
  "utc_offset": -300,
  "locale": "en-US",
  "languages": ["en-US", "en"],
  "platform": "Win32",
  "webgl": {
    "vendor": "Google Inc. (NVIDIA)",
    "renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  "canvas_seed": 9876543,
  "hardwareConcurrency": 16,
  "deviceMemory": 16,
  "resolution": { "width": 1920, "height": 1080, "colorDepth": 24 }
}
```

### 重新编译 FGHook.dll

若对 C++ 底层钩子进行了修改，可在 `hook-dll` 目录下快速重新编译：

```powershell
cd hook-dll
mkdir build -ErrorAction SilentlyContinue
cd build
cmake .. -A x64
cmake --build . --config Release
```

编译输出的 `FGHook.dll` 将位于 `hook-dll/build/`，GUI 服务会自动加载最新构建。

---

## ❓ 常见问题排查 (FAQ)

**Q: Claude 或 ChatGPT 等 UWP 应用启动后显示真实 IP 怎么办？**
- 确保代理设置填写正确，且系统编译的 `FGHook.dll` 正常生成在 `hook-dll/build/FGHook.dll`。FingerprintGuard 包含专门的 `WinHttpGetIEProxyConfigForCurrentUser` 钩子，会自动将全局代理注入到 UWP 进程中。

**Q: 为什么某些页面依然能够通过字体检测到本地语言？**
- 本工具已在 JS 运行时通过 WeakMap 代理剔除了包含常见非目标语言字体（如中文字体家族）的字体样式，并重写了 `CanvasRenderingContext2D.prototype.measureText`。如遇特殊变体，可在 `js-inject/fingerprint_override.js` 的 `BLOCKED_FONTS` 列表中添加相应字体族名称。

**Q: 启动 Chrome 提示已在运行或指纹未生效？**
- 普通浏览器如果后台有同名常驻进程，会复用已有的主进程导致参数失效。FingerprintGuard 会自动为每个浏览器实例分配独立的 `--user-data-dir` 临时配置目录，保证每次启动均为全新独立环境。

---

*FingerprintGuard - Protect your digital footprint seamlessly.*

