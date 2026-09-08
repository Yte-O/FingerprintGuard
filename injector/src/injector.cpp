#include <windows.h>
#include <tlhelp32.h>
#include <iostream>
#include <string>
#include <fstream>
#include <sstream>
#include <vector>
#include <map>

// ============================================================================
// FingerprintGuard — Process Injector
//
// Usage:
//   FGInjector.exe <target.exe> <config.json> [--dll <path_to_FGHook.dll>]
//
// This tool:
//   1. Reads the fingerprint config JSON
//   2. Launches the target process in a SUSPENDED state
//   3. Writes the config to %TEMP%/fg_<pid>.json
//   4. Injects FGHook.dll into the target process
//   5. Resumes the process
//
// The target process will have all system API calls hooked before its own
// code executes, ensuring the fingerprint data is consistent from startup.
// ============================================================================

// Enable SE_DEBUG_NAME privilege
static bool EnableDebugPrivilege() {
    HANDLE hToken;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hToken))
        return false;

    TOKEN_PRIVILEGES tp;
    tp.PrivilegeCount = 1;
    tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    if (!LookupPrivilegeValueW(nullptr, L"SeDebugPrivilege", &tp.Privileges[0].Luid)) {
        CloseHandle(hToken);
        return false;
    }

    BOOL result = AdjustTokenPrivileges(hToken, FALSE, &tp, sizeof(tp), nullptr, nullptr);
    CloseHandle(hToken);
    return result && GetLastError() != ERROR_NOT_ALL_ASSIGNED;
}

// Copy config file to %TEMP%/fg_<pid>.json
static bool WriteConfigForPid(DWORD pid, const std::string& configContent) {
    wchar_t tmp[MAX_PATH];
    GetTempPathW(MAX_PATH, tmp);
    std::wstring path = std::wstring(tmp) + L"fg_" + std::to_wstring(pid) + L".json";

    std::ofstream f(path, std::ios::binary);
    if (!f.is_open()) return false;
    f.write(configContent.c_str(), configContent.size());
    f.close();

    std::wcout << L"[+] Config written to: " << path << std::endl;
    return true;
}

// Inject DLL into target process using CreateRemoteThread + LoadLibraryW
static bool InjectDLL(HANDLE hProcess, const std::wstring& dllPath) {
    // Allocate memory in target process for the DLL path
    size_t pathSize = (dllPath.size() + 1) * sizeof(wchar_t);
    LPVOID remoteMem = VirtualAllocEx(hProcess, nullptr, pathSize,
                                       MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remoteMem) {
        std::cerr << "[-] VirtualAllocEx failed: " << GetLastError() << std::endl;
        return false;
    }

    // Write the DLL path to the target process
    if (!WriteProcessMemory(hProcess, remoteMem, dllPath.c_str(), pathSize, nullptr)) {
        std::cerr << "[-] WriteProcessMemory failed: " << GetLastError() << std::endl;
        VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
        return false;
    }

    // Get LoadLibraryW address (same in all processes due to ASLR kernel32 mapping)
    HMODULE hKernel32 = GetModuleHandleW(L"kernel32.dll");
    LPVOID pLoadLibrary = (LPVOID)GetProcAddress(hKernel32, "LoadLibraryW");
    if (!pLoadLibrary) {
        std::cerr << "[-] GetProcAddress(LoadLibraryW) failed" << std::endl;
        VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
        return false;
    }

    // Create remote thread to call LoadLibraryW with our DLL path
    HANDLE hThread = CreateRemoteThread(hProcess, nullptr, 0,
                                         (LPTHREAD_START_ROUTINE)pLoadLibrary,
                                         remoteMem, 0, nullptr);
    if (!hThread) {
        std::cerr << "[-] CreateRemoteThread failed: " << GetLastError() << std::endl;
        VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
        return false;
    }

    // Wait for the remote thread to complete (DLL loaded)
    WaitForSingleObject(hThread, 5000);

    // Check if LoadLibrary succeeded by reading the thread exit code
    DWORD exitCode = 0;
    GetExitCodeThread(hThread, &exitCode);

    CloseHandle(hThread);
    VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);

    if (exitCode == 0) {
        std::cerr << "[-] LoadLibraryW returned NULL in target process" << std::endl;
        return false;
    }

    return true;
}

// Get the absolute path of the DLL (default: same directory as injector)
static std::wstring GetDefaultDllPath() {
    wchar_t exePath[MAX_PATH];
    GetModuleFileNameW(nullptr, exePath, MAX_PATH);
    std::wstring path(exePath);
    size_t lastSlash = path.find_last_of(L"\\/");
    if (lastSlash != std::wstring::npos) {
        path = path.substr(0, lastSlash + 1);
    }
    return path + L"FGHook.dll";
}

// Convert narrow string to wide
static std::wstring ToWide(const std::string& s) {
    if (s.empty()) return {};
    int sz = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring out(sz, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], sz);
    return out;
}

// Read entire file to string
static std::string ReadFile(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open()) return "";
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// Simple JSON string value extractor:  "key": "value"
static std::string JsonStr(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) return "";
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return "";
    pos = json.find('"', pos + 1);
    if (pos == std::string::npos) return "";
    auto end = json.find('"', pos + 1);
    if (end == std::string::npos) return "";
    return json.substr(pos + 1, end - pos - 1);
}

// Build a custom environment block for the child process.
// Inherits the current environment, then overrides/adds TZ, LANG, LC_ALL,
// FG_CONFIG_PATH so that V8/ICU picks up the correct timezone and locale.
static std::vector<wchar_t> BuildEnvironmentBlock(
    const std::string& configJson,
    const std::wstring& configFilePath)
{
    // Collect current environment
    std::map<std::wstring, std::wstring> envMap;
    LPWCH envStrings = GetEnvironmentStringsW();
    if (envStrings) {
        const wchar_t* p = envStrings;
        while (*p) {
            std::wstring entry(p);
            auto eq = entry.find(L'=');
            if (eq != std::wstring::npos && eq > 0) {
                std::wstring name = entry.substr(0, eq);
                std::wstring val  = entry.substr(eq + 1);
                envMap[name] = val;
            }
            p += entry.size() + 1;
        }
        FreeEnvironmentStringsW(envStrings);
    }

    // Extract values from config JSON
    std::string tzIana = JsonStr(configJson, "timezone_iana");  // e.g. "Asia/Tokyo"
    std::string locale = JsonStr(configJson, "locale");          // e.g. "ja-JP"

    // Override environment variables
    if (!tzIana.empty()) {
        envMap[L"TZ"] = ToWide(tzIana);
    }
    if (!locale.empty()) {
        // LANG format: ll_CC.UTF-8  (e.g. ja_JP.UTF-8)
        std::string langVal = locale;
        // Convert "ja-JP" -> "ja_JP.UTF-8"
        for (auto& c : langVal) { if (c == '-') c = '_'; }
        langVal += ".UTF-8";
        envMap[L"LANG"]   = ToWide(langVal);
        envMap[L"LC_ALL"] = ToWide(langVal);
    }
    envMap[L"FG_CONFIG_PATH"] = configFilePath;

    // Build the environment block (double-null terminated)
    std::vector<wchar_t> block;
    for (auto& [name, val] : envMap) {
        std::wstring entry = name + L"=" + val;
        block.insert(block.end(), entry.begin(), entry.end());
        block.push_back(L'\0');
    }
    block.push_back(L'\0'); // Double null terminator
    return block;
}

// ============================================================================
// MAIN
// ============================================================================

