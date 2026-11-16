<#
  Stops running copies of Nexus Internet Scheduler on this machine:
    - the boot task (if installed),
    - leftover node processes started from THIS folder's supervisor.js / server.js
      (e.g. an orphan left behind by a task restart).
  Processes started with a relative path ("npm start" in a terminal) can't be
  attributed to this folder with certainty, so they are only listed, not killed.
  Usage (elevated if the boot task runs as SYSTEM):
    powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
#>
$Root = Split-Path -Parent $PSScriptRoot
$TaskName = 'Nexus Internet Scheduler'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host "Stopped scheduled task '$TaskName'."
}

$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine })
$ours = @($nodes | Where-Object { $_.CommandLine -like "*$Root\src\supervisor.js*" -or $_.CommandLine -like "*$Root\src\server.js*" })
$maybe = @($nodes | Where-Object { $_.CommandLine -match '(^|\s|")src[\\/](server|supervisor)\.js' -and $ours.ProcessId -notcontains $_.ProcessId })

foreach ($p in $ours) {
  Write-Host "Stopping PID $($p.ProcessId): $($p.CommandLine)"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if (-not $ours.Count) { Write-Host "No processes running from $Root." }

if ($maybe.Count) {
  Write-Host ''
  Write-Host 'These look like "npm start" runs (relative path) and MAY be this app.'
  Write-Host 'If so, close their terminal window or run: Stop-Process -Id <PID>'
  $maybe | ForEach-Object { Write-Host "  PID $($_.ProcessId)  started $($_.CreationDate)  $($_.CommandLine)" }
}
Write-Host ''
Write-Host 'Devices the app blocked stay blocked until the app runs again or you restore them in the router UI.'
