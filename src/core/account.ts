import {
  DEFAULT_ACCOUNT_ID,
  accountPaths,
  ensureAccountDirectories,
  type AccountPaths,
} from "../config/paths";
import { BanStore } from "./ban-store";
import { BotState } from "./state";
import { CallLeadStore } from "./lead-store";
import { CallerStore } from "./caller-store";
import { CampaignStore } from "./campaign-store";
import { GroupDelayStore } from "./group-delay-store";
import { KeywordStore } from "./keyword-store";
import { ProfileStore } from "./profile-store";
import { SettingsStore } from "./settings-store";
import { StickerLibrary } from "./sticker-library";
import { WhatsAppConnection, type Connection, type ConnectionFactory } from "./connection";
import { ChargeStore } from "./charge-store";
import { ConversationTracker } from "./conversation-tracker";
import { MisticStore } from "./mistic-store";
import { MessageHandler } from "../handlers/message.handler";
import { GreetingService, type GreetingTiming } from "../services/greeting.service";
import { InactivityGuard } from "../services/inactivity-guard";
import { sendNotification } from "../services/notification.service";
import { MisticService, type MisticTiming } from "../services/mistic/service";
import type { RateLimiter } from "../services/mistic/rate-limiter";
import { SentMessageRegistry } from "../utils/sent-registry";
import { phoneFromJid } from "../utils/jid";
import { logger } from "../utils/logger";
import { generateMessageIDV2 } from "baileys-joss";
import type { AnyMessageContent } from "baileys-joss";

export interface AccountMeta {
  id: string;
  name: string;
  createdAt: number;
}

export interface AccountOptions {
  appDataDir?: string;
  tempDir?: string;
  createConnection?: ConnectionFactory;
  /** Aviso no computador (notificação do Windows). */
  notify?: (title: string, body: string) => void;
  /** Só pra testes: prazo da segurança em ms, no lugar do configurado (que é em minutos). */
  guardTimeoutMs?: () => number;
  /** Só pra testes: tempos da saudação (o padrão espera vários segundos). */
  greetingTiming?: GreetingTiming;
  /** Só pra testes: a MisticPay de mentira e os tempos do acompanhamento de pagamentos. */
  mistic?: { fetch?: typeof fetch; timing?: MisticTiming; limiter?: RateLimiter };
  /** Chamado quando a configuração da MisticPay muda (liga/desliga o botão solto na tela). */
  onMisticChange?: () => void;
}

export interface AutoShutdownEvent {
  at: number;
  chatJid: string;
}

/**
 * Uma conta de WhatsApp: a conexão e todos os dados que hoje existem no painel
 * (perfis, regras, campanhas, grupos, métricas, banidos, configurações...).
 * Cada conta é totalmente independente das outras.
 */
export class Account {
  readonly id: string;
  name: string;
  readonly createdAt: number;
  readonly paths: AccountPaths;

  readonly profiles: ProfileStore;
  readonly keywords: KeywordStore;
  readonly campaigns: CampaignStore;
  readonly bot: BotState;
  readonly settings: SettingsStore;
  readonly bans: BanStore;
  readonly callers: CallerStore;
  readonly leads: CallLeadStore;
  readonly groupDelays: GroupDelayStore;
  readonly stickers: StickerLibrary;

  /** Conversas privadas recentes: é o que diz ao painel com quem você está falando agora. */
  readonly conversations = new ConversationTracker();
  readonly misticSettings: MisticStore;
  readonly charges: ChargeStore;
  readonly mistic: MisticService;

  /** IDs das mensagens que o próprio bot enviou (pra não confundir com respostas suas). */
  readonly sent = new SentMessageRegistry();
  readonly greeting: GreetingService;
  readonly guard: InactivityGuard;
  readonly connection: Connection;

  /** Última vez que a segurança desligou o bot (só em memória; o painel mostra um aviso). */
  lastAutoShutdown: AutoShutdownEvent | null = null;

  /** Mostra um aviso no computador. */
  readonly notify: (title: string, body: string) => void;
  private readonly handler: MessageHandler;
  private readonly onMisticChange?: () => void;

