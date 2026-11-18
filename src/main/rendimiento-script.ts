/**
 * Script de PowerShell 5.1 (viene con Windows) que arma el Job Object de las terminales: recorre el árbol
 * de procesos desde SLOTH_JOB_RAIZ, les pone el tope de memoria y la afinidad, y le deja un handle del Job
 * al proceso dueño para que el nombre siga vivo y los límites se puedan cambiar o sacar después.
 * Los datos llegan por variables de entorno (rendimiento-core.ts: entornoJob), nunca dentro del código.
 */
export const SCRIPT_JOB = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SlothJob {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr MinWS; public UIntPtr MaxWS; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint opts);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int Aplicar(string nombre, long memBytes, ulong afinidad, uint[] pids, uint dueno) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, nombre);
    if (job == IntPtr.Zero) throw new Win32Exception();
    bool nuevo = Marshal.GetLastWin32Error() != 183;
    try {
      EXT info = new EXT();
      if (memBytes > 0) { info.Basic.LimitFlags |= 0x200; info.JobMemoryLimit = (UIntPtr)(ulong)memBytes; }
      if (afinidad != 0) { info.Basic.LimitFlags |= 0x10; info.Basic.Affinity = (UIntPtr)afinidad; }
      int n = Marshal.SizeOf(typeof(EXT));
      IntPtr p = Marshal.AllocHGlobal(n);
      try {
        Marshal.StructureToPtr(info, p, false);
        if (!SetInformationJobObject(job, 9, p, (uint)n)) throw new Win32Exception();
      } finally { Marshal.FreeHGlobal(p); }
      int ok = 0;
      foreach (uint pid in pids) {
        IntPtr h = OpenProcess(0x0101, false, pid);
        if (h == IntPtr.Zero) continue;
        if (AssignProcessToJobObject(job, h)) ok++;
        CloseHandle(h);
      }
      if (nuevo && dueno != 0) {
        IntPtr hp = OpenProcess(0x0040, false, dueno);
        if (hp == IntPtr.Zero) throw new Win32Exception();
        IntPtr dup;
        bool dupOk = DuplicateHandle(GetCurrentProcess(), job, hp, out dup, 0, false, 2);
        CloseHandle(hp);
        if (!dupOk) throw new Win32Exception();
      }
      return ok;
    } finally { CloseHandle(job); }
  }
}
'@
$raiz = [uint32]$env:SLOTH_JOB_RAIZ
$excluir = $env:SLOTH_JOB_EXCLUIR
$hijos = @{}
foreach ($p in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath) {
  if ($excluir -and $p.ExecutablePath -eq $excluir) { continue }
  $k = [uint32]$p.ParentProcessId
  if (-not $hijos.ContainsKey($k)) { $hijos[$k] = New-Object System.Collections.Generic.List[uint32] }
  $hijos[$k].Add([uint32]$p.ProcessId)
}
$pids = New-Object System.Collections.Generic.List[uint32]
$visto = New-Object System.Collections.Generic.HashSet[uint32]
$cola = New-Object System.Collections.Generic.Queue[uint32]
if ($env:SLOTH_JOB_INCLUIR_RAIZ -eq '1') { $pids.Add($raiz) }
[void]$visto.Add($raiz)
$cola.Enqueue($raiz)
while ($cola.Count -gt 0) {
  $padre = $cola.Dequeue()
  if (-not $hijos.ContainsKey($padre)) { continue }
  foreach ($h in $hijos[$padre]) {
    if ($visto.Add($h)) { $pids.Add($h); $cola.Enqueue($h) }
  }
}
$n = [SlothJob]::Aplicar($env:SLOTH_JOB_NOMBRE, [int64]$env:SLOTH_JOB_RAM_BYTES, [uint64]$env:SLOTH_JOB_AFINIDAD, $pids.ToArray(), [uint32]$env:SLOTH_JOB_DUENO)
Write-Output "{\`"procesos\`":$n,\`"vistos\`":$($pids.Count)}"
`

/** Para -EncodedCommand: UTF-16LE en base64, sin archivos temporales. */
export const scriptCodificado = (): string => Buffer.from(SCRIPT_JOB, 'utf16le').toString('base64')
