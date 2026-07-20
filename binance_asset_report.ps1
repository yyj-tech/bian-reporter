param(
    [string]$ApiKey = $env:BINANCE_API_KEY,
    [string]$ApiSecret = $env:BINANCE_API_SECRET,
    [string]$OutputPath = ".\binance_asset_report_zh.md"
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

function T {
    param([string]$Text)

    return [Text.RegularExpressions.Regex]::Unescape($Text)
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

$BaseUrl = if ($env:BINANCE_BASE_URL) { $env:BINANCE_BASE_URL.TrimEnd("/") } else { "https://api.binance.com" }

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

function Get-PublicJson {
    param([string]$Path)

    $uri = "{0}{1}" -f $BaseUrl, $Path
    return Invoke-RestMethod -Uri $uri -Method Get
}

function Resolve-AssetValueUsdt {
    param(
        [string]$Asset,
        [double]$Qty,
        [hashtable]$PriceMap
    )

    if ($Qty -eq 0) { return 0.0 }
    if ($Asset -in @("USDT", "FDUSD", "USDC", "BUSD")) { return $Qty }

    $direct = "$Asset`USDT"
    if ($PriceMap.ContainsKey($direct)) { return $Qty * $PriceMap[$direct] }

    $fdusd = "$Asset`FDUSD"
    if ($PriceMap.ContainsKey($fdusd)) { return $Qty * $PriceMap[$fdusd] }

    $btc = "$Asset`BTC"
    if ($PriceMap.ContainsKey($btc) -and $PriceMap.ContainsKey("BTCUSDT")) {
        return $Qty * $PriceMap[$btc] * $PriceMap["BTCUSDT"]
    }

    $eth = "$Asset`ETH"
    if ($PriceMap.ContainsKey($eth) -and $PriceMap.ContainsKey("ETHUSDT")) {
        return $Qty * $PriceMap[$eth] * $PriceMap["ETHUSDT"]
    }

    return $null
}

function Get-AllFlexiblePositions {
    $current = 1
    $size = 100
    $all = @()

    while ($true) {
        $page = Get-SignedJson -Path "/sapi/v1/simple-earn/flexible/position" -Params @{
            current = $current
            size = $size
            recvWindow = 5000
        }

        if ($page.rows) {
            $all += @($page.rows)
        }

        if (-not $page.rows -or $page.rows.Count -lt $size) {
            break
        }

        $current += 1
    }

    return $all
}

function Get-AllLockedPositions {
    $current = 1
    $size = 100
    $all = @()

    while ($true) {
        $page = Get-SignedJson -Path "/sapi/v1/simple-earn/locked/position" -Params @{
            current = $current
            size = $size
            recvWindow = 5000
        }

        if ($page.rows) {
            $all += @($page.rows)
        }

        if (-not $page.rows -or $page.rows.Count -lt $size) {
            break
        }

        $current += 1
    }

    return $all
}

$now = Get-Date
$account = Get-SignedJson -Path "/api/v3/account" -Params @{
    omitZeroBalances = "true"
    recvWindow = 5000
}
$tickers = Get-PublicJson -Path "/api/v3/ticker/price"
$flexible = Get-AllFlexiblePositions
$locked = Get-AllLockedPositions

$priceMap = @{}
foreach ($ticker in $tickers) {
    $priceMap[$ticker.symbol] = [double]$ticker.price
}

$rows = @()
[double]$spotTotal = 0
[double]$flexTotal = 0
[double]$lockedTotal = 0

foreach ($balance in $account.balances) {
    $qty = [double]$balance.free + [double]$balance.locked
    $valueUsdt = Resolve-AssetValueUsdt -Asset $balance.asset -Qty $qty -PriceMap $priceMap
    if ($null -eq $valueUsdt) { continue }

    $spotTotal += $valueUsdt
    $rows += [pscustomobject]@{
        Category = (T "\u73b0\u8d27")
        Asset = $balance.asset
        Quantity = $qty
        ValueUsdt = $valueUsdt
        Detail = if ([double]$balance.locked -gt 0) { "free=$($balance.free); locked=$($balance.locked)" } else { "free=$($balance.free)" }
    }
}

foreach ($item in $flexible) {
    $asset = [string]$item.asset
    $qty = [double]$item.totalAmount
    $valueUsdt = Resolve-AssetValueUsdt -Asset $asset -Qty $qty -PriceMap $priceMap
    if ($null -eq $valueUsdt) { continue }

    $flexTotal += $valueUsdt
    $rows += [pscustomobject]@{
        Category = (T "Simple Earn \u6d3b\u671f")
        Asset = $asset
        Quantity = $qty
        ValueUsdt = $valueUsdt
        Detail = "productId=$($item.productId); $((T '\u6700\u65b0\u5e74\u5316'))=$($item.latestAnnualPercentageRate); $((T '\u81ea\u52a8\u7533\u8d2d'))=$($item.autoSubscribe)"
    }
}

foreach ($item in $locked) {
    $asset = [string]$item.asset
    $qty = [double]$item.amount
    $valueUsdt = Resolve-AssetValueUsdt -Asset $asset -Qty $qty -PriceMap $priceMap
    if ($null -eq $valueUsdt) { continue }

    $lockedTotal += $valueUsdt
    $rows += [pscustomobject]@{
        Category = (T "Simple Earn \u5b9a\u671f")
        Asset = $asset
        Quantity = $qty
        ValueUsdt = $valueUsdt
        Detail = "projectId=$($item.projectId); $((T '\u671f\u9650'))=$($item.duration)$((T '\u5929')); $((T '\u5e74\u5316'))=$($item.apr); $((T '\u81ea\u52a8\u7533\u8d2d'))=$($item.autoSubscribe); $((T '\u53ef\u63d0\u524d\u8d4e\u56de'))=$($item.canRedeemEarly)"
    }
}

$rows = $rows | Sort-Object ValueUsdt -Descending
[double]$grandTotal = $spotTotal + $flexTotal + $lockedTotal

$lines = @(
    (T "# \u5e01\u5b89\u603b\u8d44\u4ea7\u62a5\u544a"),
    "",
    ((T "- \u751f\u6210\u65f6\u95f4\uff1a{0}") -f $now.ToString("yyyy-MM-dd HH:mm:ss zzz")),
    (T "- \u7edf\u8ba1\u8303\u56f4\uff1a\u73b0\u8d27\u8d26\u6237 + Simple Earn \u6d3b\u671f + Simple Earn \u5b9a\u671f"),
    (T "- \u8ba1\u4ef7\u65b9\u5f0f\uff1a\u4f7f\u7528\u5e01\u5b89\u516c\u5f00\u884c\u60c5\uff0c\u7edf\u4e00\u6298\u7b97\u4e3a USDT"),
    "",
    (T "## \u603b\u89c8"),
    "",
    ((T "- \u603b\u8d44\u4ea7\uff1a{0} USDT") -f [string]::Format('{0:N2}', $grandTotal)),
    ((T "- \u73b0\u8d27\u8d44\u4ea7\uff1a{0} USDT") -f [string]::Format('{0:N2}', $spotTotal)),
    ((T "- Simple Earn \u6d3b\u671f\uff1a{0} USDT") -f [string]::Format('{0:N2}', $flexTotal)),
    ((T "- Simple Earn \u5b9a\u671f\uff1a{0} USDT") -f [string]::Format('{0:N2}', $lockedTotal)),
    "",
    (T "## \u8d44\u4ea7\u914d\u7f6e\u660e\u7ec6"),
    "",
    (T "| \u5206\u7c7b | \u8d44\u4ea7 | \u6570\u91cf | \u6298\u7b97\u4ef7\u503c\uff08USDT\uff09 | \u914d\u7f6e\u8bf4\u660e |"),
    "|---|---:|---:|---:|---|"
)

foreach ($row in $rows) {
    $lines += "| $($row.Category) | $($row.Asset) | $([string]::Format('{0:N8}', $row.Quantity)) | $([string]::Format('{0:N2}', $row.ValueUsdt)) | $($row.Detail) |"
}

$lines += ""
$lines += (T "## \u8bf4\u660e")
$lines += ""
$lines += (T "- LDUSDT \u548c LDETH \u5df2\u6309 Simple Earn \u6301\u4ed3\u8fd8\u539f\u5e76\u8ba1\u5165\u603b\u8d44\u4ea7\uff0c\u4e0d\u518d\u5355\u72ec\u4f5c\u4e3a\u73b0\u8d27\u8d44\u4ea7\u91cd\u590d\u8ba1\u7b97\u3002")
$lines += (T "- \u5982\u679c\u8d26\u6237\u91cc\u51fa\u73b0\u6ca1\u6709\u76f4\u63a5\u6216\u95f4\u63a5 USDT \u6298\u7b97\u8def\u5f84\u7684\u5e01\u79cd\uff0c\u8be5\u5e01\u79cd\u4f1a\u88ab\u6392\u9664\u5728\u603b\u8d44\u4ea7\u4e4b\u5916\uff0c\u9700\u8981\u540e\u7eed\u8865\u5145\u6298\u7b97\u8def\u5f84\u3002")

Set-Content -Path $OutputPath -Value $lines -Encoding utf8

Write-Output ("Markdown report written to {0}" -f (Resolve-Path $OutputPath))
Write-Output ("Total Asset ~= {0:N2} USDT" -f $grandTotal)
