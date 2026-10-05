import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { downloadMediaMessage, generateMessageIDV2, normalizeMessageContent, toNumber } from "baileys-joss";
import type { WASocket, WAMessage, WAMessageKey, AnyMessageContent } from "baileys-joss";
import { ChatStore, type ChatMessageRecord, type ChatSummary, type ChatFolder } from "../core/chat-store";
import { extractChatContent, extractRevokeKey, renderSystemText, type ChatContent, type ChatMessageType } from "../utils/chat-content";
import { normalizeJid, phoneFromJid } from "../utils/jid";
import { logger } from "../utils/logger";
import { SentMessageRegistry } from "../utils/sent-registry";

export interface OperatorMediaInput {
  type: "image" | "video" | "audio" | "document" | "sticker";
  dataBase64: string;
  mimeType: string;
  fileName?: string;
  /** Áudio como mensagem de voz (bolinha com forma de onda) em vez de arquivo anexado. */
  ptt?: boolean;
}

/** Prévia de "em resposta a..." (quando a mensagem cita outra). */
export interface QuotedPreview {
  id: string;
  fromMe: boolean;
  pushName: string | null;
  type: ChatMessageType;
  text: string | null;
}

/** Uma reação (emoji) de alguém a esta mensagem — a mais recente de cada pessoa. */
export interface MessageReaction {
  emoji: string;
  fromMe: boolean;
  pushName: string | null;
}

/** Mensagem pronta pra tela: já vem com a prévia da citação e as reações anexadas (não como linhas à parte). */
export interface ChatMessageView extends ChatMessageRecord {
  quotedPreview?: QuotedPreview | null;
  reactions?: MessageReaction[];
}

/** Status que o WhatsApp manda pra mensagens que você enviou (proto.WebMessageInfo.Status). */
const STATUS_LABELS: Record<number, string> = {
  0: "error",
  2: "sent",
  3: "delivered",
  4: "read",
  5: "played",
};

export interface ChatServiceOptions {
  getSock: () => WASocket;
  isConnected: () => boolean;
  /** Pasta onde ficam os arquivos de mídia desta conta (fotos, áudios, vídeos, documentos). */
  mediaDir: string;
  /** Nome pra mostrar na lista de conversas: nome do grupo, ou o que se souber do contato. */
  resolveChatName: (chatJid: string, isGroup: boolean, pushName: string | null) => string | null;
  /** Só pra testes: baixar a mídia de uma mensagem sem precisar de rede/WhatsApp de verdade. */
  downloadMedia?: (msg: WAMessage, sock: WASocket) => Promise<Buffer>;
  /**
   * Espera antes de cada nova tentativa de baixar mídia que falhou (uma tentativa a mais por
   * valor aqui, incluindo a primeira, imediata). Padrão: 2 tentativas extras. Só pra testes
   * trocarem por algo bem mais rápido (ou vazio, pra desistir na primeira falha).
   */
  mediaRetryDelaysMs?: number[];
  /**
   * Avisa em tempo real (painel aberto): mensagem nova, enviada, ou que acabou de ganhar o arquivo de mídia.
   * `isNew` só é true na primeira vez que a mensagem aparece — mídia que terminou de baixar, status de
   * entrega, mensagem apagada e reentregas do WhatsApp são atualizações de algo que o painel já viu
   * (e não podem tocar o som de mensagem nova).
   */
  onMessage?: (message: ChatMessageRecord, isNew: boolean) => void;
  /** Avisa em tempo real que uma mensagem sumiu do histórico (apagada só pra você, neste painel). */
  onMessageDeleted?: (chatJid: string, id: string) => void;
}

const DOWNLOADABLE_TYPES = new Set<ChatMessageType>(["image", "video", "audio", "document", "sticker"]);

/**
 * Quantas vezes a varredura automática tenta de novo uma mídia antes de desistir sozinha (uma falha
 * persistente — ex.: DNS fora do ar por horas — não pode gerar tentativa e log a cada varredura pra
 * sempre). Clicar "Tentar de novo" manualmente não passa por esse limite.
 */
const MAX_AUTO_RETRY_SWEEPS = 5;

function messageTimeMs(msg: WAMessage): number {
  const seconds = toNumber(msg.messageTimestamp);
  return seconds ? seconds * 1000 : Date.now();
}

function extFromMime(mime: string | null): string {
  if (!mime) return "bin";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("3gpp")) return "3gp";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("pdf")) return "pdf";
  return "bin";
}

/** "5511942412694" → "+55 11 94241-2694" (números de fora do Brasil ficam só com o "+"). */
function formatPhoneForDisplay(digits: string): string {
  const br = digits.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return br ? `+55 ${br[1]} ${br[2]}-${br[3]}` : `+${digits}`;
}

/** Uma marcação no meio do texto: "@" seguido do número da pessoa (telefone ou LID). */
const MENTION_PATTERN = /@(\d{7,20})(?!\d)/g;

