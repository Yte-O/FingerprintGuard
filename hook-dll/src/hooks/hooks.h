#pragma once
#ifndef FG_HOOKS_H
#define FG_HOOKS_H

// ============================================================================
// FingerprintGuard — Hook declarations
// ============================================================================

namespace fg {

// Timezone hooks
bool InstallTimezoneHooks();
void UninstallTimezoneHooks();

// Locale hooks
bool InstallLocaleHooks();
void UninstallLocaleHooks();

// Font hooks
bool InstallFontHooks();
void UninstallFontHooks();

// Display hooks
bool InstallDisplayHooks();
void UninstallDisplayHooks();

} // namespace fg

#endif // FG_HOOKS_H
