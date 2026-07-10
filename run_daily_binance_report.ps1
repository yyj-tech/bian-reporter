param(
    [string]$OutputPath = $(if ($env:REPORT_OUTPUT_PATH) { $env:REPORT_OUTPUT_PATH } else { Join-Path $PSScriptRoot "binance_asset_report_zh.md" }),
    [string]$Subject = $(if ($env:REPORT_EMAIL_SUBJECT) { $env:REPORT_EMAIL_SUBJECT } else { "Binance Account Report $(Get-Date -Format 'yyyy-MM-dd')" }),
    [string]$LogDirectory = $(if ($env:REPORT_LOG_DIR) { $env:REPORT_LOG_DIR } else { Join-Path $PSScriptRoot "logs" })
)

$ErrorActionPreference = "Stop"

function Get-ConfigValue {
    param([string]$Name)

    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $value) {
        $value = [Environment]::GetEnvironmentVariable($Name, "User")
    }
    if (-not $value) {
        $value = [Environment]::GetEnvironmentVariable($Name, "Machine")
    }
    if (-not $value) {
        $envFilePath = Join-Path $PSScriptRoot ".env.local"
        if (Test-Path -LiteralPath $envFilePath) {
            foreach ($line in Get-Content -Path $envFilePath -Encoding ascii) {
                if (-not $line -or $line.TrimStart().StartsWith("#")) { continue }
                $separatorIndex = $line.IndexOf("=")
                if ($separatorIndex -le 0) { continue }
                $key = $line.Substring(0, $separatorIndex).Trim()
                if ($key -eq $Name) {
                    $value = $line.Substring($separatorIndex + 1)
                    break
                }
            }
        }
    }

    return $value
}

if (-not $env:REPORT_OUTPUT_PATH) {
    $configuredOutputPath = Get-ConfigValue -Name "REPORT_OUTPUT_PATH"
    if ($configuredOutputPath) {
        $OutputPath = $configuredOutputPath
    }
}
if (-not $env:REPORT_EMAIL_SUBJECT) {
    $configuredSubject = Get-ConfigValue -Name "REPORT_EMAIL_SUBJECT"
    if ($configuredSubject) {
        $Subject = $configuredSubject
    }
}
if (-not $env:REPORT_LOG_DIR) {
    $configuredLogDirectory = Get-ConfigValue -Name "REPORT_LOG_DIR"
    if ($configuredLogDirectory) {
        $LogDirectory = $configuredLogDirectory
    }
}

if (-not (Test-Path -LiteralPath $LogDirectory)) {
    New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
}

$logPath = Join-Path $LogDirectory ("daily_report_{0}.log" -f (Get-Date -Format "yyyyMMdd_HHmmss"))

Push-Location $PSScriptRoot
try {
    Start-Transcript -Path $logPath -Force | Out-Null
    & (Join-Path $PSScriptRoot "binance_asset_report.ps1") -OutputPath $OutputPath
    & (Join-Path $PSScriptRoot "send_report_email.ps1") -BodyPath $OutputPath -Subject $Subject
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