/** Servidor de mídia padrão do WhatsApp — o que sempre responde pelo caminho (`directPath`) de qualquer mídia. */
const DEFAULT_MEDIA_HOST = "mmg.whatsapp.net";

/** O endereço do servidor de mídia não existe no DNS (diferente de "sem internet agora", que é EAI_AGAIN/timeout). */
function isUnknownHostError(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "ENOTFOUND" || e?.cause?.code === "ENOTFOUND";
}

/**
 * Baixa pelo servidor que a própria mensagem indica e, se esse nome não existir no DNS, tenta de
 * novo pelo servidor padrão. Algumas mensagens (figurinhas, principalmente) chegam apontando pra
 * `a.whatsapp.net`, que não resolve em DNS nenhum — a biblioteca usa esse nome do jeito que veio e
 * toda tentativa terminava em "getaddrinfo ENOTFOUND", por mais vezes que se tentasse de novo. A
 * mesma mídia baixa normalmente por `mmg.whatsapp.net`.
 */
export async function downloadWithHostFallback(download: (host?: string) => Promise<Buffer>): Promise<Buffer> {
  try {
    return await download();
  } catch (err) {
    if (!isUnknownHostError(err)) throw err;
    return download(DEFAULT_MEDIA_HOST);
  }
}

async function defaultDownloadMedia(msg: WAMessage, sock: WASocket): Promise<Buffer> {
  return downloadWithHostFallback(async (host) => {
    const buffer = await downloadMediaMessage(msg, "buffer", host ? { host } : {}, { logger, reuploadRequest: sock.updateMediaMessage });
    return buffer as Buffer;
  });
}

function buildOutgoingContent(media: OperatorMediaInput, caption: string, buffer: Buffer): AnyMessageContent {
  switch (media.type) {
    case "image":
      return { image: buffer, caption: caption || undefined };
    case "video":
      return { video: buffer, caption: caption || undefined };
    case "audio":
      return { audio: buffer, mimetype: media.mimeType, ptt: !!media.ptt };
    case "document":
      return { document: buffer, mimetype: media.mimeType, fileName: media.fileName || "arquivo" };
    case "sticker":
      return { sticker: buffer };
  }
}

/**
 * A mensagem do jeito que o download de mídia entende. Recado de vídeo (`ptvMessage`) e figurinha
 * animada (embrulhada em `lottieStickerMessage`) trazem a mídia num campo que o download não
 * procura: monta a mensagem no formato direto (`videoMessage`/`stickerMessage`), igual ao que
 * `retryMediaDownload` já faz com a mídia guardada.
 */
function downloadableMessage(msg: WAMessage, content: ChatContent): WAMessage {
  const field = `${content.type}Message`;
  const direct = normalizeMessageContent(msg.message) as Record<string, unknown> | undefined;
  if (!content.mediaEnvelope || direct?.[field]) return msg;
  return { ...msg, message: { [field]: content.mediaEnvelope } } as WAMessage;
}

/** Reconstrói o conteúdo de uma mensagem já guardada, pra reenviar (encaminhar) a outra conversa. */
function buildForwardContent(source: ChatMessageRecord, buffer: Buffer | null): AnyMessageContent {
  switch (source.type) {
    case "text":
      return { text: source.text || "" };
    case "image":
      return { image: buffer!, caption: source.text || undefined };
    case "video":
      return { video: buffer!, caption: source.text || undefined };
    case "audio":
      return { audio: buffer!, mimetype: source.mediaMimeType || "audio/ogg; codecs=opus", ptt: source.isPtt };
    case "document":
      return { document: buffer!, mimetype: source.mediaMimeType || "application/octet-stream", fileName: source.mediaFileName || "arquivo" };
    case "sticker":
      return { sticker: buffer! };
    default:
      throw new Error("Esse tipo de mensagem não pode ser encaminhado.");
  }
}

/**
 * Histórico de conversas da conta: grava o que chega e o que é enviado
 * (privado e grupo), baixa a mídia de verdade (foto, áudio, vídeo, documento)
 * e permite responder direto pelo painel, usando a mesma conexão do bot.
 */
export class ChatService {
  /** Vira true depois de close(): uma tentativa de baixar mídia em andamento não pode tocar o banco já fechado. */
  private closed = false;
  /** IDs das mensagens mandadas pelo painel (pra distinguir, no eco do WhatsApp, do que você digitou no celular). */
  private readonly panelSent = new SentMessageRegistry();

  /** Número de uma marcação que era LID (identidade oculta) → JID de telefone de verdade, já resolvido. */
  private readonly mentionPhones = new Map<string, string>();

  constructor(
    private readonly store: ChatStore,
    private readonly options: ChatServiceOptions
  ) {}

  /**
   * Descobre de quem são as marcações ("@150170008293498") de um texto. O WhatsApp manda a marcação
   * só como o número interno da pessoa (LID), que não diz nada a ninguém; aqui ele vira o telefone de
   * verdade, guardado pra `withMentionNames` trocar pelo nome sem precisar esperar.
   */
  async warmMentions(text: string | null | undefined): Promise<void> {
    if (!text || !this.options.isConnected()) return;
    for (const [, digits] of text.matchAll(MENTION_PATTERN)) {
      if (digits) await this.resolveLid(digits);
    }
  }

