#Requires -RunAsAdministrator
# Stops and removes the boot task. Does NOT touch the router or the database.
$ErrorActionPreference = 'Stop'
$TaskName = 'Nexus Internet Scheduler'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed task '$TaskName'."
} else {
  Write-Host "Task '$TaskName' is not installed."
}
Write-Host 'Note: devices the app blocked stay blocked. Restore them first (dashboard: "Restore all & disarm") or via the router UI.'