  constructor(meta: AccountMeta, options: AccountOptions = {}) {
    this.id = meta.id;
    this.onMisticChange = options.onMisticChange;
    this.name = meta.name;
    this.createdAt = meta.createdAt;
    this.notify = options.notify ?? ((title, body) => void sendNotification(title, body));

    this.paths = accountPaths(meta.id, options.appDataDir, options.tempDir);
    ensureAccountDirectories(this.paths);

    this.profiles = new ProfileStore(this.paths);
    this.keywords = new KeywordStore(this.profiles);
    this.campaigns = new CampaignStore(this.profiles);
    this.bot = new BotState(this.paths.state, this.profiles);
    this.settings = new SettingsStore(this.paths.settings);
    this.bans = new BanStore(this.paths.bans);
    this.callers = new CallerStore(this.paths.callers);
    this.leads = new CallLeadStore(this.paths.callLeads);
    this.groupDelays = new GroupDelayStore(this.paths.groupDelays);
    this.stickers = new StickerLibrary(this.paths.stickerLibrary, this.paths.stickerMedia);

    this.greeting = new GreetingService(
      {
        getRule: (id) => this.keywords.get(id),
        isBotActive: () => this.bot.active,
        markSent: (id) => this.sent.mark(id),
      },
      options.greetingTiming
    );

    this.guard = new InactivityGuard({
      isEnabled: () => this.settings.get().autoShutdownEnabled,
      timeoutMs: () => options.guardTimeoutMs?.() ?? this.settings.get().autoShutdownMinutes * 60_000,
      isBotActive: () => this.bot.active,
      shutdown: (info) => this.shutdownForInactivity(info),
    });

    this.misticSettings = new MisticStore(this.paths.mistic);
    this.charges = new ChargeStore(this.paths.misticCharges);
    this.mistic = new MisticService({
      store: this.misticSettings,
      charges: this.charges,
      sender: {
        sendText: (chatJid, text) => this.sendPrivate(chatJid, { text }),
        sendImage: (chatJid, image, caption) => this.sendPrivate(chatJid, { image, caption }),
      },
      contacts: {
        find: (jid) => this.conversations.find(jid),
        lookupPhone: (phone) => this.lookupPhone(phone),
        aliases: (jid) => this.conversations.aliasesOf(jid),
      },
      notify: (title, body) => this.notify(title, body),
      accountName: () => this.name,
      // Pagamento confirmado: a corrida da pessoa nas métricas vira "Fechou" com o valor recebido
      onPaid: (record) => {
        const lead = this.leads.applyPayment({
          chargeId: record.id,
          jids: [...(record.contactJids ?? []), ...(record.chatJid ? [record.chatJid] : [])],
          phone: record.phone,
          amountCents: record.amountCents,
          paidAt: record.paidAt ?? Date.now(),
          chargeCreatedAt: record.createdAt,
        });
        if (lead) logger.info({ account: this.name, chargeId: record.id, leadId: lead.id }, "Pagamento registrado nas métricas");
      },
      // Criar uma cobrança é você atendendo: cancela a saudação automática e satisfaz a segurança
      onOperatorAction: (chatJid) => {
        this.greeting.cancelForChat([chatJid]);
        this.guard.onOperatorReply([chatJid]);
      },
      ...options.mistic,
    });

    this.handler = new MessageHandler(this);

    const createConnection: ConnectionFactory =
      options.createConnection ?? ((connectionOptions) => new WhatsAppConnection(connectionOptions));
    this.connection = createConnection({
      label: () => this.name,
      authDir: this.paths.auth,
      qrPath: this.paths.qrCode,
      openQrViewer: this.id === DEFAULT_ACCOUNT_ID,
      onMessage: (sock, msg) => this.handler.handle(sock, msg),
      onGroups: (groups) => this.bot.setGroups(groups),
    });
  }

  start(): Promise<void> {
    // O acompanhamento de pagamentos roda mesmo com o WhatsApp fora do ar (o agradecimento espera a conexão)
    this.mistic.start();
    return this.connection.start();
  }

  stop(): void {
    this.mistic.stop();
    this.guard.reset();
    this.connection.stop();
  }

  /** A configuração da MisticPay mudou: quem depende dela (o botão solto na tela) se ajusta. */
  notifyMisticChange(): void {
    this.onMisticChange?.();
  }

  /** Envia uma mensagem pelo bot a uma conversa privada, registrando o ID pra não contar como resposta sua. */
  private async sendPrivate(chatJid: string, content: AnyMessageContent): Promise<void> {
    if (!this.connection.connected) throw new Error("O WhatsApp desta conta está desconectado.");
    const sock = this.connection.getSock();
    const messageId = generateMessageIDV2(sock.user?.id);
    this.sent.mark(messageId);
    await sock.sendMessage(chatJid, content, { messageId });
  }

  /** Confere no WhatsApp se um número existe e devolve o JID certo pra enviar. */
  private async lookupPhone(phone: string): Promise<{ chatJid: string; phone: string } | null> {
    if (!this.connection.connected) throw new Error("O WhatsApp desta conta está desconectado.");
    const [found] = (await this.connection.getSock().onWhatsApp(`${phone}@s.whatsapp.net`)) ?? [];
    return found?.exists ? { chatJid: found.jid, phone: phoneFromJid(found.jid) } : null;
  }

  /** Liga ou desliga o bot. Qualquer contagem da segurança em andamento é cancelada. */
  setBotActive(active: boolean): void {
    if (active) this.bot.enable();
    else this.bot.disable();
    this.guard.reset();
  }

  /** Recarrega o que é guardado por perfil (chamado ao trocar/importar perfil). */
  reloadProfileScopedStores(): void {
    this.keywords.reload();
    this.campaigns.reload();
    this.bot.reloadGroupsForProfile();
  }

  /** Número de telefone da conta, quando conectada. */
  get phone(): string | null {
    try {
      const jid = this.connection.getSock().user?.id;
      return jid ? phoneFromJid(jid) : null;
    } catch {
      return null;
    }
  }

  /** Situação da segurança, pro painel. */
  guardStatus() {
    const settings = this.settings.get();
    return {
      enabled: settings.autoShutdownEnabled,
      minutes: settings.autoShutdownMinutes,
      pending: this.guard.pendingCount,
      deadlineAt: this.guard.nextDeadline,
      lastShutdown: this.lastAutoShutdown,
    };
  }

  private shutdownForInactivity(info: { chatJid: string; waitedMs: number }): void {
    this.setBotActive(false);
    this.lastAutoShutdown = { at: Date.now(), chatJid: info.chatJid };

    const minutes = Math.max(1, Math.round(info.waitedMs / 60_000));
    logger.warn(
      { account: this.name, chatJid: info.chatJid, waitedMs: info.waitedMs },
      "Bot DESLIGADO pela segurança: mensagem no privado sem resposta"
    );
    this.notify(
      `${this.name}: bot desligado por segurança`,
      `Chegou uma mensagem no privado e ninguém respondeu em ${minutes} min. Ligue o bot de novo quando puder atender.`
    );
  }
}
