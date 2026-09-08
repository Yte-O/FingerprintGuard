# FingerprintGuard 🛡️

FingerprintGuard 是一款强大的客户端指纹伪装工具，专门针对 Windows 桌面应用程序（特别是基于 Electron/Chromium 的应用）设计，使其能够在不改变系统真实设置的情况下，采集到与目标代理 IP 相匹配的一致性指纹。

## 原理架构

本项目采用 **双层伪装机制 (Double-Layer Spoofing)**，确保应用无论是通过系统 API 还是浏览器引擎获取的信息都保持高度一致：

1. **Win32 API Hook 层 (C++ MinHook)**:
   - 拦截系统底层调用，覆盖 `GetTimeZoneInformation`, `GetLocaleInfoW`, `EnumFontFamiliesExW`, `GetSystemMetrics` 等 API。
   - 实现**环境变量注入** (`TZ`, `LANG`, `LC_ALL`)，从根源上欺骗 V8 引擎和 ICU 国际化组件。
   - 伪装时区、系统语言、区域设置、字体列表和屏幕分辨率。

2. **JS CDP 注入层 (Node.js + Chrome DevTools Protocol)**:
   - 自动连接目标 Electron 应用的调试端口。
   - 注入 `fingerprint_override.js` 脚本，在页面加载前覆盖浏览器环境。
   - 完美伪造 `navigator` (语言、平台、UA 等)、`Intl` / `Date` 对象 (时区时间)、WebGL 渲染器信息以及对 Canvas 绘图加入一致性噪声以抵御指纹追踪。

3. **智能匹配中心 (GUI Server)**:
   - 内置 12 个国家/地区的优质指纹配置库。
   - 一键检测出口 IP 所在地理位置，并自动匹配对应的国家指纹。
   - 统一管理目标应用的启动、代理（SOCKS5）设置和多实例隔离。

---

## 快速开始

### 环境要求

- 操作系统: Windows 10 / 11 (64-bit)
- 运行环境: Node.js (建议 v18+)
- 目标程序: 任何 64 位应用程序 (针对 Electron/CEF 效果最佳)

### 1. 启动控制面板

本项目摒弃了繁琐的命令行，提供了现代化的高级 Web GUI。请在项目根目录下运行：

```bash
node gui_server.js
```

启动后，系统会自动在您的默认浏览器中打开控制面板（通常是 `http://127.0.0.1:7842`）。

### 2. 使用控制面板

GUI 界面分为以下几个核心功能区：

#### **启动配置**
- **目标应用程序**: 输入或点击“浏览”选择你要伪装启动的 `.exe` 文件路径（例如 `C:\Program Files\Google\Chrome\Application\chrome.exe`）。程序会自动检测 Chrome/Edge 浏览器并为其强制开启独立环境（`--user-data-dir`），保证完全隔离不受后台常驻进程干扰。
- **SOCKS5 / HTTP 代理**: (可选) 填写你的代理服务器地址（Host）和端口（Port）。
  - **代理认证支持**：如果你的 SOCKS5/HTTP 代理需要账号密码，可以直接填入**用户名**和**密码**。系统会在后台智能启动一个极轻量的“本地无密代理中转服务”，从而完美解决原生 Chromium 不支持代理账号密码注入的问题。
- **选择国家/地区**: 从列表中选择你希望伪装的国家。右侧的“指纹预览”会实时显示该国家的时区和语言设定。
- **自动检测 IP 并启动**: 点击此按钮，程序会自动检测你当前的真实出口 IP 地理位置，自动在库中寻找匹配的国家，然后立即启动目标程序！

#### **运行中的实例**
- 可以在这里看到所有通过 FingerprintGuard 启动的应用程序。
- 你可以同时启动多个不同国家指纹、不同代理的实例，它们之间**完全隔离**，互不干扰。
- 点击“停止”按钮可随时终止对应的应用进程。已停止的实例可点击“删除”彻底移除。

---

## 高级说明

### 指纹库扩展

内置了 12 个预设国家模板。你可以通过在 `shared/profiles/` 目录下添加或修改 `.json` 文件来自定义指纹。

示例格式 (JP.json):
```json
{
  "country": "JP",
  "country_name": "Japan",
  "timezone_iana": "Asia/Tokyo",
  "utc_offset": 540,
  "locale": "ja-JP",
  "languages": ["ja", "ja-JP", "en-US", "en"],
  "platform": "Win32",
  "webgl": {
    "vendor": "Google Inc. (NVIDIA)",
    "renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  },
  "canvas_seed": 1234567,
  "hardwareConcurrency": 16,
  "deviceMemory": 16,
  "resolution": { "width": 1920, "height": 1080, "colorDepth": 24 }
}
```

### 故障排除

1. **目标应用没有应用 WebGL/Canvas 伪装**
   - 目标应用必须是一个 Electron/Chromium 应用才能注入 JS。如果目标关闭了远程调试端口支持，JS 注入可能会失败。但是底层的 C++ DLL (时区、语言) 依然会生效。
2. **时区没有改变**
   - 确保你的目标应用没有使用自己内部硬编码的 NTP 服务器。大多数现代应用 (通过 V8/ICU) 会尊重本工具注入的 `TZ` 环境变量。

---
*FingerprintGuard - Protect your digital footprint.*
