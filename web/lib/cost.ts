export type BuyRecord = {
  id: string;
  time: number;
  asset: string;
  quantity: number;
  costUsdt: number;
  priceUsdt: number;
  source: string;
};

export type AssetCost = {
  asset: string;
  buyCount: number;
  boughtQuantity: number;
  totalCostUsdt: number;
  avgCostUsdt: number;
  currentPriceUsdt: number | null;
  heldQuantity: number;
  pnlUsdt: number | null;
  pnlRate: number | null;
  extraQuantity: number;
};

export type CostTotals = {
  investedUsdt: number;
  pnlUsdt: number;
  pnlRate: number | null;
  buyCount: number;
};

export type HeldAsset = {
  asset: string;
  quantity: number;
  priceUsdt: number | null;
};

type RawFields = Record<string, unknown>;

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function planSource(planType: string): string {
  if (planType === "SINGLE") return "单币定投";
  if (planType === "INDEX") return "指数定投";
  if (planType === "PORTFOLIO") return "组合定投";
  return "定投";
}

export function buysFromAutoInvest(items: unknown[]): { buys: BuyRecord[]; skippedOtherQuote: number } {
  const buys: BuyRecord[] = [];
  const seen = new Set<string>();
  let skippedOtherQuote = 0;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as RawFields;
    if (text(row.transactionStatus) !== "SUCCESS") continue;
    const asset = text(row.targetAsset);
    const quantity = num(row.targetAssetAmount);
    if (!asset || !(quantity > 0)) continue;
    if (text(row.sourceAsset) !== "USDT") {
      skippedOtherQuote += 1;
      continue;
    }
    const fee = text(row.transactionFeeUnit) === "USDT" ? num(row.transactionFee) : 0;
    const costUsdt = num(row.sourceAssetAmount) + fee;
    if (!(costUsdt > 0)) continue;
    const time = num(row.transactionDateTime);
    const id = `${time}:${asset}:${quantity}:${costUsdt}:${text(row.planType)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const namedPrice = num(row.executionPrice);
    buys.push({
      id,
      time,
      asset,
      quantity,
      costUsdt,
      priceUsdt: namedPrice > 0 ? namedPrice : costUsdt / quantity,
      source: planSource(text(row.planType)),
    });
  }

  return { buys, skippedOtherQuote };
}

export function buysFromSpotTrades(trades: unknown[], asset: string): BuyRecord[] {
  const buys: BuyRecord[] = [];
  for (const item of trades) {
    if (!item || typeof item !== "object") continue;
    const row = item as RawFields;
    if (row.isBuyer !== true) continue;
    const grossQty = num(row.qty);
    const commission = num(row.commission);
    const commissionAsset = text(row.commissionAsset);
    const quantity = commissionAsset === asset ? grossQty - commission : grossQty;
    const costUsdt = num(row.quoteQty) + (commissionAsset === "USDT" ? commission : 0);
    if (!(quantity > 0) || !(costUsdt > 0)) continue;
    const id = `spot:${text(row.symbol)}:${num(row.id)}`;
    buys.push({
      id,
      time: num(row.time),
      asset,
      quantity,
      costUsdt,
      priceUsdt: costUsdt / quantity,
      source: "现货",
    });
  }
  return buys;
}

export function summarizeBuys(buys: BuyRecord[], held: HeldAsset[]): { assets: AssetCost[]; totals: CostTotals } {
  const grouped = new Map<string, { count: number; quantity: number; cost: number }>();
  for (const buy of buys) {
    const current = grouped.get(buy.asset) ?? { count: 0, quantity: 0, cost: 0 };
    current.count += 1;
    current.quantity += buy.quantity;
    current.cost += buy.costUsdt;
    grouped.set(buy.asset, current);
  }

  const heldByAsset = new Map(held.map((row) => [row.asset, row]));
  const assets: AssetCost[] = [];
  for (const [asset, lot] of grouped) {
    const position = heldByAsset.get(asset);
    const heldQuantity = position?.quantity ?? 0;
    const price = position?.priceUsdt ?? null;
    const avgCostUsdt = lot.quantity > 0 ? lot.cost / lot.quantity : 0;
    const covered = Math.min(heldQuantity, lot.quantity);
    const costOfHeld = avgCostUsdt * covered;
    const value = price == null ? null : price * covered;
    const pnlUsdt = value == null ? null : value - costOfHeld;
    assets.push({
      asset,
      buyCount: lot.count,
      boughtQuantity: lot.quantity,
      totalCostUsdt: lot.cost,
      avgCostUsdt,
      currentPriceUsdt: price,
      heldQuantity,
      pnlUsdt,
      pnlRate: pnlUsdt != null && costOfHeld > 0 ? (pnlUsdt / costOfHeld) * 100 : null,
      extraQuantity: Math.max(0, heldQuantity - lot.quantity),
    });
  }

  assets.sort((a, b) => Math.abs(b.pnlUsdt ?? 0) - Math.abs(a.pnlUsdt ?? 0) || a.asset.localeCompare(b.asset));

  let investedUsdt = 0;
  let pnlUsdt = 0;
  let priced = false;
  for (const asset of assets) {
    if (asset.pnlUsdt == null || !(asset.heldQuantity > 0)) continue;
    const covered = Math.min(asset.heldQuantity, asset.boughtQuantity);
    investedUsdt += asset.avgCostUsdt * covered;
    pnlUsdt += asset.pnlUsdt;
    priced = true;
  }

  return {
    assets,
    totals: {
      investedUsdt,
      pnlUsdt,
      pnlRate: priced && investedUsdt > 0 ? (pnlUsdt / investedUsdt) * 100 : null,
      buyCount: buys.length,
    },
  };
}
