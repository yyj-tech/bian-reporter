export function shanghaiNow(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function formatQty(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const negative = value < 0;
  const text = Math.abs(value).toFixed(8).replace(/\.?0+$/, "");
  const [whole, fraction] = text.split(".");
  const grouped = Number(whole).toLocaleString("en-US");
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${body}` : body;
}

export function formatUsdt(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "无法折算";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) {
    return `${value.toLocaleString("en-US", { maximumFractionDigits: 6 })} USDT`;
  }
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

export function formatCny(usdt: number, rate: number | null): string {
  if (rate == null || !Number.isFinite(rate)) return "人民币估算暂不可用";
  const amount = (usdt * rate).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `≈ ¥${amount}`;
}

export function formatPct(part: number | null, total: number): string {
  if (part == null || !(total > 0)) return "";
  return `${((part / total) * 100).toFixed(1)}%`;
}

export function formatApr(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const percent = Math.abs(value) <= 2 ? value * 100 : value;
  return `年化 ${percent.toFixed(2)}%`;
}
