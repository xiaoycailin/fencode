import { redirect } from "next/navigation";
import { listSessions } from "@/lib/db";
import { buildFcodeServerUrl, shouldProxyToFcodeServer } from "@/lib/fcodeServerProxy";
import type { Session } from "@/types/session";

export default async function ChatIndexPage() {
  const sessions = shouldProxyToFcodeServer()
    ? await fetch(buildFcodeServerUrl("/sessions"), { cache: "no-store" })
      .then((response) => response.json() as Promise<{ data?: Session[] }>)
      .then((payload) => payload.data ?? [])
      .catch(() => [])
    : listSessions();
  if (sessions[0]) redirect(`/chat/${sessions[0].id}`);
  redirect("/");
}
