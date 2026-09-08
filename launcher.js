// ============================================================================
// FingerprintGuard — Unified Launcher
//
// All-in-one launcher that combines:
//   1. Win32 API hooks (DLL injection via FGInjector)
//   2. Chromium JS hooks (CDP injection via fingerprint_override.js)
//   3. SOCKS5 proxy support
//   4. Auto IP geolocation → fingerprint matching
//
// Usage:
//   node launcher.js <target.exe> [options]
//
// Options:
//   --profile <path>        Use a specific profile JSON file
//   --country <code>        Use a country profile (e.g. JP, US, KR)
//   --proxy <url>           SOCKS5 proxy (e.g. socks5://127.0.0.1:1080)
//   --auto                  Auto-detect IP and match fingerprint
//   --debug-port <port>     CDP debug port (default: 9222)
//   --no-dll                Skip DLL injection (JS-only mode)
//   --no-js                 Skip JS injection (DLL-only mode)
// ============================================================================

const { spawn, execSync, execFileSync } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---- Constants -------------------------------------------------------------
const ROOT_DIR       = path.resolve(__dirname);
const PROFILES_DIR   = path.join(ROOT_DIR, 'shared', 'profiles');
const INJECTOR_EXE   = path.join(ROOT_DIR, 'hook-dll', 'build', 'FGInjector.exe');
const OVERRIDE_JS    = path.join(ROOT_DIR, 'js-inject', 'fingerprint_override.js');
const CDP_LAUNCHER   = path.join(ROOT_DIR, 'js-inject', 'launcher_cdp.js');

// ---- Parse arguments -------------------------------------------------------
const args = process.argv.slice(2);
if (args.length < 1) {
    console.log(`
=== FingerprintGuard v1.0 ===

Usage: node launcher.js <target.exe> [options]

Options:
  --profile <path>        Use a specific profile JSON file
  --country <code>        Use a country code (JP, US, KR, CN, TW, GB, DE, FR, RU, BR, IN, AU)
  --proxy <url>           SOCKS5 proxy (e.g. socks5://127.0.0.1:1080)
  --auto                  Auto-detect exit IP and match fingerprint
  --debug-port <port>     CDP debug port (default: 9222)
  --no-dll                Skip DLL injection (JS-only mode)
  --no-js                 Skip JS injection (DLL-only mode)

Examples:
  node launcher.js "C:\\...\\Cursor.exe" --country JP
  node launcher.js "C:\\...\\Claude.exe" --auto --proxy socks5://127.0.0.1:1080
  node launcher.js "C:\\...\\app.exe" --profile ./my_custom_profile.json
`);
    process.exit(1);
}

let targetExe = args[0];
let profilePath = null;
let countryCode = null;
let proxyUrl = null;
let autoDetect = false;
let debugPort = 9222;
let useDll = true;
let useJs = true;

for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
        case '--profile': profilePath = args[++i]; break;
        case '--country': countryCode = args[++i]; break;
        case '--proxy':   proxyUrl = args[++i]; break;
        case '--auto':    autoDetect = true; break;
        case '--debug-port': debugPort = parseInt(args[++i]); break;
        case '--no-dll':  useDll = false; break;
        case '--no-js':   useJs = false; break;
    }
}

// ---- Helper functions ------------------------------------------------------

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

async function getExitIP() {
    try {
        const ip = (await httpGet('https://api.ipify.org')).trim();
        return ip;
    } catch {
        try {
            const ip = (await httpGet('http://ifconfig.me/ip')).trim();
            return ip;
        } catch {
            return null;
        }
    }
}

async function geolocateIP(ip) {
    try {
        const data = JSON.parse(
            await httpGet(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,timezone,lat,lon`)
        );
        if (data.status === 'success') return data;
    } catch {}
    return null;
}

// Map common timezone to country code
function timezoneToCountry(timezone) {
    const map = {
        'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR',
        'Asia/Shanghai': 'CN', 'Asia/Taipei': 'TW',
        'America/New_York': 'US', 'America/Chicago': 'US',
        'America/Denver': 'US', 'America/Los_Angeles': 'US',
        'Europe/London': 'GB', 'Europe/Berlin': 'DE',
        'Europe/Paris': 'FR', 'Europe/Moscow': 'RU',
        'America/Sao_Paulo': 'BR', 'Asia/Kolkata': 'IN',
        'Australia/Sydney': 'AU',
    };
    return map[timezone] || null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Main ------------------------------------------------------------------

async function main() {
    console.log('=== FingerprintGuard v1.0 ===\n');

    // Step 1: Determine the profile
    let profile;

    if (profilePath) {
        // Explicit profile file
        console.log(`[*] Loading profile: ${profilePath}`);
        profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    } else if (countryCode) {
        // Country code
        const p = path.join(PROFILES_DIR, `${countryCode.toUpperCase()}.json`);
        if (!fs.existsSync(p)) {
            console.error(`[-] Profile not found for country: ${countryCode}`);
            console.error(`    Available: ${fs.readdirSync(PROFILES_DIR).map(f => f.replace('.json','')).join(', ')}`);
            process.exit(1);
        }
        console.log(`[*] Using country profile: ${countryCode.toUpperCase()}`);
        profile = JSON.parse(fs.readFileSync(p, 'utf8'));
    } else if (autoDetect) {
        // Auto-detect from exit IP
        console.log('[*] Auto-detecting exit IP...');
        const ip = await getExitIP();
        if (!ip) {
            console.error('[-] Could not detect exit IP');
            process.exit(1);
        }
        console.log(`[+] Exit IP: ${ip}`);

        const geo = await geolocateIP(ip);
        if (!geo) {
            console.error('[-] Could not geolocate IP');
            process.exit(1);
        }
        console.log(`[+] Location: ${geo.city}, ${geo.country} (${geo.countryCode})`);
        console.log(`[+] Timezone: ${geo.timezone}`);

        // Find matching profile
        const cc = geo.countryCode || timezoneToCountry(geo.timezone);
        const p = path.join(PROFILES_DIR, `${cc}.json`);
        if (fs.existsSync(p)) {
            profile = JSON.parse(fs.readFileSync(p, 'utf8'));
            console.log(`[+] Matched profile: ${profile.country_name}`);
        } else {
            console.warn(`[!] No profile for country ${cc}, using closest timezone match`);
            // Fallback: just use the detected timezone and country to build a minimal profile
            const fallbackCC = timezoneToCountry(geo.timezone) || 'US';
            const fp = path.join(PROFILES_DIR, `${fallbackCC}.json`);
            profile = JSON.parse(fs.readFileSync(fp, 'utf8'));
            // Override timezone from actual geo data
            profile.timezone_iana = geo.timezone;
            console.log(`[+] Using fallback profile: ${profile.country_name} with timezone ${geo.timezone}`);
        }
    } else {
        console.error('[-] No profile specified. Use --profile, --country, or --auto');
        process.exit(1);
    }

    console.log(`\n[*] Fingerprint Summary:`);
    console.log(`    Country:    ${profile.country_name} (${profile.country})`);
    console.log(`    Timezone:   ${profile.timezone_iana}`);
    console.log(`    Locale:     ${profile.locale}`);
    console.log(`    Languages:  ${profile.languages.join(', ')}`);
    console.log(`    Resolution: ${profile.resolution.w}x${profile.resolution.h}`);
    if (proxyUrl) console.log(`    Proxy:      ${proxyUrl}`);
    console.log('');

    // Step 2: Write temp config for DLL injection
    const tempConfig = path.join(process.env.TEMP || '.', `fg_config_${Date.now()}.json`);
    fs.writeFileSync(tempConfig, JSON.stringify(profile, null, 2));

    // Step 3: Launch with DLL injection
    if (useDll && fs.existsSync(INJECTOR_EXE)) {
        console.log('[*] Phase 1: DLL injection (Win32 API hooks)...');

        const injArgs = [targetExe, tempConfig];

        // Add proxy as extra arg for Electron
        if (proxyUrl) {
            injArgs.push('--');
            injArgs.push(`--remote-debugging-port=${debugPort}`);
            injArgs.push('--remote-allow-origins=*');
            injArgs.push(`--proxy-server=${proxyUrl}`);
        } else {
            injArgs.push('--');
            injArgs.push(`--remote-debugging-port=${debugPort}`);
            injArgs.push('--remote-allow-origins=*');
        }

        try {
            const result = execFileSync(INJECTOR_EXE, injArgs, {
                encoding: 'utf8',
                timeout: 15000,
                env: {
                    ...process.env,
                    TZ: profile.timezone_iana,
                    LANG: profile.locale.replace('-', '_') + '.UTF-8',
                    LC_ALL: profile.locale.replace('-', '_') + '.UTF-8',
                }
            });
            console.log(result.trim());
            console.log('[+] DLL injection complete\n');
        } catch (e) {
            console.warn(`[!] DLL injection failed: ${e.message}`);
            console.warn('[!] Falling back to JS-only mode\n');
        }
    } else if (useDll) {
        console.warn(`[!] FGInjector.exe not found at ${INJECTOR_EXE}`);
        console.warn('[!] Skipping DLL injection\n');

        // Launch process manually without DLL injection
        const electronArgs = [
            `--remote-debugging-port=${debugPort}`,
            '--remote-allow-origins=*',
        ];
        if (proxyUrl) electronArgs.push(`--proxy-server=${proxyUrl}`);

        spawn(targetExe, electronArgs, {
            stdio: 'inherit',
            detached: true,
            env: {
                ...process.env,
                TZ: profile.timezone_iana,
                LANG: profile.locale.replace('-', '_') + '.UTF-8',
                LC_ALL: profile.locale.replace('-', '_') + '.UTF-8',
            }
        }).unref();
    }

    // Step 4: CDP JS injection
    if (useJs) {
        console.log('[*] Phase 2: JS injection (Chromium API overrides)...');
        console.log(`[*] Waiting for CDP on port ${debugPort}...`);

        // Build injection script
        let overrideJs;
        try {
            overrideJs = fs.readFileSync(OVERRIDE_JS, 'utf8');
        } catch {
            console.warn('[!] fingerprint_override.js not found, skipping JS injection');
            return;
        }

        const jsConfig = {
            timezone_iana: profile.timezone_iana,
            utc_offset_minutes: profile.utc_offset,
            locale: profile.locale,
            languages: profile.languages,
            platform: profile.platform || 'Win32',
            hardwareConcurrency: profile.hardwareConcurrency || 8,
            deviceMemory: profile.deviceMemory || 8,
            webgl: profile.webgl,
            canvas_seed: profile.canvas_seed || 0,
            resolution: profile.resolution
        };

        const injectionScript = overrideJs.replace('__FG_CONFIG__', JSON.stringify(jsConfig));

        // Try to connect to CDP and inject
        let injected = false;
        for (let attempt = 0; attempt < 20; attempt++) {
            await sleep(2000);
            try {
                const targets = await getDebugTargets(debugPort);
                if (targets && targets.length > 0) {
                    for (const target of targets) {
                        if (target.type === 'page' && target.webSocketDebuggerUrl) {
                            await injectViaCDP(target.webSocketDebuggerUrl, injectionScript);
                            console.log(`[+] JS injected into: ${target.title || target.url}`);
                            injected = true;
                        }
                    }
                    if (injected) break;
                }
            } catch {}
        }

        if (injected) {
            console.log('[+] JS injection complete!\n');
        } else {
            console.warn('[!] Could not inject JS via CDP (app may not support --remote-debugging-port)');
            console.warn('[!] Win32 API hooks are still active\n');
        }
    }

    console.log('[+] FingerprintGuard is active. Press Ctrl+C to exit.');

    // Clean up temp config on exit
    process.on('exit', () => {
        try { fs.unlinkSync(tempConfig); } catch {}
    });
    process.on('SIGINT', () => process.exit(0));

    // Keep the launcher alive to maintain the monitoring
    await new Promise(() => {});
}

// ---- CDP helpers -----------------------------------------------------------

async function getDebugTargets(port) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json`, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { reject(new Error('Invalid JSON')); }
            });
        }).on('error', reject);
    });
}

function injectViaCDP(wsUrl, script) {
    return new Promise((resolve, reject) => {
        let ws;
        try {
            const WebSocket = require(path.join(ROOT_DIR, 'js-inject', 'node_modules', 'ws'));
            ws = new WebSocket(wsUrl);
        } catch {
            reject(new Error('ws module not found'));
            return;
        }

        let msgId = 1;
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: msgId++, method: 'Page.enable' }));
            ws.send(JSON.stringify({
                id: msgId++,
                method: 'Page.addScriptToEvaluateOnNewDocument',
                params: { source: script }
            }));
            ws.send(JSON.stringify({
                id: msgId++,
                method: 'Runtime.evaluate',
                params: { expression: script, allowUnsafeEvalBlockedByCSP: true }
            }));
        });

        let responses = 0;
        ws.on('message', () => {
            responses++;
            if (responses >= 3) { ws.close(); resolve(); }
        });
        ws.on('error', reject);
        setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 5000);
    });
}

main().catch(e => { console.error(e); process.exit(1); });
