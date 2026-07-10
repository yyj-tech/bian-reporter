param(
    [string]$ApiKey = $env:BINANCE_API_KEY,
    [string]$ApiSecret = $env:BINANCE_API_SECRET,
    [string]$EnvFilePath = $(Join-Path (Split-Path $PSScriptRoot -Parent) ".env.local"),
    [string]$InputPath = ".\auto_invest_history_sample.json",
    [string]$OutputPath = ".\auto_invest_enriched_report.md"
)

$ErrorActionPreference = "Stop"
$BaseUrl = "https://api.binance.com"

function T {
    param([string]$Text)

    return [Text.RegularExpressions.Regex]::Unescape($Text)
}

function Get-PublicJson {
    param([string]$Path)

    return Invoke-RestMethod -Uri ("{0}{1}" -f $BaseUrl, $Path) -Method Get
}

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

function Resolve-AssetPriceUsdt {
    param(
        [string]$Asset,
        [hashtable]$PriceMap
    )

    if ($Asset -in @("USDT", "FDUSD", "USDC", "BUSD")) { return 1.0 }

    $direct = "$Asset`USDT"
    if ($PriceMap.ContainsKey($direct)) { return $PriceMap[$direct] }

    $fdusd = "$Asset`FDUSD"
    if ($PriceMap.ContainsKey($fdusd)) { return $PriceMap[$fdusd] }

    $btc = "$Asset`BTC"
    if ($PriceMap.ContainsKey($btc) -and $PriceMap.ContainsKey("BTCUSDT")) {
        return $PriceMap[$btc] * $PriceMap["BTCUSDT"]
    }

    $eth = "$Asset`ETH"
    if ($PriceMap.ContainsKey($eth) -and $PriceMap.ContainsKey("ETHUSDT")) {
        return $PriceMap[$eth] * $PriceMap["ETHUSDT"]
    }

    return $null
}

