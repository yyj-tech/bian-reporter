# 每日账户账面邮件配置

这个目录里的脚本会按下面的顺序运行：

1. `binance_asset_report.ps1` 生成 `binance_asset_report_zh.md`
2. `send_report_email.ps1` 把报告正文和 Markdown 附件发送给收件人
3. `run_daily_binance_report.ps1` 串起生成和发送，并把运行日志写到 `logs`
4. `Register-DailyBinanceReportTask.ps1` 可把每日运行注册到 Windows 计划任务

## 需要的环境变量

请用只读权限的币安 API Key，至少需要读取现货账户和 Simple Earn 持仓的权限。

可以运行交互式配置脚本：

```powershell
Set-Location "D:\yingjian\bian"
.\Configure-DailyBinanceReportEnv.ps1
```

这个脚本会同时写入当前目录的 `.env.local`，定时任务会从这个文件读取配置。`.env.local` 已加入 `.gitignore`，不要把它发给任何人。

也可以手动设置：

```powershell
[Environment]::SetEnvironmentVariable("BINANCE_API_KEY", "你的币安 API Key", "User")
[Environment]::SetEnvironmentVariable("BINANCE_API_SECRET", "你的币安 API Secret", "User")

[Environment]::SetEnvironmentVariable("REPORT_SMTP_FROM", "发件邮箱@example.com", "User")
[Environment]::SetEnvironmentVariable("REPORT_SMTP_USERNAME", "发件邮箱@example.com", "User")
[Environment]::SetEnvironmentVariable("REPORT_SMTP_PASSWORD", "邮箱 SMTP 授权码", "User")
[Environment]::SetEnvironmentVariable("REPORT_SMTP_TO", "收件人1@example.com,收件人2@example.com", "User")
```

可选 SMTP 配置：

```powershell
[Environment]::SetEnvironmentVariable("REPORT_SMTP_SERVER", "smtp.163.com", "User")
[Environment]::SetEnvironmentVariable("REPORT_SMTP_PORT", "25", "User")
[Environment]::SetEnvironmentVariable("REPORT_SMTP_ENABLE_SSL", "True", "User")
```

设置环境变量后，重新打开 PowerShell，让新环境变量生效。

## 手动测试

```powershell
Set-Location "D:\yingjian\bian"
.\run_daily_binance_report.ps1
```

如果发送失败，查看 `logs` 目录里最新的 `daily_report_*.log`。

## 注册每日定时任务

下面示例每天 08:30 发送：

```powershell
Set-Location "D:\yingjian\bian"
.\Register-DailyBinanceReportTask.ps1 -At "08:30"
```

修改时间后重新运行注册脚本即可覆盖同名任务。
