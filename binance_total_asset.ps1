param(
    [string]$ApiKey = $env:BINANCE_API_KEY,
    [string]$ApiSecret = $env:BINANCE_API_SECRET
)

$ErrorActionPreference = "Stop"

if (-not $ApiKey -or -not $ApiSecret) {
    throw "Missing BINANCE_API_KEY or BINANCE_API_SECRET."
}

$BaseUrl = "https://api.binance.com"

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

function Get-SignedJson {
    param(
        [string]$Path,
        [hashtable]$Params
    )

    $pairs = New-Object System.Collections.Generic.List[string]
    foreach ($key in $Params.Keys) {
        $pairs.Add(("{0}={1}" -f $key, [uri]::EscapeDataString([string]$Params[$key])))
    }
    $pairs.Add("timestamp=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())")

    $unsigned = [string]::Join("&", $pairs)
    $signature = Get-Signature -Secret $ApiSecret -Message $unsigned

    $headers = @{
        "X-MBX-APIKEY" = $ApiKey
    }

    $uri = "{0}{1}?{2}&signature={3}" -f $BaseUrl, $Path, $unsigned, $signature
    return Invoke-RestMethod -Uri $uri -Headers $headers -Method Get
}

function Get-PublicJson {
    param(
        [string]$Path
    )

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

$account = Get-SignedJson -Path "/api/v3/account" -Params @{
    omitZeroBalances = "true"
    recvWindow = "5000"
}

$tickers = Get-PublicJson -Path "/api/v3/ticker/price"
$priceMap = @{}
foreach ($ticker in $tickers) {
    $priceMap[$ticker.symbol] = [double]$ticker.price
}

$rows = @()
$unresolved = @()
[double]$totalUsdt = 0

foreach ($balance in $account.balances) {
    $qty = [double]$balance.free + [double]$balance.locked
    $value = Resolve-AssetValueUsdt -Asset $balance.asset -Qty $qty -PriceMap $priceMap
    if ($null -eq $value) {
        $unresolved += [pscustomobject]@{
            Asset = $balance.asset
            Qty = $qty
        }
        continue
    }

    $totalUsdt += $value
    $rows += [pscustomobject]@{
        Asset = $balance.asset
        Qty = $qty
        Value = $value
    }
}

$rows = $rows | Sort-Object Value -Descending

Write-Output ("Total Spot Asset ~= {0:N2} USDT" -f $totalUsdt)
Write-Output "------------------------------------------------------------"
foreach ($row in $rows) {
    Write-Output ("{0,-10} qty={1,18:N8}  value={2,12:N2} USDT" -f $row.Asset, $row.Qty, $row.Value)
}

if ($unresolved.Count -gt 0) {
    Write-Output ""
    Write-Output "Unresolved assets:"
    foreach ($item in $unresolved) {
        Write-Output ("{0}: {1}" -f $item.Asset, $item.Qty)
    }
}
