import type { Account } from "../core/account";
import type { SettingsInput } from "../core/settings-store";

export async function handleSettingsRoutes(
  req: Request,
  url: URL,
  account: Account
): Promise<Response | null> {
  const { settings, bans } = account;

  if (url.pathname === "/settings" && req.method === "GET") {
    return Response.json(settings.get());
  }

  if (url.pathname === "/settings" && req.method === "PUT") {
    const body = (await req.json()) as SettingsInput;
    const updated = settings.update(body);
    // Segurança desligada: nenhuma contagem em andamento deve desligar o bot depois
    if (!updated.autoShutdownEnabled) account.guard.reset();
    return Response.json(updated);
  }

  if (url.pathname === "/bans" && req.method === "GET") {
    return Response.json({ bans: bans.list() });
  }

  const banMatch = url.pathname.match(/^\/bans\/([^/]+)$/);
  if (banMatch && req.method === "DELETE") {
    const jid = decodeURIComponent(banMatch[1]!);
    const ok = bans.unban(jid);
    if (!ok) return new Response("Not found", { status: 404 });
    return Response.json({ ok: true });
  }

  return null;
}
