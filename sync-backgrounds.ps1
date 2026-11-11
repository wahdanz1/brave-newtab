# Copies Brave's current new tab wallpapers (Unsplash-licensed) into ./backgrounds.
# Brave swaps the set roughly every quarter; re-run this to pick up the new one.
$ErrorActionPreference = 'Stop'

$component = Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data\aoojcmojmmcbpfgoecoadbdpnagfchel'
$latest = Get-ChildItem $component -Directory |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1

if (-not $latest) { throw "No Brave background set found in $component" }

$target = Join-Path $PSScriptRoot 'backgrounds'
if (Test-Path $target) { Remove-Item $target -Recurse -Force -Confirm:$false }
New-Item -ItemType Directory $target | Out-Null

Copy-Item (Join-Path $latest.FullName '*.jpg') $target
Copy-Item (Join-Path $latest.FullName 'photo.json') $target

$count = (Get-ChildItem $target -Filter *.jpg).Count
Write-Output "Copied $count backgrounds from Brave $($latest.Name)"