int wmain(int argc, wchar_t* argv[]) {
    std::wcout << L"=== FingerprintGuard Injector v1.0 ===" << std::endl;

    if (argc < 3) {
        std::wcout << L"Usage: FGInjector.exe <target.exe> <config.json> [--dll <FGHook.dll>] [-- extra args...]" << std::endl;
        std::wcout << L"\nExample:" << std::endl;
        std::wcout << L"  FGInjector.exe \"C:\\Users\\P\\AppData\\Local\\Programs\\cursor\\Cursor.exe\" profile_jp.json" << std::endl;
        std::wcout << L"  FGInjector.exe \"C:\\...\\Claude.exe\" profile_jp.json --dll C:\\path\\to\\FGHook.dll" << std::endl;
        return 1;
    }

    std::wstring targetExe  = argv[1];
    std::wstring configPath = argv[2];
    std::wstring dllPath    = GetDefaultDllPath();

    // Parse optional args
    std::wstring extraArgs;
    for (int i = 3; i < argc; i++) {
        if (wcscmp(argv[i], L"--dll") == 0 && i + 1 < argc) {
            dllPath = argv[++i];
        } else if (wcscmp(argv[i], L"--") == 0) {
            // Everything after -- is passed to the target process
            for (int j = i + 1; j < argc; j++) {
                if (!extraArgs.empty()) extraArgs += L" ";
                extraArgs += argv[j];
            }
            break;
        }
    }

    // Read config file
    std::ifstream configFile(configPath, std::ios::binary);
    if (!configFile.is_open()) {
        std::wcerr << L"[-] Cannot open config file: " << configPath << std::endl;
        return 1;
    }
    std::ostringstream ss;
    ss << configFile.rdbuf();
    std::string configContent = ss.str();
    configFile.close();

    if (configContent.empty()) {
        std::wcerr << L"[-] Config file is empty" << std::endl;
        return 1;
    }

    // Verify DLL exists
    DWORD dllAttr = GetFileAttributesW(dllPath.c_str());
    if (dllAttr == INVALID_FILE_ATTRIBUTES) {
        std::wcerr << L"[-] DLL not found: " << dllPath << std::endl;
        return 1;
    }

    // Enable debug privilege
    EnableDebugPrivilege();

    // Build command line
    std::wstring cmdLine = L"\"" + targetExe + L"\"";
    if (!extraArgs.empty()) {
        cmdLine += L" " + extraArgs;
    }

    std::wcout << L"[*] Target:  " << targetExe << std::endl;
    std::wcout << L"[*] DLL:     " << dllPath << std::endl;
    std::wcout << L"[*] Config:  " << configPath << std::endl;

    // Build custom environment block with TZ, LANG, LC_ALL
    // This is the absolute config path we'll write to shortly
    wchar_t tmpDir[MAX_PATH];
    GetTempPathW(MAX_PATH, tmpDir);
    // We don't know the PID yet, but we can construct it after CreateProcess.
    // For the env block, pass the config file path directly via FG_CONFIG_PATH.
    wchar_t absConfigPath[MAX_PATH];
    GetFullPathNameW(configPath.c_str(), MAX_PATH, absConfigPath, nullptr);
    auto envBlock = BuildEnvironmentBlock(configContent, absConfigPath);

    std::wcout << L"[*] Environment: TZ=" << ToWide(JsonStr(configContent, "timezone_iana"))
               << L", LANG=" << ToWide(JsonStr(configContent, "locale")) << std::endl;

    // Create target process in SUSPENDED state
    STARTUPINFOW si = {};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi = {};

    if (!CreateProcessW(nullptr, &cmdLine[0], nullptr, nullptr, FALSE,
                         CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                         envBlock.data(), nullptr, &si, &pi)) {
        std::wcerr << L"[-] CreateProcess failed: " << GetLastError() << std::endl;
        return 1;
    }

    std::wcout << L"[+] Process created (PID: " << pi.dwProcessId << L") — SUSPENDED" << std::endl;

    // Write config file for the target PID
    if (!WriteConfigForPid(pi.dwProcessId, configContent)) {
        std::wcerr << L"[-] Failed to write config for PID" << std::endl;
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        return 1;
    }

    // Inject the hook DLL
    std::wcout << L"[*] Injecting DLL..." << std::endl;
    if (!InjectDLL(pi.hProcess, dllPath)) {
        std::wcerr << L"[-] DLL injection failed" << std::endl;
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        return 1;
    }

    std::wcout << L"[+] DLL injected successfully!" << std::endl;

    // Resume the main thread
    ResumeThread(pi.hThread);
    std::wcout << L"[+] Process resumed — fingerprint hooks active" << std::endl;

    // Clean up handles
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    std::wcout << L"[+] Done. Target is running with spoofed fingerprint." << std::endl;
    return 0;
}
