// ============================================================================
// FingerprintGuard — CDP Launcher
//
// Launches an Electron app with --remote-debugging-port, connects via Chrome
// DevTools Protocol, and injects fingerprint_override.js into all pages/frames.
//
// Usage:
//   node launcher_cdp.js <target.exe> <profile.json> [--proxy socks5://ip:port]
//
// This handles the Chromium/JS layer of fingerprinting:
//   - Navigator properties (language, languages, platform, etc.)
//   - Date.getTimezoneOffset / Intl.DateTimeFormat timezone
//   - WebGL vendor/renderer
//   - Canvas noise injection
//   - Screen resolution
// ============================================================================

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');  // Will use raw WebSocket if ws not available

// ---- Config ----------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length < 2) {
    console.log('Usage: node launcher_cdp.js <target.exe> <profile.json> [--proxy socks5://ip:port] [--debug-port 9222]');
    console.log('');
    console.log('Example:');
    console.log('  node launcher_cdp.js "C:\\...\\Cursor.exe" profiles/JP.json');
    console.log('  node launcher_cdp.js "C:\\...\\Claude.exe" profiles/JP.json --proxy socks5://127.0.0.1:1080');
    process.exit(1);
}

const targetExe = args[0];
const profilePath = args[1];
let proxyUrl = null;
let debugPort = 9222;

for (let i = 2; i < args.length; i++) {
    if (args[i] === '--proxy' && args[i + 1]) {
        proxyUrl = args[++i];
    } else if (args[i] === '--debug-port' && args[i + 1]) {
        debugPort = parseInt(args[++i]);
    }
}

// ---- Load profile ----------------------------------------------------------

let profile;
try {
    profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
} catch (e) {
    console.error(`[-] Failed to load profile: ${e.message}`);
    process.exit(1);
}

console.log(`[*] Profile: ${profile.country_name} (${profile.locale})`);

// ---- Build JS injection script ---------------------------------------------

const overrideJsPath = path.join(__dirname, 'fingerprint_override.js');
let overrideJs;
try {
    overrideJs = fs.readFileSync(overrideJsPath, 'utf8');
} catch (e) {
    console.error(`[-] fingerprint_override.js not found at ${overrideJsPath}`);
    process.exit(1);
}

// Build the config object for the JS override
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

// Replace the placeholder with actual config
const injectionScript = overrideJs.replace('__FG_CONFIG__', JSON.stringify(jsConfig));

// ---- Launch target process -------------------------------------------------

const electronArgs = [
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
];

// Add proxy if specified
if (proxyUrl) {
    electronArgs.push(`--proxy-server=${proxyUrl}`);
    console.log(`[*] Proxy: ${proxyUrl}`);
}

console.log(`[*] Debug port: ${debugPort}`);
console.log(`[*] Launching: ${targetExe}`);

const child = spawn(targetExe, electronArgs, {
    stdio: 'inherit',
    env: {
        ...process.env,
        TZ: profile.timezone_iana,
        LANG: profile.locale.replace('-', '_') + '.UTF-8',
        LC_ALL: profile.locale.replace('-', '_') + '.UTF-8',
    }
});

child.on('error', (err) => {
    console.error(`[-] Failed to launch: ${err.message}`);
    process.exit(1);
});

child.on('exit', (code) => {
    console.log(`[*] Target exited with code ${code}`);
    process.exit(code || 0);
});

// ---- Connect via CDP -------------------------------------------------------

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getDebugTargets(port, retries = 15) {
    for (let i = 0; i < retries; i++) {
        try {
            const data = await new Promise((resolve, reject) => {
                http.get(`http://127.0.0.1:${port}/json`, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); }
                        catch (e) { reject(e); }
                    });
                }).on('error', reject);
            });
            return data;
        } catch (e) {
            if (i < retries - 1) {
                await sleep(1000);
            }
        }
    }
    return null;
}

// Simple CDP client using raw HTTP for addScriptToEvaluateOnNewDocument
async function injectViaCDP(port, script) {
    const targets = await getDebugTargets(port);
    if (!targets || targets.length === 0) {
        console.error('[-] No debug targets found');
        return false;
    }

    console.log(`[+] Found ${targets.length} debug target(s)`);

    let injected = 0;
    for (const target of targets) {
        if (!target.webSocketDebuggerUrl) continue;
        if (target.type !== 'page') continue;

        try {
            await injectToTarget(target.webSocketDebuggerUrl, script);
            injected++;
            console.log(`[+] Injected into: ${target.title || target.url}`);
        } catch (e) {
            console.warn(`[!] Failed to inject into ${target.url}: ${e.message}`);
        }
    }

    return injected > 0;
}

// Use raw WebSocket to send CDP commands
function injectToTarget(wsUrl, script) {
    return new Promise((resolve, reject) => {
        // Use native WebSocket or ws module
        let ws;
        try {
            ws = new (require('ws'))(wsUrl);
        } catch (e) {
            // Fallback: try native WebSocket
            console.warn('[!] ws module not available, trying native WebSocket');
            reject(new Error('ws module required: npm install ws'));
            return;
        }

        let msgId = 1;

        ws.on('open', () => {
            // 1. Enable Page domain
            ws.send(JSON.stringify({
                id: msgId++,
                method: 'Page.enable'
            }));

            // 2. Add script to evaluate on new document
            ws.send(JSON.stringify({
                id: msgId++,
                method: 'Page.addScriptToEvaluateOnNewDocument',
                params: { source: script }
            }));

            // 3. Also evaluate immediately on current page
            ws.send(JSON.stringify({
                id: msgId++,
                method: 'Runtime.evaluate',
                params: {
                    expression: script,
                    allowUnsafeEvalBlockedByCSP: true
                }
            }));
        });

        let responses = 0;
        ws.on('message', (data) => {
            responses++;
            if (responses >= 3) {
                ws.close();
                resolve();
            }
        });

        ws.on('error', reject);

        setTimeout(() => {
            ws.close();
            resolve(); // Don't fail on timeout, just continue
        }, 5000);
    });
}

// ---- Main: wait for debug port and inject ----------------------------------

async function main() {
    console.log('[*] Waiting for debug port...');

    // Keep trying to inject (the app might create new windows/tabs)
    let attempts = 0;
    let firstSuccess = false;

    while (attempts < 30) {
        await sleep(2000);
        attempts++;

        try {
            const success = await injectViaCDP(debugPort, injectionScript);
            if (success && !firstSuccess) {
                firstSuccess = true;
                console.log('[+] JS fingerprint overrides injected successfully!');
                console.log('[*] Monitoring for new pages...');
            }
        } catch (e) {
            // Still waiting for the app to start
        }

        // After first success, check less frequently
        if (firstSuccess) {
            await sleep(8000);
        }
    }

    if (!firstSuccess) {
        console.warn('[!] Could not inject JS overrides via CDP');
        console.warn('[!] The Win32 API hooks (timezone, locale, fonts, resolution) are still active');
    }
}

main().catch(console.error);