  /** Telefone de verdade por trás de um número interno (LID), guardado em `mentionPhones` pra uso sem espera. */
  private async resolveLid(digits: string): Promise<void> {
    if (this.mentionPhones.has(digits) || !this.options.isConnected()) return;
    try {
      const resolved = await this.options.getSock().signalRepository.lidMapping.getPNForLID(`${digits}@lid`);
      if (resolved?.endsWith("@s.whatsapp.net")) this.mentionPhones.set(digits, normalizeJid(resolved));
    } catch (err) {
      logger.debug({ err }, "Falha ao descobrir o telefone por trás de um número interno (ignorado)");
    }
  }

  /**
   * Prepara os nomes de uma mensagem que acabou de chegar — chamar antes de gravá-la. Cobre as
   * marcações do texto (ou legenda) e, nos avisos de grupo ("Fulano removeu Beltrano"), quem fez e
   * quem sofreu a ação: o WhatsApp manda essas pessoas só pelo número interno (LID), e sem o
   * telefone por trás dele o aviso saía como "Alguém removeu...".
   */
  async prepareMentions(msg: WAMessage): Promise<void> {
    const content = normalizeMessageContent(msg.message);
    await this.warmMentions(content?.conversation || content?.extendedTextMessage?.text || content?.imageMessage?.caption || content?.videoMessage?.caption);

    if (msg.messageStubType == null) return;
    const involved = JSON.stringify([msg.key, msg.participant, msg.messageStubParameters]);
    for (const [, digits] of involved.matchAll(/(\d{5,20})(?::\d+)?@lid/g)) {
      if (digits) await this.resolveLid(digits);
    }
  }

  /**
   * Troca cada marcação pelo que dá pra reconhecer: "@Você", o nome do WhatsApp da pessoa
   * ("@~Fulano") ou, sem nome conhecido, o telefone dela. Marcação que não deu pra descobrir de quem
   * é fica como veio.
   */
  private withMentionNames(text: string): string {
    if (!text.includes("@")) return text;
    return text.replace(MENTION_PATTERN, (token: string, digits: string) => {
      const phoneJid = this.mentionPhones.get(digits);
      const jids = [phoneJid, `${digits}@s.whatsapp.net`, `${digits}@lid`].filter((jid): jid is string => !!jid);
      if (jids.some((jid) => this.ownJids().includes(jid))) return "@Você";
      for (const jid of jids) {
        const name = this.store.lastPushName(jid);
        if (name) return `@~${name}`;
      }
      return phoneJid ? `@${formatPhoneForDisplay(phoneFromJid(phoneJid))}` : token;
    });
  }

  /** Mensagem recebida de alguém (privado ou grupo). */
  recordIncoming(sock: WASocket, msg: WAMessage, chatJid: string, senderJid: string, isGroup: boolean): ChatMessageRecord | null {
    const revokeKey = extractRevokeKey(msg);
    if (revokeKey?.id) return this.handleRevoke(chatJid, revokeKey.id);
    return this.record(sock, msg, chatJid, senderJid, isGroup, false, false);
  }

  /** Mensagem enviada pela própria conta: você no celular, o painel, ou o bot automaticamente. */
  recordOutgoing(sock: WASocket, msg: WAMessage, chatJid: string, isGroup: boolean, isBot: boolean): ChatMessageRecord | null {
    const revokeKey = extractRevokeKey(msg);
    if (revokeKey?.id) return this.handleRevoke(chatJid, revokeKey.id);
    return this.record(sock, msg, chatJid, null, isGroup, true, isBot);
  }

  /** "Apagar para todos" chegando (de outro aparelho seu, ou de quem mandou a mensagem original). */
  private handleRevoke(chatJid: string, targetId: string): ChatMessageRecord | null {
    const changed = this.store.markRevoked(chatJid, targetId);
    if (!changed) return null;
    const updated = this.store.getMessage(chatJid, targetId);
    if (updated) this.options.onMessage?.(updated, false);
    return updated;
  }

