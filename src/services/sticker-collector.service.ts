import { downloadMediaMessage, type WASocket, type WAMessage, type proto } from "baileys-joss";
import type { StickerLibrary } from "../core/sticker-library";
import type { BotState } from "../core/state";
import { logger } from "../utils/logger";

export class StickerCollectorService {
  constructor(
    private readonly stickers: StickerLibrary,
    private readonly bot: BotState
  ) {}

  /** Baixa a figurinha vista no grupo e guarda na galeria local, sem bloquear o handler principal. */
  public async collect(sock: WASocket, msg: proto.IWebMessageInfo, jid: string): Promise<void> {
    try {
      const buffer = await downloadMediaMessage(msg as WAMessage, "buffer", {}, {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      });
      const groupName = this.bot.groups.find((g) => g.jid === jid)?.name ?? jid;
      this.stickers.addSeen(buffer, groupName);
    } catch (err) {
      logger.debug({ err }, "Falha ao coletar figurinha do grupo (ignorado)");
    }
  }
}
