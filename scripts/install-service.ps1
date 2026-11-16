#Requires -RunAsAdministrator
<#
  Registers Nexus Internet Scheduler as a boot-time background task.
  - Starts at Windows boot (no login needed), runs as SYSTEM.
  - src/supervisor.js restarts the app if it crashes; Task Scheduler restarts
    the supervisor if it ever dies.
  - Restricts .env so only SYSTEM, Administrators and you can read it.
  Usage (elevated PowerShell, from the project folder):
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
#>
$ErrorActionPreference = 'Stop'
$TaskName = 'Nexus Internet Scheduler'
$Root = Split-Path -Parent $PSScriptRoot

$node = (Get-Command node -ErrorAction Stop).Source
if ($node -like "$env:USERPROFILE*") {
  Write-Warning "node.exe is under your user profile ($node). SYSTEM can usually run it, but a machine-wide Node.js install (C:\Program Files\nodejs) is more reliable."
}
if (-not (Test-Path "$Root\.env")) { throw ".env not found in $Root. Copy .env.example to .env and fill it in first." }
if (-not (Test-Path "$Root\node_modules")) { throw "node_modules missing. Run 'npm ci' (or 'npm install') first." }

# Lock down .env (router password, DB password, session secret).
& icacls "$Root\.env" /inheritance:r /grant:r "SYSTEM:(R)" "Administrators:(F)" "$($env:USERNAME):(F)" | Out-Null
Write-Host "Restricted permissions on .env"

$action    = New-ScheduledTaskAction -Execute $node -Argument "`"$Root\src\supervisor.js`"" -WorkingDirectory $Root
$trigger   = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'   # give the network and PostgreSQL a head start
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Per-device internet schedules for the NETGEAR C6230 (self-hosted).' -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table -AutoSize
Write-Host "Installed. Logs: $Root\logs\app.log"
