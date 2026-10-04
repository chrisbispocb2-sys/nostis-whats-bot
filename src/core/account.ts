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
import { ChatStore, type ChatMessageRecord } from "./chat-store";
import { QuickReplyStore } from "./quick-reply-store";
import { MisticStore } from "./mistic-store";
import { MessageHandler } from "../handlers/message.handler";
import { ChatService } from "../services/chat.service";
import { GreetingService, type GreetingTiming } from "../services/greeting.service";
import { InactivityGuard } from "../services/inactivity-guard";
import { AwayMessageService } from "../services/away-message.service";
import { sendNotification } from "../services/notification.service";
import { MisticService, type MisticTiming } from "../services/mistic/service";
import type { RateLimiter } from "../services/mistic/rate-limiter";
import { UberTripTrackerService, type UberStatusFetcher } from "../services/uber-trip-tracker.service";
import { openUberStatusFetcher } from "./uber-cdp";
import { UberTripStore } from "./uber-trip-store";
import type { RideMessageKey } from "./settings-store";
import { describeRide, extractChamaAmountCents, extractUberShareToken, type UberTripSnapshot } from "./uber-trip";
import { SentMessageRegistry } from "../utils/sent-registry";
import { phoneFromJid, normalizeJid } from "../utils/jid";
import { centsToReais, formatBRL } from "../utils/money";
import { logger } from "../utils/logger";
import { CONFIG } from "../config";
import { generateMessageIDV2 } from "baileys-joss";
import type { AnyMessageContent, WAMessage, WASocket } from "baileys-joss";

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
  /** Só pra testes: baixar mídia do chat (fotos, áudios...) sem precisar de rede/WhatsApp de verdade. */
  chatDownloadMedia?: (msg: WAMessage, sock: WASocket) => Promise<Buffer>;
  /** Só pra testes: espera entre tentativas de baixar mídia que falhou (produção usa um tempo bem maior). */
  chatMediaRetryDelaysMs?: number[];
  /**
   * Mensagem nova (ou que ganhou mídia) no chat desta conta: o painel aberto é avisado em tempo real.
   * `isNew` é false quando é só uma atualização de mensagem que já existia (ver `ChatServiceOptions.onMessage`).
   */
  onChatMessage?: (accountId: string, message: ChatMessageRecord, isNew: boolean) => void;
  /** Mensagem apagada (só pra você) no chat desta conta: o painel aberto é avisado em tempo real. */
  onChatMessageDeleted?: (accountId: string, chatJid: string, id: string) => void;
  /** Só pra testes: de quanto em quanto tempo consulta o status de uma corrida Uber sendo acompanhada. */
  uberTripPollIntervalMs?: number;
  /** Só pra testes: abre a "torneira" de leituras de status de uma corrida sem precisar de navegador de verdade. */
  uberOpenStatusFetcher?: (shareToken: string) => Promise<UberStatusFetcher>;
  /** Só pra testes: de quanto em quanto tempo confere se o WhatsApp já conectou pra retomar corridas guardadas. */
  uberResumeCheckMs?: number;
  /**
   * De quanto em quanto tempo tenta de novo, sozinho, mídia do chat que desistiu de baixar (falha
   * passageira de rede/DNS não devia exigir clicar "Tentar de novo" em cada mensagem). Produção usa
   * um tempo bem maior; testes trocam por algo rápido (ou `0` pra desligar a varredura automática).
   */
  chatMediaRetrySweepMs?: number;
}

/** Até quanto tempo atrás um "NN,NN chama ?" ainda vale como o valor combinado da corrida de agora. */
const CHAMA_MAX_AGE_MS = 6 * 60 * 60_000;

/** Até quanto tempo depois de abrir o programa ainda espera o WhatsApp conectar pra retomar corridas em andamento. */
const UBER_RESUME_MAX_WAIT_MS = 10 * 60_000;

