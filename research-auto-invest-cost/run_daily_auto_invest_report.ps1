param(
    [string]$StartDate = "2026-01-01",
    [string]$HistoryPath = $(Join-Path $PSScriptRoot "auto_invest_history_2026.json"),
    [string]$ReportPath = $(Join-Path $PSScriptRoot "auto_invest_enriched_report_2026.md"),
    [string]$Subject = "",
    [string]$LogDirectory = $(Join-Path $PSScriptRoot "logs"),
    [string[]]$PlanType = @("PORTFOLIO")
)

$ErrorActionPreference = "Stop"

function T {
    param([string]$Text)

    return [Text.RegularExpressions.Regex]::Unescape($Text)
}

if (-not $Subject) {
    $Subject = (T "\u5e01\u5b89\u5b9a\u6295\u6210\u672c\u548c\u603b\u4ed3\u4f4d\u62a5\u8868 {0}") -f (Get-Date -Format "yyyy-MM-dd")
}

if (-not (Test-Path -LiteralPath $LogDirectory)) {
    New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
}

$logPath = Join-Path $LogDirectory ("auto_invest_report_{0}.log" -f (Get-Date -Format "yyyyMMdd_HHmmss"))

Push-Location $PSScriptRoot
try {
    Start-Transcript -Path $logPath -Force | Out-Null

    & (Join-Path $PSScriptRoot "probe_auto_invest_history.ps1") `
        -StartDate $StartDate `
        -OutputPath $HistoryPath `
        -PlanType $PlanType

    & (Join-Path $PSScriptRoot "build_enriched_auto_invest_report.ps1") `
        -InputPath $HistoryPath `
        -OutputPath $ReportPath

    & (Join-Path (Split-Path $PSScriptRoot -Parent) "send_report_email.ps1") `
        -BodyPath $ReportPath `
        -Subject $Subject
}
finally {
    try {
        Stop-Transcript | Out-Null
    }
    catch {
        # Transcript might not be active if startup failed before it began.
    }
    Pop-Location
}
