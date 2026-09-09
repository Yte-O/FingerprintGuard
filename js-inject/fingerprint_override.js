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

    // ---- Font Fingerprint Override v2 --------------------------------------
    // Strategy: Intercept font-family assignment at BOTH the Canvas API and
    // DOM/CSS levels. Hidden (e.g. Chinese) font names are stripped BEFORE they
    // reach the browser's layout/render engine.  Width-comparison detection then
    // sees identical metrics for hidden fonts vs their fallbacks → concludes
    // font is NOT installed.
    //
    // v1 bugs fixed:
    //   • RegExp with 'g' flag caused test() to alternate true/false (lastIndex)
    //   • document.fonts.check hooked on instance instead of prototype
    //   • CSSStyleDeclaration hooks shared a single WeakMap causing collisions
    //   • cssText hook ran the same sanitizer meant for font-family strings

    if (config.fonts_hidden && config.fonts_hidden.length > 0) {
        const HIDDEN = new Set(config.fonts_hidden.map(f => f.toLowerCase().trim()));

        // ---- Helpers (no global-flag regex, no state) ----
        function isHidden(name) {
            return HIDDEN.has(name.replace(/['"]/g, '').trim().toLowerCase());
        }

        function containsHidden(str) {
            if (!str || typeof str !== 'string') return false;
            return str.split(',').some(f => isHidden(f));
        }

        // Strip hidden fonts from a bare font-family list: "'YaHei', Arial, mono"
        function stripFamilies(familyStr) {
            const clean = familyStr.split(',')
                .filter(f => !isHidden(f))
                .map(f => f.trim())
                .filter(Boolean);
            return clean.length ? clean.join(', ') : 'sans-serif';
        }

        // Strip hidden fonts from a Canvas/CSS font shorthand:
        //   "[style] [variant] [weight] size[/lh] family1, family2"
        function stripCanvasFont(fontStr) {
            if (!fontStr || typeof fontStr !== 'string') return fontStr;
            var m = fontStr.match(
                /^((?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|\d{1,4})\s+)*(?:\d+(?:\.\d+)?(?:px|pt|em|rem|%|ex|ch|vw|vh|vmin|vmax)(?:\s*\/\s*\S+)?))\s+(.+)$/i
            );
            if (!m) return stripFamilies(fontStr);   // no size prefix → just families
            return m[1] + ' ' + stripFamilies(m[2]);
        }

        // Strip hidden fonts from arbitrary CSS text containing font-family decls
        function stripFromCSS(css) {
            if (!css || typeof css !== 'string') return css;
            return css.replace(/font-family\s*:\s*([^;!}]+)/gi, function(_, fams) {
                return 'font-family: ' + stripFamilies(fams);
            });
        }

        // ================================================================
        // 1. Canvas ctx.font — strip hidden fonts before rendering/measuring
        // ================================================================
        var _ctxFontDesc = Object.getOwnPropertyDescriptor(
            CanvasRenderingContext2D.prototype, 'font'
        );
        if (_ctxFontDesc && _ctxFontDesc.set) {
            var _fGet = _ctxFontDesc.get, _fSet = _ctxFontDesc.set;
            var _fMap = new WeakMap();
            Object.defineProperty(CanvasRenderingContext2D.prototype, 'font', {
                get: function() {
                    return _fMap.has(this) ? _fMap.get(this) : _fGet.call(this);
                },
                set: function(v) {
                    _fMap.set(this, v);          // store original for getter
                    _fSet.call(this, stripCanvasFont(v));  // set clean version
                },
                configurable: true,
                enumerable: true
            });
        }

        // OffscreenCanvas (Web Workers)
        if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
            var _oDesc = Object.getOwnPropertyDescriptor(
                OffscreenCanvasRenderingContext2D.prototype, 'font'
            );
            if (_oDesc && _oDesc.set) {
                var _oGet = _oDesc.get, _oSet = _oDesc.set;
                var _oMap = new WeakMap();
                Object.defineProperty(OffscreenCanvasRenderingContext2D.prototype, 'font', {
                    get: function() { return _oMap.has(this) ? _oMap.get(this) : _oGet.call(this); },
                    set: function(v) { _oMap.set(this, v); _oSet.call(this, stripCanvasFont(v)); },
                    configurable: true, enumerable: true
                });
            }
        }

        // ================================================================
        // 2. document.fonts (FontFaceSet) — deny existence of hidden fonts
        //    Hook on PROTOTYPE so it applies to all documents incl. iframes
        // ================================================================
        try {
            var _origCheck = FontFaceSet.prototype.check;
            FontFaceSet.prototype.check = function(font, text) {
                if (typeof font === 'string' && containsHidden(font)) return false;
                return _origCheck.call(this, font, text);
            };
            var _origLoad = FontFaceSet.prototype.load;
            FontFaceSet.prototype.load = function(font, text) {
                if (typeof font === 'string' && containsHidden(font)) return Promise.resolve([]);
                return _origLoad.call(this, font, text);
            };
        } catch (_e) {}

        // ================================================================
        // 3. CSSStyleDeclaration — strip hidden fonts from DOM styles so
        //    offsetWidth / getBoundingClientRect return fallback metrics
        // ================================================================
        var _cssMap = new WeakMap();  // stores original fontFamily per style obj

        // 3a. fontFamily property
        var _ffDesc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'fontFamily');
        if (_ffDesc && _ffDesc.set) {
            Object.defineProperty(CSSStyleDeclaration.prototype, 'fontFamily', {
                get: function() {
                    return _cssMap.has(this) ? _cssMap.get(this) : _ffDesc.get.call(this);
                },
                set: function(v) {
                    _cssMap.set(this, v);                   // original for getter
                    _ffDesc.set.call(this, stripFamilies(v)); // clean for rendering
                },
                configurable: true, enumerable: true
            });
        }

        // 3b. font shorthand property (separate WeakMap to avoid collision)
        var _fShDesc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'font');
        if (_fShDesc && _fShDesc.set) {
            var _fShMap = new WeakMap();
            Object.defineProperty(CSSStyleDeclaration.prototype, 'font', {
                get: function() {
                    return _fShMap.has(this) ? _fShMap.get(this) : _fShDesc.get.call(this);
                },
                set: function(v) {
                    _fShMap.set(this, v);
                    _fShDesc.set.call(this, stripCanvasFont(v));
                },
                configurable: true, enumerable: true
            });
        }

        // 3c. setProperty / getPropertyValue
        var _origSP = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function(prop, val, pri) {
            if (typeof val === 'string') {
                if (prop === 'font-family') {
                    _cssMap.set(this, val);
                    val = stripFamilies(val);
                } else if (prop === 'font') {
                    val = stripCanvasFont(val);
                }
            }
            return _origSP.call(this, prop, val, pri);
        };

        var _origGPV = CSSStyleDeclaration.prototype.getPropertyValue;
        CSSStyleDeclaration.prototype.getPropertyValue = function(prop) {
            if (prop === 'font-family' && _cssMap.has(this)) return _cssMap.get(this);
            return _origGPV.call(this, prop);
        };

        // 3d. cssText setter — only touch font-family declarations inside the CSS
        var _ctDesc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');
        if (_ctDesc && _ctDesc.set) {
            Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
                get: function() { return _ctDesc.get.call(this); },
                set: function(v) {
                    _ctDesc.set.call(this, typeof v === 'string' ? stripFromCSS(v) : v);
                },
                configurable: true, enumerable: true
            });
        }

        // ================================================================
        // 4. Element.setAttribute — catch inline style="font-family: ..."
        // ================================================================
        var _origSetAttr = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function(name, value) {
            if (name.toLowerCase() === 'style' && typeof value === 'string' && containsHidden(value)) {
                value = stripFromCSS(value);
            }
            return _origSetAttr.call(this, name, value);
        };

        // ================================================================
        // 5. @font-face CSS injection — Shadow every hidden system font
        //    with a non-existent local source. This is the NUCLEAR OPTION:
        //    regardless of HOW font-family is applied (CSS class, <style>,
        //    external stylesheet), the browser will fail to load the font
        //    and fall back, producing identical metrics to the fallback.
        // ================================================================
        function injectFontFaceOverrides() {
            var target = document.head || document.documentElement;
            if (!target) return;
            var style = document.createElement('style');
            style.setAttribute('data-fg', '1');
            var css = '';
            for (var i = 0; i < config.fonts_hidden.length; i++) {
                var name = config.fonts_hidden[i];
                // Use a non-existent local() source to shadow the real system font
                css += '@font-face{font-family:"' + name + '";src:local("__FG_BLOCK__");}\n';
                // Also cover unquoted variant
                css += '@font-face{font-family:' + name + ';src:local("__FG_BLOCK__");}\n';
            }
            style.textContent = css;
            // Prepend so our rules come first (they shadow system fonts regardless of order, 
            // but being first ensures they're parsed before any page font usage)
            target.insertBefore(style, target.firstChild);
        }

        // Inject immediately if DOM is available, otherwise wait
        function tryInject() {
            if (document.head) {
                injectFontFaceOverrides();
                return true;
            }
            if (document.documentElement && document.documentElement.firstChild && document.documentElement.firstChild.nodeName === 'HEAD') {
                injectFontFaceOverrides();
                return true;
            }
            return false;
        }

        if (!tryInject()) {
            var _obs = new MutationObserver(function(mutations, obs) {
                if (tryInject()) {
                    obs.disconnect();
                }
            });
            _obs.observe(document, { childList: true, subtree: true });
        }

        // ================================================================
        // 6. HTMLElement measurement hooks — Last line of defense
        //    If @font-face override doesn't work in some edge case, intercept
        //    offsetWidth/offsetHeight/getBoundingClientRect to return fallback
        //    metrics when hidden fonts are detected in computed style.
        // ================================================================
        var _owDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
        var _ohDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

        function getFallbackDimension(el, origGetter) {
            try {
                var computed = window.getComputedStyle(el);
                var ff = computed.fontFamily;
                if (ff && containsHidden(ff)) {
                    // Temporarily force fallback font via inline style
                    var saved = _ffDesc ? _ffDesc.get.call(el.style) : el.style.fontFamily;
                    var cleanFF = stripFamilies(ff);
                    if (_ffDesc) {
                        _ffDesc.set.call(el.style, cleanFF);
                    } else {
                        el.style.fontFamily = cleanFF;
                    }
                    var val = origGetter.call(el);
                    // Restore
                    if (_ffDesc) {
                        _ffDesc.set.call(el.style, saved);
                    } else {
                        el.style.fontFamily = saved;
                    }
                    return val;
                }
            } catch(e) {}
            return origGetter.call(el);
        }

        if (_owDesc && _owDesc.get) {
            Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
                get: function() { return getFallbackDimension(this, _owDesc.get); },
                configurable: true, enumerable: true
            });
        }
        if (_ohDesc && _ohDesc.get) {
            Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
                get: function() { return getFallbackDimension(this, _ohDesc.get); },
                configurable: true, enumerable: true
            });
        }

        // getBoundingClientRect
        var _origGBCR = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function() {
            try {
                var computed = window.getComputedStyle(this);
                var ff = computed.fontFamily;
                if (ff && containsHidden(ff)) {
                    var saved = _ffDesc ? _ffDesc.get.call(this.style) : this.style.fontFamily;
                    var cleanFF = stripFamilies(ff);
                    if (_ffDesc) {
                        _ffDesc.set.call(this.style, cleanFF);
                    } else {
                        this.style.fontFamily = cleanFF;
                    }
                    var rect = _origGBCR.call(this);
                    if (_ffDesc) {
                        _ffDesc.set.call(this.style, saved);
                    } else {
                        this.style.fontFamily = saved;
                    }
                    return rect;
                }
            } catch(e) {}
            return _origGBCR.call(this);
        };
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
