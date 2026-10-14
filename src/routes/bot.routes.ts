import { describeLeaseHolder, type Account } from "../core/account";
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
      away: { enabled: account.settings.get().awayMessageEnabled },
      // Última vez em que o bot daqui foi desligado porque outra pessoa já estava com ele ligado neste WhatsApp
      botConflict: account.coordination.lastBotConflict
        ? { who: describeLeaseHolder(account.coordination.lastBotConflict.holder), at: account.coordination.lastBotConflict.at }
        : null,
    });
  }

  if (url.pathname === "/on" && req.method === "POST") {
    // Outra pessoa atendendo neste mesmo WhatsApp (em outro computador) já está com o bot ligado:
    // os dois ligados responderiam cada chamada em dobro
    const holder = await account.coordination.claimBot();
    if (holder) {
      const who = describeLeaseHolder(holder);
      return Response.json(
        { error: `${who} já está com o bot ligado neste WhatsApp. Só um pode ficar ligado por vez: peça para desligar lá antes de ligar aqui.`, holder },
        { status: 409 }
      );
    }
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
