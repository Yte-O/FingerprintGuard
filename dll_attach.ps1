# ============================================================================
# FingerprintGuard — DLL Attach Injector
# Injects FGHook.dll into an already-running process by PID.
# Usage: powershell -ExecutionPolicy Bypass -File dll_attach.ps1 -PID <pid> -DllPath <path>
# ============================================================================
param(
    [Parameter(Mandatory=$true)][int]$PID,
    [Parameter(Mandatory=$true)][string]$DllPath
)

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class FGAttach {
    const uint PROCESS_ALL_ACCESS = 0x001F0FFF;
    const uint MEM_COMMIT  = 0x1000;
    const uint MEM_RESERVE = 0x2000;
    const uint MEM_RELEASE = 0x8000;
    const uint PAGE_READWRITE = 0x04;

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr VirtualAllocEx(IntPtr proc, IntPtr addr, uint size, uint type, uint protect);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool WriteProcessMemory(IntPtr proc, IntPtr addr, byte[] buf, uint size, out int written);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetModuleHandle(string name);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetProcAddress(IntPtr module, string name);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr CreateRemoteThread(IntPtr proc, IntPtr attr, uint stack, IntPtr start, IntPtr param, uint flags, out uint tid);

    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);

    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeThread(IntPtr handle, out uint code);

    [DllImport("kernel32.dll")]
    static extern bool VirtualFreeEx(IntPtr proc, IntPtr addr, uint size, uint type);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    public static string Inject(int pid, string dllPath) {
        IntPtr hProc = OpenProcess(PROCESS_ALL_ACCESS, false, pid);
        if (hProc == IntPtr.Zero)
            return "ERROR:OpenProcess failed: " + Marshal.GetLastWin32Error();

        byte[] dllBytes = Encoding.Unicode.GetBytes(dllPath + "\0");
        IntPtr mem = VirtualAllocEx(hProc, IntPtr.Zero, (uint)dllBytes.Length, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (mem == IntPtr.Zero) {
            CloseHandle(hProc);
            return "ERROR:VirtualAllocEx failed: " + Marshal.GetLastWin32Error();
        }

        int written;
        if (!WriteProcessMemory(hProc, mem, dllBytes, (uint)dllBytes.Length, out written)) {
            VirtualFreeEx(hProc, mem, 0, MEM_RELEASE);
            CloseHandle(hProc);
            return "ERROR:WriteProcessMemory failed: " + Marshal.GetLastWin32Error();
        }

        IntPtr k32 = GetModuleHandle("kernel32.dll");
        IntPtr loadLib = GetProcAddress(k32, "LoadLibraryW");
        if (loadLib == IntPtr.Zero) {
            VirtualFreeEx(hProc, mem, 0, MEM_RELEASE);
            CloseHandle(hProc);
            return "ERROR:GetProcAddress(LoadLibraryW) failed";
        }

        uint tid;
        IntPtr hThread = CreateRemoteThread(hProc, IntPtr.Zero, 0, loadLib, mem, 0, out tid);
        if (hThread == IntPtr.Zero) {
            VirtualFreeEx(hProc, mem, 0, MEM_RELEASE);
            CloseHandle(hProc);
            return "ERROR:CreateRemoteThread failed: " + Marshal.GetLastWin32Error();
        }

        WaitForSingleObject(hThread, 10000);

        uint exitCode = 0;
        GetExitCodeThread(hThread, out exitCode);

        CloseHandle(hThread);
        VirtualFreeEx(hProc, mem, 0, MEM_RELEASE);
        CloseHandle(hProc);

        if (exitCode == 0)
            return "ERROR:LoadLibraryW returned NULL in target (DLL load failed)";

        return "OK:DLL injected successfully, module handle=0x" + exitCode.ToString("X");
    }
}
'@

Add-Type -TypeDefinition $code

$result = [FGAttach]::Inject($PID, $DllPath)
Write-Output $result
