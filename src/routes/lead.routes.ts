import type { Account } from "../core/account";
import { summarizePayments } from "../core/charge-store";
import type { LeadUpdateInput } from "../core/lead-store";

export async function handleLeadRoutes(
  req: Request,
  url: URL,
  account: Account
): Promise<Response | null> {
  const { leads, bans, callers } = account;

  if (url.pathname === "/leads" && req.method === "GET") {
    // `payments`: quanto entrou pela MisticPay hoje e no mês (independe de o cliente ter uma corrida nas métricas)
    return Response.json({ leads: leads.list(), payments: summarizePayments(account.charges.list()) });
  }

  if (url.pathname === "/callers" && req.method === "GET") {
    return Response.json({ callers: callers.list() });
  }

  const leadBanMatch = url.pathname.match(/^\/leads\/([^/]+)\/ban$/);
  if (leadBanMatch && req.method === "POST") {
    const id = decodeURIComponent(leadBanMatch[1]!);
    const lead = leads.get(id);
    if (!lead) return new Response("Not found", { status: 404 });
    const ban = bans.ban(lead.callerJid, lead.callerName);
    return Response.json({ ban });
  }

  const leadMatch = url.pathname.match(/^\/leads\/([^/]+)$/);
  if (leadMatch) {
    const id = decodeURIComponent(leadMatch[1]!);

    if (req.method === "PUT") {
      const body = (await req.json()) as Partial<LeadUpdateInput>;
      try {
        const lead = leads.update(id, body);
        if (!lead) return new Response("Not found", { status: 404 });
        return Response.json({ lead });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message }, { status: 400 });
      }
    }

    if (req.method === "DELETE") {
      const ok = leads.delete(id);
      if (!ok) return new Response("Not found", { status: 404 });
      return Response.json({ ok: true });
    }
  }

  return null;
}