/** Acrescenta carro/placa/motorista ao aviso, quando a Uber já informou (o cliente sabe qual carro procurar). */
function withRideDetails(text: string, snapshot: UberTripSnapshot): string {
  const details = describeRide(snapshot);
  return details ? `${text}\n${details}` : text;
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
  /** Histórico de conversas (privadas e de grupo), pra conversar direto pelo painel. */
  readonly chats: ChatService;
  /** Chips de resposta rápida + variantes sorteadas, pra conversar mais rápido pelo painel. */
  readonly quickReplies: QuickReplyStore;
  readonly misticSettings: MisticStore;
  readonly charges: ChargeStore;
  readonly mistic: MisticService;
  /** Acompanha corridas da Uber em andamento (pelo link público de compartilhar viagem), avisando o cliente sozinho. */
  readonly uberTrips: UberTripTrackerService;
  private readonly uberTripStore: UberTripStore;
  private uberResumeTimer?: ReturnType<typeof setInterval>;
  private readonly uberResumeCheckMs: number;

  /** IDs das mensagens que o próprio bot enviou (pra não confundir com respostas suas). */
  readonly sent = new SentMessageRegistry();
  readonly greeting: GreetingService;
  readonly guard: InactivityGuard;
  readonly awayMessage: AwayMessageService;
  readonly connection: Connection;

  /** Última vez que a segurança desligou o bot (só em memória; o painel mostra um aviso). */
  lastAutoShutdown: AutoShutdownEvent | null = null;

  /** Mostra um aviso no computador. */
  readonly notify: (title: string, body: string) => void;
  private readonly handler: MessageHandler;
  private readonly onMisticChange?: () => void;
  private readonly chatMediaRetrySweepMs: number;
  private mediaRetryTimer?: ReturnType<typeof setInterval>;

  constructor(meta: AccountMeta, options: AccountOptions = {}) {
    this.id = meta.id;
    this.onMisticChange = options.onMisticChange;
    this.name = meta.name;
    this.createdAt = meta.createdAt;
    this.notify = options.notify ?? ((title, body) => void sendNotification(title, body));
    this.chatMediaRetrySweepMs = options.chatMediaRetrySweepMs ?? 5 * 60_000;

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
    this.quickReplies = new QuickReplyStore(this.paths.chatQuickReplies);

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
      correlationWindowMs: () => CONFIG.correlationWindowMs,
    });

    this.awayMessage = new AwayMessageService({
      isEnabled: () => this.settings.get().awayMessageEnabled,
      isBotActive: () => this.bot.active,
      message: () => this.settings.awayMessageText(),
      isNoReplyNumber: (phone) => this.settings.isNoReplyNumber(phone),
      send: (chatJid, text) => this.sendPrivate(chatJid, { text }),
      accountName: () => this.name,
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
      // O agradecimento final do pagamento saiu: se a conversa estava fixada pra acompanhar a venda, desafixa sozinha
      onThanksSent: (chatJid) => this.chats.unpinIfTemporary(chatJid),
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
      onMessageUpdate: (key, status) => this.chats.updateMessageStatus(key, status),
    });

    this.chats = new ChatService(new ChatStore(this.paths.chatDb), {
      getSock: () => this.connection.getSock(),
      isConnected: () => this.connection.connected,
      mediaDir: this.paths.chatMedia,
      resolveChatName: (chatJid, isGroup, pushName) =>
        isGroup
          ? (this.bot.groups.find((g) => g.jid === chatJid)?.name ?? null)
          : pushName || this.conversations.find(chatJid)?.name || null,
      downloadMedia: options.chatDownloadMedia,
      mediaRetryDelaysMs: options.chatMediaRetryDelaysMs,
      onMessage: (message, isNew) => options.onChatMessage?.(this.id, message, isNew),
      onMessageDeleted: (chatJid, id) => options.onChatMessageDeleted?.(this.id, chatJid, id),
    });

    this.uberResumeCheckMs = options.uberResumeCheckMs ?? 2000;
    this.uberTripStore = new UberTripStore(this.paths.uberTrips);
    this.uberTrips = new UberTripTrackerService({
      pollIntervalMs: options.uberTripPollIntervalMs,
      openStatusFetcher: options.uberOpenStatusFetcher ?? openUberStatusFetcher,
      // Em qual marco a cobrança sai: configurável nas Configurações do chat (padrão: 2 min do motorista)
      chargeTrigger: () => this.settings.get().rideChargeTrigger,
      // Corridas em andamento ficam em disco: fechar e abrir o programa retoma de onde parou (ver `start`)
      persistence: { load: () => this.uberTripStore.read(), save: (state) => this.uberTripStore.write(state) },
      onCharge: async (chatJid, agreedAmountCents) => {
        if (!this.settings.get().rideAutoChargeEnabled) return false; // desligado: só acompanha e avisa, não cobra

        try {
          await this.sendPrivate(chatJid, { text: this.settings.rideChargeMessageText() });
        } catch (err) {
          logger.error({ err, account: this.name, chatJid }, "Falha ao avisar sobre o pagamento antecipado da corrida");
        }

        try {
          await this.mistic.createCharge({ chatJid, amount: centsToReais(agreedAmountCents), description: "Corrida combinada" });
          return true;
        } catch (err) {
          logger.error({ err, account: this.name, chatJid }, "Falha ao cobrar automaticamente a corrida");
          // Sem este aviso a falha passava em branco: o cliente recebia o texto do pagamento
          // antecipado, nenhum PIX, e você só descobria no fim da corrida
          const reason = err instanceof Error && err.message ? ` Motivo: ${err.message}` : "";
          void this.notifySelf(
            `⚠️ Não consegui gerar a cobrança automática de ${formatBRL(agreedAmountCents)} da corrida com +${phoneFromJid(chatJid)}.${reason} Cobre na mão.`
          );
          return false;
        }
      },
      onChargeSkipped: (chatJid, agreedAmountCents) => {
        if (!this.settings.get().rideAutoChargeEnabled) return;
        void this.notifySelf(
          `ℹ️ Nova corrida com +${phoneFromJid(chatJid)}: a anterior já tinha sido cobrada e não chegou a embarcar, então não mandei outra cobrança (${formatBRL(agreedAmountCents)}). Se for preciso cobrar de novo, cobre na mão.`
        );
      },
      // Os textos são os das Configurações (ou os padrão). Carro/placa/motorista entram nos avisos em
      // que o cliente precisa saber quem procurar; com vários marcos pulados de uma vez, só o atual sai
      // (ver `UberTripTrackerOptions.onNearPickup`), então o de 1 min também leva os dados.
      onNearPickup: (chatJid, snapshot) => this.sendRideNotice(chatJid, "rideNear2MinMessage", snapshot),
      onNearPickup1Min: (chatJid, snapshot) => this.sendRideNotice(chatJid, "rideNear1MinMessage", snapshot),
      onArrivedPickup: (chatJid, snapshot) => this.sendRideNotice(chatJid, "rideArrivedMessage", snapshot),
      onTripStarted: (chatJid) => this.sendRideNotice(chatJid, "rideStartedMessage", null),
      onDriverChanged: (chatJid, snapshot) => this.sendRideNotice(chatJid, "rideDriverChangedMessage", snapshot),
      onCancelled: (chatJid) => {
        logger.warn({ account: this.name, chatJid }, "Corrida Uber dessa conversa foi cancelada antes do embarque");
        void this.notifySelf(
          `⚠️ A corrida com +${phoneFromJid(chatJid)} sumiu do link da Uber antes do embarque (cancelada). Parei de acompanhar — se pedir outro carro, mande o link novo na conversa.`
        );
      },
      onGaveUp: (chatJid) => {
        logger.warn({ account: this.name, chatJid }, "Parou de acompanhar a corrida Uber dessa conversa");
        const phone = phoneFromJid(chatJid);
        void this.notifySelf(
          `⚠️ Não consegui acompanhar automaticamente a corrida com +${phone} (falha ao consultar o status da Uber várias vezes seguidas). Avise o cliente e cobre na mão se precisar.`
        );
      },
    });
  }

  start(): Promise<void> {
    // O acompanhamento de pagamentos roda mesmo com o WhatsApp fora do ar (o agradecimento espera a conexão)
    this.mistic.start();
    if (this.chatMediaRetrySweepMs > 0) {
      this.mediaRetryTimer = setInterval(() => {
        this.chats.retryAllFailedMedia().catch((err) => logger.error({ err, account: this.name }, "Falha na varredura automática de mídia pendente"));
      }, this.chatMediaRetrySweepMs);
    }
    this.resumeUberTripsWhenConnected();
    return this.connection.start();
  }

  /**
   * Retoma as corridas que estavam sendo acompanhadas quando o programa fechou. Espera o WhatsApp
   * conectar primeiro: retomar antes faria o aviso do marco atual falhar ao enviar e se perder.
   */
  private resumeUberTripsWhenConnected(): void {
    if (this.uberTripStore.read().trips.length === 0) return;
    const startedWaitingAt = Date.now();
    this.uberResumeTimer = setInterval(() => {
      const gaveUpWaiting = Date.now() - startedWaitingAt > UBER_RESUME_MAX_WAIT_MS;
      if (!this.connection.connected && !gaveUpWaiting) return;
      clearInterval(this.uberResumeTimer);
      if (gaveUpWaiting) return; // sem WhatsApp não há como avisar ninguém; as corridas antigas expiram sozinhas
      this.uberTrips.restore().catch((err) => logger.error({ err, account: this.name }, "Falha ao retomar corridas Uber depois de reiniciar"));
    }, this.uberResumeCheckMs);
  }

  stop(): void {
    this.mistic.stop();
    this.guard.reset();
    this.connection.stop();
    clearInterval(this.uberResumeTimer);
    // Suspende (não encerra): as corridas continuam guardadas em disco pra próxima vez que abrir
    this.uberTrips.suspendAll();
    clearInterval(this.mediaRetryTimer);
    // Fecha o handle do SQLite antes de a conta poder ser removida (apaga a pasta): no Windows,
    // apagar um arquivo com handle aberto falha ou deixa lixo.
    this.chats.close();
  }

  /** A configuração da MisticPay mudou: quem depende dela (o botão solto na tela) se ajusta. */
  notifyMisticChange(): void {
    this.onMisticChange?.();
  }

  /**
   * Último "NN,NN chama ?" que você mandou nessa conversa — fonte do valor combinado pro assistente de
   * corrida. Só vale se for recente: o "chama ?" de uma corrida de outro dia não é o preço desta (e
   * usá-lo cobraria o cliente com o valor errado sem ninguém perceber).
   */
  findRecentChamaAmountCents(chatJid: string): number | null {
    const oldestAllowed = Date.now() - CHAMA_MAX_AGE_MS;
    const recent = this.chats.listMessages(chatJid, { limit: 80 }); // já vem do mais recente pro mais antigo
    for (const m of recent) {
      if (m.timestamp < oldestAllowed) break;
      if (!m.fromMe || m.type !== "text" || !m.text) continue;
      const cents = extractChamaAmountCents(m.text);
      if (cents !== null) return cents;
    }
    return null;
  }

  /**
   * Link de corrida detectado num texto que você mandou pro cliente — começa a acompanhar sozinho.
   * Chamado tanto por quem manda pelo painel (rede de segurança, caso o valor já tenha sido achado
   * por outro caminho) quanto, principalmente, por quem manda o link direto do celular, sem abrir o
   * painel: sem isto, só o envio pelo painel disparava o acompanhamento.
   */
  maybeStartUberTripTracking(chatJid: string, text: string, { sentFromPanel = false } = {}): void {
    if (!this.settings.get().rideAssistantEnabled) return;
    const shareToken = extractUberShareToken(text);
    if (!shareToken) return;
    // O mesmo link de novo não reinicia nada (o próprio `startTracking` ignora); um link DIFERENTE é
    // outra corrida (ex.: o motorista cancelou e você pediu outro carro) e substitui a anterior —
    // antes era ignorado enquanto a corrida velha ainda constasse como acompanhada.

    const agreedAmountCents = extractChamaAmountCents(text) ?? this.findRecentChamaAmountCents(chatJid);
    if (agreedAmountCents === null) {
      // Pelo painel, ele mesmo pergunta o valor na tela e começa a acompanhar em seguida
      if (sentFromPanel) return;
      // Pelo celular não há a quem perguntar: acompanha e avisa o cliente mesmo assim, só não cobra
      // (antes a corrida inteira ficava sem acompanhamento e só um log dizia por quê)
      if (!this.uberTrips.isTracking(chatJid)) {
        void this.notifySelf(
          `ℹ️ Estou acompanhando a corrida com +${phoneFromJid(chatJid)} e vou avisar o cliente, mas sem cobrar: não achei nenhum "NN,NN chama ?" recente nessa conversa. Defina o valor na faixa da corrida, no painel, ou cobre na mão.`
        );
      }
    }

    this.uberTrips.startTracking(chatJid, shareToken, agreedAmountCents).catch((err) => {
      logger.error({ err, account: this.name, chatJid }, "Falha ao começar a acompanhar a corrida Uber (detecção automática)");
      const phone = phoneFromJid(chatJid);
      void this.notifySelf(
        `⚠️ Não consegui começar a acompanhar a corrida com +${phone} automaticamente (falha ao abrir o navegador pra consultar a Uber). Avise o cliente e cobre na mão se precisar.`
      );
    });
  }

  /** Manda ao cliente o aviso de um marco da corrida (texto das Configurações), com os dados do carro quando couber. */
  private async sendRideNotice(chatJid: string, key: RideMessageKey, snapshot: UberTripSnapshot | null): Promise<void> {
    const text = this.settings.rideMessageText(key);
    const withDetails = snapshot && this.settings.get().rideVehicleDetailsEnabled ? withRideDetails(text, snapshot) : text;
    try {
      await this.sendPrivate(chatJid, { text: withDetails });
    } catch (err) {
      logger.error({ err, account: this.name, chatJid, notice: key }, "Falha ao mandar aviso da corrida ao cliente");
    }
  }

  /** Envia uma mensagem pelo bot a uma conversa privada, registrando o ID pra não contar como resposta sua. */
  private async sendPrivate(chatJid: string, content: AnyMessageContent): Promise<void> {
    if (!this.connection.connected) throw new Error("O WhatsApp desta conta está desconectado.");
    const sock = this.connection.getSock();
    const messageId = generateMessageIDV2(sock.user?.id);
    this.sent.mark(messageId);
    await sock.sendMessage(chatJid, content, { messageId });
  }

  /**
   * Avisa você mesmo (mensagem no seu próprio WhatsApp) quando o assistente de corrida desiste de
   * acompanhar uma corrida sozinho — sem isso, uma falha no navegador/rede passava em branco: o
   * cliente nunca recebia aviso nem cobrança e ninguém ficava sabendo que precisava fazer na mão.
   */
  private async notifySelf(text: string): Promise<void> {
    try {
      if (!this.connection.connected) return;
      const ownJid = normalizeJid(this.connection.getSock().user?.id ?? "");
      if (!ownJid) return;
      await this.sendPrivate(ownJid, { text });
    } catch (err) {
      logger.error({ err, account: this.name }, "Falha ao mandar aviso para você mesmo");
    }
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
    // Ligou de novo: da próxima vez que desligar, o recado automático pode avisar todo mundo outra vez
    if (active) this.awayMessage.reset();
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
