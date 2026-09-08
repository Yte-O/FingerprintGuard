#include "config.h"
#include "../deps/MinHook/include/MinHook.h"

// ============================================================================
// FingerprintGuard — Display / Resolution Hook
//
// Hooks:
//   GetSystemMetrics  -> returns spoofed screen width/height and other metrics
//   GetDeviceCaps     -> returns spoofed DPI, color depth, screen size
// ============================================================================

namespace fg {

extern FingerprintProfile g_profile;

// ---- Original function pointers -------------------------------------------

typedef int(WINAPI* fn_GetSystemMetrics)(int);
static fn_GetSystemMetrics pOrigGetSystemMetrics = nullptr;

typedef int(WINAPI* fn_GetDeviceCaps)(HDC, int);
static fn_GetDeviceCaps pOrigGetDeviceCaps = nullptr;

// ---- Detour functions -----------------------------------------------------

static int WINAPI Detour_GetSystemMetrics(int nIndex) {
    switch (nIndex) {
    case SM_CXSCREEN:
        return g_profile.resolution.width;
    case SM_CYSCREEN:
        return g_profile.resolution.height;
    case SM_CXVIRTUALSCREEN:
        return g_profile.resolution.width;
    case SM_CYVIRTUALSCREEN:
        return g_profile.resolution.height;
    default:
        return pOrigGetSystemMetrics(nIndex);
    }
}

static int WINAPI Detour_GetDeviceCaps(HDC hdc, int index) {
    switch (index) {
    case HORZRES:
        return g_profile.resolution.width;
    case VERTRES:
        return g_profile.resolution.height;
    case LOGPIXELSX:
        return g_profile.dpi;
    case LOGPIXELSY:
        return g_profile.dpi;
    case DESKTOPHORZRES:
        return g_profile.resolution.width;
    case DESKTOPVERTRES:
        return g_profile.resolution.height;
    default:
        return pOrigGetDeviceCaps(hdc, index);
    }
}

// ---- Install / Uninstall ---------------------------------------------------

bool InstallDisplayHooks() {
    HMODULE hUser32 = GetModuleHandleW(L"user32.dll");
    HMODULE hGdi32  = GetModuleHandleW(L"gdi32.dll");

    bool ok = true;

    if (hUser32) {
        auto p1 = GetProcAddress(hUser32, "GetSystemMetrics");
        if (p1) {
            ok &= (MH_CreateHook(p1, &Detour_GetSystemMetrics,
                                  reinterpret_cast<LPVOID*>(&pOrigGetSystemMetrics)) == MH_OK);
            ok &= (MH_EnableHook(p1) == MH_OK);
        }
    }

    if (hGdi32) {
        auto p2 = GetProcAddress(hGdi32, "GetDeviceCaps");
        if (p2) {
            ok &= (MH_CreateHook(p2, &Detour_GetDeviceCaps,
                                  reinterpret_cast<LPVOID*>(&pOrigGetDeviceCaps)) == MH_OK);
            ok &= (MH_EnableHook(p2) == MH_OK);
        }
    }

    return ok;
}

void UninstallDisplayHooks() {
    HMODULE hUser32 = GetModuleHandleW(L"user32.dll");
    HMODULE hGdi32  = GetModuleHandleW(L"gdi32.dll");

    if (hUser32) {
        auto p1 = GetProcAddress(hUser32, "GetSystemMetrics");
        if (p1) MH_DisableHook(p1);
    }
    if (hGdi32) {
        auto p2 = GetProcAddress(hGdi32, "GetDeviceCaps");
        if (p2) MH_DisableHook(p2);
    }
}

} // namespace fg
