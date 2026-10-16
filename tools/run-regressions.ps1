# Run every regression suite with a FRESH browser per test.
# Reason: chaining several suites over one Chrome instance kills the browser,
# and every later suite then fails with CDP timeouts (false failures).
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less .ps1 as ANSI,
# so any CJK literal in here corrupts the parse.
param(
  [string]$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe",
  [string[]]$Only
)
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)

$tests = @(
  @{ n = 'edit-test.mjs';    t = 'edit regression A (core)' },
  @{ n = 'edit-test2.mjs';   t = 'edit regression B (align/layer/marquee)' },
  @{ n = 'cursor-test.mjs';  t = 'cursor / rotate / grab points' },
  @{ n = 'textpos-test.mjs'; t = 'text positioning accuracy' },
  @{ n = 'panel-test.mjs';   t = 'panel collapse / expand' },
  @{ n = 'topbar-test.mjs';  t = 'topbar flat buttons + icons' },
  @{ n = 'video-test.mjs';   t = 'insert video + poster fallback' },
  @{ n = 'overlay-test.mjs'; t = 'selection overlay: zero occlusion + shortcut parity' },
  @{ n = 'latex-test.mjs';   t = 'latex to mathml parser'; browser = $false },
  @{ n = 'elements-test.mjs'; t = 'shapes / titles / text / table / formula / chart' },
  @{ n = 'ui-smoke.mjs';     t = 'workbench shell smoke (topbar/panels/find/painter)' },
  @{ n = 'pattern-test.mjs'; t = 'slide-split detection' }
)
if ($Only) { $tests = $tests | Where-Object { $Only -contains $_.n } }

$port = 9500
$logDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp\regressions'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
foreach ($test in $tests) {
  if (-not (Test-Path "tools/$($test.n)")) { "  skip $($test.n) (missing)"; continue }
  "===== $($test.t)  [$($test.n)] ====="
  $log = Join-Path $logDir ($test.n + '.log')

  # Pure-node suites (no browser needed) skip the Chrome launch entirely.
  if (-not $test.ContainsKey('browser') -or $test.browser) {
    $port++
    $prof = Join-Path $env:TEMP ("wd-t-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Start-Process $Chrome -ArgumentList @(
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      "--remote-debugging-port=$port", "--user-data-dir=$prof",
      '--window-size=1600,950', '--allow-file-access-from-files', 'about:blank'
    ) -WindowStyle Hidden
    Start-Sleep -Seconds 4
    & node "tools/$($test.n)" $Chrome $port 2>&1 | Out-File -FilePath $log -Encoding utf8
  } else {
    & node "tools/$($test.n)" 2>&1 | Out-File -FilePath $log -Encoding utf8
  }
  "  exit=$LASTEXITCODE  log=$log"

  Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
"===== done ====="