function Resolve-AssetValueUsdt {
    param(
        [string]$Asset,
        [double]$Qty,
        [hashtable]$PriceMap
    )

    $price = Resolve-AssetPriceUsdt -Asset $Asset -PriceMap $PriceMap
    if ($null -eq $price) { return $null }
    return $Qty * $price
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

if (-not (Test-Path -LiteralPath $InputPath)) {
    throw "Input file not found: $InputPath"
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

$sample = Get-Content -Raw -Encoding utf8 $InputPath | ConvertFrom-Json
$tickers = Get-PublicJson -Path "/api/v3/ticker/price"
$priceMap = @{}
foreach ($ticker in $tickers) {
    $priceMap[$ticker.symbol] = [double]$ticker.price
}

$account = Get-SignedJson -Path "/api/v3/account" -Params @{
    omitZeroBalances = "true"
    recvWindow = 5000
}
$flexible = Get-AllFlexiblePositions
$locked = Get-AllLockedPositions

$holdingRows = @()
[double]$spotTotal = 0
[double]$flexibleTotal = 0
[double]$lockedTotal = 0

foreach ($balance in $account.balances) {
    $qty = [double]$balance.free + [double]$balance.locked
    $value = Resolve-AssetValueUsdt -Asset $balance.asset -Qty $qty -PriceMap $priceMap
    if ($null -eq $value) { continue }
    $spotTotal += $value
    $holdingRows += [pscustomobject]@{
        Category = (T "\u73b0\u8d27")
        Asset = [string]$balance.asset
        Quantity = $qty
        ValueUsdt = $value
    }
}

foreach ($item in $flexible) {
    $asset = [string]$item.asset
    $qty = [double]$item.totalAmount
    $value = Resolve-AssetValueUsdt -Asset $asset -Qty $qty -PriceMap $priceMap
    if ($null -eq $value) { continue }
    $flexibleTotal += $value
    $holdingRows += [pscustomobject]@{
        Category = (T "Simple Earn \u6d3b\u671f")
        Asset = $asset
        Quantity = $qty
        ValueUsdt = $value
    }
}

foreach ($item in $locked) {
    $asset = [string]$item.asset
    $qty = [double]$item.amount
    $value = Resolve-AssetValueUsdt -Asset $asset -Qty $qty -PriceMap $priceMap
    if ($null -eq $value) { continue }
    $lockedTotal += $value
    $holdingRows += [pscustomobject]@{
        Category = (T "Simple Earn \u5b9a\u671f")
        Asset = $asset
        Quantity = $qty
        ValueUsdt = $value
    }
}

$holdingRows = $holdingRows | Sort-Object ValueUsdt -Descending
[double]$totalHoldingValue = $spotTotal + $flexibleTotal + $lockedTotal

$records = @()
foreach ($result in $sample.results) {
    if (-not $result.ok -or -not $result.data -or -not $result.data.list) { continue }
    foreach ($item in $result.data.list) {
        if ($item.transactionStatus -ne "SUCCESS") { continue }
        if ($item.sourceAsset -ne "USDT") { continue }

        $sourceAmount = [double]$item.sourceAssetAmount
        $targetAmount = [double]$item.targetAssetAmount
        $fee = 0.0
        if ($item.transactionFee -and $item.transactionFeeUnit -eq "USDT") {
            $fee = [double]$item.transactionFee
        }

        $records += [pscustomobject]@{
            Asset = [string]$item.targetAsset
            PlanType = [string]$item.planType
            PlanName = [string]$item.planName
            CostUsdt = $sourceAmount + $fee
            Quantity = $targetAmount
            ExecutionPrice = [double]$item.executionPrice
            Time = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$item.transactionDateTime).ToLocalTime()
        }
    }
}

$summary = $records |
    Group-Object Asset |
    ForEach-Object {
        [double]$totalCost = ($_.Group | Measure-Object CostUsdt -Sum).Sum
        [double]$totalQty = ($_.Group | Measure-Object Quantity -Sum).Sum
        [double]$avgCost = if ($totalQty -gt 0) { $totalCost / $totalQty } else { 0 }
        $currentPrice = Resolve-AssetPriceUsdt -Asset $_.Name -PriceMap $priceMap
        $currentValue = if ($null -ne $currentPrice) { $totalQty * $currentPrice } else { $null }
        $pnl = if ($null -ne $currentValue) { $currentValue - $totalCost } else { $null }
        $pnlRate = if ($null -ne $pnl -and $totalCost -gt 0) { $pnl / $totalCost * 100 } else { $null }

        [pscustomobject]@{
            Asset = $_.Name
            Count = $_.Count
            TotalCostUsdt = $totalCost
            TotalQuantity = $totalQty
            AvgCostUsdt = $avgCost
            CurrentPriceUsdt = $currentPrice
            CurrentValueUsdt = $currentValue
            PnlUsdt = $pnl
            PnlRate = $pnlRate
            FirstTime = ($_.Group | Sort-Object Time | Select-Object -First 1).Time
            LastTime = ($_.Group | Sort-Object Time -Descending | Select-Object -First 1).Time
        }
    } |
    Sort-Object TotalCostUsdt -Descending

[double]$totalCostAll = ($summary | Measure-Object TotalCostUsdt -Sum).Sum
[double]$totalValueAll = ($summary | Where-Object { $null -ne $_.CurrentValueUsdt } | Measure-Object CurrentValueUsdt -Sum).Sum
[double]$totalPnlAll = $totalValueAll - $totalCostAll
[double]$totalPnlRate = if ($totalCostAll -gt 0) { $totalPnlAll / $totalCostAll * 100 } else { 0 }

$windowText = if ($sample.startDate -and $sample.endDate) {
    "{0} .. {1}" -f $sample.startDate, $sample.endDate
}
elseif ($sample.days) {
    (T "\u6700\u8fd1 {0} \u5929") -f $sample.days
}
else {
    "-"
}

$lines = @(
    (T "# Auto-Invest \u5b9a\u6295\u6210\u672c\u548c\u76c8\u4e8f\u62a5\u8868"),
    "",
    ((T "- \u751f\u6210\u65f6\u95f4\uff1a{0}") -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")),
    ((T "- \u5386\u53f2\u7a97\u53e3\uff1a{0}") -f $windowText),
    ((T "- \u6210\u529f\u5b9a\u6295\u8bb0\u5f55\uff1a{0}") -f $records.Count),
    ((T "- \u8d26\u6237\u603b\u4ed3\u4f4d\u4ef7\u503c\uff1a{0} USDT") -f [string]::Format('{0:N2}', $totalHoldingValue)),
    ((T "  - \u73b0\u8d27\uff1a{0} USDT") -f [string]::Format('{0:N2}', $spotTotal)),
    ((T "  - Simple Earn \u6d3b\u671f\uff1a{0} USDT") -f [string]::Format('{0:N2}', $flexibleTotal)),
    ((T "  - Simple Earn \u5b9a\u671f\uff1a{0} USDT") -f [string]::Format('{0:N2}', $lockedTotal)),
    ((T "- \u7d2f\u8ba1\u6295\u5165\uff1a{0} USDT") -f [string]::Format('{0:N2}', $totalCostAll)),
    ((T "- \u5f53\u524d\u5e02\u503c\uff1a{0} USDT") -f [string]::Format('{0:N2}', $totalValueAll)),
    ((T "- \u6d6e\u52a8\u76c8\u4e8f\uff1a{0} USDT\uff08{1}%\uff09") -f [string]::Format('{0:N2}', $totalPnlAll), [string]::Format('{0:N2}', $totalPnlRate)),
    "",
    (T "## \u6309\u8d44\u4ea7\u6c47\u603b"),
    "",
    (T "| \u8d44\u4ea7 | \u7b14\u6570 | \u7d2f\u8ba1\u6295\u5165\uff08USDT\uff09 | \u7d2f\u8ba1\u4e70\u5165\u6570\u91cf | \u5e73\u5747\u6210\u672c\u4ef7 | \u5f53\u524d\u4ef7 | \u5f53\u524d\u5e02\u503c\uff08USDT\uff09 | \u6d6e\u52a8\u76c8\u4e8f\uff08USDT\uff09 | \u76c8\u4e8f\u6bd4\u4f8b |"),
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|"
)

foreach ($row in $summary) {
    $currentPriceText = if ($null -ne $row.CurrentPriceUsdt) { [string]::Format('{0:N8}', $row.CurrentPriceUsdt) } else { "-" }
    $currentValueText = if ($null -ne $row.CurrentValueUsdt) { [string]::Format('{0:N2}', $row.CurrentValueUsdt) } else { "-" }
    $pnlText = if ($null -ne $row.PnlUsdt) { [string]::Format('{0:N2}', $row.PnlUsdt) } else { "-" }
    $pnlRateText = if ($null -ne $row.PnlRate) { [string]::Format('{0:N2}', $row.PnlRate) + "%" } else { "-" }

    $lines += "| $($row.Asset) | $($row.Count) | $([string]::Format('{0:N2}', $row.TotalCostUsdt)) | $([string]::Format('{0:N8}', $row.TotalQuantity)) | $([string]::Format('{0:N8}', $row.AvgCostUsdt)) | $currentPriceText | $currentValueText | $pnlText | $pnlRateText |"
}

$lines += ""
$lines += (T "## \u5f53\u524d\u4ed3\u4f4d\u660e\u7ec6")
$lines += ""
$lines += (T "| \u7c7b\u522b | \u8d44\u4ea7 | \u6570\u91cf | \u5f53\u524d\u4ef7\u503c\uff08USDT\uff09 |")
$lines += "|---|---:|---:|---:|"

foreach ($row in $holdingRows) {
    $lines += "| $($row.Category) | $($row.Asset) | $([string]::Format('{0:N8}', $row.Quantity)) | $([string]::Format('{0:N2}', $row.ValueUsdt)) |"
}

$lines += ""
$lines += (T "## \u53e3\u5f84\u8bf4\u660e")
$lines += ""
$lines += (T "- \u6210\u672c\u4ef7 = \u7d2f\u8ba1\u6295\u5165 USDT / \u7d2f\u8ba1\u4e70\u5165\u6570\u91cf\u3002")
$lines += (T "- \u5f53\u524d\u4ef7\u4f7f\u7528 Binance \u516c\u5f00 ticker \u884c\u60c5\uff0c\u7edf\u4e00\u6298\u7b97\u4e3a USDT\u3002")
$lines += (T "- \u6d6e\u52a8\u76c8\u4e8f\u57fa\u4e8e\u5b9a\u6295\u4e70\u5165\u6570\u91cf\u8ba1\u7b97\uff0c\u4e0d\u628a Simple Earn \u5229\u606f\u589e\u91cf\u7eb3\u5165\u672c\u6b21\u6210\u672c\u3002")
$lines += (T "- \u8d26\u6237\u603b\u4ed3\u4f4d\u4ef7\u503c = \u73b0\u8d27 + Simple Earn \u6d3b\u671f + Simple Earn \u5b9a\u671f\uff0c\u4f7f\u7528\u5f53\u524d ticker \u6298\u7b97\u4e3a USDT\u3002")

Set-Content -Path $OutputPath -Value $lines -Encoding utf8
Write-Output ("Enriched report written to {0}" -f (Resolve-Path $OutputPath))
