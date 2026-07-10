param(
    [string]$SmtpServer = "smtp.163.com",
    [int]$SmtpPort = 25,
    [bool]$SmtpEnableSsl = $true,
    [string]$EnvFilePath = $(Join-Path $PSScriptRoot ".env.local")
)

$ErrorActionPreference = "Stop"

function Read-RequiredValue {
    param(
        [string]$Name,
        [string]$Prompt
    )

    while ($true) {
        $value = Read-Host $Prompt
        if ($value) {
            [Environment]::SetEnvironmentVariable($Name, $value, "User")
            [Environment]::SetEnvironmentVariable($Name, $value, "Process")
            return $value
        }

        Write-Output "$Name cannot be empty."
    }
}

function Read-RequiredSecret {
    param(
        [string]$Name,
        [string]$Prompt
    )

    while ($true) {
        $secret = Read-Host $Prompt -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        try {
            $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }

        if ($value) {
            [Environment]::SetEnvironmentVariable($Name, $value, "User")
            [Environment]::SetEnvironmentVariable($Name, $value, "Process")
            return $value
        }

        Write-Output "$Name cannot be empty."
    }
}

$binanceApiKey = Read-RequiredSecret -Name "BINANCE_API_KEY" -Prompt "Binance API Key"
$binanceApiSecret = Read-RequiredSecret -Name "BINANCE_API_SECRET" -Prompt "Binance API Secret"
$smtpFrom = Read-RequiredValue -Name "REPORT_SMTP_FROM" -Prompt "SMTP sender email"
$smtpPassword = Read-RequiredSecret -Name "REPORT_SMTP_PASSWORD" -Prompt "SMTP password or authorization code"
$smtpTo = Read-RequiredValue -Name "REPORT_SMTP_TO" -Prompt "Recipients, comma separated"

[Environment]::SetEnvironmentVariable("REPORT_SMTP_SERVER", $SmtpServer, "User")
[Environment]::SetEnvironmentVariable("REPORT_SMTP_PORT", [string]$SmtpPort, "User")
[Environment]::SetEnvironmentVariable("REPORT_SMTP_ENABLE_SSL", [string]$SmtpEnableSsl, "User")
[Environment]::SetEnvironmentVariable("REPORT_SMTP_SERVER", $SmtpServer, "Process")
[Environment]::SetEnvironmentVariable("REPORT_SMTP_PORT", [string]$SmtpPort, "Process")
[Environment]::SetEnvironmentVariable("REPORT_SMTP_ENABLE_SSL", [string]$SmtpEnableSsl, "Process")

$envLines = @(
    "BINANCE_API_KEY=$binanceApiKey",
    "BINANCE_API_SECRET=$binanceApiSecret",
    "REPORT_SMTP_FROM=$smtpFrom",
    "REPORT_SMTP_USERNAME=$smtpFrom",
    "REPORT_SMTP_PASSWORD=$smtpPassword",
    "REPORT_SMTP_TO=$smtpTo",
    "REPORT_SMTP_SERVER=$SmtpServer",
    "REPORT_SMTP_PORT=$SmtpPort",
    "REPORT_SMTP_ENABLE_SSL=$SmtpEnableSsl"
)
Set-Content -Path $EnvFilePath -Value $envLines -Encoding ascii

Write-Output "Environment variables saved for the current Windows user."
Write-Output "Environment variables were also loaded into the current PowerShell process."
Write-Output "Local config file written to $EnvFilePath."
