# Binance Auto-Invest 成本价调研

目标：确认币安 Auto-Invest 每日定投是否能通过 API 查询到历史买入记录，并据此计算每个资产的平均成本价。

## 初步结论

可以尝试查询 Auto-Invest 历史接口：

```text
GET /sapi/v1/lending/auto-invest/history/list
```

该接口用于查询定投计划的 subscription transaction history，常见参数包括：

- `planId`
- `startTime`
- `endTime`
- `targetAsset`
- `planType`
- `current`
- `size`
- `recvWindow`

公开文档/SDK 信息显示它是 USER_DATA 签名接口，并且查询窗口通常需要按 30 天拆分。

## 计算思路

如果接口返回字段中包含每次定投的：

- 目标资产，例如 BTC、ETH、BNB
- 买入数量
- 投入资产，例如 USDT
- 投入金额
- 交易状态/成功状态
- 交易时间

就可以按资产汇总：

```text
平均成本价 = 累计投入 USDT / 累计买入数量
成本金额 = 当前持仓数量 * 平均成本价
浮动盈亏 = 当前市值 - 成本金额
盈亏比例 = 浮动盈亏 / 成本金额
```

## 需要验证的问题

1. 当前 API Key 是否有权限调用 Auto-Invest history。
2. 实际返回字段名是什么。
3. 历史记录是否包含所有每日定投，而不仅最近 30 天。
4. 是否有手续费字段，以及手续费币种是否影响实际成本。
5. Auto-Invest 买入后转入 Simple Earn 的资产，是否能和当前 Simple Earn 持仓按同一资产合并。

## 探测脚本

运行：

```powershell
Set-Location "D:\yingjian\bian\research-auto-invest-cost"
.\probe_auto_invest_history.ps1
```

脚本默认只查最近 30 天，并分别尝试 `SINGLE`、`PORTFOLIO`、`INDEX` 三种计划类型，输出到：

```text
auto_invest_history_sample.json
```

该目录是独立调研目录，不会修改上层目录现有每日邮件脚本。

如果只想查某一种计划类型：

```powershell
.\probe_auto_invest_history.ps1 -PlanType SINGLE
```

查询 2026 年以来的数据：

```powershell
.\probe_auto_invest_history.ps1 -StartDate "2026-01-01" -OutputPath ".\auto_invest_history_2026.json"
.\summarize_auto_invest_cost.ps1 -InputPath ".\auto_invest_history_2026.json" -OutputPath ".\auto_invest_cost_summary_2026.md"
```

## 汇总成本价

如果 `auto_invest_history_sample.json` 已生成，可以运行：

```powershell
.\summarize_auto_invest_cost.ps1
```

它会生成：

```text
auto_invest_cost_summary.md
```

如果要补当前行情和浮动盈亏：

```powershell
.\build_enriched_auto_invest_report.ps1 -InputPath ".\auto_invest_history_sample.json"
```

输出：

```text
auto_invest_enriched_report.md
```

## 每天 10:00 自动发送

运行入口：

```powershell
.\run_daily_auto_invest_report.ps1
```

它会按顺序执行：

1. 查询 `2026-01-01` 至今的 Auto-Invest 历史。
2. 生成 `auto_invest_enriched_report_2026.md`。
3. 调用上层目录的 `send_report_email.ps1` 发送邮件。

注册 Windows 计划任务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Register-DailyAutoInvestReportTask.ps1 -At "10:00"
```

任务名称：

```text
Daily Binance Auto Invest Cost Report Email
```

当前已确认字段：

- `sourceAssetAmount`：投入金额
- `targetAssetAmount`：买入数量
- `executionPrice`：成交价
- `transactionStatus`：可用 `SUCCESS` 过滤成功记录
- `transactionFee` / `transactionFeeUnit`：手续费
