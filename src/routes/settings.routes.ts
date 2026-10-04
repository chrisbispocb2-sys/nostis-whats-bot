import type { Account } from "../core/account";
import { DEFAULT_AWAY_MESSAGE, DEFAULT_RIDE_CHARGE_MESSAGE, DEFAULT_RIDE_MESSAGES, type SettingsInput } from "../core/settings-store";

const SETTINGS_DEFAULTS = { awayMessage: DEFAULT_AWAY_MESSAGE, rideChargeMessage: DEFAULT_RIDE_CHARGE_MESSAGE, ...DEFAULT_RIDE_MESSAGES };

export async function handleSettingsRoutes(
  req: Request,
  url: URL,
  account: Account
): Promise<Response | null> {
  const { settings, bans } = account;

  if (url.pathname === "/settings" && req.method === "GET") {
    return Response.json({ ...settings.get(), defaults: SETTINGS_DEFAULTS });
  }

  if (url.pathname === "/settings" && req.method === "PUT") {
    const body = (await req.json()) as SettingsInput;
    const updated = settings.update(body);
    // Segurança desligada: nenhuma contagem em andamento deve desligar o bot depois
    if (!updated.autoShutdownEnabled) account.guard.reset();
    // O recado automático é pra quando o bot está desligado: ligá-lo desliga o bot agora, se estiver ligado
    if (body.awayMessageEnabled === true && account.bot.active) account.setBotActive(false);
    return Response.json({ ...updated, defaults: SETTINGS_DEFAULTS, botActive: account.bot.active });
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
