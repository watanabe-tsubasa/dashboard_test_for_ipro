import { adminApi } from "@/src/collector/admin/api.mts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ camera: string }> },
) {
  return adminApi().thumbnail(request, (await params).camera);
}
