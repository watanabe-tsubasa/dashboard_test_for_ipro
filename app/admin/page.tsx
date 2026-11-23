import type { Metadata } from "next";
import Dashboard from "./Dashboard";

export const metadata: Metadata = {
  title: "i-PRO データ収集管理",
  description: "同期、履歴取得、画像更新のローカル管理画面",
};

export default function AdminPage() {
  return <Dashboard />;
}
