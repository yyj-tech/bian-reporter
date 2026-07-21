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
HTML_REPORT_PATH = REPORT_DIR / "auto_invest_enriched_report_2026.html"
LAST_REPORT_CONTEXT: dict[str, object] = {}


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


def fetch_usd_cny_rate() -> tuple[float | None, str]:
    configured = env("USD_CNY_RATE")
    if configured:
        return float(configured), "USD_CNY_RATE"
    try:
        data = request_json("https://open.er-api.com/v6/latest/USD")
        rate = (data.get("rates") or {}).get("CNY")
        if rate:
            return float(rate), "open.er-api.com"
    except Exception as exc:
        print(f"USD/CNY rate lookup failed: {exc}", file=sys.stderr)
    return None, "unavailable"


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


def build_report(
    sample: dict,
    positions: list[dict],
    spot_total: float,
    flexible_total: float,
    locked_total: float,
    prices: dict[str, float],
    usd_cny_rate: float | None,
    usd_cny_source: str,
) -> str:
    global LAST_REPORT_CONTEXT
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
    cny_note = f"按 1 USDT ≈ ¥{usd_cny_rate:,.4f} 折算，汇率来源：{usd_cny_source}" if usd_cny_rate else "人民币折算不可用：未获取到 USD/CNY 汇率"

    def cny(value: float | None) -> str:
        if value is None or usd_cny_rate is None:
            return "-"
        return f"¥{value * usd_cny_rate:,.2f}"

    LAST_REPORT_CONTEXT = {
        "generated_at": now,
        "start_date": sample["startDate"],
        "end_date": sample["endDate"],
        "record_count": len(records),
        "total_holding": total_holding,
        "spot_total": spot_total,
        "flexible_total": flexible_total,
        "locked_total": locked_total,
        "total_cost": total_cost,
        "total_value": total_value,
        "total_pnl": total_pnl,
        "total_pnl_rate": total_pnl_rate,
        "usd_cny_rate": usd_cny_rate,
        "usd_cny_source": usd_cny_source,
        "summary": summary,
        "positions": positions,
    }

    lines = [
        "# 币安资产日报",
        "",
        "## 当前总资产",
        "",
        "| 指标 | USDT | 人民币估算 |",
        "|---|---:|---:|",
        f"| 账户总资产 | {total_holding:,.2f} | {cny(total_holding)} |",
        f"| Simple Earn 活期 | {flexible_total:,.2f} | {cny(flexible_total)} |",
        f"| 现货 | {spot_total:,.2f} | {cny(spot_total)} |",
        f"| Simple Earn 定期 | {locked_total:,.2f} | {cny(locked_total)} |",
        "",
        "## 定投盈亏",
        "",
        "| 指标 | USDT | 人民币估算 |",
        "|---|---:|---:|",
        f"| 累计投入 | {total_cost:,.2f} | {cny(total_cost)} |",
        f"| 当前市值 | {total_value:,.2f} | {cny(total_value)} |",
        f"| 浮动盈亏 | {total_pnl:,.2f}（{total_pnl_rate:,.2f}%） | {cny(total_pnl)} |",
        "",
        "## 本次统计",
        "",
        "| 项目 | 值 |",
        "|---|---:|",
        f"| 生成时间 | {now} |",
        f"| 历史窗口 | {sample['startDate']} .. {sample['endDate']} |",
        f"| 成功定投记录 | {len(records)} |",
        f"| 人民币折算 | {cny_note} |",
        "",
        "## 按资产汇总",
        "",
        "| 资产 | 笔数 | 累计投入 | 当前市值 | 浮动盈亏 | 盈亏比例 | 平均成本 | 当前价 | 累计买入数量 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in summary:
        lines.append(
            f"| {row['Asset']} | {row['Count']} | {row['TotalCostUsdt']:,.2f} | {row['CurrentValueUsdt']:,.2f} | "
            f"{row['PnlUsdt']:,.2f} | {row['PnlRate']:,.2f}% | {row['AvgCostUsdt']:,.8f} | "
            f"{row['CurrentPriceUsdt']:,.8f} | {row['TotalQuantity']:,.8f} |"
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
        "- 人民币金额按 USDT 近似 USD 后乘以 USD/CNY 汇率估算，仅用于快速阅读，不作为结算价格。",
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
    html_body = report_to_html(LAST_REPORT_CONTEXT)
    HTML_REPORT_PATH.write_text(html_body, encoding="utf-8")
    message.add_alternative(html_body, subtype="html", charset="utf-8")
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


def report_to_html(context: dict[str, object] | None = None) -> str:
    context = context or {}
    total_holding = float(context.get("total_holding") or 0)
    total_cost = float(context.get("total_cost") or 0)
    total_value = float(context.get("total_value") or 0)
    total_pnl = float(context.get("total_pnl") or 0)
    total_pnl_rate = float(context.get("total_pnl_rate") or 0)
    spot_total = float(context.get("spot_total") or 0)
    flexible_total = float(context.get("flexible_total") or 0)
    locked_total = float(context.get("locked_total") or 0)
    usd_cny_rate = context.get("usd_cny_rate")
    usd_cny_source = str(context.get("usd_cny_source") or "unavailable")
    generated_at = str(context.get("generated_at") or "")
    record_count = int(context.get("record_count") or 0)
    window_text = f"{context.get('start_date') or ''} .. {context.get('end_date') or ''}"
    summary = context.get("summary") or []
    positions = context.get("positions") or []

    def money_usdt(value: float) -> str:
        return f"{value:,.2f} USDT"

    def money_cny(value: float) -> str:
        if not usd_cny_rate:
            return "暂不可用"
        converted = value * float(usd_cny_rate)
        sign = "-" if converted < 0 else ""
        return f"{sign}¥{abs(converted):,.2f}"

    def optional_number(value: object, digits: int = 2) -> str:
        if value is None:
            return "-"
        return f"{float(value):,.{digits}f}"

    def pnl_text(value: float) -> str:
        sign = "+" if value > 0 else ""
        return f"{sign}{value:,.2f} USDT"

    def percentage(value: float) -> str:
        sign = "+" if value > 0 else ""
        return f"{sign}{value:,.2f}%"

    def escaped(value: object) -> str:
        return html.escape(str(value))

    pnl_class = "positive" if total_pnl >= 0 else "negative"
    pnl_color = "#047857" if total_pnl >= 0 else "#b91c1c"
    asset_cards = []
    for row in summary:
        row_pnl = float(row.get("PnlUsdt") or 0)
        row_rate = float(row.get("PnlRate") or 0)
        row_color = "#047857" if row_pnl >= 0 else "#b91c1c"
        asset_cards.append(
            '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" '
            'style="width:100%;margin:0 0 10px;border:1px solid #e5e7eb;border-radius:6px;background:#ffffff">'
            '<tr>'
            f'<td style="padding:12px 14px 8px;font-size:16px;font-weight:700;color:#0f172a">{escaped(row.get("Asset") or "-")}</td>'
            f'<td align="right" style="padding:12px 14px 8px;font-size:14px;font-weight:700;color:{row_color}">'
            f'{escaped(pnl_text(row_pnl))} · {escaped(percentage(row_rate))}</td>'
            '</tr><tr><td colspan="2" style="padding:0 14px 12px">'
            '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>'
            f'<td width="40%" valign="top" style="padding-right:8px"><div style="font-size:11px;color:#64748b">累计投入</div><div style="font-size:14px;color:#111827">{optional_number(row.get("TotalCostUsdt"))} USDT</div></td>'
            f'<td width="40%" valign="top" style="padding-right:8px"><div style="font-size:11px;color:#64748b">当前市值</div><div style="font-size:14px;color:#111827">{optional_number(row.get("CurrentValueUsdt"))} USDT</div></td>'
            f'<td width="20%" valign="top"><div style="font-size:11px;color:#64748b">定投</div><div style="font-size:14px;color:#111827">{escaped(row.get("Count") or 0)} 笔</div></td>'
            '</tr></table></td></tr></table>'
        )

    position_cards = []
    for row in positions:
        position_cards.append(
            '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" '
            'style="width:100%;margin:0 0 10px;border:1px solid #e5e7eb;border-radius:6px;background:#ffffff">'
            '<tr>'
            f'<td style="padding:11px 14px 4px;font-size:15px;font-weight:700;color:#0f172a">{escaped(row.get("Asset") or "-")}</td>'
            f'<td align="right" style="padding:11px 14px 4px;font-size:12px;color:#64748b">{escaped(row.get("Category") or "-")}</td>'
            '</tr><tr>'
            f'<td style="padding:2px 14px 11px;font-size:12px;color:#64748b">数量&nbsp; {optional_number(row.get("Quantity"), 8)}</td>'
            f'<td align="right" style="padding:2px 14px 11px;font-size:14px;font-weight:700;color:#111827">{optional_number(row.get("ValueUsdt"))} USDT</td>'
            '</tr></table>'
        )

    rate_note = "人民币估算暂不可用"
    if usd_cny_rate:
        rate_note = f"人民币估算按 1 USDT ≈ ¥{float(usd_cny_rate):,.4f} 折算，来源：{usd_cny_source}"

    output = [
        "<!doctype html>",
        '<html lang="zh-CN">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        "<style>",
        "*{box-sizing:border-box}",
        "body{margin:0;padding:24px;background:#eef2f7;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,'Microsoft YaHei',sans-serif;line-height:1.55;letter-spacing:0}",
        ".wrap{width:100%;max-width:760px;margin:0 auto;background:#fff;border:1px solid #dbe3ef;border-radius:8px;overflow:hidden}",
        ".hero{background:#0f172a;color:#fff;padding:28px 32px}",
        ".eyebrow{margin:0 0 8px;color:#cbd5e1;font-size:13px}",
        ".total{margin:0;font-size:42px;line-height:1.1;font-weight:760}",
        ".cny{margin-top:8px;color:#dbeafe;font-size:22px}",
        ".meta{margin-top:18px;color:#cbd5e1;font-size:12px}",
        ".meta span{display:inline-block;margin:0 16px 4px 0}",
        ".content{padding:24px 32px 32px}",
        ".cards{width:100%;border-collapse:separate;border-spacing:6px;margin:0 -6px 24px}",
        ".card{width:50%;vertical-align:top;border:1px solid #e5e7eb;border-radius:8px;background:#fbfdff;padding:14px 16px}",
        ".label{font-size:12px;color:#64748b;margin-bottom:6px}",
        ".value{font-size:18px;line-height:1.3;font-weight:720;color:#0f172a;word-break:break-word}",
        ".sub{font-size:12px;color:#64748b;margin-top:3px;word-break:break-word}",
        ".positive{color:#047857!important}.negative{color:#b91c1c!important}",
        "h2{font-size:17px;line-height:1.4;margin:26px 0 12px;color:#111827}",
        ".data{width:100%;border-collapse:collapse;font-size:13px}",
        ".data th,.data td{border-bottom:1px solid #e5e7eb;padding:10px 12px;text-align:right}",
        ".data th{background:#f8fafc;color:#64748b;font-size:12px;font-weight:700}",
        ".data .left{text-align:left}.data .strong{font-weight:700;color:#0f172a}",
        ".foot{margin:26px 0 0;color:#64748b;font-size:12px}",
        "@media(max-width:680px){body{padding:0!important}.wrap{border:0!important;border-radius:0!important}.hero{padding:22px 18px!important}.total{font-size:32px!important}.cny{font-size:18px!important}.content{padding:16px 12px 24px!important}.card{padding:11px 10px!important}.value{font-size:16px!important}.data th,.data td{padding:8px 6px!important;font-size:12px!important}}",
        "</style>",
        "</head>",
        '<body style="margin:0;padding:24px;background:#eef2f7;color:#111827;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,Microsoft YaHei,sans-serif;line-height:1.55">',
        '<main class="wrap" style="width:100%;max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #dbe3ef;border-radius:8px;overflow:hidden">',
        '<section class="hero" style="background:#0f172a;color:#ffffff;padding:28px 32px">',
        '<p class="eyebrow">当前账户总资产</p>',
        f'<h1 class="total" style="margin:0;font-size:40px;line-height:1.1;font-weight:760;color:#ffffff">{escaped(f"{total_holding:,.2f}")} <span style="font-size:18px;font-weight:600">USDT</span></h1>',
        f'<div class="cny">约 {escaped(money_cny(total_holding))}</div>',
        '<div class="meta">',
        f'<span>生成时间：{escaped(generated_at)}</span>',
        f'<span>历史窗口：{escaped(window_text)}</span>',
        f'<span>成功定投：{record_count} 笔</span>',
        "</div>",
        "</section>",
        '<section class="content" style="padding:24px 32px 32px">',
        '<table role="presentation" class="cards" width="100%" cellspacing="6" cellpadding="0" style="width:100%;margin:0 0 22px"><tr>',
        f'<td class="card" width="50%" valign="top" style="width:50%;padding:14px 16px;border:1px solid #e5e7eb;border-radius:8px;background:#fbfdff"><div class="label" style="font-size:12px;color:#64748b;margin-bottom:6px">Simple Earn 活期</div><div class="value" style="font-size:18px;line-height:1.3;font-weight:700;color:#0f172a">{escaped(money_usdt(flexible_total))}</div><div class="sub" style="font-size:12px;color:#64748b;margin-top:3px">{escaped(money_cny(flexible_total))}</div></td>',
        f'<td class="card" width="50%" valign="top" style="width:50%;padding:14px 16px;border:1px solid #e5e7eb;border-radius:8px;background:#fbfdff"><div class="label" style="font-size:12px;color:#64748b;margin-bottom:6px">累计投入</div><div class="value" style="font-size:18px;line-height:1.3;font-weight:700;color:#0f172a">{escaped(money_usdt(total_cost))}</div><div class="sub" style="font-size:12px;color:#64748b;margin-top:3px">{escaped(money_cny(total_cost))}</div></td>',
        '</tr><tr>',
        f'<td class="card" width="50%" valign="top" style="width:50%;padding:14px 16px;border:1px solid #e5e7eb;border-radius:8px;background:#fbfdff"><div class="label" style="font-size:12px;color:#64748b;margin-bottom:6px">定投当前市值</div><div class="value" style="font-size:18px;line-height:1.3;font-weight:700;color:#0f172a">{escaped(money_usdt(total_value))}</div><div class="sub" style="font-size:12px;color:#64748b;margin-top:3px">{escaped(money_cny(total_value))}</div></td>',
        f'<td class="card" width="50%" valign="top" style="width:50%;padding:14px 16px;border:1px solid #e5e7eb;border-radius:8px;background:#fbfdff"><div class="label" style="font-size:12px;color:#64748b;margin-bottom:6px">浮动盈亏</div><div class="value {pnl_class}" style="font-size:18px;line-height:1.3;font-weight:700;color:{pnl_color}">{escaped(pnl_text(total_pnl))}</div><div class="sub {pnl_class}" style="font-size:12px;color:{pnl_color};margin-top:3px">{escaped(percentage(total_pnl_rate))} / {escaped(money_cny(total_pnl))}</div></td>',
        "</tr></table>",
        "<h2>资产分布</h2>",
        '<table class="data" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th class="left" style="padding:9px 8px;text-align:left;background:#f8fafc;color:#64748b">位置</th><th style="padding:9px 8px;text-align:right;background:#f8fafc;color:#64748b">USDT</th><th style="padding:9px 8px;text-align:right;background:#f8fafc;color:#64748b">人民币估算</th></tr></thead><tbody>',
        f'<tr><td class="left strong">Simple Earn 活期</td><td>{optional_number(flexible_total)}</td><td>{escaped(money_cny(flexible_total))}</td></tr>',
        f'<tr><td class="left strong">现货</td><td>{optional_number(spot_total)}</td><td>{escaped(money_cny(spot_total))}</td></tr>',
        f'<tr><td class="left strong">Simple Earn 定期</td><td>{optional_number(locked_total)}</td><td>{escaped(money_cny(locked_total))}</td></tr>',
        "</tbody></table>",
        "<h2>按资产汇总</h2>",
        *asset_cards,
        "<h2>当前仓位明细</h2>",
        *position_cards,
        f'<p class="foot">{escaped(rate_note)}。详细计算口径和完整字段见随信附上的 Markdown 报表。</p>',
        "</section></main></body></html>",
    ]
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
    usd_cny_rate, usd_cny_source = fetch_usd_cny_rate()
    positions, spot_total, flexible_total, locked_total = fetch_positions(base_url, api_key, api_secret, prices)
    body = build_report(sample, positions, spot_total, flexible_total, locked_total, prices, usd_cny_rate, usd_cny_source)
    subject = env("REPORT_EMAIL_SUBJECT") or f"币安定投成本和总仓位报表 {dt.datetime.now(ZoneInfo('Asia/Shanghai')).date()}"
    send_email(subject, body)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise
