# GitHub Actions 定时报告配置

这个仓库已添加 GitHub Actions workflow：

```text
.github/workflows/daily-binance-auto-invest-report.yml
```

默认行为：

- 每天北京时间 10:00 运行 Auto-Invest 定投成本报告。
- 可在 GitHub Actions 页面手动运行，并选择发送 `auto_invest` 或 `asset_total`。
- 运行结果和日志会作为 workflow artifact 上传。

## 需要配置的 GitHub Secrets

进入 GitHub 仓库：

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

添加这些必填 Secrets：

```text
BINANCE_API_KEY
BINANCE_API_SECRET
REPORT_SMTP_FROM
REPORT_SMTP_TO
REPORT_SMTP_PASSWORD
```

可选 Secrets：

```text
REPORT_SMTP_SERVER
REPORT_SMTP_PORT
REPORT_SMTP_ENABLE_SSL
```

如果不配置可选项，默认使用：

```text
REPORT_SMTP_SERVER=smtp.163.com
REPORT_SMTP_PORT=25
REPORT_SMTP_ENABLE_SSL=True
```

注意：云环境可能无法稳定使用 SMTP 25 端口。如果发送失败，优先尝试邮箱服务商支持的 TLS/SSL 端口，并把 `REPORT_SMTP_PORT` 和 `REPORT_SMTP_ENABLE_SSL` 放到 Secrets 里覆盖。

## Binance API 注意事项

- API Key 只给读取权限，不要给交易和提现权限。
- 如果 Binance API Key 开了 IP 白名单，GitHub-hosted runner 的出口 IP 不固定，可能会调用失败。需要关闭白名单、改用自托管 runner，或迁到有固定出口 IP 的云服务器/云函数。

## 第一次验证

1. 把本目录推到 GitHub 仓库。
2. 在 GitHub 添加上面的 Secrets。
3. 打开 `Actions -> Daily Binance Auto-Invest Report`。
4. 点击 `Run workflow`，先选择 `auto_invest` 手动跑一次。
5. 邮件收到后，本机的 Windows 计划任务就可以停用或删除。

## 不要提交本地报告数据

`.gitignore` 已排除 `.env.local`、日志、历史 JSON 和本地生成的 Markdown 报告。首次推送到 GitHub 前，请确认不要把本地资产数据提交到仓库，尤其是公开仓库。
