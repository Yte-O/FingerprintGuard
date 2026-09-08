// ============================================================================
// FingerprintGuard — Chromium/Electron JS Fingerprint Override
//
// This script is injected into Electron's renderer process via CDP
// (Chrome DevTools Protocol) to override browser-level fingerprint APIs.
//
// It must run BEFORE any page scripts to ensure all overrides are in place.
//
// Usage (injected by the launcher):
//   1. Launch Electron with --remote-debugging-port=<port>
//   2. Connect via CDP and use Page.addScriptToEvaluateOnNewDocument
//   3. This script overrides navigator, Date, Intl, Canvas, WebGL APIs
// ============================================================================

(function(config) {
    'use strict';

    // ---- Timezone Override ------------------------------------------------

    // Override Date.prototype.getTimezoneOffset
    const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Object.defineProperty(Date.prototype, 'getTimezoneOffset', {
        value: function() {
            // getTimezoneOffset returns minutes BEHIND UTC (opposite of offset)
            // e.g. UTC+9 (Tokyo) → returns -540
            return -(config.utc_offset_minutes || 0);
        },
        writable: false,
        configurable: false
    });

    // Override Intl.DateTimeFormat to return spoofed timezone
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    const originalResolvedOptions = OriginalDateTimeFormat.prototype.resolvedOptions;

    Intl.DateTimeFormat = function(...args) {
        // Inject our timezone into the options
        if (args.length >= 2 && typeof args[1] === 'object') {
            if (!args[1].timeZone) {
                args[1] = { ...args[1], timeZone: config.timezone_iana };
            }
        } else if (args.length < 2) {
            args[1] = { timeZone: config.timezone_iana };
        }
        return new OriginalDateTimeFormat(...args);
    };
    Intl.DateTimeFormat.prototype = OriginalDateTimeFormat.prototype;

    // Patch resolvedOptions to always report our timezone
    OriginalDateTimeFormat.prototype.resolvedOptions = function() {
        const opts = originalResolvedOptions.call(this);
        opts.timeZone = config.timezone_iana || opts.timeZone;
        opts.locale = config.locale || opts.locale;
        return opts;
    };

    // ---- Navigator Override -----------------------------------------------

    const navigatorOverrides = {
        language:            config.languages ? config.languages[0] : undefined,
        languages:           config.languages ? Object.freeze([...config.languages]) : undefined,
        platform:            config.platform || 'Win32',
        hardwareConcurrency: config.hardwareConcurrency || 8,
        deviceMemory:        config.deviceMemory || 8,
    };

    for (const [key, value] of Object.entries(navigatorOverrides)) {
        if (value === undefined) continue;
        try {
            Object.defineProperty(navigator, key, {
                get: () => value,
                configurable: false
            });
        } catch (e) {
            // Some properties may not be overridable in certain contexts
        }
    }

    // Ensure navigator.webdriver is false (anti-automation flag)
    try {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
            configurable: false
        });
    } catch (e) {}

    // ---- WebGL Override ---------------------------------------------------

    if (config.webgl) {
        const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param) {
            // UNMASKED_VENDOR_WEBGL = 37445 (0x9245)
            // UNMASKED_RENDERER_WEBGL = 37446 (0x9246)
            if (param === 37445) return config.webgl.vendor;
            if (param === 37446) return config.webgl.renderer;
            return getParameterOrig.call(this, param);
        };

        // Also override WebGL2
        if (typeof WebGL2RenderingContext !== 'undefined') {
            const getParameter2Orig = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function(param) {
                if (param === 37445) return config.webgl.vendor;
                if (param === 37446) return config.webgl.renderer;
                return getParameter2Orig.call(this, param);
            };
        }
    }

    // ---- Canvas Fingerprint Noise -----------------------------------------

    if (config.canvas_seed) {
        // Simple seeded PRNG for deterministic noise
        let seed = config.canvas_seed;
        function seededRandom() {
            seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF;
            return (seed >>> 0) / 0xFFFFFFFF;
        }

        // Hook toDataURL to inject subtle noise
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function(...args) {
            // Only modify if canvas has content
            try {
                const ctx = this.getContext('2d');
                if (ctx) {
                    const w = this.width;
                    const h = this.height;
                    if (w > 0 && h > 0) {
                        const imageData = ctx.getImageData(0, 0, w, h);
                        const data = imageData.data;
                        // Inject very subtle noise (±1 in a few pixels)
                        // Use deterministic positions based on seed
                        const numPixels = Math.min(10, Math.floor(data.length / 4));
                        for (let i = 0; i < numPixels; i++) {
                            const idx = Math.floor(seededRandom() * (data.length / 4)) * 4;
                            const channel = Math.floor(seededRandom() * 3); // R, G, or B
                            const delta = seededRandom() > 0.5 ? 1 : -1;
                            data[idx + channel] = Math.max(0, Math.min(255,
                                data[idx + channel] + delta));
                        }
                        ctx.putImageData(imageData, 0, 0);
                    }
                }
            } catch (e) {
                // Canvas might be tainted (cross-origin) — skip noise
            }
            return origToDataURL.apply(this, args);
        };

        // Hook toBlob similarly
        const origToBlob = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
            try {
                const ctx = this.getContext('2d');
                if (ctx) {
                    const w = this.width;
                    const h = this.height;
                    if (w > 0 && h > 0) {
                        const imageData = ctx.getImageData(0, 0, w, h);
                        const data = imageData.data;
                        const numPixels = Math.min(10, Math.floor(data.length / 4));
                        for (let i = 0; i < numPixels; i++) {
                            const idx = Math.floor(seededRandom() * (data.length / 4)) * 4;
                            const channel = Math.floor(seededRandom() * 3);
                            const delta = seededRandom() > 0.5 ? 1 : -1;
                            data[idx + channel] = Math.max(0, Math.min(255,
                                data[idx + channel] + delta));
                        }
                        ctx.putImageData(imageData, 0, 0);
                    }
                }
            } catch (e) {}
        };

        // Hook getImageData to add noise directly when scripts read pixels
        const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function(...args) {
            const imageData = origGetImageData.apply(this, args);
            try {
                const data = imageData.data;
                const numPixels = Math.min(10, Math.floor(data.length / 4));
                for (let i = 0; i < numPixels; i++) {
                    const idx = Math.floor(seededRandom() * (data.length / 4)) * 4;
                    const channel = Math.floor(seededRandom() * 3);
                    const delta = seededRandom() > 0.5 ? 1 : -1;
                    data[idx + channel] = Math.max(0, Math.min(255, data[idx + channel] + delta));
                }
            } catch (e) {}
            return imageData;
        };
    }

    // ---- Screen Override --------------------------------------------------

    if (config.resolution) {
        const screenOverrides = {
            width:      config.resolution.w,
            height:     config.resolution.h,
            availWidth: config.resolution.w,
            availHeight: config.resolution.h - 40, // Simulate taskbar
            colorDepth: 24,
            pixelDepth: 24
        };

        for (const [key, value] of Object.entries(screenOverrides)) {
            try {
                Object.defineProperty(screen, key, {
                    get: () => value,
                    configurable: false
                });
            } catch (e) {}
        }

        // Also override window.innerWidth/innerHeight and outerWidth/outerHeight
        try {
            Object.defineProperty(window, 'outerWidth', {
                get: () => config.resolution.w,
                configurable: false
            });
            Object.defineProperty(window, 'outerHeight', {
                get: () => config.resolution.h,
                configurable: false
            });
        } catch (e) {}
    }

    // ---- Font Fingerprint Override ----------------------------------------
    if (config.fonts_hidden && config.fonts_hidden.length > 0) {
        let css = '';
        for (const font of config.fonts_hidden) {
            // Using a guaranteed non-existent local font causes the browser to fallback
            // to the next font in the stack (e.g. monospace). This makes the measured
            // width exactly equal to the fallback width, tricking the fingerprinter
            // into believing the font is NOT installed.
            css += `@font-face { font-family: "${font}"; src: local("FG_Fake_Font_12345"); }\n`;
        }

        // 1. Synchronous injection via adoptedStyleSheets (covers inline scripts in <head>)
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(css);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
            
            // Protect our stylesheet from being overwritten
            const origAdopted = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets');
            if (origAdopted) {
                Object.defineProperty(Document.prototype, 'adoptedStyleSheets', {
                    get: function() {
                        const sheets = origAdopted.get.call(this);
                        return sheets.filter(s => s !== sheet); // Hide our sheet
                    },
                    set: function(val) {
                        if (Array.isArray(val) && !val.includes(sheet)) {
                            val = [...val, sheet];
                        }
                        return origAdopted.set.call(this, val);
                    }
                });
            }
        } catch (e) {}

        // 2. Fallback DOM injection (covers cases where adoptedStyleSheets fails or isn't supported)
        const style = document.createElement('style');
        style.textContent = css;

        const insertStyle = () => {
            if (document.documentElement && !document.documentElement.contains(style)) {
                (document.head || document.documentElement).appendChild(style);
            }
        };
        const observer = new MutationObserver((mutations, obs) => {
            if (document.documentElement) {
                insertStyle();
                obs.disconnect();
            }
        });
        observer.observe(document, { childList: true, subtree: true });
        if (document.documentElement) insertStyle();
    }

    // ---- Report success ---------------------------------------------------
    console.log('[FingerprintGuard] JS overrides active:', {
        timezone: config.timezone_iana,
        locale: config.locale,
        languages: config.languages,
        resolution: config.resolution,
        webgl: config.webgl ? 'spoofed' : 'native',
        canvas: config.canvas_seed ? 'noise-injected' : 'native',
        hidden_fonts: config.fonts_hidden
    });

})(__FG_CONFIG__);
// NOTE: __FG_CONFIG__ is replaced by the injector with the actual JSON config
// at injection time via CDP's Page.addScriptToEvaluateOnNewDocument
