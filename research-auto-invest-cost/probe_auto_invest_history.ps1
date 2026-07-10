param(
    [string]$ApiKey = $env:BINANCE_API_KEY,
    [string]$ApiSecret = $env:BINANCE_API_SECRET,
    [string]$EnvFilePath = $(Join-Path (Split-Path $PSScriptRoot -Parent) ".env.local"),
    [string]$OutputPath = ".\auto_invest_history_sample.json",
    [int]$Days = 30,
    [string]$StartDate = "",
    [string]$EndDate = "",
    [string]$TargetAsset = "",
    [string[]]$PlanType = @("SINGLE", "PORTFOLIO", "INDEX")
)

$ErrorActionPreference = "Stop"
$BaseUrl = "https://api.binance.com"

function Get-ConfigValue {
    param([string]$Name)

    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $value) {
        $value = [Environment]::GetEnvironmentVariable($Name, "User")
    }
    if (-not $value -and (Test-Path -LiteralPath $EnvFilePath)) {
        foreach ($line in Get-Content -Path $EnvFilePath -Encoding ascii) {
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

    return $value
}

function Get-Signature {
    param(
        [string]$Secret,
        [string]$Message
    )

    $hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
    try {
        $hash = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Message))
        return ([BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $hmac.Dispose()
    }
}

function New-QueryString {
    param([hashtable]$Params)

    $pairs = New-Object System.Collections.Generic.List[string]
    foreach ($key in $Params.Keys) {
        if ($null -eq $Params[$key] -or [string]$Params[$key] -eq "") { continue }
        $pairs.Add(("{0}={1}" -f $key, [uri]::EscapeDataString([string]$Params[$key])))
    }
    return [string]::Join("&", $pairs)
}

function Get-SignedJson {
    param(
        [string]$Path,
        [hashtable]$Params
    )

    $payload = @{}
    foreach ($key in $Params.Keys) {
        $payload[$key] = $Params[$key]
    }
    $payload["timestamp"] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $unsigned = New-QueryString -Params $payload
    $signature = Get-Signature -Secret $ApiSecret -Message $unsigned
    $uri = "{0}{1}?{2}&signature={3}" -f $BaseUrl, $Path, $unsigned, $signature

    return Invoke-RestMethod -Uri $uri -Headers @{ "X-MBX-APIKEY" = $ApiKey } -Method Get
}

if (-not $ApiKey) {
    $ApiKey = Get-ConfigValue -Name "BINANCE_API_KEY"
}
if (-not $ApiSecret) {
    $ApiSecret = Get-ConfigValue -Name "BINANCE_API_SECRET"
}
if (-not $ApiKey -or -not $ApiSecret) {
    throw "Missing BINANCE_API_KEY or BINANCE_API_SECRET."
}

$end = [DateTimeOffset]::UtcNow
$start = $end.AddDays(-1 * $Days)
if ($StartDate) {
    $start = [DateTimeOffset]::new(([datetime]::ParseExact($StartDate, "yyyy-MM-dd", $null)), [TimeSpan]::Zero)
}
if ($EndDate) {
    $end = [DateTimeOffset]::new(([datetime]::ParseExact($EndDate, "yyyy-MM-dd", $null)).AddDays(1).AddMilliseconds(-1), [TimeSpan]::Zero)
}

$results = @()

foreach ($type in $PlanType) {
    $typeItems = @()
    $typeErrors = @()
    $windowStart = $start

    while ($windowStart -lt $end) {
        $windowEnd = $windowStart.AddDays(30).AddMilliseconds(-1)
        if ($windowEnd -gt $end) {
            $windowEnd = $end
        }

        $current = 1
        while ($true) {
            $params = @{
                startTime = $windowStart.ToUnixTimeMilliseconds()
                endTime = $windowEnd.ToUnixTimeMilliseconds()
                current = $current
                size = 100
                planType = $type
                targetAsset = $TargetAsset
                recvWindow = 5000
            }

            Write-Output ("Querying Auto-Invest history: planType={0}, window={1}..{2}, page={3}" -f $type, $windowStart.ToString("yyyy-MM-dd"), $windowEnd.ToString("yyyy-MM-dd"), $current)

            try {
                $data = Get-SignedJson -Path "/sapi/v1/lending/auto-invest/history/list" -Params $params
                if ($data.list) {
                    $typeItems += @($data.list)
                }

                if (-not $data.list -or $data.list.Count -lt 100) {
                    break
                }
                $current += 1
            }
            catch {
                $typeErrors += [pscustomobject]@{
                    windowStart = $windowStart.ToString("yyyy-MM-dd")
                    windowEnd = $windowEnd.ToString("yyyy-MM-dd")
                    page = $current
                    error = $_.Exception.Message
                }
                break
            }
        }

        $windowStart = $windowEnd.AddMilliseconds(1)
    }

    $results += [pscustomobject]@{
        planType = $type
        ok = ($typeErrors.Count -eq 0)
        error = if ($typeErrors.Count -eq 0) { $null } else { $typeErrors }
        data = [pscustomobject]@{
            total = $typeItems.Count
            list = $typeItems
        }
    }
}

[pscustomobject]@{
    generatedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")
    days = if ($StartDate) { $null } else { $Days }
    startDate = $start.ToString("yyyy-MM-dd")
    endDate = $end.ToString("yyyy-MM-dd")
    targetAsset = $TargetAsset
    results = $results
} | ConvertTo-Json -Depth 30 | Set-Content -Path $OutputPath -Encoding utf8

Write-Output ("Auto-Invest history sample written to {0}" -f (Resolve-Path $OutputPath))
