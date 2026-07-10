param(
    [string]$TaskName = "Daily Binance Asset Report Email",
    [string]$At = "08:30",
    [string]$ScriptPath = $(Join-Path $PSScriptRoot "run_daily_binance_report.ps1"),
    [string]$WorkingDirectory = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

$resolvedScript = Resolve-Path -LiteralPath $ScriptPath
$resolvedWorkingDirectory = Resolve-Path -LiteralPath $WorkingDirectory
$powerShellPath = Join-Path $PSHOME "powershell.exe"
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$($resolvedScript.Path)`""
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $resolvedWorkingDirectory.Path
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($At, "HH:mm", $null))
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Description "Generate Binance asset report and email it to configured recipients." -Force | Out-Null

Write-Output "Scheduled task registered: $TaskName"
Write-Output "Daily run time: $At"
Write-Output "Script: $($resolvedScript.Path)"
