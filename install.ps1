# Installs Maestro for the current user: irm https://raw.githubusercontent.com/hallygtree/maestro/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Windows PowerShell downloads crawl with the progress bar on

# OSArchitecture, not PROCESSOR_ARCHITECTURE: an emulated x64 PowerShell on ARM64 would say AMD64.
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$dir = Join-Path $env:LOCALAPPDATA 'Programs\maestro'
$bin = Join-Path $dir 'bin'
$url = "https://github.com/hallygtree/maestro/releases/latest/download/maestro-win32-$arch.tar.gz"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('maestro-' + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  Write-Host "Downloading $url"
  Invoke-WebRequest -UseBasicParsing $url -OutFile "$tmp\maestro.tar.gz"
  # Windows' own tar: Git's GNU tar, if first on PATH, reads "C:\..." as a remote host
  & "$env:SystemRoot\System32\tar.exe" -xzf "$tmp\maestro.tar.gz" -C $tmp
  if ($LASTEXITCODE) { throw "Couldn't extract $url" }
  if (Test-Path $dir) {
    try { Remove-Item -Recurse -Force $dir }
    catch { throw "Couldn't replace $dir. Close Maestro and run the installer again." }
  }
  New-Item -ItemType Directory -Force (Split-Path $dir) | Out-Null
  Move-Item "$tmp\maestro" $dir
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# The bundled node.exe stays out of PATH; only bin\ goes in. The extensionless one is for Git Bash.
New-Item -ItemType Directory -Force $bin | Out-Null
[IO.File]::WriteAllText("$bin\maestro.cmd", "@`"%~dp0..\node.exe`" `"%~dp0..\src\cli.ts`" %*`r`n")
[IO.File]::WriteAllText("$bin\maestro", "#!/bin/sh`nexec `"`$(dirname `"`$0`")/../node.exe`" `"`$(dirname `"`$0`")/../src/cli.ts`" `"`$@`"`n")

# First in PATH, so a stale `maestro` elsewhere (e.g. an old npm link) can't shadow it.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';')[0] -ne $bin) {
  $rest = $userPath -split ';' | Where-Object { $_ -and $_ -ne $bin }
  [Environment]::SetEnvironmentVariable('Path', (@($bin) + $rest) -join ';', 'User')
}
$env:Path = (@($bin) + ($env:Path -split ';' | Where-Object { $_ -and $_ -ne $bin })) -join ';'
Write-Host "Maestro installed in $dir. Run: maestro"
