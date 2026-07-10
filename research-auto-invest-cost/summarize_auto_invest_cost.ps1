param(
    [string]$InputPath = ".\auto_invest_history_sample.json",
    [string]$OutputPath = ".\auto_invest_cost_summary.md"
)

$ErrorActionPreference = "Stop"

function T {
    param([string]$Text)

    return [Text.RegularExpressions.Regex]::Unescape($Text)
}

if (-not (Test-Path -LiteralPath $InputPath)) {
    throw "Input file not found: $InputPath"
}

$sample = Get-Content -Raw -Encoding utf8 $InputPath | ConvertFrom-Json
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
            PlanType = [string]$item.planType
            PlanName = [string]$item.planName
            Asset = [string]$item.targetAsset
            SourceUsdt = $sourceAmount
            FeeUsdt = $fee
            NetCostUsdt = $sourceAmount + $fee
            Quantity = $targetAmount
            ExecutionPrice = [double]$item.executionPrice
            Time = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$item.transactionDateTime).ToLocalTime()
        }
    }
}

$summary = $records |
    Group-Object Asset |
    ForEach-Object {
        [double]$totalCost = ($_.Group | Measure-Object NetCostUsdt -Sum).Sum
        [double]$totalQty = ($_.Group | Measure-Object Quantity -Sum).Sum
        [double]$avgCost = if ($totalQty -gt 0) { $totalCost / $totalQty } else { 0 }

        [pscustomobject]@{
            Asset = $_.Name
            Count = $_.Count
            TotalCostUsdt = $totalCost
            TotalQuantity = $totalQty
            AvgCostUsdt = $avgCost
            FirstTime = ($_.Group | Sort-Object Time | Select-Object -First 1).Time
            LastTime = ($_.Group | Sort-Object Time -Descending | Select-Object -First 1).Time
        }
    } |
    Sort-Object TotalCostUsdt -Descending

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
    (T "# Auto-Invest \u6210\u672c\u4ef7\u6c47\u603b"),
    "",
    ((T "- \u6837\u672c\u751f\u6210\u65f6\u95f4\uff1a{0}") -f $sample.generatedAt),
    ((T "- \u6837\u672c\u7a97\u53e3\uff1a{0}") -f $windowText),
    ((T "- \u6210\u529f\u8bb0\u5f55\u6570\uff1a{0}") -f $records.Count),
    (T "- \u6210\u672c\u53e3\u5f84\uff1a\u4ec5\u7edf\u8ba1 sourceAsset=USDT \u4e14 transactionStatus=SUCCESS \u7684\u5b9a\u6295\u8bb0\u5f55\uff1bUSDT \u624b\u7eed\u8d39\u8ba1\u5165\u6210\u672c\u3002"),
    "",
    (T "## \u6309\u8d44\u4ea7\u6c47\u603b"),
    "",
    (T "| \u8d44\u4ea7 | \u7b14\u6570 | \u7d2f\u8ba1\u6295\u5165\uff08USDT\uff09 | \u7d2f\u8ba1\u4e70\u5165\u6570\u91cf | \u5e73\u5747\u6210\u672c\u4ef7\uff08USDT\uff09 | \u9996\u7b14\u65f6\u95f4 | \u6700\u8fd1\u4e00\u7b14\u65f6\u95f4 |"),
    "|---|---:|---:|---:|---:|---|---|"
)

foreach ($row in $summary) {
    $lines += "| $($row.Asset) | $($row.Count) | $([string]::Format('{0:N2}', $row.TotalCostUsdt)) | $([string]::Format('{0:N8}', $row.TotalQuantity)) | $([string]::Format('{0:N8}', $row.AvgCostUsdt)) | $($row.FirstTime.ToString('yyyy-MM-dd HH:mm:ss zzz')) | $($row.LastTime.ToString('yyyy-MM-dd HH:mm:ss zzz')) |"
}

$lines += ""
$lines += (T "## \u5b57\u6bb5\u786e\u8ba4")
$lines += ""
$lines += (T "- sourceAssetAmount\uff1a\u672c\u6b21\u5b9a\u6295\u6295\u5165\u91d1\u989d\u3002\u5f53\u524d\u6837\u672c\u91cc sourceAsset \u5747\u4e3a USDT\u3002")
$lines += (T "- targetAssetAmount\uff1a\u672c\u6b21\u5b9a\u6295\u4e70\u5165\u7684\u76ee\u6807\u8d44\u4ea7\u6570\u91cf\u3002")
$lines += (T "- executionPrice\uff1a\u672c\u6b21\u6210\u4ea4\u4ef7\u683c\u3002")
$lines += (T "- transactionFee / transactionFeeUnit\uff1a\u624b\u7eed\u8d39\uff1b\u5f53\u524d\u6837\u672c\u624b\u7eed\u8d39\u4e3a 0 USDT\u3002")

Set-Content -Path $OutputPath -Value $lines -Encoding utf8
Write-Output ("Cost summary written to {0}" -f (Resolve-Path $OutputPath))
