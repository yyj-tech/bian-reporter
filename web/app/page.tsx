"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { summarizeBuys, type AssetCost, type BuyRecord } from "@/lib/cost";
import { formatCny, formatPct, formatPrice, formatQty, formatShanghaiParts, formatSignedPct, formatSignedUsdt, formatUsdt } from "@/lib/format";
import type { Holding, OverviewRow, Portfolio, Wallet } from "@/lib/portfolio";

type Tab = "overview" | "buys" | Wallet;

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "总览" },
  { id: "spot", label: "现货" },
  { id: "funding", label: "资金" },
  { id: "flexible", label: "活期" },
  { id: "locked", label: "定期" },
  { id: "buys", label: "买入记录" },
];

type ViewRow = {
  key: string;
  asset: string;
  primary: string;
  secondary: string;
  value: number | null;
  cost: AssetCost | null;
};

type ApiBody = { error?: string; buys?: BuyRecord[]; warnings?: unknown; startDate?: string } & Partial<Portfolio>;

async function readJson(response: Response): Promise<ApiBody> {
  try {
    return (await response.json()) as ApiBody;
  } catch {
    return { error: "服务器返回了无法识别的内容。" };
  }
}

function hue(asset: string): number {
  let hash = 0;
  for (const char of asset) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function BuyHistory({
  buys,
  loading,
  startDate,
  prices,
  onPickAsset,
}: {
  buys: BuyRecord[];
  loading: boolean;
  startDate: string;
  prices: Array<{ asset: string; priceUsdt: number | null }>;
  onPickAsset: (asset: string) => void;
}) {
  const priceByAsset = new Map(prices.map((row) => [row.asset, row.priceUsdt]));
  const ordered = [...buys].sort((a, b) => b.time - a.time);
  if (loading && ordered.length === 0) return <p className="empty">正在读取买入记录…</p>;
  if (ordered.length === 0) return <p className="empty">从 {startDate || "2026-01-01"} 起没有买入记录。</p>;

  let lastDate = "";
  return (
    <>
      {ordered.map((buy) => {
        const when = formatShanghaiParts(buy.time);
        const showDate = when.date !== lastDate;
        lastDate = when.date;
        const current = priceByAsset.get(buy.asset) ?? null;
        const pnl = current == null ? null : (current - buy.priceUsdt) * buy.quantity;
        const pnlClass = pnl == null ? "" : pnl > 0 ? "pnl-up" : pnl < 0 ? "pnl-down" : "";
        return (
          <div key={buy.id}>
            {showDate ? <p className="day">{when.date}</p> : null}
            <article className="buy">
              <div>
                <button className="asset-name" type="button" onClick={() => onPickAsset(buy.asset)}>
                  {buy.asset}
                  <span className="secondary"> {buy.source}</span>
                </button>
                <span className="secondary">
                  {when.time} · 买入 {formatQty(buy.quantity)} · 成交价 {formatPrice(buy.priceUsdt)}
                  {current != null ? ` · 当前价 ${formatPrice(current)}` : ""}
                </span>
              </div>
              <div className="value">
                <b>{formatUsdt(buy.costUsdt)}</b>
                {pnl != null ? <em className={pnlClass}>{formatSignedUsdt(pnl)}</em> : null}
              </div>
            </article>
          </div>
        );
      })}
    </>
  );
}

function holdingSecondary(row: Holding): string {
  const parts: string[] = [];
  if (row.free != null && row.locked != null && row.locked > 0) {
    parts.push(`可用 ${formatQty(row.free)}`);
    parts.push(`冻结 ${formatQty(row.locked)}`);
  }
  if (row.detail) parts.push(row.detail);
  return parts.join(" · ");
}

export default function Page() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [query, setQuery] = useState("");
  const [hideSmall, setHideSmall] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [buys, setBuys] = useState<BuyRecord[] | null>(null);
  const [buyWarnings, setBuyWarnings] = useState<string[]>([]);
  const [buyStart, setBuyStart] = useState("");
  const [buysLoading, setBuysLoading] = useState(false);
  const requestId = useRef(0);
  const buyRequest = useRef(0);

  const load = useCallback(async (fresh: boolean) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const response = await fetch(fresh ? "/api/balances?fresh=1" : "/api/balances", { cache: "no-store" });
      const body = await readJson(response);
      if (id !== requestId.current) return;
      if (response.status === 401) {
        setAuthed(false);
        setData(null);
        setError("");
        return;
      }
      if (!response.ok || !body.holdings || !body.totals || !body.overview) {
        setError(body.error || "读取余额失败。");
        if (response.status === 503) setAuthed(false);
        return;
      }
      setAuthed(true);
      setData(body as Portfolio);
      setError("");
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : "网络异常");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!authed || !autoRefresh) return;
    const timer = window.setInterval(() => {
      void load(false);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [authed, autoRefresh, load]);

  const assetKey = useMemo(() => (data ? data.overview.map((row) => row.asset).sort().join(",") : ""), [data]);

  const loadBuys = useCallback(async (assets: string, fresh: boolean) => {
    const id = ++buyRequest.current;
    setBuysLoading(true);
    try {
      const response = await fetch(`/api/buys?assets=${encodeURIComponent(assets)}${fresh ? "&fresh=1" : ""}`, {
        cache: "no-store",
      });
      const body = await readJson(response);
      if (id !== buyRequest.current) return;
      if (response.status === 401) {
        setAuthed(false);
        setData(null);
        setBuys(null);
        return;
      }
      if (!response.ok || !Array.isArray(body.buys)) {
        setBuyWarnings([body.error || "买入记录没读到。"]);
        return;
      }
      setBuys(body.buys);
      setBuyWarnings(Array.isArray(body.warnings) ? body.warnings.filter((item): item is string => typeof item === "string") : []);
      setBuyStart(typeof body.startDate === "string" ? body.startDate : "");
    } catch (cause) {
      if (id !== buyRequest.current) return;
      setBuyWarnings([cause instanceof Error ? cause.message : "买入记录没读到。"]);
    } finally {
      if (id === buyRequest.current) setBuysLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authed || !assetKey) return;
    void loadBuys(assetKey, false);
  }, [assetKey, authed, loadBuys]);

  async function onLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        setError(body.error || "登录失败。");
        return;
      }
      setPassword("");
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络异常");
    } finally {
      setSubmitting(false);
    }
  }

  async function onLogout() {
    await fetch("/api/session", { method: "DELETE" });
    requestId.current += 1;
    setAuthed(false);
    setData(null);
    setBuys(null);
    setBuyWarnings([]);
    setError("");
    setLoading(false);
  }

  const held = useMemo(
    () =>
      (data?.overview ?? []).map((row) => ({
        asset: row.asset,
        quantity: row.quantity,
        priceUsdt: row.quantity > 0 && row.valueUsdt != null ? row.valueUsdt / row.quantity : null,
      })),
    [data],
  );
  const cost = useMemo(() => summarizeBuys(buys ?? [], held), [buys, held]);
  const costByAsset = useMemo(() => new Map(cost.assets.map((row) => [row.asset, row])), [cost]);

  const rows = useMemo(() => {
    if (!data || tab === "buys") return [];
    const keyword = query.trim().toUpperCase();
    const source: ViewRow[] =
      tab === "overview"
        ? data.overview.map((row: OverviewRow) => ({
            key: row.asset,
            asset: row.asset,
            primary: formatQty(row.quantity),
            secondary: row.wallets.map((slice) => `${slice.label} ${formatQty(slice.quantity)}`).join(" · "),
            value: row.valueUsdt,
            cost: costByAsset.get(row.asset) ?? null,
          }))
        : data.holdings
            .filter((row) => row.wallet === tab)
            .map((row, index) => ({
              key: `${row.wallet}-${row.asset}-${index}`,
              asset: row.asset,
              primary: formatQty(row.quantity),
              secondary: holdingSecondary(row),
              value: row.valueUsdt,
              cost: costByAsset.get(row.asset) ?? null,
            }));

    return source.filter((row) => {
      if (keyword && !row.asset.toUpperCase().includes(keyword)) return false;
      if (hideSmall && (row.value ?? 0) < 1) return false;
      return true;
    });
  }, [costByAsset, data, hideSmall, query, tab]);

  const visibleBuys = useMemo(() => {
    const keyword = query.trim().toUpperCase();
    return (buys ?? []).filter((buy) => {
      if (keyword && !buy.asset.toUpperCase().includes(keyword)) return false;
      if (hideSmall && buy.costUsdt < 1) return false;
      return true;
    });
  }, [buys, hideSmall, query]);

  const hiddenCount = useMemo(() => {
    if (!hideSmall) return 0;
    if (tab === "buys") return (buys ?? []).filter((buy) => buy.costUsdt < 1).length;
    if (!data) return 0;
    const source = tab === "overview" ? data.overview : data.holdings.filter((row) => row.wallet === tab);
    return source.filter((row) => (row.valueUsdt ?? 0) < 1).length;
  }, [buys, data, hideSmall, tab]);

  if (authed === null && !error) {
    return <main className="boot">正在读取余额…</main>;
  }

  if (!authed || !data) {
    return (
      <main className="login-card">
        <div className="mark" aria-hidden="true" />
        <h1>账户余额</h1>
        <p className="lede">查看现货、资金账户和 Simple Earn 里每种币还剩多少。页面需要密码，余额只在登录后从服务器读取。</p>
        {error ? <p className="alert" role="alert">{error}</p> : null}
        <form onSubmit={onLogin}>
          <label htmlFor="password">访问密码</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <button className="primary" type="submit" disabled={submitting}>
            {submitting ? "正在进入…" : "进入"}
          </button>
        </form>
      </main>
    );
  }

  const total = data.totals.grand;

  return (
    <main className="shell">
      <header className="top">
        <div>
          <h1>账户余额</h1>
          <p className="updated">{loading ? "正在更新…" : `更新于 ${data.generatedAt}（北京时间）`}</p>
        </div>
        <div className="actions">
          <button
            className="ghost"
            type="button"
            onClick={() => {
              void load(true);
              void loadBuys(assetKey, true);
            }}
            disabled={loading || buysLoading}
          >
            刷新
          </button>
          <button className="ghost" type="button" onClick={() => void onLogout()}>
            退出
          </button>
        </div>
      </header>

      {error ? <p className="alert" role="alert">{error}</p> : null}
      {(data.warnings ?? []).map((warning) => (
        <p className="alert note" key={warning}>{warning}</p>
      ))}
      {buyWarnings.map((warning) => (
        <p className="alert note" key={warning}>{warning}</p>
      ))}

      <section className="hero">
        <p className="eyebrow">预估总资产</p>
        <p className="total">
          {total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span>USDT</span>
        </p>
        <div className="cny">{formatCny(total, data.cnyRate)}</div>
        {buysLoading && buys == null ? <p className="updated">正在读取买入成本…</p> : null}
        {cost.totals.buyCount > 0 ? (
          <p className={cost.totals.pnlUsdt > 0 ? "hero-pnl pnl-up" : cost.totals.pnlUsdt < 0 ? "hero-pnl pnl-down" : "hero-pnl"}>
            浮动盈亏 {formatSignedUsdt(cost.totals.pnlUsdt)} {formatSignedPct(cost.totals.pnlRate)}
            <span> 对应成本 {formatUsdt(cost.totals.investedUsdt)}</span>
          </p>
        ) : null}
      </section>

      <section className="stats">
        {([
          ["spot", "现货", data.totals.spot],
          ["funding", "资金", data.totals.funding],
          ["flexible", "活期", data.totals.flexible],
          ["locked", "定期", data.totals.locked],
        ] as const).map(([id, label, value]) => (
          <button key={id} className="stat" type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>
            <span>{label}</span>
            <strong>{formatUsdt(value)}</strong>
          </button>
        ))}
      </section>

      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="账户">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="filters">
          <label className="search">
            <input
              value={query}
              placeholder="搜索币种"
              aria-label="搜索币种"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={hideSmall} onChange={(event) => setHideSmall(event.target.checked)} />
            隐藏不足 1 USDT
          </label>
          <label className="check">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            15 秒自动刷新
          </label>
        </div>
      </div>

      <section className="panel list" aria-live="polite">
        {tab === "buys" ? (
          <BuyHistory buys={visibleBuys} loading={buysLoading} startDate={buyStart} prices={held} onPickAsset={(asset) => setQuery(asset)} />
        ) : (
          <>
            {rows.length === 0 ? <p className="empty">这个视图里没有余额。</p> : null}
            {rows.map((row) => {
              const pct = formatPct(row.value, total);
              const width = pct || "0%";
              const pnlClass = row.cost?.pnlUsdt == null ? "" : row.cost.pnlUsdt > 0 ? "pnl-up" : row.cost.pnlUsdt < 0 ? "pnl-down" : "";
              return (
                <article className="row" key={row.key}>
                  <div className="avatar" style={{ background: `hsl(${hue(row.asset)} 42% 42%)` }} aria-hidden="true">
                    {row.asset.slice(0, 1)}
                  </div>
                  <div className="asset">
                    <button
                      className="asset-name"
                      type="button"
                      onClick={() => {
                        setTab("buys");
                        setQuery(row.asset);
                      }}
                    >
                      {row.asset}
                    </button>
                    <span className="qty">剩余 {row.primary}</span>
                    {row.cost ? (
                      <span className="secondary">
                        当前价 {formatPrice(row.cost.currentPriceUsdt)} · 买入均价 {formatPrice(row.cost.avgCostUsdt)} · {row.cost.buyCount} 笔
                      </span>
                    ) : (
                      <span className="secondary">{buys == null ? "正在读取买入成本…" : "没有买入记录"}</span>
                    )}
                    {row.secondary ? <span className="secondary">{row.secondary}</span> : null}
                    {row.cost && row.cost.extraQuantity > 0 ? (
                      <span className="secondary">另有 {formatQty(row.cost.extraQuantity)} 没有买入记录，不计入盈亏</span>
                    ) : null}
                    {row.value != null && total > 0 ? (
                      <span className="track" aria-hidden="true">
                        <i style={{ width }} />
                      </span>
                    ) : null}
                  </div>
                  <div className="value">
                    <b>{formatUsdt(row.value)}</b>
                    {row.cost?.pnlUsdt != null ? (
                      <em className={pnlClass}>
                        {formatSignedUsdt(row.cost.pnlUsdt)} {formatSignedPct(row.cost.pnlRate)}
                      </em>
                    ) : pct ? (
                      <em>{pct}</em>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </>
        )}
      </section>

      {hiddenCount > 0 ? <p className="foot">已隐藏 {hiddenCount} 个不足 1 USDT 的币种，总资产里仍然计算它们。</p> : null}
      {data.omittedLendingTokens.length > 0 ? (
        <p className="foot">{data.omittedLendingTokens.join("、")} 是理财凭证，已经按活期或定期持仓计算，这里不再重复计入。</p>
      ) : null}
      <p className="foot">
        买入成本按 {buyStart || "2026-01-01"} 以来的成功定投和现货买入计算。买入均价 = 花费的 USDT ÷ 买入数量，浮动盈亏 = 当前价相对均价、只计算现在还持有的数量。
        点币种可以看它的买入记录。合约和杠杆不在这个页面里。
      </p>
    </main>
  );
}