  private record(
    sock: WASocket,
    msg: WAMessage,
    chatJid: string,
    senderJid: string | null,
    isGroup: boolean,
    fromMe: boolean,
    isBot: boolean
  ): ChatMessageRecord | null {
    const id = msg.key.id;
    if (!id) return null;

    try {
      const content = extractChatContent(msg);
      if (!content) return null;

      // Aviso do WhatsApp ("Fulano adicionou Beltrano"): não é mensagem de ninguém — sem nome de
      // remetente na prévia e nunca como "sua" (não tem lado na conversa, fica centralizado)
      const system = content.type === "system" ? content.system : null;
      const pushName = system ? null : (msg.pushName ?? null);
      if (system) fromMe = false;

      const { message: stored, inserted } = this.store.recordMessageDetailed(
        {
          chatJid,
          id,
          senderJid,
          fromMe,
          isBot,
          pushName,
          type: content.type,
          text: system
            ? renderSystemText(system, (jids, role) => this.displayNameFor(jids, role, msg))
            : content.text && this.withMentionNames(content.text),
          mediaFile: null,
          mediaMimeType: content.mimeType,
          mediaFileName: content.fileName,
          mediaSeconds: content.seconds,
          isPtt: content.ptt,
          mediaDownloadFailed: false,
          quotedId: content.quotedId,
          reactionEmoji: content.reactionEmoji,
          reactionTargetId: content.reactionTargetId,
          status: null,
          timestamp: messageTimeMs(msg),
        },
        // fromMe (eco do que você mandou) traz o SEU pushName no payload do WhatsApp, não o do
        // contato — nunca pode ser usado pra nomear a conversa, senão o nome na lista vira o seu
        // próprio nome toda vez que você responde. Só o pushName de quem recebeu é confiável aqui.
        this.options.resolveChatName(chatJid, isGroup, fromMe ? null : pushName),
        DOWNLOADABLE_TYPES.has(content.type) ? content.mediaEnvelope : null
      );

      // Reentrega de uma mídia que já tem arquivo (ou já está baixando): não baixa de novo
      if (DOWNLOADABLE_TYPES.has(content.type) && (inserted || !stored.mediaFile)) {
        void this.downloadAndAttach(sock, downloadableMessage(msg, content), chatJid, id, content.mimeType);
      }

      this.options.onMessage?.(stored, inserted);
      return stored;
    } catch (err) {
      logger.error({ err, chatJid }, "Falha ao gravar mensagem no histórico do chat (ignorado)");
      return null;
    }
  }

  /**
   * Nome a mostrar num aviso de sistema pra uma pessoa (dada por todos os JIDs conhecidos dela):
   * "Você" se for a própria conta, o nome do WhatsApp dela (~Nome) se já apareceu no histórico ou veio
   * junto com esta mensagem, senão o telefone — e, sem nada disso (só LID), um termo genérico.
   */
  private displayNameFor(jids: string[], role: "actor" | "target", msg: WAMessage): string {
    const known = jids.map(normalizeJid);
    // Quem veio só pelo número interno (LID) ganha também o telefone de verdade, se já foi descoberto
    // (ver `prepareMentions`): é pelo telefone que o histórico guarda o nome da pessoa
    const viaLid = known.map((jid) => (jid.endsWith("@lid") ? this.mentionPhones.get(jid.split("@")[0]!.split(":")[0]!) : undefined)).filter((jid): jid is string => !!jid);
    const candidates = [...new Set([...known, ...viaLid])];

    if (candidates.some((jid) => this.ownJids().includes(jid))) return role === "actor" ? "Você" : "você";

    const key = msg.key as WAMessageKey & { participantAlt?: string | null };
    const senderJids = [key.participant, key.participantAlt, msg.participant].filter((j): j is string => !!j).map(normalizeJid);
    if (msg.pushName && candidates.some((jid) => senderJids.includes(jid))) return `~${msg.pushName}`;

    for (const jid of candidates) {
      const name = this.store.lastPushName(jid);
      if (name) return `~${name}`;
    }

    const phoneJid = candidates.find((jid) => jid.endsWith("@s.whatsapp.net"));
    if (phoneJid) return formatPhoneForDisplay(phoneFromJid(phoneJid));
    return role === "actor" ? "Alguém" : "um participante";
  }

  /** Os JIDs da própria conta (telefone e LID), ou vazio se a conexão ainda não está pronta. */
  private ownJids(): string[] {
    try {
      const user = this.options.getSock().user as { id?: string; lid?: string } | undefined;
      return [user?.id, user?.lid].filter((j): j is string => !!j).map(normalizeJid);
    } catch {
      return [];
    }
  }

  /**
   * Tenta baixar algumas vezes antes de desistir (uma falha de rede passageira não pode deixar a
   * mídia perdida pra sempre). Só na desistência final marca `mediaDownloadFailed`, pro painel
   * parar de mostrar "baixando…" pra algo que já não vai mais terminar.
   */
  private async downloadAndAttach(sock: WASocket, msg: WAMessage, chatJid: string, id: string, mimeType: string | null): Promise<void> {
    const download = this.options.downloadMedia ?? defaultDownloadMedia;
    const delays = this.options.mediaRetryDelaysMs ?? [1500, 4000];
    const attempts = [0, ...delays];

    for (let i = 0; i < attempts.length; i++) {
      if (attempts[i]! > 0) await Bun.sleep(attempts[i]!);
      if (this.closed) return; // conta foi parada enquanto esperava: o banco já fechou, não toca mais nele
      try {
        const buffer = await download(msg, sock);
        if (this.closed) return;
        const file = this.saveMediaFile(buffer, mimeType);
        this.store.updateMediaFile(chatJid, id, file);
        const updated = this.store.getMessage(chatJid, id);
        if (updated) this.options.onMessage?.(updated, false);
        return;
      } catch (err) {
        if (this.closed) return;
        const isLastAttempt = i === attempts.length - 1;
        if (isLastAttempt) {
          // Em "warn" (sempre visível) — em "debug" ninguém via o motivo real da falha (link
          // expirado, erro de rede, etc.) e parecia que a mídia só sumia sem explicação nenhuma.
          logger.warn({ err, chatJid, id, attempts: attempts.length }, "Falha ao baixar mídia da conversa (desistindo, já tentou de novo)");
          this.store.markMediaDownloadFailed(chatJid, id);
          const updated = this.store.getMessage(chatJid, id);
          if (updated) this.options.onMessage?.(updated, false);
        } else {
          logger.debug({ err, chatJid, id, attempt: i + 1, of: attempts.length }, "Falha ao baixar mídia da conversa (tentando de novo)");
        }
      }
    }
  }

