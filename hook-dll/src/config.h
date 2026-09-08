#pragma once
#ifndef FG_CONFIG_H
#define FG_CONFIG_H

#include <windows.h>
#include <string>
#include <vector>
#include <map>

// ============================================================================
// FingerprintGuard — Configuration
// Loads the fingerprint profile that the Hook DLL uses to return spoofed data.
//
// Communication between GUI launcher and DLL:
//   GUI writes a JSON config file to %TEMP%\fg_<pid>.json
//   DLL reads this config on DLL_PROCESS_ATTACH using its own PID.
// ============================================================================

namespace fg {

struct Resolution {
    int width  = 1920;
    int height = 1080;
};

struct WebGLInfo {
    std::string vendor   = "Google Inc. (NVIDIA)";
    std::string renderer = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
};

struct FingerprintProfile {
    // Timezone
    std::string timezone_iana;        // e.g. "Asia/Tokyo"
    std::wstring timezone_windows;    // e.g. L"Tokyo Standard Time"
    int         utc_offset_minutes;   // e.g. 540 for UTC+9
    int         bias;                 // e.g. -540  (Windows BIAS = -offset)

    // Locale
    std::wstring locale;              // e.g. L"ja-JP"
    LCID         lcid;                // e.g. 0x0411
    LANGID       ui_language;         // e.g. MAKELANGID(LANG_JAPANESE, SUBLANG_DEFAULT)
    std::vector<std::wstring> languages;  // e.g. {"ja", "ja-JP", "en-US"}

    // Fonts
    std::vector<std::wstring> fonts_common;  // Fonts to add to enumeration

    // Display
    Resolution resolution;
    int        dpi = 96;

    // WebGL / Canvas (passed to JS layer, stored here for reference)
    WebGLInfo  webgl;
    uint32_t   canvas_seed = 0;

    // User-Agent hint
    std::string ua_hint;
};

// Load the profile from the temp JSON file for the current process
bool LoadProfile(FingerprintProfile& profile);

// Load profile from a specific file path
bool LoadProfileFromFile(const std::wstring& path, FingerprintProfile& profile);

// Get the config file path for a given PID
std::wstring GetConfigPath(DWORD pid = 0);

} // namespace fg

#endif // FG_CONFIG_H
