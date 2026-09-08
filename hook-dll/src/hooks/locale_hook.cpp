#include "config.h"
#include "../deps/MinHook/include/MinHook.h"
#include <cstring>

// ============================================================================
// FingerprintGuard — Locale / Language Hook
//
// Hooks:
//   GetUserDefaultLocaleName      -> returns spoofed locale string
//   GetUserDefaultLCID            -> returns spoofed LCID
//   GetSystemDefaultUILanguage    -> returns spoofed LANGID
//   GetUserDefaultUILanguage      -> returns spoofed LANGID
//   GetLocaleInfoW                -> returns spoofed locale info
// ============================================================================

namespace fg {

extern FingerprintProfile g_profile;

// ---- Original function pointers -------------------------------------------

typedef int(WINAPI* fn_GetUserDefaultLocaleName)(LPWSTR, int);
static fn_GetUserDefaultLocaleName pOrigGetUserDefaultLocaleName = nullptr;

typedef LCID(WINAPI* fn_GetUserDefaultLCID)();
static fn_GetUserDefaultLCID pOrigGetUserDefaultLCID = nullptr;

typedef LANGID(WINAPI* fn_GetSystemDefaultUILanguage)();
static fn_GetSystemDefaultUILanguage pOrigGetSystemDefaultUILanguage = nullptr;

typedef LANGID(WINAPI* fn_GetUserDefaultUILanguage)();
static fn_GetUserDefaultUILanguage pOrigGetUserDefaultUILanguage = nullptr;

typedef int(WINAPI* fn_GetLocaleInfoW)(LCID, LCTYPE, LPWSTR, int);
static fn_GetLocaleInfoW pOrigGetLocaleInfoW = nullptr;

typedef int(WINAPI* fn_GetLocaleInfoEx)(LPCWSTR, LCTYPE, LPWSTR, int);
static fn_GetLocaleInfoEx pOrigGetLocaleInfoEx = nullptr;

typedef int(WINAPI* fn_GetSystemDefaultLocaleName)(LPWSTR, int);
static fn_GetSystemDefaultLocaleName pOrigGetSystemDefaultLocaleName = nullptr;

// ---- Detour functions -----------------------------------------------------

static int WINAPI Detour_GetUserDefaultLocaleName(LPWSTR lpLocaleName, int cchLocaleName) {
    if (!lpLocaleName || cchLocaleName <= 0) return 0;
    const std::wstring& loc = g_profile.locale;
    int len = min((int)loc.size(), cchLocaleName - 1);
    wcsncpy_s(lpLocaleName, cchLocaleName, loc.c_str(), len);
    return len + 1;
}

static LCID WINAPI Detour_GetUserDefaultLCID() {
    return g_profile.lcid;
}

static LANGID WINAPI Detour_GetSystemDefaultUILanguage() {
    return g_profile.ui_language;
}

static LANGID WINAPI Detour_GetUserDefaultUILanguage() {
    return g_profile.ui_language;
}

static int WINAPI Detour_GetLocaleInfoW(LCID Locale, LCTYPE LCType, LPWSTR lpLCData, int cchData) {
    // Override the locale to our target LCID
    // For LOCALE_USER_DEFAULT or the original LCID, redirect to our spoofed one
    if (Locale == LOCALE_USER_DEFAULT || Locale == LOCALE_SYSTEM_DEFAULT) {
        Locale = g_profile.lcid;
    }

    // For locale name queries, return our spoofed locale
    LCTYPE baseType = LCType & ~LOCALE_RETURN_NUMBER;
    if (baseType == LOCALE_SISO639LANGNAME || baseType == LOCALE_SISO3166CTRYNAME ||
        baseType == LOCALE_SNAME || baseType == LOCALE_SENGLISHLANGUAGENAME) {
        // Let the real API handle it with our redirected LCID
        return pOrigGetLocaleInfoW(g_profile.lcid, LCType, lpLCData, cchData);
    }

    // For all other types, redirect to our LCID
    return pOrigGetLocaleInfoW(g_profile.lcid, LCType, lpLCData, cchData);
}

static int WINAPI Detour_GetLocaleInfoEx(LPCWSTR lpLocaleName, LCTYPE LCType, LPWSTR lpLCData, int cchData) {
    // Redirect any user/system locale queries to our spoofed locale name
    LPCWSTR targetLocale = g_profile.locale.c_str();

    if (lpLocaleName == LOCALE_NAME_USER_DEFAULT ||
        lpLocaleName == LOCALE_NAME_SYSTEM_DEFAULT ||
        lpLocaleName == nullptr) {
        return pOrigGetLocaleInfoEx(targetLocale, LCType, lpLCData, cchData);
    }

    // Also redirect if the query is for the real system locale
    return pOrigGetLocaleInfoEx(targetLocale, LCType, lpLCData, cchData);
}

static int WINAPI Detour_GetSystemDefaultLocaleName(LPWSTR lpLocaleName, int cchLocaleName) {
    if (!lpLocaleName || cchLocaleName <= 0) return 0;
    const std::wstring& loc = g_profile.locale;
    int len = min((int)loc.size(), cchLocaleName - 1);
    wcsncpy_s(lpLocaleName, cchLocaleName, loc.c_str(), len);
    return len + 1;
}

// ---- Install / Uninstall ---------------------------------------------------

bool InstallLocaleHooks() {
    HMODULE hKernel32 = GetModuleHandleW(L"kernel32.dll");
    if (!hKernel32) return false;

    bool ok = true;

    auto p1 = GetProcAddress(hKernel32, "GetUserDefaultLocaleName");
    if (p1) {
        ok &= (MH_CreateHook(p1, &Detour_GetUserDefaultLocaleName,
                              reinterpret_cast<LPVOID*>(&pOrigGetUserDefaultLocaleName)) == MH_OK);
        ok &= (MH_EnableHook(p1) == MH_OK);
    }

    auto p2 = GetProcAddress(hKernel32, "GetUserDefaultLCID");
    if (p2) {
        ok &= (MH_CreateHook(p2, &Detour_GetUserDefaultLCID,
                              reinterpret_cast<LPVOID*>(&pOrigGetUserDefaultLCID)) == MH_OK);
        ok &= (MH_EnableHook(p2) == MH_OK);
    }

    auto p3 = GetProcAddress(hKernel32, "GetSystemDefaultUILanguage");
    if (p3) {
        ok &= (MH_CreateHook(p3, &Detour_GetSystemDefaultUILanguage,
                              reinterpret_cast<LPVOID*>(&pOrigGetSystemDefaultUILanguage)) == MH_OK);
        ok &= (MH_EnableHook(p3) == MH_OK);
    }

    auto p4 = GetProcAddress(hKernel32, "GetUserDefaultUILanguage");
    if (p4) {
        ok &= (MH_CreateHook(p4, &Detour_GetUserDefaultUILanguage,
                              reinterpret_cast<LPVOID*>(&pOrigGetUserDefaultUILanguage)) == MH_OK);
        ok &= (MH_EnableHook(p4) == MH_OK);
    }

    auto p5 = GetProcAddress(hKernel32, "GetLocaleInfoW");
    if (p5) {
        ok &= (MH_CreateHook(p5, &Detour_GetLocaleInfoW,
                              reinterpret_cast<LPVOID*>(&pOrigGetLocaleInfoW)) == MH_OK);
        ok &= (MH_EnableHook(p5) == MH_OK);
    }

    auto p6 = GetProcAddress(hKernel32, "GetLocaleInfoEx");
    if (p6) {
        ok &= (MH_CreateHook(p6, &Detour_GetLocaleInfoEx,
                              reinterpret_cast<LPVOID*>(&pOrigGetLocaleInfoEx)) == MH_OK);
        ok &= (MH_EnableHook(p6) == MH_OK);
    }

    auto p7 = GetProcAddress(hKernel32, "GetSystemDefaultLocaleName");
    if (p7) {
        ok &= (MH_CreateHook(p7, &Detour_GetSystemDefaultLocaleName,
                              reinterpret_cast<LPVOID*>(&pOrigGetSystemDefaultLocaleName)) == MH_OK);
        ok &= (MH_EnableHook(p7) == MH_OK);
    }

    return ok;
}

void UninstallLocaleHooks() {
    HMODULE hKernel32 = GetModuleHandleW(L"kernel32.dll");
    if (!hKernel32) return;

    auto p1 = GetProcAddress(hKernel32, "GetUserDefaultLocaleName");
    auto p2 = GetProcAddress(hKernel32, "GetUserDefaultLCID");
    auto p3 = GetProcAddress(hKernel32, "GetSystemDefaultUILanguage");
    auto p4 = GetProcAddress(hKernel32, "GetUserDefaultUILanguage");
    auto p5 = GetProcAddress(hKernel32, "GetLocaleInfoW");
    auto p6 = GetProcAddress(hKernel32, "GetLocaleInfoEx");
    auto p7 = GetProcAddress(hKernel32, "GetSystemDefaultLocaleName");

    if (p1) MH_DisableHook(p1);
    if (p2) MH_DisableHook(p2);
    if (p3) MH_DisableHook(p3);
    if (p4) MH_DisableHook(p4);
    if (p5) MH_DisableHook(p5);
    if (p6) MH_DisableHook(p6);
    if (p7) MH_DisableHook(p7);
}

} // namespace fg
