// ============================================================================
// FingerprintGuard — GUI Server
//
// Lightweight web-based GUI launcher backed by a local Node.js HTTP server.
// Opens in the default browser, provides a premium dark UI for:
//   - Target application selection
//   - SOCKS5 proxy configuration  
//   - Country/fingerprint profile selection
//   - Auto IP detection
//   - Launch with DLL + JS injection
//   - Multi-instance management
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile, exec } = require('child_process');
const https = require('https');
const net = require('net');
const url = require('url');

const PORT = 7842;
const ROOT = path.resolve(__dirname);
const PROFILES_DIR = path.join(ROOT, 'shared', 'profiles');
const INJECTOR_EXE = path.join(ROOT, 'hook-dll', 'build', 'FGInjector.exe');
const OVERRIDE_JS  = path.join(ROOT, 'js-inject', 'fingerprint_override.js');
const CONFIG_FILE  = path.join(ROOT, 'gui_config.json');
const INSTANCES_FILE = path.join(ROOT, 'instances.json');
const DLL_ATTACH_PS1 = path.join(ROOT, 'dll_attach.ps1');
const FGHOOK_DLL     = path.join(ROOT, 'hook-dll', 'build', 'FGHook.dll');

// ---- UWP Helpers -----------------------------------------------------------
// Detect if a target path is inside the WindowsApps folder (UWP/MSIX app)
function isUWPApp(target) {
    return target.toLowerCase().includes('\\windowsapps\\');
}

// Extract the executable name (without extension) from a full path
function getProcessName(target) {
    return path.basename(target, path.extname(target));
}

// Resolve the AppUserModelId from a WindowsApps path.
// Accurately reads the AppxManifest.xml from the package directory,
// extracting <Identity Name="..."> and <Application Id="...">
function resolveAppModelId(target) {
    let dir = path.dirname(target);
    while (dir && dir !== path.dirname(dir)) {
        const manifest = path.join(dir, 'AppxManifest.xml');
        if (fs.existsSync(manifest)) {
            try {
                const xml = fs.readFileSync(manifest, 'utf8');
                const pkgFolder = path.basename(dir);
                const pubId = (pkgFolder.split('__')[1] || '').split('\\')[0].split('/')[0];
                const idMatch = xml.match(/<Identity[^>]+Name="([^"]+)"/i);
                const appMatch = xml.match(/<Application[^>]+Id="([^"]+)"/i);
                if (idMatch && appMatch && pubId) {
                    return `${idMatch[1]}_${pubId}!${appMatch[1]}`;
                }
            } catch (e) {
                console.error('[UWP] Error reading AppxManifest.xml:', e.message);
            }
        }
        dir = path.dirname(dir);
    }

    // Fallback heuristic if AppxManifest.xml is not readable
    const lower = target.toLowerCase();
    const idx = lower.indexOf('\\windowsapps\\');
    if (idx >= 0) {
        const afterWA = target.substring(idx + '\\windowsapps\\'.length);
        const folderName = afterWA.split('\\')[0];
        const pubId = (folderName.split('__')[1] || '').split('\\')[0];
        const pkgName = folderName.split('_')[0];
        if (pubId && pkgName) {
            return `${pkgName}_${pubId}!App`;
        }
    }
    return null;
}

// Poll for a process by name, returns PID or 0 after timeout
function pollForProcess(processName, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const interval = setInterval(() => {
            try {
                const { execSync } = require('child_process');
                const out = execSync(
                    `powershell.exe -NoProfile -Command "(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Select-Object -First 1).Id"`,
                    { encoding: 'utf8', timeout: 5000 }
                ).trim();
                const pid = parseInt(out);
                if (pid > 0) {
                    clearInterval(interval);
                    resolve(pid);
                }
            } catch (e) { /* not found yet */ }
            if (Date.now() - startTime > timeoutMs) {
                clearInterval(interval);
                resolve(0);
            }
        }, 500);
    });
}

// Inject FGHook.dll into a running process using dll_attach.ps1
function attachDll(pid, dllPath) {
    return new Promise((resolve) => {
        const { execFile } = require('child_process');
        execFile('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DLL_ATTACH_PS1, '-PID', String(pid), '-DllPath', dllPath],
            { encoding: 'utf8', timeout: 15000 },
            (err, stdout, stderr) => {
                const output = ((stdout || '') + (stderr || '')).trim();
                resolve({ success: output.startsWith('OK:'), output });
            }
        );
    });
}