  /**
   * Tenta baixar de novo uma mídia que já desistiu (ver `downloadAndAttach`). Reconstrói uma mensagem
   * mínima a partir do envelope salvo na hora de gravar — sem ele (mensagem de antes dessa guarda
   * existir, ou um tipo não suportado), não tem como tentar de novo.
   */
  async retryMediaDownload(chatJid: string, id: string): Promise<ChatMessageRecord> {
    const record = this.store.getMessage(chatJid, id);
    if (!record) throw new Error("Mensagem não encontrada.");
    if (record.mediaFile) return record; // já tem o arquivo, nada a fazer

    const envelope = this.store.getMediaEnvelope(chatJid, id);
    if (!envelope || !DOWNLOADABLE_TYPES.has(record.type)) {
      throw new Error("Essa mídia não pode ser baixada de novo.");
    }
    if (!this.options.isConnected()) throw new Error("O WhatsApp desta conta está desconectado.");

    const fakeMsg = {
      key: { remoteJid: chatJid, id, fromMe: record.fromMe, participant: record.senderJid ?? undefined },
      message: { [`${record.type}Message`]: envelope },
    } as unknown as WAMessage;

    this.store.markMediaDownloadFailed(chatJid, id, false);
    const resetRecord = this.store.getMessage(chatJid, id);
    if (resetRecord) this.options.onMessage?.(resetRecord, false);

    await this.downloadAndAttach(this.options.getSock(), fakeMsg, chatJid, id, record.mediaMimeType);
    return this.store.getMessage(chatJid, id)!;
  }

  /**
   * Tenta de novo, sozinho, toda mídia que desistiu em qualquer conversa — pra uma falha passageira
   * de rede/DNS (ex.: uma figurinha que não baixou) se resolver sem precisar clicar "Tentar de novo"
   * uma a uma. Chamado de tempos em tempos (ver `account.ts`); depois de `MAX_AUTO_RETRY_SWEEPS`
   * tentativas sem sucesso, uma mídia específica para de ser tentada sozinha (falha persistente, não
   * passageira) — só "Tentar de novo" manual tenta ela de novo a partir daí.
   */
  async retryAllFailedMedia(): Promise<void> {
    if (!this.options.isConnected()) return;
    for (const { chatJid, id } of this.store.listFailedMediaMessages(MAX_AUTO_RETRY_SWEEPS)) {
      if (this.closed) return;
      this.store.incrementMediaRetrySweepCount(chatJid, id);
      try {
        await this.retryMediaDownload(chatJid, id);
      } catch (err) {
        logger.debug({ err, chatJid, id }, "Nova tentativa automática de baixar mídia falhou de novo (ignorado)");
      }
    }
  }

  private saveMediaFile(buffer: Buffer, mimeType: string | null): string {
    mkdirSync(this.options.mediaDir, { recursive: true });
    const filename = `${randomUUID()}.${extFromMime(mimeType)}`;
    writeFileSync(join(this.options.mediaDir, filename), buffer);
    return filename;
  }

  /** Caminho em disco da mídia de uma mensagem, ou null se ela não tem (ou ainda não baixou). */
  getMediaPath(chatJid: string, id: string): { path: string; mimeType: string | null; fileName: string | null } | null {
    const msg = this.store.getMessage(chatJid, id);
    if (!msg?.mediaFile) return null;
    return { path: join(this.options.mediaDir, msg.mediaFile), mimeType: msg.mediaMimeType, fileName: msg.mediaFileName };
  }

  /** Conversas ativas (não arquivadas), fixadas primeiro. */
  listChats(): ChatSummary[] {
    return this.store.listChats();
  }

  /** Só as arquivadas (pra seção "Arquivadas" do painel). */
  listArchivedChats(): ChatSummary[] {
    return this.store.listArchivedChats();
  }

  /** Galeria de mídia já baixada dessa conversa, pros "dados do contato/grupo". */
  listMediaMessages(chatJid: string): ChatMessageRecord[] {
    return this.store.listMediaMessages(chatJid);
  }

