#include "config.h"
#include "../deps/MinHook/include/MinHook.h"
#include <winhttp.h>

namespace fg {

extern FingerprintProfile g_profile;

typedef BOOL(WINAPI* fn_WinHttpGetIEProxyConfigForCurrentUser)(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG*);
static fn_WinHttpGetIEProxyConfigForCurrentUser pOrigWinHttpGetIEProxyConfigForCurrentUser = nullptr;

static BOOL WINAPI Detour_WinHttpGetIEProxyConfigForCurrentUser(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG* pProxyConfig) {
    if (!g_profile.proxy_server.empty()) {
        pProxyConfig->fAutoDetect = FALSE;
        pProxyConfig->lpszAutoConfigUrl = NULL;
        
        size_t len = g_profile.proxy_server.length() + 1;
        pProxyConfig->lpszProxy = (LPWSTR)GlobalAlloc(GPTR, len * sizeof(WCHAR));
        MultiByteToWideChar(CP_UTF8, 0, g_profile.proxy_server.c_str(), -1, pProxyConfig->lpszProxy, (int)len);
        
        pProxyConfig->lpszProxyBypass = (LPWSTR)GlobalAlloc(GPTR, 32 * sizeof(WCHAR));
        wcscpy_s(pProxyConfig->lpszProxyBypass, 32, L"<-loopback>");
        
        return TRUE;
    }
    
    if (pOrigWinHttpGetIEProxyConfigForCurrentUser) {
        return pOrigWinHttpGetIEProxyConfigForCurrentUser(pProxyConfig);
    }
    return FALSE;
}

bool InstallProxyHooks() {
    HMODULE hWinHttp = LoadLibraryA("winhttp.dll");
    if (!hWinHttp) return false;

    void* pWinHttpGetIEProxyConfigForCurrentUser = GetProcAddress(hWinHttp, "WinHttpGetIEProxyConfigForCurrentUser");
    if (pWinHttpGetIEProxyConfigForCurrentUser) {
        MH_CreateHook(pWinHttpGetIEProxyConfigForCurrentUser, &Detour_WinHttpGetIEProxyConfigForCurrentUser, (LPVOID*)&pOrigWinHttpGetIEProxyConfigForCurrentUser);
        MH_EnableHook(pWinHttpGetIEProxyConfigForCurrentUser);
    }

    return true;
}

void UninstallProxyHooks() {
    MH_DisableHook(MH_ALL_HOOKS); // Simplification, other uninstalls will disable too
}

} // namespace fg
