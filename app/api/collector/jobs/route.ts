import { adminApi } from "@/src/collector/admin/api.mts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return adminApi().list(request);
}

export function POST(request: Request) {
  return adminApi().start(request);
}
