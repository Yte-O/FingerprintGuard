// ============================================================================
// FingerprintGuard — Quick Test Script
//
// This script reads system fingerprint data and prints it.
// Run it normally to see real data, then run via FGInjector with a profile
// to verify the hooks are working.
//
// Usage:
//   node test_fingerprint.js                    (shows real system info)
//   FGInjector.exe node.exe profile_JP.json -- test_fingerprint.js  (shows spoofed)
// ============================================================================

console.log('=== FingerprintGuard Test ===\n');

// Timezone
console.log('[Timezone]');
console.log('  Date.getTimezoneOffset():', new Date().getTimezoneOffset());
console.log('  Intl timezone:', Intl.DateTimeFormat().resolvedOptions().timeZone);
console.log('  Local time:', new Date().toLocaleString());

// Locale
console.log('\n[Locale]');
console.log('  Intl locale:', Intl.DateTimeFormat().resolvedOptions().locale);
console.log('  navigator.language:', typeof navigator !== 'undefined' ? navigator.language : 'N/A (Node.js)');

// OS info (Node.js level)
const os = require('os');
console.log('\n[System - Node.js os module]');
console.log('  os.platform():', os.platform());
console.log('  os.type():', os.type());
console.log('  os.cpus().length:', os.cpus().length);
console.log('  os.totalmem():', Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' GB');

// Process environment locale hints
console.log('\n[Environment]');
console.log('  process.env.LANG:', process.env.LANG || 'not set');
console.log('  process.env.LC_ALL:', process.env.LC_ALL || 'not set');
console.log('  process.env.TZ:', process.env.TZ || 'not set');

// Try to get Windows-specific locale info via child_process
const { execSync } = require('child_process');
try {
    console.log('\n[Windows System Info]');
    const tzInfo = execSync('wmic timezone get StandardName /value', { encoding: 'utf8' }).trim();
    console.log('  ' + tzInfo);
} catch (e) {
    console.log('  (Could not query WMI)');
}

console.log('\n=== Test Complete ===');
