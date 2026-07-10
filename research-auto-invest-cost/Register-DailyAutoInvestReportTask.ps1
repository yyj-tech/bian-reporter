param(
    [string]$TaskName = "Daily Binance Auto Invest Cost Report Email",
    [string]$At = "10:00",
    [string]$ScriptPath = $(Join-Path $PSScriptRoot "run_daily_auto_invest_report.ps1"),
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

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Description "Generate Binance Auto-Invest cost, PnL, total holding report and email it." -Force | Out-Null

Write-Output "Scheduled task registered: $TaskName"
Write-Output "Daily run time: $At"
Write-Output "Script: $($resolvedScript.Path)"
