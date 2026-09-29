import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = {
  title: "Reversiritori | ことばの陣取り",
  description: "言葉をつなぎ、マスを取る。二人で遊ぶひらがな対戦ゲーム。",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
