import type { Account } from "../core/account";
import { logger } from "../utils/logger";

export async function handleBotRoutes(
  req: Request,
  url: URL,
  account: Account
): Promise<Response | null> {
  if (url.pathname === "/status" && req.method === "GET") {
    return Response.json({
      active: account.bot.active,
      whatsappConnected: account.connection.connected,
      needsQr: account.connection.qr !== null,
      guard: account.guardStatus(),
    });
  }

  if (url.pathname === "/on" && req.method === "POST") {
    account.setBotActive(true);
    logger.info(`Bot LIGADO via dashboard (${account.name})`);
    return Response.json({ active: true });
  }

  if (url.pathname === "/off" && req.method === "POST") {
    account.setBotActive(false);
    logger.info(`Bot DESLIGADO via dashboard (${account.name})`);
    return Response.json({ active: false });
  }

  return null;
}
