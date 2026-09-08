cmake_minimum_required(VERSION 3.15)
project(FingerprintGuard VERSION 1.0.0 LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ============================================================================
# MinHook library (built from source)
# ============================================================================
set(MINHOOK_DIR ${CMAKE_CURRENT_SOURCE_DIR}/deps/MinHook)

add_library(MinHook STATIC
    ${MINHOOK_DIR}/src/buffer.c
    ${MINHOOK_DIR}/src/hook.c
    ${MINHOOK_DIR}/src/trampoline.c
    ${MINHOOK_DIR}/src/hde/hde32.c
    ${MINHOOK_DIR}/src/hde/hde64.c
)
target_include_directories(MinHook PUBLIC ${MINHOOK_DIR}/include)

# ============================================================================
# Hook DLL — FGHook.dll
# ============================================================================
add_library(FGHook SHARED
    src/dllmain.cpp
    src/config.cpp
    src/hooks/timezone_hook.cpp
    src/hooks/locale_hook.cpp
    src/hooks/font_hook.cpp
    src/hooks/display_hook.cpp
)

target_include_directories(FGHook PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${MINHOOK_DIR}/include
)
target_link_libraries(FGHook PRIVATE MinHook)

# Export nothing explicitly — the DLL is loaded via injection
set_target_properties(FGHook PROPERTIES
    OUTPUT_NAME "FGHook"
    PREFIX ""
)

# ============================================================================
# Injector — FGInjector.exe
# ============================================================================
add_executable(FGInjector
    ${CMAKE_CURRENT_SOURCE_DIR}/../injector/src/injector.cpp
)

target_link_libraries(FGInjector PRIVATE
    advapi32
)

set_target_properties(FGInjector PROPERTIES
    OUTPUT_NAME "FGInjector"
)
