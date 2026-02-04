$ErrorActionPreference = "Stop"

$Repo = "epodivilov/worktree-kit"
$Binary = "wt-windows-x64.exe"
$InstallDir = "$env:LOCALAPPDATA\Programs\worktree-kit"
$BinaryName = "wt.exe"

Write-Host "Downloading $Binary..."

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$DownloadUrl = "https://github.com/$Repo/releases/latest/download/$Binary"
$Target = Join-Path $InstallDir $BinaryName

Invoke-WebRequest -Uri $DownloadUrl -OutFile $Target -UseBasicParsing

Write-Host ""
Write-Host "Installed: $Target"
Write-Host ""

# Add to PATH if not already there
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "Added to PATH. Restart your terminal to use 'wt'"
} else {
    Write-Host "Run 'wt --help' to get started"
}
