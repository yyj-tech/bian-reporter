export type Wallet = "spot" | "funding" | "flexible" | "locked";

export type RawBalance = {
  asset: string;
  free: string;
  locked: string;
  freeze?: string;
  withdrawing?: string;
};

export type RawEarn = {
  asset: string;
  amount: string;
  detail?: string;
};

export type Holding = {
  wallet: Wallet;
  walletLabel: string;
  asset: string;
  quantity: number;
  free: number | null;
  locked: number | null;
  valueUsdt: number | null;
  priceUsdt: number | null;
  detail: string;
};

export type WalletSlice = {
  label: string;
  quantity: number;
};

export type OverviewRow = {
  asset: string;
  quantity: number;
  valueUsdt: number | null;
  wallets: WalletSlice[];
};

export type Portfolio = {
  generatedAt: string;
  cnyRate: number | null;
  totals: {
    grand: number;
    spot: number;
    funding: number;
    flexible: number;
    locked: number;
  };
  holdings: Holding[];
  overview: OverviewRow[];
  warnings: string[];
  omittedLendingTokens: string[];
};

const STABLES = new Set(["USDT", "FDUSD", "USDC", "BUSD"]);

const WALLET_LABEL: Record<Wallet, string> = {
  spot: "现货",
  funding: "资金",
  flexible: "活期",
  locked: "定期",
};

const WALLET_ORDER = ["现货", "资金", "活期", "定期"];

function priceOf(asset: string, prices: Record<string, number>): number | null {
  if (STABLES.has(asset)) return 1;
  for (const quote of ["USDT", "FDUSD"]) {
    const direct = prices[`${asset}${quote}`];
    if (direct != null && Number.isFinite(direct)) return direct;
  }
  for (const quote of ["BTC", "ETH"]) {
    const via = prices[`${asset}${quote}`];
    const bridge = prices[`${quote}USDT`];
    if (via != null && bridge != null && Number.isFinite(via) && Number.isFinite(bridge)) {
      return via * bridge;
    }
  }
  return null;
}

export function assetPriceUsdt(asset: string, prices: Record<string, number>): number | null {
  const direct = priceOf(asset, prices);
  if (direct != null) return direct;
  if (asset.startsWith("LD") && asset.length > 2) return priceOf(asset.slice(2), prices);
  return null;
}

function num(value: string | undefined): number {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function makeHolding(
  wallet: Wallet,
  asset: string,
  quantity: number,
  free: number | null,
  locked: number | null,
  prices: Record<string, number>,
  detail: string,
): Holding | null {
  if (!(quantity > 0)) return null;
  const price = assetPriceUsdt(asset, prices);
  return {
    wallet,
    walletLabel: WALLET_LABEL[wallet],
    asset,
    quantity,
    free,
    locked,
    priceUsdt: price,
    valueUsdt: price == null ? null : quantity * price,
    detail,
  };
}

export function buildPortfolio(input: {
  spot: RawBalance[];
  funding: RawBalance[];
  flexible: RawEarn[];
  locked: RawEarn[];
  prices: Record<string, number>;
  warnings?: string[];
  generatedAt: string;
  cnyRate: number | null;
}): Portfolio {
  const earnAssets = new Set<string>();
  for (const row of [...input.flexible, ...input.locked]) {
    if (num(row.amount) > 0) earnAssets.add(row.asset);
  }

  const holdings: Holding[] = [];
  const omittedLendingTokens: string[] = [];

  for (const balance of input.spot) {
    const free = num(balance.free);
    const locked = num(balance.locked);
    const holding = makeHolding("spot", balance.asset, free + locked, free, locked, input.prices, "");
    if (!holding) continue;
    if (balance.asset.startsWith("LD") && balance.asset.length > 2 && earnAssets.has(balance.asset.slice(2))) {
      omittedLendingTokens.push(balance.asset);
      continue;
    }
    holdings.push(holding);
  }

  for (const balance of input.funding) {
    const free = num(balance.free);
    const locked = num(balance.locked);
    const quantity = free + locked + num(balance.freeze) + num(balance.withdrawing);
    const extra: string[] = [];
    if (num(balance.freeze) > 0) extra.push(`冻结中 ${num(balance.freeze)}`);
    if (num(balance.withdrawing) > 0) extra.push(`提现中 ${num(balance.withdrawing)}`);
    const holding = makeHolding("funding", balance.asset, quantity, free, locked, input.prices, extra.join(" · "));
    if (holding) holdings.push(holding);
  }

  for (const row of input.flexible) {
    const holding = makeHolding("flexible", row.asset, num(row.amount), null, null, input.prices, row.detail ?? "");
    if (holding) holdings.push(holding);
  }

  for (const row of input.locked) {
    const holding = makeHolding("locked", row.asset, num(row.amount), null, null, input.prices, row.detail ?? "");
    if (holding) holdings.push(holding);
  }

  const totals = { grand: 0, spot: 0, funding: 0, flexible: 0, locked: 0 };
  const warnings = [...(input.warnings ?? [])];
  const unpriced: string[] = [];

  for (const holding of holdings) {
    if (holding.valueUsdt == null) {
      unpriced.push(`${holding.walletLabel} ${holding.asset}`);
      continue;
    }
    totals[holding.wallet] += holding.valueUsdt;
    totals.grand += holding.valueUsdt;
  }

  if (unpriced.length > 0) {
    warnings.push(`这些币种没有 USDT 折算价，数量仍会显示：${unpriced.join("、")}`);
  }

  holdings.sort((a, b) => (b.valueUsdt ?? -1) - (a.valueUsdt ?? -1) || a.asset.localeCompare(b.asset));

  const grouped = new Map<string, { quantity: number; value: number; priced: boolean; wallets: Map<string, number> }>();
  for (const holding of holdings) {
    const current = grouped.get(holding.asset) ?? {
      quantity: 0,
      value: 0,
      priced: false,
      wallets: new Map<string, number>(),
    };
    current.quantity += holding.quantity;
    if (holding.valueUsdt != null) {
      current.value += holding.valueUsdt;
      current.priced = true;
    }
    current.wallets.set(holding.walletLabel, (current.wallets.get(holding.walletLabel) ?? 0) + holding.quantity);
    grouped.set(holding.asset, current);
  }

  const overview: OverviewRow[] = [...grouped.entries()]
    .map(([asset, row]) => ({
      asset,
      quantity: row.quantity,
      valueUsdt: row.priced ? row.value : null,
      wallets: [...row.wallets.entries()]
        .map(([label, quantity]) => ({ label, quantity }))
        .sort((a, b) => WALLET_ORDER.indexOf(a.label) - WALLET_ORDER.indexOf(b.label)),
    }))
    .sort((a, b) => (b.valueUsdt ?? -1) - (a.valueUsdt ?? -1) || a.asset.localeCompare(b.asset));

  return {
    generatedAt: input.generatedAt,
    cnyRate: input.cnyRate,
    totals,
    holdings,
    overview,
    warnings,
    omittedLendingTokens,
  };
}