// ---- State -----------------------------------------------------------------
let savedConfig = {};
if (fs.existsSync(CONFIG_FILE)) {
    try { savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
}

let instances = [];
if (fs.existsSync(INSTANCES_FILE)) {
    try { 
        instances = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8')); 
        instances.forEach(inst => inst.status = 'stopped'); // Reset statuses on load
    } catch (e) {}
}

function saveConfig(cfg) {
    savedConfig = { ...savedConfig, ...cfg };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(savedConfig, null, 2));
}

function saveInstances() {
    // Avoid saving non-serializable objects
    const cleanInstances = instances.map(inst => {
        const { localProxyServer, cdpWs, ...rest } = inst;
        return rest;
    });
    fs.writeFileSync(INSTANCES_FILE, JSON.stringify(cleanInstances, null, 2));
}

// ---- Profiles --------------------------------------------------------------
function getProfiles() {
    const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
        return {
            code: data.country,
            name: data.country_name,
            locale: data.locale,
            timezone: data.timezone_iana,
            languages: data.languages
        };
    });
}

// ---- IP Geolocation --------------------------------------------------------
function httpGet(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, { timeout: 8000 }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

async function detectIP() {
    try {
        const ip = (await httpGet('https://api.ipify.org')).trim();
        const geo = JSON.parse(await httpGet(
            `http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,timezone,lat,lon,isp`
        ));
        return { ip, ...geo };
    } catch (e) {
        return { error: e.message };
    }
}

// ---- Launch Instance -------------------------------------------------------
async function launchInstance(target, countryCode, proxyHost, proxyPort, proxyUser, proxyPass, debugPort, existingId = null) {
    const profilePath = path.join(PROFILES_DIR, `${countryCode}.json`);
    if (!fs.existsSync(profilePath)) {
        return { error: `Profile not found: ${countryCode}` };
    }

    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const id = existingId || `inst_${Date.now()}`;
    const port = debugPort || (9222 + instances.length);
    const existingInst = existingId ? instances.find(i => i.id === existingId) : null;
    
    let chromeProfileDir = existingInst ? existingInst.chromeProfileDir : null;
    const tempConfigPath = path.join(process.env.TEMP || '.', `fg_${id}.json`);
    fs.writeFileSync(tempConfigPath, JSON.stringify(profile, null, 2));

    let finalProxyStr = null;
    let localProxyServer = null;

    if (proxyHost && proxyPort) {
        if (proxyUser && proxyPass) {
            const httpToSocks = require('http-proxy-to-socks');
            const getFreePort = () => new Promise(res => {
                const srv = net.createServer();
                srv.listen(0, () => {
                    const p = srv.address().port;
                    srv.close(() => res(p));
                });
            });
            const localPort = await getFreePort();
            try {
                let scheme = 'socks5://';
                let cleanHost = proxyHost;
                if (proxyHost.includes('://')) {
                    const parts = proxyHost.split('://');
                    scheme = parts[0] + '://';
                    cleanHost = parts[1];
                }
                localProxyServer = httpToSocks.createServer({
                    socks: `${cleanHost}:${proxyPort}:${proxyUser}:${proxyPass}`
                });
                localProxyServer.listen(localPort, '127.0.0.1');
                finalProxyStr = `http://127.0.0.1:${localPort}`;
            } catch (e) {
                return { error: `无法启动本地代理中转: ${e.message}` };
            }
        } else {
            // Do not force socks5:// so HTTP proxies (like Clash 7890) work out of the box.
            // If the user wants SOCKS5, they can include socks5:// in the host field.
            let host = proxyHost;
            if (!host.includes('://')) {
                // If it's just an IP, we leave it as is; Chrome defaults to HTTP proxy
            }
            finalProxyStr = `${host}:${proxyPort}`;
        }
    }

    const injArgs = [target, tempConfigPath, '--'];
    injArgs.push(`--remote-debugging-port=${port}`);
    injArgs.push('--remote-allow-origins=*');
    
    const lowerTarget = target.toLowerCase();
    const isBrowser = lowerTarget.includes('chrome.exe') || lowerTarget.includes('msedge.exe') || lowerTarget.includes('brave.exe');

    if (isBrowser) {
        if (!chromeProfileDir) chromeProfileDir = path.join(process.env.TEMP || '.', `fg_chrome_profile_${id}`);
        injArgs.push(`--user-data-dir=${chromeProfileDir}`);
        injArgs.push('--no-first-run');
        injArgs.push('--no-default-browser-check');
    }

    if (finalProxyStr) {
        injArgs.push(`--proxy-server=${finalProxyStr}`);
    }

    let webview2Args = `--remote-debugging-port=${port} --remote-allow-origins=*`;
    if (finalProxyStr) webview2Args += ` --proxy-server=${finalProxyStr}`;
    if (profile.languages && profile.languages.length) webview2Args += ` --accept-lang=${profile.languages.join(',')}`;

    const env = {
        ...process.env,
        TZ: profile.timezone,
        LANG: 'zh-CN', // Force OS locale variable to Chinese for the UI
        FG_CONFIG_PATH: tempConfigPath,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webview2Args
    };

    const isUWP = isUWPApp(target);

    // ========================================================================
    // PATH A: UWP/MSIX apps (e.g. Claude, apps inside WindowsApps)
    // Strategy: Launch via shell:AppsFolder -> poll for process -> attach DLL
    // ========================================================================
    if (isUWP) {
        const appModelId = resolveAppModelId(target);
        const procName = getProcessName(target);
        console.log(`[UWP] Detected UWP app: ${procName}, AppModelId: ${appModelId}`);

        // Create the instance record immediately (status: launching)
        const instance = {
            id, pid: 0, target, country: countryCode,
            countryName: profile.country_name,
            proxy: finalProxyStr || 'none',
            proxyHost, proxyPort, proxyUser, proxyPass,
            debugPort: port,
            startTime: new Date().toISOString(),
            status: 'launching (UWP)',
            tempConfig: tempConfigPath,
            chromeProfileDir,
            localProxyServer,
            output: ''
        };
        if (existingInst) {
            Object.assign(existingInst, instance);
        } else {
            instances.push(instance);
        }
        saveInstances();
        saveConfig({ lastTarget: target, lastProxyHost: proxyHost || '', lastProxyPort: proxyPort || '', lastProxyUser: proxyUser || '', lastProxyPass: proxyPass || '', lastCountry: countryCode });

        // Launch asynchronously, don't block the HTTP response
        (async () => {
            try {
                // Step 1: Launch via shell:AppsFolder (the only way UWP apps accept activation)
                if (appModelId) {
                    console.log(`[UWP] Launching via shell:AppsFolder\\${appModelId}`);
                    // Launch via PowerShell Start-Process so explorer.exe exit code never throws or blocks
                    spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process 'shell:AppsFolder\\${appModelId}'`], {
                        stdio: 'ignore',
                        detached: true
                    }).unref();
                } else {
                    // Fallback: try direct launch without DLL injection first
                    console.log(`[UWP] No AppModelId resolved, trying direct launch...`);
                    spawn(target, [], { stdio: 'ignore', detached: true, env }).unref();
                }

                // Step 2: Wait for the process to appear
                console.log(`[UWP] Polling for process: ${procName}...`);
                const pid = await pollForProcess(procName, 20000);
                if (pid === 0) {
                    console.log(`[UWP] ERROR: Process ${procName} did not appear within 20s`);
                    instance.status = 'error';
                    instance.output = `Process ${procName} did not start within 20 seconds`;
                    saveInstances();
                    return;
                }

                console.log(`[UWP] Found process PID: ${pid}`);
                instance.pid = pid;
                instance.status = 'injecting DLL...';
                saveInstances();

                // Step 3: Write the config file for this PID
                if (finalProxyStr) {
                    profile.proxyServer = finalProxyStr;
                }
                const pidConfigPath = path.join(process.env.TEMP || '.', `fg_${pid}.json`);
                fs.writeFileSync(pidConfigPath, JSON.stringify(profile, null, 2));
                console.log(`[UWP] Config written to: ${pidConfigPath}`);

                // Step 4: Wait a moment for the app to fully initialize, then inject DLL
                await new Promise(r => setTimeout(r, 2000));

                if (fs.existsSync(FGHOOK_DLL) && fs.existsSync(DLL_ATTACH_PS1)) {
                    console.log(`[UWP] Injecting FGHook.dll into PID ${pid}...`);
                    const result = await attachDll(pid, FGHOOK_DLL);
                    console.log(`[UWP] Injection result: ${result.output}`);

                    if (result.success) {
                        instance.status = 'running (DLL hooked)';
                        instance.output = result.output;
                    } else {
                        instance.status = 'running (DLL failed)';
                        instance.output = result.output;
                    }
                } else {
                    instance.status = 'running (no DLL)';
                    instance.output = 'FGHook.dll or dll_attach.ps1 not found';
                }

                saveInstances();

                // Step 5: Try CDP connection (Electron apps may have debug port if ELECTRON_ADDITIONAL_CHROMIUM_FLAGS is set)
                setTimeout(() => tryCDPInject(id, port, profile), 3000);

            } catch (e) {
                console.log(`[UWP] Launch error: ${e.message}`);
                instance.status = 'error';
                instance.output = e.message;
                saveInstances();
            }
        })();

        return instance;
    }

    // ========================================================================
    // PATH B: Standard exe (with DLL injector creating the process SUSPENDED)
    // ========================================================================
    return new Promise((resolve) => {
        if (!isBrowser && fs.existsSync(INJECTOR_EXE)) {
            execFile(INJECTOR_EXE, injArgs, { encoding: 'utf8', timeout: 15000, env }, (err, stdout, stderr) => {
                const output = (stdout || '') + (stderr || '');
                const pidMatch = output.match(/PID:\s*(\d+)/);
                const pid = pidMatch ? parseInt(pidMatch[1]) : 0;

                const instance = {
                    id, pid, target, country: countryCode,
                    countryName: profile.country_name,
                    proxy: finalProxyStr || 'none',
                    proxyHost, proxyPort, proxyUser, proxyPass,
                    debugPort: port,
                    startTime: new Date().toISOString(),
                    status: err ? 'error' : 'running',
                    tempConfig: tempConfigPath,
                    chromeProfileDir,
                    localProxyServer,
                    output: output.trim()
                };
                if (existingInst) {
                    Object.assign(existingInst, instance);
                } else {
                    instances.push(instance);
                }
                saveInstances();

                if (!err) {
                    setTimeout(() => tryCDPInject(id, port, profile), 3000);
                }

                saveConfig({ lastTarget: target, lastProxyHost: proxyHost || '', lastProxyPort: proxyPort || '', lastProxyUser: proxyUser || '', lastProxyPass: proxyPass || '', lastCountry: countryCode });
                resolve(instance);
            });
        } else {
            const electronArgs = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'];
            if (isBrowser) {
                if (!chromeProfileDir) chromeProfileDir = path.join(process.env.TEMP || '.', `fg_chrome_profile_${id}`);
                electronArgs.push(`--user-data-dir=${chromeProfileDir}`);
                electronArgs.push('--no-first-run');
                electronArgs.push('--no-default-browser-check');
                electronArgs.push(`--lang=zh-CN`);
                if (profile.languages && profile.languages.length) {
                    electronArgs.push(`--accept-lang=${profile.languages.join(',')}`);
                }
            }
            if (finalProxyStr) electronArgs.push(`--proxy-server=${finalProxyStr}`);

            const isShellScript = lowerTarget.endsWith('.lnk') || lowerTarget.endsWith('.bat') || lowerTarget.endsWith('.cmd');
            const child = spawn(target, electronArgs, { 
                stdio: 'ignore', 
                detached: true, 
                env,
                shell: isShellScript 
            });
            child.unref();

            const instance = {
                id, pid: child.pid || 0, target, country: countryCode,
                countryName: profile.country_name,
                proxy: finalProxyStr || 'none', 
                proxyHost, proxyPort, proxyUser, proxyPass,
                debugPort: port,
                startTime: new Date().toISOString(),
                status: isBrowser ? 'running (no DLL)' : 'running',
                tempConfig: tempConfigPath,
                chromeProfileDir,
                localProxyServer
            };
            if (existingInst) {
                Object.assign(existingInst, instance);
            } else {
                instances.push(instance);
            }
            saveInstances();
            setTimeout(() => tryCDPInject(id, port, profile), 3000);
            saveConfig({ lastTarget: target, lastProxyHost: proxyHost || '', lastProxyPort: proxyPort || '', lastProxyUser: proxyUser || '', lastProxyPass: proxyPass || '', lastCountry: countryCode });
            resolve(instance);
        }
    });
}

async function tryCDPInject(instanceId, port, profile) {
    const inst = instances.find(i => i.id === instanceId);
    if (!inst) return;

    try {
        const overrideJs = fs.readFileSync(OVERRIDE_JS, 'utf8');
        const jsConfig = {
            timezone_iana: profile.timezone_iana,
            utc_offset_minutes: profile.utc_offset,
            locale: profile.locale,
            languages: profile.languages,
            platform: profile.platform || 'Win32',
            hardwareConcurrency: profile.hardwareConcurrency || 8,
            deviceMemory: profile.deviceMemory || 8,
            webgl: profile.webgl,
            canvas_seed: profile.canvas_seed || Math.floor(Math.random() * 1000000), // Fallback if missing
            resolution: profile.resolution,
            ua_hint: profile.ua_hint,
            fonts_hidden: (profile.country === 'CN' || profile.country === 'TW' || profile.country === 'JP' || profile.country === 'KR') ? [] : [
                // Simplified Chinese (Windows)
                "Microsoft YaHei", "Microsoft YaHei UI", "SimSun", "NSimSun",
                "SimHei", "FangSong", "KaiTi", "DengXian", "SimSun-ExtB", "SimKai",
                // Simplified Chinese (macOS)
                "PingFang SC", "Heiti SC", "STHeiti", "STKaiti", "STSong",
                "STFangsong", "STXihei", "STZhongsong",
                // Traditional Chinese
                "Microsoft JhengHei", "Microsoft JhengHei UI", "MingLiU",
                "PMingLiU", "MingLiU-ExtB", "PMingLiU-ExtB", "DFKai-SB",
                "PingFang TC", "PingFang HK", "Heiti TC",
                // Japanese
                "MS Gothic", "MS PGothic", "MS UI Gothic", "MS Mincho", "MS PMincho",
                "Yu Gothic", "Yu Gothic UI", "Yu Mincho", "Meiryo", "Meiryo UI",
                "Hiragino Sans", "Hiragino Kaku Gothic Pro",
                // Korean
                "Malgun Gothic", "Gulim", "GulimChe", "Dotum", "DotumChe",
                "Batang", "BatangChe", "Gungsuh", "GungsuhChe",
                "Apple SD Gothic Neo",
                // Cross-platform CJK
                "Source Han Sans SC", "Source Han Serif SC", "Noto Sans CJK SC",
                "Noto Serif CJK SC", "WenQuanYi Micro Hei", "WenQuanYi Zen Hei",
                "AR PL UKai", "AR PL UMing", "LiSu", "YouYuan"
            ]
        };
        const script = overrideJs.replace('__FG_CONFIG__', JSON.stringify(jsConfig));

        // Get browser websocket endpoint with retries
        let versionData = null;
        for (let i = 0; i < 15; i++) {
            try {
                versionData = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/version`));
                break;
            } catch (err) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        
        if (versionData && versionData.webSocketDebuggerUrl) {
            setupBrowserCDP(versionData.webSocketDebuggerUrl, script, jsConfig, inst);
        }
    } catch (e) {
        // CDP not available or failed
    }
}

function setupBrowserCDP(browserWsUrl, script, jsConfig, inst) {
    try {
        const WebSocket = require(path.join(ROOT, 'js-inject', 'node_modules', 'ws'));
        const ws = new WebSocket(browserWsUrl);
        let msgId = 1;

        const sendCmd = (method, params, sessionId) => {
            const payload = { id: msgId++, method, params };
            if (sessionId) payload.sessionId = sessionId;
            ws.send(JSON.stringify(payload));
        };

        ws.on('open', () => {
            // Auto-attach to all new targets (pages), pausing them on start so we can inject before they load
            sendCmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
            inst.status = 'running (Native CDP)';
            inst.cdpWs = ws; // Save ws to keep it alive
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.method === 'Target.attachedToTarget') {
                const { sessionId, targetInfo } = msg.params;
                if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
                    // Send Emulation commands to this specific page/iframe
                    sendCmd('Emulation.setTimezoneOverride', { timezoneId: jsConfig.timezone_iana }, sessionId);
                    sendCmd('Emulation.setLocaleOverride', { locale: jsConfig.locale }, sessionId);
                    sendCmd('Emulation.setUserAgentOverride', { 
                        userAgent: jsConfig.ua_hint || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`,
                        acceptLanguage: (jsConfig.languages || []).join(',')
                    }, sessionId);
                    // Inject JS overrides
                    sendCmd('Page.addScriptToEvaluateOnNewDocument', { source: script }, sessionId);
                    
                    // Resume the paused target
                    sendCmd('Runtime.runIfWaitingForDebugger', {}, sessionId);
                } else {
                    // Resume non-page targets immediately
                    sendCmd('Runtime.runIfWaitingForDebugger', {}, sessionId);
                }
            }
        });

        ws.on('error', () => {});
        ws.on('close', () => { inst.cdpWs = null; });
    } catch (e) {}
}

function killInstance(id) {
    const inst = instances.find(i => i.id === id);
    if (!inst) return false;
    try {
        const { execSync } = require('child_process');
        execSync('taskkill /F /T /PID ' + inst.pid, { stdio: 'ignore' });
    } catch {
        // Might already be dead
    }
    inst.status = 'stopped';
    try { fs.unlinkSync(inst.tempConfig); } catch {}
    if (inst.localProxyServer) {
        try { inst.localProxyServer.close(); } catch {}
    }
    // Do NOT delete chromeProfileDir here, so we can relaunch it.
    saveInstances();
    return true;
}

// ---- HTTP Server -----------------------------------------------------------
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // API routes
    if (url.pathname === '/api/profiles') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getProfiles()));
    }
    else if (url.pathname === '/api/detect-ip') {
        const result = await detectIP();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    }
    else if (url.pathname === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(savedConfig));
    }
    else if (url.pathname === '/api/launch' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { target, country, proxyHost, proxyPort, proxyUser, proxyPass, debugPort } = JSON.parse(body);
                const result = await launchInstance(target, country, proxyHost, proxyPort, proxyUser, proxyPass, debugPort);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }
    else if (url.pathname === '/api/instances') {
        // Auto-update status for dead processes
        instances.forEach(inst => {
            if (inst.status.startsWith('running')) {
                try {
                    process.kill(inst.pid, 0); // 0 signal checks if process is alive
                } catch (e) {
                    inst.status = 'stopped';
                }
            }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(instances));
    }
    else if (url.pathname.startsWith('/api/kill/') && req.method === 'DELETE') {
        const id = url.pathname.split('/').pop();
        killInstance(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    }
    else if (url.pathname.startsWith('/api/instances/delete/') && req.method === 'DELETE') {
        const id = url.pathname.split('/').pop();
        const inst = instances.find(i => i.id === id);
        if (inst && inst.chromeProfileDir && fs.existsSync(inst.chromeProfileDir)) {
            try { fs.rmSync(inst.chromeProfileDir, { recursive: true, force: true }); } catch {}
        }
        instances = instances.filter(i => i.id !== id);
        saveInstances();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    }
    else if (url.pathname.startsWith('/api/instances/relaunch/') && req.method === 'POST') {
        const id = url.pathname.split('/').pop();
        const inst = instances.find(i => i.id === id);
        if (inst) {
            try {
                await launchInstance(inst.target, inst.country, inst.proxyHost, inst.proxyPort, inst.proxyUser, inst.proxyPass, inst.debugPort, inst.id);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    }
    else if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(ROOT, 'gui', 'index.html'), 'utf8'));
    }
    else {
        // Serve static files from gui/
        const filePath = path.join(ROOT, 'gui', url.pathname);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath);
            const mimeTypes = {
                '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon'
            };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            res.end(fs.readFileSync(filePath));
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n=== FingerprintGuard GUI ===`);
    console.log(`Server running at http://127.0.0.1:${PORT}`);
    console.log(`Opening browser...\n`);

    // Open in default browser
    const openCmd = process.platform === 'win32' ? 'start' :
                    process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCmd} http://127.0.0.1:${PORT}`);
});