  /** Grupos em comum com essa pessoa (por qualquer um dos JIDs conhecidos dela), pelo que o histórico já viu. */
  groupsInCommon(participantJids: string[]): ChatSummary[] {
    return this.store.groupsInCommon(participantJids);
  }

  createFolder(name: string): ChatFolder {
    return this.store.createFolder(name);
  }

  deleteFolder(id: string): boolean {
    return this.store.deleteFolder(id);
  }

  listFolders(): ChatFolder[] {
    return this.store.listFolders();
  }

  addChatToFolder(folderId: string, chatJid: string): void {
    this.store.addChatToFolder(folderId, chatJid);
  }

  removeChatFromFolder(folderId: string, chatJid: string): void {
    this.store.removeChatFromFolder(folderId, chatJid);
  }

  foldersForChat(chatJid: string): string[] {
    return this.store.foldersForChat(chatJid);
  }

  listChatsInFolder(folderId: string): ChatSummary[] {
    return this.store.listChatsInFolder(folderId);
  }

  /** Fixa (ou desafixa) uma conversa no topo da lista. */
  setPinned(chatJid: string, pinned: boolean, temporary = false): void {
    this.store.setPinned(chatJid, pinned, temporary);
  }

  /** Desafixa só se a fixada era temporária (até o pagamento) — chamado quando o agradecimento da MisticPay sai. */
  unpinIfTemporary(chatJid: string): void {
    this.store.unpinIfTemporary(chatJid);
  }

  /** Arquiva (ou desarquiva) uma conversa: some da lista principal, continua recebendo mensagens normalmente. */
  setArchived(chatJid: string, archived: boolean): void {
    this.store.setArchived(chatJid, archived);
  }

  isArchived(chatJid: string): boolean {
    return this.store.isArchived(chatJid);
  }

  /** Mensagens de texto que contêm o termo buscado nesta conversa, mais recente primeiro. */
  searchMessages(chatJid: string, query: string, limit?: number): ChatMessageRecord[] {
    return this.store.searchMessages(chatJid, query, limit);
  }

  /**
   * Mensagens prontas pra tela: reações viram um detalhe anexado à mensagem alvo (não aparecem como
   * linha própria) e citações ganham uma prévia de "em resposta a...". Só enxerga o que está dentro
   * da mesma página — uma reação cujo alvo ficou numa página mais antiga (ainda não carregada) fica
   * de fora por enquanto; ela aparece quando aquela página for carregada.
   */
  listMessages(chatJid: string, opts?: { before?: number; limit?: number }): ChatMessageView[] {
    const rows = this.store.listMessages(chatJid, opts);

    const reactionsByTarget = new Map<string, ChatMessageRecord[]>();
    const regular: ChatMessageRecord[] = [];
    for (const row of rows) {
      if (row.type === "reaction" && row.reactionTargetId) {
        const list = reactionsByTarget.get(row.reactionTargetId) ?? [];
        list.push(row);
        reactionsByTarget.set(row.reactionTargetId, list);
      } else {
        regular.push(row);
      }
    }

    return regular.map((m) => {
      const view: ChatMessageView = { ...m };

      if (m.quotedId) {
        const quoted = this.store.getMessage(chatJid, m.quotedId);
        view.quotedPreview = quoted
          ? { id: quoted.id, fromMe: quoted.fromMe, pushName: quoted.pushName, type: quoted.type, text: quoted.text }
          : null;
      }

      const reactionRows = reactionsByTarget.get(m.id);
      if (reactionRows) {
        // O WhatsApp só guarda a reação mais recente de cada pessoa (reagir de novo troca; reagir com
        // o mesmo emoji de novo remove — chega aqui com texto vazio).
        const latestBySender = new Map<string, ChatMessageRecord>();
        for (const r of [...reactionRows].sort((a, b) => a.timestamp - b.timestamp)) {
          latestBySender.set(r.fromMe ? "__me__" : (r.senderJid ?? r.id), r);
        }
        const reactions = [...latestBySender.values()]
          .filter((r) => r.reactionEmoji)
          .map((r) => ({ emoji: r.reactionEmoji!, fromMe: r.fromMe, pushName: r.pushName }));
        if (reactions.length) view.reactions = reactions;
      }

      return view;
    });
  }

  /**
   * `listMessages` com as marcações trocadas pelo nome também nas mensagens antigas, gravadas quando
   * a marcação ainda ficava só como número (as novas já são gravadas com o nome).
   */
  async listMessagesWithMentions(chatJid: string, opts?: { before?: number; limit?: number }): Promise<ChatMessageView[]> {
    const views = this.listMessages(chatJid, opts);
    for (const view of views) {
      if (view.type === "system") continue;
      await this.warmMentions(view.text);
      await this.warmMentions(view.quotedPreview?.text);
      if (view.text) view.text = this.withMentionNames(view.text);
      if (view.quotedPreview?.text) view.quotedPreview = { ...view.quotedPreview, text: this.withMentionNames(view.quotedPreview.text) };
    }
    return views;
  }

