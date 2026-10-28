import { createHmac } from "crypto";

export function signedParams(params: Record<string, string>, secret: string, now = Date.now()): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "timestamp" || key === "signature" || value === "") continue;
    search.append(key, value);
  }
  search.append("timestamp", String(now));
  const query = search.toString();
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  return `${query}&signature=${signature}`;
}
