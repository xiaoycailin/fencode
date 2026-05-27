import { redirect } from "next/navigation";
import { ChatRoom } from "@/components/chat/ChatRoom";
import { getSession, listSessions } from "@/lib/db";
import { buildFcodeServerUrl, shouldProxyToFcodeServer } from "@/lib/fcodeServerProxy";
import type { Session, SessionDetail } from "@/types/session";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const detail = shouldProxyToFcodeServer()
    ? await fetch(buildFcodeServerUrl(`/sessions/${encodeURIComponent(sessionId)}`), { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<SessionDetail> : null)
      .catch(() => null)
    : getSession(sessionId);
  if (!detail) {
    const latest = shouldProxyToFcodeServer()
      ? await fetch(buildFcodeServerUrl("/sessions"), { cache: "no-store" })
        .then((response) => response.json() as Promise<{ data?: Session[] }>)
        .then((payload) => (payload.data ?? [])[0])
        .catch(() => null)
      : listSessions()[0];
    redirect(latest ? `/chat/${latest.id}` : "/chat");
  }
  return <ChatRoom detail={detail} />;
}