  /** Zera o contador de não lidas (o painel chama ao abrir a conversa). */
  markRead(chatJid: string): void {
    this.store.markRead(chatJid);
  }

  /** Zera o contador de não lidas de todas as conversas de uma vez (botão "ler tudo" do painel). */
  markAllRead(): void {
    this.store.markAllRead();
  }

  /** Quantas conversas diferentes têm mensagem não lida — pro selo na barra de contas. */
  countUnreadChats(): number {
    return this.store.countUnreadChats();
  }

  /** O WhatsApp avisou que uma mensagem que você (ou o bot) enviou mudou de status (entregue, lida...). */
  updateMessageStatus(key: WAMessageKey, status: number | null | undefined): void {
    const chatJid = key.remoteJid;
    const id = key.id;
    const label = status != null ? STATUS_LABELS[status] : undefined;
    if (!chatJid || !id || !label) return;

    const changed = this.store.updateStatus(chatJid, id, label);
    if (!changed) return;
    const updated = this.store.getMessage(chatJid, id);
    if (updated) this.options.onMessage?.(updated, false);
  }

  /** Monta um "esqueleto" da mensagem citada a partir do que já temos guardado, pra o WhatsApp mostrar a tarja de resposta. */
  private buildQuotedStanza(chatJid: string, quotedId: string | undefined, isGroup: boolean): WAMessage | undefined {
    if (!quotedId) return undefined;
    const target = this.store.getMessage(chatJid, quotedId);
    if (!target) return undefined;
    return {
      key: {
        remoteJid: chatJid,
        id: target.id,
        fromMe: target.fromMe,
        participant: isGroup && !target.fromMe ? (target.senderJid ?? undefined) : undefined,
      },
      message: { conversation: target.text || "" },
    } as WAMessage;
  }

  /**
   * Envia uma mensagem (texto e/ou mídia, opcionalmente respondendo a outra)
   * como se fosse você respondendo pelo celular: sem marcar o ID como
   * "enviado pelo bot", o eco que o WhatsApp devolve entra pelo fluxo normal
   * de resposta do operador (cancela a saudação automática, satisfaz a
   * segurança). Grava otimisticamente já aqui; quando o eco chegar, o mesmo
   * ID só confirma a mesma linha (não duplica).
   */
  async sendAsOperator(chatJid: string, input: { text?: string; media?: OperatorMediaInput; quotedId?: string }): Promise<ChatMessageRecord> {
    const text = (input.text ?? "").trim();
    if (!text && !input.media) throw new Error("Mensagem vazia.");
    if (!this.options.isConnected()) throw new Error("O WhatsApp desta conta está desconectado.");

    const sock = this.options.getSock();
    const messageId = generateMessageIDV2(sock.user?.id);
    this.panelSent.mark(messageId); // antes de enviar: o eco pode chegar antes de o envio "terminar"
    const isGroup = chatJid.endsWith("@g.us");
    const quoted = this.buildQuotedStanza(chatJid, input.quotedId, isGroup);

    let mediaFile: string | null = null;
    let type: ChatMessageType = "text";
    let mediaMimeType: string | null = null;
    let mediaFileName: string | null = null;
    let isPtt = false;

    if (input.media) {
      const buffer = Buffer.from(input.media.dataBase64, "base64");
      await sock.sendMessage(chatJid, buildOutgoingContent(input.media, text, buffer), { messageId, quoted });
      mediaFile = this.saveMediaFile(buffer, input.media.mimeType);
      type = input.media.type;
      mediaMimeType = input.media.mimeType;
      mediaFileName = input.media.fileName ?? null;
      isPtt = !!input.media.ptt;
    } else {
      await sock.sendMessage(chatJid, { text }, { messageId, quoted });
    }

    const stored = this.store.recordMessage(
      {
        chatJid,
        id: messageId,
        senderJid: null,
        fromMe: true,
        isBot: false,
        pushName: null,
        type,
        text: text || null,
        mediaFile,
        mediaMimeType,
        mediaFileName,
        mediaSeconds: null,
        isPtt,
        mediaDownloadFailed: false,
        quotedId: input.quotedId ?? null,
        reactionEmoji: null,
        reactionTargetId: null,
        status: null,
        timestamp: Date.now(),
      },
      this.options.resolveChatName(chatJid, isGroup, null)
    );
    this.options.onMessage?.(stored, true);
    return stored;
  }

  /** Essa mensagem foi mandada pelo painel (e não digitada no celular)? */
  wasSentFromPanel(id: string | null | undefined): boolean {
    return this.panelSent.has(id);
  }

  /** "Apagar para mim": some do histórico deste painel (não mexe no WhatsApp de verdade, nem avisa ninguém). */
  deleteForMe(chatJid: string, id: string): boolean {
    const removed = this.store.deleteMessage(chatJid, id);
    if (removed) this.options.onMessageDeleted?.(chatJid, id);
    return removed;
  }

