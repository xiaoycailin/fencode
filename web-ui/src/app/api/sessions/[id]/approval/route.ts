import { proxyJson } from "@/lib/fcodeServerProxy";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  return proxyJson(request, `/sessions/${encodeURIComponent(id)}/approval`, {
    method: "POST",
    body,
  });
}
