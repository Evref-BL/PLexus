$ErrorActionPreference = "Stop"

function Write-Check {
  param(
    [string] $Name,
    [bool] $Ok,
    [string] $Detail = ""
  )

  $status = if ($Ok) { "OK" } else { "MISSING" }
  if ($Detail) {
    Write-Host ("{0,-32} {1}  {2}" -f $Name, $status, $Detail)
  } else {
    Write-Host ("{0,-32} {1}" -f $Name, $status)
  }
}

function Get-CommandDetail {
  param([string] $CommandName)

  $cmd = Get-Command $CommandName -ErrorAction SilentlyContinue
  if (-not $cmd) {
    return $null
  }

  return $cmd.Source
}

$node = Get-CommandDetail "node"
$npm = Get-CommandDetail "npm"
$npx = Get-CommandDetail "npx"
$git = Get-CommandDetail "git"

Write-Check "git" ([bool] $git) $git
Write-Check "node" ([bool] $node) $node
Write-Check "npm" ([bool] $npm) $npm
Write-Check "npx" ([bool] $npx) $npx

if ($node) {
  $pharoLauncherMcpEntry = & node -e "try { process.stdout.write(require.resolve('@evref-bl/pharo-launcher-mcp')) } catch { process.exit(1) }" 2>$null
  Write-Check "@evref-bl/pharo-launcher-mcp package" ($LASTEXITCODE -eq 0) $pharoLauncherMcpEntry
} else {
  Write-Check "@evref-bl/pharo-launcher-mcp package" $false "node is required to resolve package dependency"
}

if ($env:PHARO_LAUNCHER_MCP_ENTRY) {
  Write-Check "PHARO_LAUNCHER_MCP_ENTRY override" (Test-Path -LiteralPath $env:PHARO_LAUNCHER_MCP_ENTRY) $env:PHARO_LAUNCHER_MCP_ENTRY
}

if ($env:PHARO_LAUNCHER_MCP_REPO_DIR) {
  Write-Check "PHARO_LAUNCHER_MCP_REPO_DIR override" (Test-Path -LiteralPath $env:PHARO_LAUNCHER_MCP_REPO_DIR) $env:PHARO_LAUNCHER_MCP_REPO_DIR
}

$launcherDir = $env:PHARO_LAUNCHER_DIR
if (-not $launcherDir) {
  $launcherDir = "C:\Users\gabriel.darbord\AppData\Local\Pharo Launcher"
}

$launcherVm = $env:PHARO_LAUNCHER_VM
if (-not $launcherVm) {
  $launcherVm = Join-Path $launcherDir "PharoConsole.exe"
}

$launcherImage = $env:PHARO_LAUNCHER_IMAGE
if (-not $launcherImage) {
  $launcherImage = Join-Path $launcherDir "PharoLauncher.image"
}

Write-Check "PHARO_LAUNCHER_DIR" (Test-Path -LiteralPath $launcherDir) $launcherDir
Write-Check "PHARO_LAUNCHER_VM" (Test-Path -LiteralPath $launcherVm) $launcherVm
Write-Check "PHARO_LAUNCHER_IMAGE" (Test-Path -LiteralPath $launcherImage) $launcherImage

if ($node) {
  Write-Host ""
  Write-Host "Versions:"
  & node --version
  if ($npm) { & npm --version }
  if ($npx) { & npx --version }
}