  /** "Apagar para todos": só pra mensagem sua, e só dentro do prazo que o WhatsApp ainda aceitar. */
  async deleteForEveryone(chatJid: string, id: string): Promise<ChatMessageRecord> {
    if (!this.options.isConnected()) throw new Error("O WhatsApp desta conta está desconectado.");
    const target = this.store.getMessage(chatJid, id);
    if (!target) throw new Error("Mensagem não encontrada.");
    if (!target.fromMe) throw new Error("Só é possível apagar para todos uma mensagem enviada por você.");

    const sock = this.options.getSock();
    const isGroup = chatJid.endsWith("@g.us");
    const key: WAMessageKey = { remoteJid: chatJid, id, fromMe: true, participant: isGroup ? (sock.user?.id ?? undefined) : undefined };
    await sock.sendMessage(chatJid, { delete: key });

    this.store.markRevoked(chatJid, id);
    const updated = this.store.getMessage(chatJid, id)!;
    this.options.onMessage?.(updated, false);
    return updated;
  }

  /**
   * Reage (ou tira a reação, mandando `emoji` vazio) a uma mensagem — igual ao WhatsApp normal.
   * Grava otimisticamente a reação como uma linha própria (igual a uma reação recebida); quando o
   * eco do WhatsApp chegar com o mesmo ID, o `INSERT OR IGNORE` do `recordMessage` não duplica.
   */
  async reactToMessage(chatJid: string, targetId: string, emoji: string): Promise<ChatMessageRecord> {
    if (!this.options.isConnected()) throw new Error("O WhatsApp desta conta está desconectado.");
    const target = this.store.getMessage(chatJid, targetId);
    if (!target) throw new Error("Mensagem não encontrada.");

    const sock = this.options.getSock();
    const isGroup = chatJid.endsWith("@g.us");
    const reactionId = generateMessageIDV2(sock.user?.id);
    const targetKey: WAMessageKey = {
      remoteJid: chatJid,
      id: targetId,
      fromMe: target.fromMe,
      participant: isGroup && !target.fromMe ? (target.senderJid ?? undefined) : undefined,
    };
    await sock.sendMessage(chatJid, { react: { text: emoji, key: targetKey } });

    const stored = this.store.recordMessage(
      {
        chatJid,
        id: reactionId,
        senderJid: null,
        fromMe: true,
        isBot: false,
        pushName: null,
        type: "reaction",
        text: null,
        mediaFile: null,
        mediaMimeType: null,
        mediaFileName: null,
        mediaSeconds: null,
        isPtt: false,
        mediaDownloadFailed: false,
        quotedId: null,
        reactionEmoji: emoji || null,
        reactionTargetId: targetId,
        status: null,
        timestamp: Date.now(),
      },
      this.options.resolveChatName(chatJid, isGroup, null)
    );
    this.options.onMessage?.(stored, true);
    return stored;
  }

  /** Reenvia uma mensagem já recebida (ou enviada) pra outra conversa — texto ou mídia (lida de volta do disco). */
  async forwardMessage(sourceChatJid: string, messageId: string, targetChatJid: string): Promise<ChatMessageRecord> {
    if (!this.options.isConnected()) throw new Error("O WhatsApp desta conta está desconectado.");
    const source = this.store.getMessage(sourceChatJid, messageId);
    if (!source) throw new Error("Mensagem não encontrada.");

    const needsMedia = DOWNLOADABLE_TYPES.has(source.type);
    if (needsMedia && !source.mediaFile) throw new Error("A mídia ainda não terminou de baixar — espere um pouco e tente de novo.");
    const buffer = needsMedia ? readFileSync(join(this.options.mediaDir, source.mediaFile!)) : null;
    const content = buildForwardContent(source, buffer);

    const sock = this.options.getSock();
    const messageId2 = generateMessageIDV2(sock.user?.id);
    await sock.sendMessage(targetChatJid, content, { messageId: messageId2 });

    const mediaFile = buffer ? this.saveMediaFile(buffer, source.mediaMimeType) : null;
    const isGroup = targetChatJid.endsWith("@g.us");
    const stored = this.store.recordMessage(
      {
        chatJid: targetChatJid,
        id: messageId2,
        senderJid: null,
        fromMe: true,
        isBot: false,
        pushName: null,
        type: source.type,
        text: source.text,
        mediaFile,
        mediaMimeType: source.mediaMimeType,
        mediaFileName: source.mediaFileName,
        mediaSeconds: source.mediaSeconds,
        isPtt: source.isPtt,
        mediaDownloadFailed: false,
        quotedId: null,
        reactionEmoji: null,
        reactionTargetId: null,
        status: null,
        timestamp: Date.now(),
      },
      this.options.resolveChatName(targetChatJid, isGroup, null)
    );
    this.options.onMessage?.(stored, true);
    return stored;
  }

  close(): void {
    this.closed = true;
    this.store.close();
  }
}
