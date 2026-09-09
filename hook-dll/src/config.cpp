#include "config.h"
#include <fstream>
#include <sstream>
#include <algorithm>

// ============================================================================
// FingerprintGuard — Config Loader
//
// Minimal JSON parser (no external dependency). Parses the flat-ish JSON
// produced by the GUI launcher. For a production build you would swap this
// for nlohmann/json or RapidJSON.
// ============================================================================

namespace fg {

// --------------- tiny helpers ------------------------------------------------

static std::wstring Utf8ToWide(const std::string& str) {
    if (str.empty()) return {};
    int sz = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), (int)str.size(), nullptr, 0);
    std::wstring out(sz, 0);
    MultiByteToWideChar(CP_UTF8, 0, str.c_str(), (int)str.size(), &out[0], sz);
    return out;
}

static std::string Trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    size_t b = s.find_last_not_of(" \t\r\n");
    return (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
}

// Extract a JSON string value:  "key": "value"
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

// Extract a JSON integer value:  "key": 123
static int JsonInt(const std::string& json, const std::string& key, int def = 0) {
    std::string needle = "\"" + key + "\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) return def;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return def;
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    try { return std::stoi(json.substr(pos)); } catch (...) { return def; }
}

// Extract a JSON unsigned integer value
static uint32_t JsonUint(const std::string& json, const std::string& key, uint32_t def = 0) {
    std::string needle = "\"" + key + "\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) return def;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return def;
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    try { return (uint32_t)std::stoul(json.substr(pos)); } catch (...) { return def; }
}

// Extract a JSON array of strings:  "key": ["a", "b", "c"]
static std::vector<std::string> JsonStrArr(const std::string& json, const std::string& key) {
    std::vector<std::string> result;
    std::string needle = "\"" + key + "\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) return result;
    pos = json.find('[', pos);
    if (pos == std::string::npos) return result;
    auto end = json.find(']', pos);
    if (end == std::string::npos) return result;
    std::string arr = json.substr(pos + 1, end - pos - 1);
    size_t p = 0;
    while (true) {
        auto q1 = arr.find('"', p);
        if (q1 == std::string::npos) break;
        auto q2 = arr.find('"', q1 + 1);
        if (q2 == std::string::npos) break;
        result.push_back(arr.substr(q1 + 1, q2 - q1 - 1));
        p = q2 + 1;
    }
    return result;
}

// Extract a nested JSON object as string: "key": { ... }
static std::string JsonObj(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) return "";
    pos = json.find('{', pos);
    if (pos == std::string::npos) return "";
    int depth = 0;
    size_t end = pos;
    for (; end < json.size(); end++) {
        if (json[end] == '{') depth++;
        else if (json[end] == '}') { depth--; if (depth == 0) break; }
    }
    return json.substr(pos, end - pos + 1);
}

// --------------- public API --------------------------------------------------

std::wstring GetConfigPath(DWORD pid) {
    if (pid == 0) pid = GetCurrentProcessId();
    wchar_t tmp[MAX_PATH];
    GetTempPathW(MAX_PATH, tmp);
    return std::wstring(tmp) + L"fg_" + std::to_wstring(pid) + L".json";
}

bool LoadProfileFromFile(const std::wstring& path, FingerprintProfile& p) {
    std::ifstream f(path);
    if (!f.is_open()) return false;

    std::ostringstream ss;
    ss << f.rdbuf();
    std::string json = ss.str();
    if (json.empty()) return false;

    // Timezone
    p.timezone_iana    = JsonStr(json, "timezone_iana");
    p.timezone_windows = Utf8ToWide(JsonStr(json, "timezone_windows"));
    p.utc_offset_minutes = JsonInt(json, "utc_offset", 0);
    p.bias             = -p.utc_offset_minutes;

    // Locale
    p.locale       = Utf8ToWide(JsonStr(json, "locale"));
    p.lcid         = (LCID)JsonUint(json, "lcid", 0x0409);
    p.ui_language  = (LANGID)JsonInt(json, "ui_language", MAKELANGID(LANG_ENGLISH, SUBLANG_ENGLISH_US));

    auto langs = JsonStrArr(json, "languages");
    p.languages.clear();
    for (auto& l : langs) p.languages.push_back(Utf8ToWide(l));

    // Fonts
    auto fonts = JsonStrArr(json, "fonts_common");
    p.fonts_common.clear();
    for (auto& f : fonts) p.fonts_common.push_back(Utf8ToWide(f));

    // Display
    std::string res = JsonObj(json, "resolution");
    if (!res.empty()) {
        p.resolution.width  = JsonInt(res, "w", 1920);
        p.resolution.height = JsonInt(res, "h", 1080);
    }
    p.dpi = JsonInt(json, "dpi", 96);

    // WebGL
    std::string wgl = JsonObj(json, "webgl");
    if (!wgl.empty()) {
        p.webgl.vendor   = JsonStr(wgl, "vendor");
        p.webgl.renderer = JsonStr(wgl, "renderer");
    }

    // Canvas
    p.canvas_seed = JsonUint(json, "canvas_seed", 0);

    // UA
    p.ua_hint = JsonStr(json, "ua_hint");

    // Proxy
    p.proxy_server = JsonStr(json, "proxyServer");

    return true;
}

bool LoadProfile(FingerprintProfile& profile) {
    std::wstring path = GetConfigPath();
    return LoadProfileFromFile(path, profile);
}

} // namespace fg
