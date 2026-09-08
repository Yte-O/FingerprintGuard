#include <windows.h>
#include "config.h"
#include "hooks/hooks.h"
#include "../deps/MinHook/include/MinHook.h"

// ============================================================================
// FingerprintGuard — DLL Entry Point
//
// On DLL_PROCESS_ATTACH:
//   1. Load the fingerprint profile from %TEMP%/fg_<pid>.json
//   2. Initialize MinHook
//   3. Install all API hooks
//
// On DLL_PROCESS_DETACH:
//   1. Uninstall all hooks
//   2. Uninitialize MinHook
// ============================================================================

namespace fg {

// Global profile instance — referenced by all hook modules via `extern`
FingerprintProfile g_profile;

static bool g_initialized = false;

static void DebugLog(const wchar_t* msg) {
    OutputDebugStringW(L"[FingerprintGuard] ");
    OutputDebugStringW(msg);
    OutputDebugStringW(L"\n");
}

static bool Initialize() {
    DebugLog(L"Initializing...");

    // 1. Load fingerprint profile
    if (!LoadProfile(g_profile)) {
        // Try alternative: config path from environment variable
        wchar_t envPath[MAX_PATH] = {};
        DWORD len = GetEnvironmentVariableW(L"FG_CONFIG_PATH", envPath, MAX_PATH);
        if (len > 0 && len < MAX_PATH) {
            if (!LoadProfileFromFile(envPath, g_profile)) {
                DebugLog(L"ERROR: Failed to load fingerprint profile");
                return false;
            }
        } else {
            DebugLog(L"ERROR: No config file found (tried PID-based and FG_CONFIG_PATH)");
            return false;
        }
    }

    DebugLog(L"Profile loaded successfully");

    // 2. Initialize MinHook
    if (MH_Initialize() != MH_OK) {
        DebugLog(L"ERROR: MH_Initialize failed");
        return false;
    }

    DebugLog(L"MinHook initialized");

    // 3. Install hooks
    bool allOk = true;

    if (!InstallTimezoneHooks()) {
        DebugLog(L"WARNING: Timezone hooks failed");
        allOk = false;
    } else {
        DebugLog(L"Timezone hooks installed");
    }

    if (!InstallLocaleHooks()) {
        DebugLog(L"WARNING: Locale hooks failed");
        allOk = false;
    } else {
        DebugLog(L"Locale hooks installed");
    }

    if (!InstallFontHooks()) {
        DebugLog(L"WARNING: Font hooks failed");
        allOk = false;
    } else {
        DebugLog(L"Font hooks installed");
    }

    if (!InstallDisplayHooks()) {
        DebugLog(L"WARNING: Display hooks failed");
        allOk = false;
    } else {
        DebugLog(L"Display hooks installed");
    }

    if (allOk) {
        DebugLog(L"All hooks installed successfully!");
    } else {
        DebugLog(L"Some hooks failed — partial protection only");
    }

    return true;  // Return true even if some hooks failed
}

static void Shutdown() {
    DebugLog(L"Shutting down...");

    UninstallTimezoneHooks();
    UninstallLocaleHooks();
    UninstallFontHooks();
    UninstallDisplayHooks();

    MH_Uninitialize();

    DebugLog(L"Shutdown complete");
}

} // namespace fg

// ============================================================================
// DLL Entry Point
// ============================================================================

BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved) {
    switch (ul_reason_for_call) {
    case DLL_PROCESS_ATTACH:
        DisableThreadLibraryCalls(hModule);
        fg::g_initialized = fg::Initialize();
        break;

    case DLL_PROCESS_DETACH:
        if (fg::g_initialized) {
            fg::Shutdown();
        }
        break;
    }
    return TRUE;
}
