import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "账户余额",
  description: "查看当前账户里每种币的剩余数量",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0b0e11",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
