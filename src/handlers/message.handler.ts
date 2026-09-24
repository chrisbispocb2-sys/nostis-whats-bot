import type { WASocket, WAMessage } from "baileys-joss";
import { toNumber } from "baileys-joss";
import type { Account } from "../core/account";
import { KeywordService } from "../services/keyword.service";
import { StickerCollectorService } from "../services/sticker-collector.service";
import { responseService } from "../services/response.service";
import { identityService } from "../services/identity.service";
import { isReaction, readContent } from "../utils/message-content";
import { isPersonalChat, phoneFromJid } from "../utils/jid";
import { CONFIG } from "../config";
import { logger } from "../utils/logger";

function nameLooksLikeAdmin(pushName: string | null | undefined): boolean {
  if (!pushName) return false;
  return /adm/i.test(pushName);
}

/** Horário da mensagem em ms (o WhatsApp manda em segundos), ou undefined se não veio. */
function messageTimeMs(msg: WAMessage): number | undefined {
  const seconds = toNumber(msg.messageTimestamp);
  return seconds ? seconds * 1000 : undefined;
}

export class MessageHandler {
  private keywordService: KeywordService;
  private stickerCollector: StickerCollectorService;

  constructor(private readonly account: Account) {
    this.keywordService = new KeywordService(account.keywords);
    this.stickerCollector = new StickerCollectorService(account.stickers, account.bot);
  }

  public async handle(sock: WASocket, msg: WAMessage): Promise<void> {
    if (!msg.key) return;

    if (msg.key.fromMe) {
      await this.handleOwnMessage(sock, msg);
      return;
    }

    const { bot, bans, callers, leads, settings, groupDelays, greeting, guard } = this.account;

    // Ignora backlog: histórico e mensagens que chegaram enquanto o bot estava desconectado/inativo
    const messageTimestamp = toNumber(msg.messageTimestamp);
    if (messageTimestamp && messageTimestamp < bot.activatedAt) return;

    const remoteJid = msg.key.remoteJid;
    if (!remoteJid) return;

    if (!remoteJid.endsWith("@g.us")) {
      if (!isPersonalChat(remoteJid)) return;

      // Em conversas com LID o contato vem oculto; ban, leads e regras usam o telefone real
      const contactJid = await identityService.resolveContactJid(sock, msg, remoteJid);

      // Mensagem privada de alguém banido: avisa e não processa como contato normal
      if (bans.isBanned(contactJid)) {
        try {
          await sock.sendMessage(remoteJid, { text: CONFIG.banWarningMessage });
        } catch (err) {
          logger.error({ err }, "Falha ao avisar número banido");
        }
        return;
      }

      // Mensagem privada: correlaciona com métricas e registra contato
      leads.markPrivateContact(contactJid);
      callers.registerCall(contactJid, msg.pushName ?? null);
      greeting.handlePrivateMessage(sock, msg, remoteJid, [contactJid, remoteJid]);

      if (readContent(msg)) {
        // Segurança: começa a contar o tempo até alguém responder essa conversa
        guard.onClientMessage(remoteJid, [contactJid, remoteJid], messageTimeMs(msg));

        // É com quem você está falando agora (o botão de cobrança do painel usa isso)
        this.account.conversations.touch({
          chatJid: remoteJid,
          jids: [contactJid, remoteJid],
          phone: contactJid.endsWith("@s.whatsapp.net") ? phoneFromJid(contactJid) : null,
          name: msg.pushName ?? null,
          from: "client",
          at: messageTimeMs(msg),
        });
      }
      return;
    }

    // Resolve LID para telefone real
    const participantJid = await identityService.resolveParticipantJid(sock, msg, remoteJid);

    // Pessoa banida: ignora
    if (bans.isBanned(participantJid)) return;

    // Ignora nomes de administrador caso configurado
    if (settings.get().ignoreAdminNames && nameLooksLikeAdmin(msg.pushName)) return;

    // Coleta figurinhas vistas para a galeria
    if (msg.message?.stickerMessage) {
      void this.stickerCollector.collect(sock, msg, remoteJid);
    }

    if (!bot.active) return;
    if (!bot.isGroupEnabled(remoteJid)) return;

    const messageText =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      "";

    if (!messageText) return;

    const rule = this.keywordService.findMatchingResponse(messageText, remoteJid);
    if (!rule) return;

    const groupName =
      bot.groups.find((g) => g.jid === remoteJid)?.name ?? remoteJid;

    if (rule.trackMetrics) {
      leads.recordTrigger({
        ruleId: rule.id,
        groupJid: remoteJid,
        groupName,
        callerJid: participantJid,
        callerName: msg.pushName ?? null,
      });
      callers.registerCall(participantJid, msg.pushName ?? null);
    }

    if (rule.reactionEmoji) {
      void responseService.sendReaction(sock, remoteJid, rule.reactionEmoji, msg.key);
    }

    this.keywordService.markTriggered(rule.id, remoteJid);

    // Número na lista "sem resposta": conta gatilho/métrica mas não envia texto
    if (!settings.isNoReplyNumber(phoneFromJid(participantJid))) {
      const randomResponse =
        rule.responses[Math.floor(Math.random() * rule.responses.length)];

      void responseService.sendDelayedResponse(
        sock,
        remoteJid,
        randomResponse,
        rule,
        msg,
        groupDelays.get(remoteJid),
        groupName,
        this.account
      );

      // Quando essa pessoa escrever no privado, o bot puxa a conversa e pergunta os endereços
      if (rule.greetingEnabled) {
        greeting.registerTrigger([participantJid, msg.key.participant], rule.id);
      }
    }
  }

  /**
   * Mensagem enviada pela própria conta. Se foi você respondendo no privado
   * (e não o bot), o bot não puxa a conversa por cima e a segurança sabe que
   * tem alguém atendendo.
   */
  private async handleOwnMessage(sock: WASocket, msg: WAMessage): Promise<void> {
    const chatJid = msg.key.remoteJid;
    if (!chatJid || !isPersonalChat(chatJid)) return;
    if (this.account.sent.has(msg.key.id)) return;
    if (!readContent(msg) && !isReaction(msg)) return;

    const contactJid = await identityService.resolveContactJid(sock, msg, chatJid);
    const jids = [chatJid, msg.key.remoteJidAlt, contactJid].filter((j): j is string => !!j);

    this.account.greeting.cancelForChat(jids);
    this.account.guard.onOperatorReply(jids, messageTimeMs(msg));

    this.account.conversations.touch({
      chatJid,
      jids,
      phone: contactJid.endsWith("@s.whatsapp.net") ? phoneFromJid(contactJid) : null,
      name: null,
      from: "operator",
      at: messageTimeMs(msg),
    });
  }
}
