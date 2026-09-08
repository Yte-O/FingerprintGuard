#include "config.h"
#include "../deps/MinHook/include/MinHook.h"
#include <vector>
#include <algorithm>

// ============================================================================
// FingerprintGuard — Font Enumeration Hook
//
// Hooks:
//   EnumFontFamiliesExW -> injects region-specific fonts into the callback
//
// Strategy:
//   1. Call the original EnumFontFamiliesExW to get real system fonts.
//   2. After the real enumeration, inject our region-specific fonts by calling
//      the callback with fabricated ENUMLOGFONTEXW entries.
//   This ensures the target app sees both the system fonts AND the regional
//   fonts it expects to find.
// ============================================================================

namespace fg {

extern FingerprintProfile g_profile;

// ---- Original function pointer --------------------------------------------

typedef int(WINAPI* fn_EnumFontFamiliesExW)(HDC, LPLOGFONTW, FONTENUMPROCW, LPARAM, DWORD);
static fn_EnumFontFamiliesExW pOrigEnumFontFamiliesExW = nullptr;

// ---- Tracking which fonts the callback already saw ------------------------

struct FontEnumContext {
    FONTENUMPROCW  originalCallback;
    LPARAM         originalParam;
    std::vector<std::wstring> seenFonts;
};

static int CALLBACK TrackingCallback(
    const LOGFONTW* lf,
    const TEXTMETRICW* tm,
    DWORD fontType,
    LPARAM lParam)
{
    FontEnumContext* ctx = reinterpret_cast<FontEnumContext*>(lParam);
    if (lf) {
        ctx->seenFonts.push_back(lf->lfFaceName);
    }
    // Forward to the original callback
    return ctx->originalCallback(lf, tm, fontType, ctx->originalParam);
}

// ---- Detour function ------------------------------------------------------

static int WINAPI Detour_EnumFontFamiliesExW(
    HDC hdc,
    LPLOGFONTW lpLogfont,
    FONTENUMPROCW lpProc,
    LPARAM lParam,
    DWORD dwFlags)
{
    if (!lpProc) {
        return pOrigEnumFontFamiliesExW(hdc, lpLogfont, lpProc, lParam, dwFlags);
    }

    // Wrap the callback to track seen fonts
    FontEnumContext ctx;
    ctx.originalCallback = lpProc;
    ctx.originalParam    = lParam;

    int result = pOrigEnumFontFamiliesExW(hdc, lpLogfont, TrackingCallback,
                                           reinterpret_cast<LPARAM>(&ctx), dwFlags);

    // Now inject region-specific fonts that weren't already enumerated
    for (const auto& fontName : g_profile.fonts_common) {
        bool alreadySeen = false;
        for (const auto& seen : ctx.seenFonts) {
            if (_wcsicmp(seen.c_str(), fontName.c_str()) == 0) {
                alreadySeen = true;
                break;
            }
        }

        if (!alreadySeen) {
            // Create a fabricated LOGFONTW for this font
            LOGFONTW fakeLogFont = {};
            wcsncpy_s(fakeLogFont.lfFaceName, LF_FACESIZE, fontName.c_str(),
                       min(fontName.size(), (size_t)(LF_FACESIZE - 1)));
            fakeLogFont.lfCharSet   = DEFAULT_CHARSET;
            fakeLogFont.lfHeight    = 0;
            fakeLogFont.lfWeight    = FW_NORMAL;
            fakeLogFont.lfOutPrecision = OUT_TT_PRECIS;
            fakeLogFont.lfQuality   = CLEARTYPE_QUALITY;

            TEXTMETRICW fakeTM = {};
            fakeTM.tmHeight        = 16;
            fakeTM.tmAscent        = 13;
            fakeTM.tmDescent       = 3;
            fakeTM.tmAveCharWidth  = 7;
            fakeTM.tmMaxCharWidth  = 14;
            fakeTM.tmWeight        = FW_NORMAL;
            fakeTM.tmCharSet       = DEFAULT_CHARSET;

            // Call the original callback with our fake font
            int cont = lpProc(&fakeLogFont, &fakeTM, TRUETYPE_FONTTYPE, lParam);
            if (cont == 0) break; // Callback requested stop
        }
    }

    return result;
}

// ---- Install / Uninstall ---------------------------------------------------

bool InstallFontHooks() {
    HMODULE hGdi32 = GetModuleHandleW(L"gdi32.dll");
    if (!hGdi32) return false;

    auto p = GetProcAddress(hGdi32, "EnumFontFamiliesExW");
    if (!p) return false;

    bool ok = true;
    ok &= (MH_CreateHook(p, &Detour_EnumFontFamiliesExW,
                          reinterpret_cast<LPVOID*>(&pOrigEnumFontFamiliesExW)) == MH_OK);
    ok &= (MH_EnableHook(p) == MH_OK);
    return ok;
}

void UninstallFontHooks() {
    HMODULE hGdi32 = GetModuleHandleW(L"gdi32.dll");
    if (!hGdi32) return;
    auto p = GetProcAddress(hGdi32, "EnumFontFamiliesExW");
    if (p) MH_DisableHook(p);
}

} // namespace fg
