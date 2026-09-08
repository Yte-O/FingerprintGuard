#include "config.h"
#include "../deps/MinHook/include/MinHook.h"
#include <cstring>

// ============================================================================
// FingerprintGuard — Timezone Hook
//
// Hooks:
//   GetTimeZoneInformation       -> returns spoofed TIME_ZONE_INFORMATION
//   GetDynamicTimeZoneInformation-> returns spoofed DYNAMIC_TIME_ZONE_INFORMATION
//   GetLocalTime                 -> returns time adjusted to target timezone
// ============================================================================

namespace fg {

extern FingerprintProfile g_profile;

// ---- Original function pointers -------------------------------------------

typedef DWORD(WINAPI* fn_GetTimeZoneInformation)(LPTIME_ZONE_INFORMATION);
static fn_GetTimeZoneInformation pOrigGetTZI = nullptr;

typedef DWORD(WINAPI* fn_GetDynamicTimeZoneInformation)(PDYNAMIC_TIME_ZONE_INFORMATION);
static fn_GetDynamicTimeZoneInformation pOrigGetDynTZI = nullptr;

typedef void(WINAPI* fn_GetLocalTime)(LPSYSTEMTIME);
static fn_GetLocalTime pOrigGetLocalTime = nullptr;

typedef void(WINAPI* fn_GetSystemTimeAsFileTime)(LPFILETIME);
static fn_GetSystemTimeAsFileTime pOrigGetSystemTimeAsFileTime = nullptr;

// ---- Helper: fill TIME_ZONE_INFORMATION from profile ----------------------

static void FillTZI(TIME_ZONE_INFORMATION* tzi) {
    ZeroMemory(tzi, sizeof(TIME_ZONE_INFORMATION));
    tzi->Bias = g_profile.bias;  // e.g. -540 for UTC+9

    // Copy the timezone name (max 32 wchars)
    const std::wstring& name = g_profile.timezone_windows;
    size_t len = min(name.size(), (size_t)31);
    wcsncpy_s(tzi->StandardName, 32, name.c_str(), len);
    wcsncpy_s(tzi->DaylightName, 32, name.c_str(), len);

    // No DST by default (simplification — most target regions don't use DST
    // or the profile would need to supply DST rules)
    tzi->StandardBias = 0;
    tzi->DaylightBias = 0;
}

// ---- Detour functions -----------------------------------------------------

static DWORD WINAPI Detour_GetTimeZoneInformation(LPTIME_ZONE_INFORMATION lpTZI) {
    if (!lpTZI) return TIME_ZONE_ID_UNKNOWN;
    FillTZI(lpTZI);
    return TIME_ZONE_ID_STANDARD;
}

static DWORD WINAPI Detour_GetDynamicTimeZoneInformation(PDYNAMIC_TIME_ZONE_INFORMATION lpDynTZI) {
    if (!lpDynTZI) return TIME_ZONE_ID_UNKNOWN;
    ZeroMemory(lpDynTZI, sizeof(DYNAMIC_TIME_ZONE_INFORMATION));
    lpDynTZI->Bias = g_profile.bias;

    const std::wstring& name = g_profile.timezone_windows;
    size_t len = min(name.size(), (size_t)31);
    wcsncpy_s(lpDynTZI->StandardName, 32, name.c_str(), len);
    wcsncpy_s(lpDynTZI->DaylightName, 32, name.c_str(), len);
    wcsncpy_s(lpDynTZI->TimeZoneKeyName, 128, name.c_str(), min(name.size(), (size_t)127));

    lpDynTZI->DynamicDaylightTimeDisabled = TRUE;
    return TIME_ZONE_ID_STANDARD;
}

static void WINAPI Detour_GetLocalTime(LPSYSTEMTIME lpSysTime) {
    if (!lpSysTime) return;

    // Get actual UTC time
    SYSTEMTIME utc;
    GetSystemTime(&utc);

    // Convert to FILETIME for arithmetic
    FILETIME ftUtc;
    SystemTimeToFileTime(&utc, &ftUtc);

    // Add the offset (utc_offset_minutes → 100ns ticks)
    ULARGE_INTEGER uli;
    uli.LowPart  = ftUtc.dwLowDateTime;
    uli.HighPart = ftUtc.dwHighDateTime;
    uli.QuadPart += (LONGLONG)g_profile.utc_offset_minutes * 60LL * 10000000LL;

    FILETIME ftLocal;
    ftLocal.dwLowDateTime  = uli.LowPart;
    ftLocal.dwHighDateTime = uli.HighPart;

    FileTimeToSystemTime(&ftLocal, lpSysTime);
}

// ---- Install / Uninstall ---------------------------------------------------

bool InstallTimezoneHooks() {
    HMODULE hKernel32 = GetModuleHandleW(L"kernel32.dll");
    if (!hKernel32) return false;

    auto pGTZI    = GetProcAddress(hKernel32, "GetTimeZoneInformation");
    auto pGDTZI   = GetProcAddress(hKernel32, "GetDynamicTimeZoneInformation");
    auto pGLT     = GetProcAddress(hKernel32, "GetLocalTime");

    bool ok = true;

    if (pGTZI) {
        ok &= (MH_CreateHook(pGTZI, &Detour_GetTimeZoneInformation,
                              reinterpret_cast<LPVOID*>(&pOrigGetTZI)) == MH_OK);
        ok &= (MH_EnableHook(pGTZI) == MH_OK);
    }

    if (pGDTZI) {
        ok &= (MH_CreateHook(pGDTZI, &Detour_GetDynamicTimeZoneInformation,
                              reinterpret_cast<LPVOID*>(&pOrigGetDynTZI)) == MH_OK);
        ok &= (MH_EnableHook(pGDTZI) == MH_OK);
    }

    if (pGLT) {
        ok &= (MH_CreateHook(pGLT, &Detour_GetLocalTime,
                              reinterpret_cast<LPVOID*>(&pOrigGetLocalTime)) == MH_OK);
        ok &= (MH_EnableHook(pGLT) == MH_OK);
    }

    return ok;
}

void UninstallTimezoneHooks() {
    HMODULE hKernel32 = GetModuleHandleW(L"kernel32.dll");
    if (!hKernel32) return;

    auto pGTZI  = GetProcAddress(hKernel32, "GetTimeZoneInformation");
    auto pGDTZI = GetProcAddress(hKernel32, "GetDynamicTimeZoneInformation");
    auto pGLT   = GetProcAddress(hKernel32, "GetLocalTime");

    if (pGTZI)  MH_DisableHook(pGTZI);
    if (pGDTZI) MH_DisableHook(pGDTZI);
    if (pGLT)   MH_DisableHook(pGLT);
}

} // namespace fg
