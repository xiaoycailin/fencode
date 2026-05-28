import { proxyJson } from "@/lib/fcodeServerProxy";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  return proxyJson(request, `/sessions/${encodeURIComponent(id)}/undo`, { method: "POST", body });
}
