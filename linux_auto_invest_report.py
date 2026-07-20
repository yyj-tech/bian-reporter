#!/usr/bin/env python3
import datetime as dt
import email.message
import email.utils
import html
import hashlib
import hmac
import json
import os
import smtplib
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
ENV_FILE = ROOT / ".env.local"
REPORT_DIR = ROOT / "research-auto-invest-cost"
HISTORY_PATH = REPORT_DIR / "auto_invest_history_2026.json"
REPORT_PATH = REPORT_DIR / "auto_invest_enriched_report_2026.md"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="ascii").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value)


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def required_env(name: str) -> str:
    value = env(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def request_json(url: str, headers: dict[str, str] | None = None) -> object:
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = response.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {url}: {body}") from exc


def signed_query(base_url: str, api_key: str, api_secret: str, path: str, params: dict[str, object]) -> object:
    payload = {k: v for k, v in params.items() if v is not None and str(v) != ""}
    payload["timestamp"] = int(time.time() * 1000)
    query = urllib.parse.urlencode(payload)
    signature = hmac.new(api_secret.encode("utf-8"), query.encode("utf-8"), hashlib.sha256).hexdigest()
    url = f"{base_url}{path}?{query}&signature={signature}"
    return request_json(url, headers={"X-MBX-APIKEY": api_key})


def public_query(base_url: str, path: str) -> object:
    return request_json(f"{base_url}{path}")


def millis(value: dt.datetime) -> int:
    return int(value.timestamp() * 1000)


def fetch_auto_invest_history(base_url: str, api_key: str, api_secret: str, start_date: str, plan_types: list[str]) -> dict:
    start = dt.datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
    end = dt.datetime.now(dt.timezone.utc)
    results = []

    for plan_type in plan_types:
        items = []
        errors = []
        window_start = start
        while window_start < end:
            window_end = min(window_start + dt.timedelta(days=30) - dt.timedelta(milliseconds=1), end)
            current = 1
            while True:
                print(
                    "Querying Auto-Invest history: "
                    f"planType={plan_type}, window={window_start.date()}..{window_end.date()}, page={current}",
                    flush=True,
                )
                try:
                    data = signed_query(
                        base_url,
                        api_key,
                        api_secret,
                        "/sapi/v1/lending/auto-invest/history/list",
                        {
                            "startTime": millis(window_start),
                            "endTime": millis(window_end),
                            "current": current,
                            "size": 100,
                            "planType": plan_type,
                            "recvWindow": 5000,
                        },
                    )
                    page_items = data.get("list") or []
                    items.extend(page_items)
                    if len(page_items) < 100:
                        break
                    current += 1
                except Exception as exc:
                    errors.append(
                        {
                            "windowStart": str(window_start.date()),
                            "windowEnd": str(window_end.date()),
                            "page": current,
                            "error": str(exc),
                        }
                    )
                    break
            window_start = window_end + dt.timedelta(milliseconds=1)

        results.append({"planType": plan_type, "ok": not errors, "error": errors or None, "data": {"total": len(items), "list": items}})

    sample = {
        "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "startDate": start.date().isoformat(),
        "endDate": end.date().isoformat(),
        "targetAsset": "",
        "results": results,
    }
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(json.dumps(sample, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Auto-Invest history sample written to {HISTORY_PATH}")

    failures = [result for result in results if not result["ok"]]
    if failures:
        details = []
        for result in failures:
            for err in result["error"] or []:
                details.append(
                    f"planType={result['planType']}, window={err['windowStart']}..{err['windowEnd']}, "
                    f"page={err['page']}: {err['error']}"
                )
        raise RuntimeError("Auto-Invest history query failed. " + " | ".join(details))

    return sample


def price_map(base_url: str) -> dict[str, float]:
    return {item["symbol"]: float(item["price"]) for item in public_query(base_url, "/api/v3/ticker/price")}


def asset_price_usdt(asset: str, prices: dict[str, float]) -> float | None:
    if asset in {"USDT", "FDUSD", "USDC", "BUSD"}:
        return 1.0
    for quote in ("USDT", "FDUSD"):
        symbol = f"{asset}{quote}"
        if symbol in prices:
            return prices[symbol]
    for quote in ("BTC", "ETH"):
        symbol = f"{asset}{quote}"
        bridge = f"{quote}USDT"
        if symbol in prices and bridge in prices:
            return prices[symbol] * prices[bridge]
    return None


def asset_value_usdt(asset: str, quantity: float, prices: dict[str, float]) -> float | None:
    price = asset_price_usdt(asset, prices)
    if price is None:
        return None
    return quantity * price


def fetch_positions(base_url: str, api_key: str, api_secret: str, prices: dict[str, float]) -> tuple[list[dict], float, float, float]:
    account = signed_query(base_url, api_key, api_secret, "/api/v3/account", {"omitZeroBalances": "true", "recvWindow": 5000})

    rows = []
    spot_total = 0.0
    for balance in account.get("balances", []):
        qty = float(balance.get("free", 0)) + float(balance.get("locked", 0))
        value = asset_value_usdt(balance["asset"], qty, prices)
        if value is None:
            continue
        spot_total += value
        rows.append({"Category": "现货", "Asset": balance["asset"], "Quantity": qty, "ValueUsdt": value})

    flexible_total = 0.0
    locked_total = 0.0
    for path, category, qty_field, total_name in (
        ("/sapi/v1/simple-earn/flexible/position", "Simple Earn 活期", "totalAmount", "flexible"),
        ("/sapi/v1/simple-earn/locked/position", "Simple Earn 定期", "amount", "locked"),
    ):
        current = 1
        while True:
            page = signed_query(base_url, api_key, api_secret, path, {"current": current, "size": 100, "recvWindow": 5000})
            page_rows = page.get("rows") or []
            for item in page_rows:
                asset = item["asset"]
                qty = float(item.get(qty_field, 0))
                value = asset_value_usdt(asset, qty, prices)
                if value is None:
                    continue
                if total_name == "flexible":
                    flexible_total += value
                else:
                    locked_total += value
                rows.append({"Category": category, "Asset": asset, "Quantity": qty, "ValueUsdt": value})
            if len(page_rows) < 100:
                break
            current += 1

    rows.sort(key=lambda row: row["ValueUsdt"], reverse=True)
    return rows, spot_total, flexible_total, locked_total


def build_report(sample: dict, positions: list[dict], spot_total: float, flexible_total: float, locked_total: float, prices: dict[str, float]) -> str:
    records = []
    for result in sample["results"]:
        for item in (result.get("data") or {}).get("list") or []:
            if item.get("transactionStatus") != "SUCCESS" or item.get("sourceAsset") != "USDT":
                continue
            fee = 0.0
            if item.get("transactionFee") and item.get("transactionFeeUnit") == "USDT":
                fee = float(item["transactionFee"])
            records.append(
                {
                    "Asset": item["targetAsset"],
                    "CostUsdt": float(item["sourceAssetAmount"]) + fee,
                    "Quantity": float(item["targetAssetAmount"]),
                }
            )

    grouped: dict[str, dict] = {}
    for record in records:
        row = grouped.setdefault(record["Asset"], {"Asset": record["Asset"], "Count": 0, "TotalCostUsdt": 0.0, "TotalQuantity": 0.0})
        row["Count"] += 1
        row["TotalCostUsdt"] += record["CostUsdt"]
        row["TotalQuantity"] += record["Quantity"]

    summary = []
    for row in grouped.values():
        price = asset_price_usdt(row["Asset"], prices)
        current_value = row["TotalQuantity"] * price if price is not None else None
        pnl = current_value - row["TotalCostUsdt"] if current_value is not None else None
        pnl_rate = pnl / row["TotalCostUsdt"] * 100 if pnl is not None and row["TotalCostUsdt"] > 0 else None
        row.update(
            {
                "AvgCostUsdt": row["TotalCostUsdt"] / row["TotalQuantity"] if row["TotalQuantity"] else 0.0,
                "CurrentPriceUsdt": price,
                "CurrentValueUsdt": current_value,
                "PnlUsdt": pnl,
                "PnlRate": pnl_rate,
            }
        )
        summary.append(row)
    summary.sort(key=lambda row: row["TotalCostUsdt"], reverse=True)

    total_holding = spot_total + flexible_total + locked_total
    total_cost = sum(row["TotalCostUsdt"] for row in summary)
    total_value = sum(row["CurrentValueUsdt"] or 0 for row in summary)
    total_pnl = total_value - total_cost
    total_pnl_rate = total_pnl / total_cost * 100 if total_cost else 0.0
    now = dt.datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S %z")

    lines = [
        "# Auto-Invest 定投成本和盈亏报表",
        "",
        f"- 生成时间：{now}",
        f"- 历史窗口：{sample['startDate']} .. {sample['endDate']}",
        f"- 成功定投记录：{len(records)}",
        f"- 账户总仓位价值：{total_holding:,.2f} USDT",
        f"  - 现货：{spot_total:,.2f} USDT",
        f"  - Simple Earn 活期：{flexible_total:,.2f} USDT",
        f"  - Simple Earn 定期：{locked_total:,.2f} USDT",
        f"- 累计投入：{total_cost:,.2f} USDT",
        f"- 当前市值：{total_value:,.2f} USDT",
        f"- 浮动盈亏：{total_pnl:,.2f} USDT（{total_pnl_rate:,.2f}%）",
        "",
        "## 按资产汇总",
        "",
        "| 资产 | 笔数 | 累计投入（USDT） | 累计买入数量 | 平均成本价 | 当前价 | 当前市值（USDT） | 浮动盈亏（USDT） | 盈亏比例 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in summary:
        lines.append(
            f"| {row['Asset']} | {row['Count']} | {row['TotalCostUsdt']:,.2f} | {row['TotalQuantity']:,.8f} | "
            f"{row['AvgCostUsdt']:,.8f} | {row['CurrentPriceUsdt']:,.8f} | {row['CurrentValueUsdt']:,.2f} | "
            f"{row['PnlUsdt']:,.2f} | {row['PnlRate']:,.2f}% |"
        )

    lines += [
        "",
        "## 当前仓位明细",
        "",
        "| 类别 | 资产 | 数量 | 当前价值（USDT） |",
        "|---|---:|---:|---:|",
    ]
    for row in positions:
        lines.append(f"| {row['Category']} | {row['Asset']} | {row['Quantity']:,.8f} | {row['ValueUsdt']:,.2f} |")

    lines += [
        "",
        "## 口径说明",
        "",
        "- 成本价 = 累计投入 USDT / 累计买入数量。",
        "- 当前价使用 Binance 公开 ticker 行情，统一折算为 USDT。",
        "- 浮动盈亏基于定投买入数量计算，不把 Simple Earn 利息增量纳入本次成本。",
        "- 账户总仓位价值 = 现货 + Simple Earn 活期 + Simple Earn 定期，使用当前 ticker 折算为 USDT。",
    ]
    REPORT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Enriched report written to {REPORT_PATH}")
    return "\n".join(lines)


def send_email(subject: str, body: str) -> None:
    sender = required_env("REPORT_SMTP_FROM")
    recipients = [part.strip() for part in required_env("REPORT_SMTP_TO").replace(";", ",").split(",") if part.strip()]
    password = required_env("REPORT_SMTP_PASSWORD")
    server = env("REPORT_SMTP_SERVER", "smtp.163.com")
    port = int(env("REPORT_SMTP_PORT", "25"))
    enable_ssl = env("REPORT_SMTP_ENABLE_SSL", "true").lower() in {"1", "true", "yes"}

    message = email.message.EmailMessage()
    message["From"] = sender
    message["To"] = ", ".join(recipients)
    message["Date"] = email.utils.formatdate(localtime=True)
    message["Subject"] = subject
    message.set_content(body, subtype="plain", charset="utf-8")
    message.add_alternative(markdown_to_html(body), subtype="html", charset="utf-8")
    message.add_attachment(REPORT_PATH.read_bytes(), maintype="text", subtype="markdown", filename=REPORT_PATH.name)

    if enable_ssl and port == 465:
        with smtplib.SMTP_SSL(server, port, timeout=30, context=ssl.create_default_context()) as smtp:
            smtp.login(sender, password)
            smtp.send_message(message)
    else:
        with smtplib.SMTP(server, port, timeout=30) as smtp:
            smtp.ehlo()
            if enable_ssl:
                smtp.starttls(context=ssl.create_default_context())
                smtp.ehlo()
            smtp.login(sender, password)
            smtp.send_message(message)
    print(f"Email sent to {', '.join(recipients)}.")


def markdown_to_html(markdown: str) -> str:
    lines = markdown.splitlines()
    output = [
        "<!doctype html>",
        "<html>",
        "<head>",
        '<meta charset="utf-8">',
        "<style>",
        "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,'Microsoft YaHei',sans-serif;color:#111827;line-height:1.55;margin:0;padding:24px;background:#f8fafc;}",
        ".wrap{max-width:1080px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;}",
        "h1{font-size:24px;margin:0 0 18px;color:#0f172a;}",
        "h2{font-size:18px;margin:28px 0 12px;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:6px;}",
        "p{margin:8px 0;}",
        "ul{margin:8px 0 16px 22px;padding:0;}",
        "li{margin:4px 0;}",
        "table{border-collapse:collapse;width:100%;margin:12px 0 22px;font-size:13px;}",
        "th,td{border:1px solid #d1d5db;padding:8px 10px;text-align:right;white-space:nowrap;}",
        "th:first-child,td:first-child{text-align:left;}",
        "th{background:#f3f4f6;color:#111827;font-weight:600;}",
        "tr:nth-child(even) td{background:#fafafa;}",
        ".muted{color:#6b7280;font-size:12px;margin-top:24px;}",
        "</style>",
        "</head>",
        '<body><div class="wrap">',
    ]
    in_list = False
    in_table = False
    table_header_written = False

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            output.append("</ul>")
            in_list = False

    def close_table() -> None:
        nonlocal in_table, table_header_written
        if in_table:
            output.append("</tbody></table>")
            in_table = False
            table_header_written = False

    for line in lines:
        stripped = line.strip()
        if not stripped:
            close_list()
            close_table()
            continue

        if stripped.startswith("|") and stripped.endswith("|"):
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if all(cell.replace(":", "").replace("-", "") == "" and "-" in cell for cell in cells):
                continue
            close_list()
            escaped = [html.escape(cell) for cell in cells]
            if not in_table:
                output.append("<table><thead><tr>" + "".join(f"<th>{cell}</th>" for cell in escaped) + "</tr></thead><tbody>")
                in_table = True
                table_header_written = True
            elif table_header_written:
                output.append("<tr>" + "".join(f"<td>{cell}</td>" for cell in escaped) + "</tr>")
            continue

        close_table()
        if stripped.startswith("# "):
            close_list()
            output.append(f"<h1>{html.escape(stripped[2:])}</h1>")
        elif stripped.startswith("## "):
            close_list()
            output.append(f"<h2>{html.escape(stripped[3:])}</h2>")
        elif stripped.startswith("- "):
            if not in_list:
                output.append("<ul>")
                in_list = True
            output.append(f"<li>{html.escape(stripped[2:])}</li>")
        else:
            close_list()
            output.append(f"<p>{html.escape(stripped)}</p>")

    close_list()
    close_table()
    output.append('<p class="muted">Markdown report is attached for archival use.</p>')
    output.append("</div></body></html>")
    return "\n".join(output)


def main() -> int:
    load_env_file(ENV_FILE)
    base_url = env("BINANCE_BASE_URL", "https://api.binance.com").rstrip("/")
    api_key = required_env("BINANCE_API_KEY")
    api_secret = required_env("BINANCE_API_SECRET")
    start_date = env("AUTO_INVEST_START_DATE", "2026-01-01")
    plan_types = [part.strip() for part in env("AUTO_INVEST_PLAN_TYPES", "PORTFOLIO").split(",") if part.strip()]

    sample = fetch_auto_invest_history(base_url, api_key, api_secret, start_date, plan_types)
    prices = price_map(base_url)
    positions, spot_total, flexible_total, locked_total = fetch_positions(base_url, api_key, api_secret, prices)
    body = build_report(sample, positions, spot_total, flexible_total, locked_total, prices)
    subject = env("REPORT_EMAIL_SUBJECT") or f"币安定投成本和总仓位报表 {dt.datetime.now(ZoneInfo('Asia/Shanghai')).date()}"
    send_email(subject, body)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise
