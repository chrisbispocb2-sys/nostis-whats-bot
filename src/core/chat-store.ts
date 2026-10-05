import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { ChatMessageType } from "../utils/chat-content";

/**
 * Buffer/Uint8Array (mediaKey, fileEncSha256...) não serializa em JSON sozinho: guarda como base64
 * marcado. `Buffer` tem um `toJSON()` próprio que o `JSON.stringify` já aplica ANTES do replacer ver
 * o valor (vira `{type:"Buffer",data:[...]}`), por isso trata os dois formatos abaixo.
 */
function serializeMediaEnvelope(envelope: unknown): string {
  return JSON.stringify(envelope, (_key, value) => {
    if (value instanceof Uint8Array) return { __u8: Buffer.from(value).toString("base64") };
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data)) {
      return { __u8: Buffer.from((value as { data: number[] }).data).toString("base64") };
    }
    if (value && typeof value === "object" && typeof (value as { toNumber?: unknown }).toNumber === "function") {
      return (value as { toNumber(): number }).toNumber();
    }
    return value;
  });
}

function deserializeMediaEnvelope(json: string): unknown {
  return JSON.parse(json, (_key, value) => {
    if (value && typeof value === "object" && typeof (value as { __u8?: unknown }).__u8 === "string") {
      return Buffer.from((value as { __u8: string }).__u8, "base64");
    }
    return value;
  });
}

export interface ChatSummary {
  jid: string;
  isGroup: boolean;
  name: string | null;
  lastMessageAt: number;
  lastMessagePreview: string | null;
  lastMessageType: ChatMessageType | null;
  /** Nome (pushName) de quem mandou a última mensagem — usado no "~Fulano: texto" da lista de grupos. */
  lastMessageSenderName: string | null;
  lastMessageFromMe: boolean;
  unreadCount: number;
  pinnedAt: number | null;
  /** Fixada "até o pagamento": desafixa sozinha quando a MisticPay confirma e agradece (ver `unpinIfTemporary`). */
  pinIsTemporary: boolean;
  archived: boolean;
  updatedAt: number;
}

/** Uma lista de conversas criada por você (ex.: "Clientes Premium"), igual às listas do WhatsApp. */
export interface ChatFolder {
  id: string;
  name: string;
  position: number;
  createdAt: number;
}

export interface ChatMessageRecord {
  chatJid: string;
  id: string;
  senderJid: string | null;
  fromMe: boolean;
  isBot: boolean;
  pushName: string | null;
  type: ChatMessageType;
  text: string | null;
  mediaFile: string | null;
  mediaMimeType: string | null;
  mediaFileName: string | null;
  mediaSeconds: number | null;
  isPtt: boolean;
  /** Já desistiu de baixar (depois de tentar de novo algumas vezes) — distingue de "ainda baixando". */
  mediaDownloadFailed: boolean;
  quotedId: string | null;
  reactionEmoji: string | null;
  reactionTargetId: string | null;
  status: string | null;
  timestamp: number;
  createdAt: number;
}

export type NewChatMessage = Omit<ChatMessageRecord, "createdAt">;

interface ChatRow {
  chat_jid: string;
  id: string;
  sender_jid: string | null;
  from_me: number;
  is_bot: number;
  push_name: string | null;
  type: string;
  text: string | null;
  media_file: string | null;
  media_mime_type: string | null;
  media_file_name: string | null;
  media_seconds: number | null;
  is_ptt: number;
  media_download_failed: number;
  quoted_id: string | null;
  reaction_emoji: string | null;
  reaction_target_id: string | null;
  status: string | null;
  timestamp: number;
  created_at: number;
}

interface SummaryRow {
  jid: string;
  is_group: number;
  name: string | null;
  last_message_at: number;
  last_message_preview: string | null;
  last_message_type: string | null;
  last_message_sender_name: string | null;
  last_message_from_me: number;
  unread_count: number;
  pinned_at: number | null;
  pin_is_temporary: number;
  archived: number;
  updated_at: number;
}

function rowToMessage(r: ChatRow): ChatMessageRecord {
  return {
    chatJid: r.chat_jid,
    id: r.id,
    senderJid: r.sender_jid,
    fromMe: !!r.from_me,
    isBot: !!r.is_bot,
    pushName: r.push_name,
    type: r.type as ChatMessageType,
    text: r.text,
    mediaFile: r.media_file,
    mediaMimeType: r.media_mime_type,
    mediaFileName: r.media_file_name,
    mediaSeconds: r.media_seconds,
    isPtt: !!r.is_ptt,
    mediaDownloadFailed: !!r.media_download_failed,
    quotedId: r.quoted_id,
    reactionEmoji: r.reaction_emoji,
    reactionTargetId: r.reaction_target_id,
    status: r.status,
    timestamp: r.timestamp,
    createdAt: r.created_at,
  };
}

function rowToSummary(r: SummaryRow): ChatSummary {
  return {
    jid: r.jid,
    isGroup: !!r.is_group,
    name: r.name,
    lastMessageAt: r.last_message_at,
    lastMessagePreview: r.last_message_preview,
    lastMessageType: r.last_message_type as ChatMessageType | null,
    lastMessageSenderName: r.last_message_sender_name,
    lastMessageFromMe: !!r.last_message_from_me,
    unreadCount: r.unread_count,
    pinnedAt: r.pinned_at,
    pinIsTemporary: !!r.pin_is_temporary,
    archived: !!r.archived,
    updatedAt: r.updated_at,
  };
}

/** Previsão curta pra lista de conversas (o que aparece abaixo do nome, tipo WhatsApp). */
export function previewFor(content: { type: ChatMessageType; text: string | null }): string {
  switch (content.type) {
    case "text":
    case "system":
      return content.text || "";
    case "image":
      return content.text ? `📷 ${content.text}` : "📷 Imagem";
    case "video":
      return content.text ? `🎥 ${content.text}` : "🎥 Vídeo";
    case "audio":
      return "🎤 Áudio";
    case "document":
      return "📄 Documento";
    case "sticker":
      return "Figurinha";
    case "location":
      return "📍 Localização";
    case "contact":
      return "👤 Contato";
    case "reaction":
      return "Reagiu a uma mensagem";
    case "revoked":
      return "🚫 Mensagem apagada";
    default:
      return "Mensagem";
  }
}

/** Escapa `%`, `_` e a própria barra de escape, pra buscar o texto literal (ex.: "50%") sem virar curinga do SQL. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Histórico de conversas (privadas e de grupo) de uma conta, em SQLite — ao
 * contrário dos outros dados do bot (JSON reescrito inteiro a cada gravação),
 * o chat cresce sem teto e precisa de paginação de verdade.
 */
export class ChatStore {
  private readonly db: Database;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        is_group INTEGER NOT NULL,
        name TEXT,
        last_message_at INTEGER NOT NULL DEFAULT 0,
        last_message_preview TEXT,
        last_message_type TEXT,
        last_message_sender_name TEXT,
        last_message_from_me INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        pinned_at INTEGER,
        archived INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        chat_jid TEXT NOT NULL,
        id TEXT NOT NULL,
        sender_jid TEXT,
        from_me INTEGER NOT NULL,
        is_bot INTEGER NOT NULL DEFAULT 0,
        push_name TEXT,
        type TEXT NOT NULL,
        text TEXT,
        media_file TEXT,
        media_mime_type TEXT,
        media_file_name TEXT,
        media_seconds INTEGER,
        is_ptt INTEGER NOT NULL DEFAULT 0,
        media_download_failed INTEGER NOT NULL DEFAULT 0,
        media_envelope TEXT,
        quoted_id TEXT,
        reaction_emoji TEXT,
        reaction_target_id TEXT,
        status TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chat_jid, id)
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp DESC, id DESC);");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_jid);");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_chats_last ON chats(last_message_at DESC);");

    // Bancos criados antes de existir fixar/arquivar não têm essas colunas: adiciona sem apagar nada.
    this.ensureColumn("chats", "pinned_at", "INTEGER");
    this.ensureColumn("chats", "archived", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("chats", "pin_is_temporary", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("messages", "media_download_failed", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("messages", "media_envelope", "TEXT");
    this.ensureColumn("chats", "last_message_sender_name", "TEXT");
    this.ensureColumn("chats", "last_message_from_me", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("messages", "media_retry_sweep_count", "INTEGER NOT NULL DEFAULT 0");
    this.runOnce(1, () => {
      // Mídias que desistiram por causa do servidor `a.whatsapp.net` (nome que não existe no DNS)
      // tinham gasto todas as tentativas automáticas sem nunca poder dar certo. Agora que o download
      // cai pro servidor padrão (ver `downloadWithHostFallback`), ganham uma rodada nova.
      this.db.run("UPDATE messages SET media_retry_sweep_count = 0 WHERE media_download_failed = 1 AND media_file IS NULL");
    });

    this.db.run(`
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS folder_chats (
        folder_id TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (folder_id, chat_jid)
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_folder_chats_chat ON folder_chats(chat_jid);");
  }

  /** Roda um ajuste nos dados uma única vez por banco (controlado pelo `user_version` do SQLite). */
  private runOnce(version: number, migrate: () => void): void {
    const { user_version: current } = this.db.query("PRAGMA user_version").get() as { user_version: number };
    if (current >= version) return;
    migrate();
    this.db.run(`PRAGMA user_version = ${version}`);
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  /** Garante que a conversa exista (criando com o nome informado) e atualiza o nome se ele mudou. */
  touchChat(jid: string, isGroup: boolean, name: string | null): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO chats (jid, is_group, name, last_message_at, updated_at)
         VALUES ($jid, $isGroup, $name, 0, $now)
         ON CONFLICT(jid) DO UPDATE SET
           name = COALESCE(excluded.name, chats.name),
           updated_at = $now`
      )
      .run({ $jid: jid, $isGroup: isGroup ? 1 : 0, $name: name, $now: now });
  }

  /**
   * Grava uma mensagem (idempotente: a mesma `(chatJid, id)` nunca duplica). `mediaEnvelope` (só pra
   * tipos baixáveis) é o objeto de mídia cru — guardado pra dar pra tentar baixar de novo bem mais
   * tarde, quando o `WAMessage` original já não existe mais em memória (ver `retryMediaDownload`).
   */
  recordMessage(msg: NewChatMessage, chatName: string | null, mediaEnvelope?: unknown): ChatMessageRecord {
    return this.recordMessageDetailed(msg, chatName, mediaEnvelope).message;
  }

  /**
   * Igual a `recordMessage`, mas diz também se a mensagem era nova de verdade (`inserted`) ou só uma
   * repetição de uma que já estava guardada — o WhatsApp reentrega mensagens (reconexão, eco do que o
   * painel acabou de mandar), e uma repetição não pode contar como não lida nem tocar o som de novo.
   */
  recordMessageDetailed(msg: NewChatMessage, chatName: string | null, mediaEnvelope?: unknown): { message: ChatMessageRecord; inserted: boolean } {
    const now = Date.now();
    this.touchChat(msg.chatJid, msg.chatJid.endsWith("@g.us"), chatName);

    const { changes } = this.db
      .query(
        `INSERT OR IGNORE INTO messages (
          chat_jid, id, sender_jid, from_me, is_bot, push_name, type, text,
          media_file, media_mime_type, media_file_name, media_seconds, is_ptt,
          media_envelope, quoted_id, reaction_emoji, reaction_target_id, status, timestamp, created_at
        ) VALUES (
          $chatJid, $id, $senderJid, $fromMe, $isBot, $pushName, $type, $text,
          $mediaFile, $mediaMimeType, $mediaFileName, $mediaSeconds, $isPtt,
          $mediaEnvelope, $quotedId, $reactionEmoji, $reactionTargetId, $status, $timestamp, $createdAt
        )`
      )
      .run({
        $chatJid: msg.chatJid,
        $id: msg.id,
        $senderJid: msg.senderJid,
        $fromMe: msg.fromMe ? 1 : 0,
        $isBot: msg.isBot ? 1 : 0,
        $pushName: msg.pushName,
        $type: msg.type,
        $text: msg.text,
        $mediaFile: msg.mediaFile,
        $mediaMimeType: msg.mediaMimeType,
        $mediaFileName: msg.mediaFileName,
        $mediaSeconds: msg.mediaSeconds,
        $isPtt: msg.isPtt ? 1 : 0,
        $mediaEnvelope: mediaEnvelope != null ? serializeMediaEnvelope(mediaEnvelope) : null,
        $quotedId: msg.quotedId,
        $reactionEmoji: msg.reactionEmoji,
        $reactionTargetId: msg.reactionTargetId,
        $status: msg.status,
        $timestamp: msg.timestamp,
        $createdAt: now,
      });

    const stored = this.getMessage(msg.chatJid, msg.id)!;

    // Só avança o "último visto" da conversa se esta mensagem é mais nova (histórico de backlog não deve empurrar pra frente)
    this.db
      .query(
        `UPDATE chats SET
           last_message_at = $at, last_message_preview = $preview, last_message_type = $type,
           last_message_sender_name = $senderName, last_message_from_me = $fromMe, updated_at = $now
         WHERE jid = $jid AND $at >= last_message_at`
      )
      .run({
        $jid: msg.chatJid,
        $at: msg.timestamp,
        $preview: previewFor(stored),
        $type: msg.type,
        $senderName: msg.pushName,
        $fromMe: msg.fromMe ? 1 : 0,
        $now: now,
      });

    // Mensagem de alguém (não sua): conta como não lida até a conversa ser aberta no painel
    const inserted = changes > 0;
    // Avisos do próprio WhatsApp ("Fulano entrou no grupo") não contam como mensagem não lida
    if (!msg.fromMe && inserted && msg.type !== "system") {
      this.db
        .query("UPDATE chats SET unread_count = unread_count + 1 WHERE jid = $jid")
        .run({ $jid: msg.chatJid });
    }

    return { message: stored, inserted };
  }

  /** Zera o contador de não lidas (chamado quando o painel abre a conversa). */
  markRead(chatJid: string): void {
    this.db.query("UPDATE chats SET unread_count = 0 WHERE jid = $jid").run({ $jid: chatJid });
  }

  /** Zera o contador de não lidas de TODAS as conversas (inclusive arquivadas) de uma vez. */
  markAllRead(): void {
    this.db.query("UPDATE chats SET unread_count = 0 WHERE unread_count != 0").run();
  }

  /** Quantas conversas diferentes (não arquivadas) têm mensagem não lida — pro selo na barra de contas. */
  countUnreadChats(): number {
    const row = this.db.query("SELECT COUNT(*) as c FROM chats WHERE unread_count > 0 AND archived = 0").get() as { c: number };
    return row.c;
  }

  /**
   * Fixa (ou desafixa) uma conversa no topo da lista. `temporary` marca que essa fixada é "até o
   * pagamento" — só esse tipo desafixa sozinho (ver `unpinIfTemporary`); a fixada normal (igual ao
   * WhatsApp original) só sai quando a pessoa desafixar à mão.
   */
  setPinned(chatJid: string, pinned: boolean, temporary = false): void {
    this.db
      .query("UPDATE chats SET pinned_at = $at, pin_is_temporary = $temp WHERE jid = $jid")
      .run({ $jid: chatJid, $at: pinned ? Date.now() : null, $temp: pinned && temporary ? 1 : 0 });
  }

  /** Desafixa só se a fixada era "temporária" (até o pagamento) — nunca mexe numa fixada permanente. */
  unpinIfTemporary(chatJid: string): void {
    this.db
      .query("UPDATE chats SET pinned_at = NULL, pin_is_temporary = 0 WHERE jid = $jid AND pin_is_temporary = 1")
      .run({ $jid: chatJid });
  }

  /** Arquiva (ou desarquiva) uma conversa: some da lista principal, mas continua recebendo mensagens. */
  isArchived(chatJid: string): boolean {
    const row = this.db.query("SELECT archived FROM chats WHERE jid = $jid").get({ $jid: chatJid }) as { archived: number } | null;
    return row?.archived === 1;
  }

  setArchived(chatJid: string, archived: boolean): void {
    this.db.query("UPDATE chats SET archived = $v WHERE jid = $jid").run({ $jid: chatJid, $v: archived ? 1 : 0 });
  }

  /** Recalcula a prévia/último horário da conversa a partir do que sobrou (chamado após apagar/revogar). */
  private refreshLastMessagePreview(chatJid: string): void {
    const row = this.db
      .query("SELECT * FROM messages WHERE chat_jid = $chatJid ORDER BY timestamp DESC, id DESC LIMIT 1")
      .get({ $chatJid: chatJid }) as ChatRow | null;
    const now = Date.now();

    if (row) {
      const msg = rowToMessage(row);
      this.db
        .query(
          `UPDATE chats SET last_message_at = $at, last_message_preview = $preview, last_message_type = $type,
             last_message_sender_name = $senderName, last_message_from_me = $fromMe, updated_at = $now WHERE jid = $jid`
        )
        .run({
          $jid: chatJid,
          $at: msg.timestamp,
          $preview: previewFor(msg),
          $type: msg.type,
          $senderName: msg.pushName,
          $fromMe: msg.fromMe ? 1 : 0,
          $now: now,
        });
    } else {
      this.db
        .query(
          `UPDATE chats SET last_message_at = 0, last_message_preview = NULL, last_message_type = NULL,
             last_message_sender_name = NULL, last_message_from_me = 0, updated_at = $now WHERE jid = $jid`
        )
        .run({ $jid: chatJid, $now: now });
    }
  }

  /** "Apagar para todos": marca a mensagem como apagada (vira uma tarja "Mensagem apagada", não some da conversa). */
  markRevoked(chatJid: string, id: string): boolean {
    const { changes } = this.db
      .query(
        `UPDATE messages SET
           type = 'revoked', text = NULL, media_file = NULL, media_mime_type = NULL, media_file_name = NULL,
           media_seconds = NULL, is_ptt = 0, reaction_emoji = NULL, reaction_target_id = NULL
         WHERE chat_jid = $chatJid AND id = $id`
      )
      .run({ $chatJid: chatJid, $id: id });
    if (changes === 0) return false;
    this.refreshLastMessagePreview(chatJid);
    return true;
  }

  /** "Apagar para mim": some do histórico deste painel (não mexe no WhatsApp de verdade). */
  deleteMessage(chatJid: string, id: string): boolean {
    const { changes } = this.db
      .query("DELETE FROM messages WHERE chat_jid = $chatJid AND id = $id")
      .run({ $chatJid: chatJid, $id: id });
    if (changes === 0) return false;
    this.refreshLastMessagePreview(chatJid);
    return true;
  }

  /** Mensagens de texto que contêm o termo buscado, mais recente primeiro. */
  searchMessages(chatJid: string, query: string, limit = 50): ChatMessageRecord[] {
    const rows = this.db
      .query("SELECT * FROM messages WHERE chat_jid = $chatJid AND text LIKE $q ESCAPE '\\' ORDER BY timestamp DESC, id DESC LIMIT $limit")
      .all({ $chatJid: chatJid, $q: `%${escapeLike(query)}%`, $limit: limit }) as ChatRow[];
    return rows.map(rowToMessage);
  }

  /** Mídia já baixada dessa conversa (fotos, vídeos, áudios, documentos, figurinhas), mais recente primeiro — pra galeria do "dados do contato". */
  listMediaMessages(chatJid: string, limit = 30): ChatMessageRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM messages
         WHERE chat_jid = $chatJid AND media_file IS NOT NULL
         AND type IN ('image', 'video', 'document', 'sticker')
         ORDER BY timestamp DESC, id DESC LIMIT $limit`
      )
      .all({ $chatJid: chatJid, $limit: limit }) as ChatRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Grupos onde essa pessoa já mandou mensagem (pelo que o histórico já viu) — "grupos em comum"
   * do WhatsApp. Recebe uma LISTA de JIDs (não só um): a mesma pessoa pode aparecer com JIDs
   * diferentes em grupos diferentes (telefone numa, LID — identidade oculta — noutra), então quem
   * chama já manda todos os apelidos conhecidos dela (ver `ConversationTracker.aliasesOf`).
   */
  groupsInCommon(participantJids: string[], limit = 20): ChatSummary[] {
    if (!participantJids.length) return [];
    const placeholders = participantJids.map((_, i) => `$j${i}`).join(", ");
    const params: Record<string, string | number> = { $limit: limit };
    participantJids.forEach((jid, i) => {
      params[`$j${i}`] = jid;
    });
    const rows = this.db
      .query(
        `SELECT DISTINCT c.* FROM chats c
         JOIN messages m ON m.chat_jid = c.jid
         WHERE m.sender_jid IN (${placeholders}) AND c.is_group = 1
         ORDER BY c.last_message_at DESC LIMIT $limit`
      )
      .all(params) as SummaryRow[];
    return rows.map(rowToSummary);
  }

  /** Atualiza o status de entrega/leitura de uma mensagem (sent/delivered/read/played/error). Devolve false se a mensagem não existe aqui. */
  updateStatus(chatJid: string, id: string, status: string): boolean {
    const { changes } = this.db
      .query("UPDATE messages SET status = $status WHERE chat_jid = $chatJid AND id = $id")
      .run({ $chatJid: chatJid, $id: id, $status: status });
    return changes > 0;
  }

  /** Preenche o arquivo de mídia (baixado do WhatsApp, ou enviado pelo painel) de uma mensagem já gravada. */
  updateMediaFile(chatJid: string, id: string, mediaFile: string): void {
    this.db
      .query("UPDATE messages SET media_file = $mediaFile WHERE chat_jid = $chatJid AND id = $id")
      .run({ $chatJid: chatJid, $id: id, $mediaFile: mediaFile });
  }

  /** Desistiu de baixar essa mídia depois de tentar de novo algumas vezes — distingue de "ainda baixando" no painel. */
  markMediaDownloadFailed(chatJid: string, id: string, failed = true): void {
    this.db
      .query("UPDATE messages SET media_download_failed = $failed WHERE chat_jid = $chatJid AND id = $id")
      .run({ $chatJid: chatJid, $id: id, $failed: failed ? 1 : 0 });
  }

  /** Mais uma tentativa automática (varredura) gasta nessa mídia — ver `listFailedMediaMessages`. */
  incrementMediaRetrySweepCount(chatJid: string, id: string): void {
    this.db
      .query("UPDATE messages SET media_retry_sweep_count = media_retry_sweep_count + 1 WHERE chat_jid = $chatJid AND id = $id")
      .run({ $chatJid: chatJid, $id: id });
  }

  /** O objeto de mídia cru guardado na hora de gravar a mensagem, pra tentar baixar de novo. Null = não dá mais pra tentar. */
  getMediaEnvelope(chatJid: string, id: string): unknown | null {
    const row = this.db
      .query("SELECT media_envelope FROM messages WHERE chat_jid = $chatJid AND id = $id")
      .get({ $chatJid: chatJid, $id: id }) as { media_envelope: string | null } | null;
    return row?.media_envelope ? deserializeMediaEnvelope(row.media_envelope) : null;
  }

  /**
   * Toda mídia que desistiu de baixar (em qualquer conversa) e ainda tem o envelope salvo, e que a
   * varredura automática ainda não tentou de novo demais vezes — base pra tentar de novo sozinho de
   * vez em quando (falha de rede passageira não deveria exigir clicar "Tentar de novo" mensagem por
   * mensagem). Depois de `maxSweepAttempts`, uma falha persistente (ex.: domínio fora do ar há horas)
   * para de ser tentada sozinha — só volta a tentar se alguém clicar "Tentar de novo" manualmente
   * (esse caminho não passa por aqui, então nunca é limitado).
   */
  listFailedMediaMessages(maxSweepAttempts: number): Array<{ chatJid: string; id: string }> {
    const rows = this.db
      .query(
        "SELECT chat_jid, id FROM messages WHERE media_download_failed = 1 AND media_file IS NULL AND media_envelope IS NOT NULL AND media_retry_sweep_count < $max"
      )
      .all({ $max: maxSweepAttempts }) as Array<{ chat_jid: string; id: string }>;
    return rows.map((r) => ({ chatJid: r.chat_jid, id: r.id }));
  }

  /** O nome do WhatsApp (pushName) mais recente que essa pessoa usou em qualquer conversa, ou null se nunca apareceu. */
  lastPushName(senderJid: string): string | null {
    const row = this.db
      .query("SELECT push_name FROM messages WHERE sender_jid = $jid AND from_me = 0 AND push_name IS NOT NULL AND push_name != '' ORDER BY timestamp DESC LIMIT 1")
      .get({ $jid: senderJid }) as { push_name: string } | null;
    return row?.push_name ?? null;
  }

  getMessage(chatJid: string, id: string): ChatMessageRecord | null {
    const row = this.db
      .query("SELECT * FROM messages WHERE chat_jid = $chatJid AND id = $id")
      .get({ $chatJid: chatJid, $id: id }) as ChatRow | null;
    return row ? rowToMessage(row) : null;
  }

  /**
   * Conversas com atividade: fixadas primeiro (mais recém-fixada primeiro), depois as demais por
   * atividade. Uma conversa enviada pra uma lista (pasta) some daqui, igual ao arquivado — ela só
   * aparece dentro da própria lista (`listChatsInFolder`), não duplicada na principal.
   */
  listChats({ includeArchived = false }: { includeArchived?: boolean } = {}): ChatSummary[] {
    const rows = this.db
      .query(
        `SELECT * FROM chats
         WHERE last_message_at > 0 ${includeArchived ? "" : "AND archived = 0"}
         AND NOT EXISTS (SELECT 1 FROM folder_chats fc WHERE fc.chat_jid = chats.jid)
         ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, last_message_at DESC`
      )
      .all() as SummaryRow[];
    return rows.map(rowToSummary);
  }

  /** Só as conversas arquivadas, mais recente primeiro (pra seção "Arquivadas" do painel). */
  listArchivedChats(): ChatSummary[] {
    const rows = this.db
      .query("SELECT * FROM chats WHERE last_message_at > 0 AND archived = 1 ORDER BY last_message_at DESC")
      .all() as SummaryRow[];
    return rows.map(rowToSummary);
  }

  /** Cria uma lista de conversas nova (ex.: "Clientes Premium"), com o nome que você escolher. */
  createFolder(name: string): ChatFolder {
    const id = randomUUID();
    const now = Date.now();
    const { position } = this.db.query("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM folders").get() as { position: number };
    this.db
      .query("INSERT INTO folders (id, name, position, created_at) VALUES ($id, $name, $position, $now)")
      .run({ $id: id, $name: name.trim(), $position: position, $now: now });
    return { id, name: name.trim(), position, createdAt: now };
  }

  deleteFolder(id: string): boolean {
    this.db.query("DELETE FROM folder_chats WHERE folder_id = $id").run({ $id: id });
    const { changes } = this.db.query("DELETE FROM folders WHERE id = $id").run({ $id: id });
    return changes > 0;
  }

  /** Todas as listas que você criou, na ordem em que foram criadas. */
  listFolders(): ChatFolder[] {
    const rows = this.db.query("SELECT * FROM folders ORDER BY position ASC, created_at ASC").all() as Array<{
      id: string;
      name: string;
      position: number;
      created_at: number;
    }>;
    return rows.map((r) => ({ id: r.id, name: r.name, position: r.position, createdAt: r.created_at }));
  }

  /** Põe uma conversa numa lista (não duplica se ela já estiver lá). */
  addChatToFolder(folderId: string, chatJid: string): void {
    this.db
      .query("INSERT OR IGNORE INTO folder_chats (folder_id, chat_jid, added_at) VALUES ($folderId, $chatJid, $now)")
      .run({ $folderId: folderId, $chatJid: chatJid, $now: Date.now() });
  }

  removeChatFromFolder(folderId: string, chatJid: string): void {
    this.db.query("DELETE FROM folder_chats WHERE folder_id = $folderId AND chat_jid = $chatJid").run({ $folderId: folderId, $chatJid: chatJid });
  }

  /** Em quais listas esta conversa está (pra marcar certinho no menu "Adicionar a uma lista"). */
  foldersForChat(chatJid: string): string[] {
    const rows = this.db.query("SELECT folder_id FROM folder_chats WHERE chat_jid = $chatJid").all({ $chatJid: chatJid }) as Array<{
      folder_id: string;
    }>;
    return rows.map((r) => r.folder_id);
  }

  /** As conversas de uma lista, fixadas primeiro, depois por atividade — igual à lista principal. */
  listChatsInFolder(folderId: string): ChatSummary[] {
    const rows = this.db
      .query(
        `SELECT c.* FROM chats c
         JOIN folder_chats fc ON fc.chat_jid = c.jid
         WHERE fc.folder_id = $folderId AND c.last_message_at > 0
         ORDER BY (c.pinned_at IS NULL) ASC, c.pinned_at DESC, c.last_message_at DESC`
      )
      .all({ $folderId: folderId }) as SummaryRow[];
    return rows.map(rowToSummary);
  }

  /**
   * Mensagens de uma conversa, mais recente primeiro, paginadas por cursor
   * (nunca por OFFSET: a tabela cresce sem parar). `before` = timestamp da
   * mensagem mais antiga já carregada, pra pedir a próxima leva mais antiga.
   */
  listMessages(chatJid: string, { before, limit = 50 }: { before?: number; limit?: number } = {}): ChatMessageRecord[] {
    const rows = (
      before != null
        ? this.db
            .query("SELECT * FROM messages WHERE chat_jid = $chatJid AND timestamp < $before ORDER BY timestamp DESC, id DESC LIMIT $limit")
            .all({ $chatJid: chatJid, $before: before, $limit: limit })
        : this.db
            .query("SELECT * FROM messages WHERE chat_jid = $chatJid ORDER BY timestamp DESC, id DESC LIMIT $limit")
            .all({ $chatJid: chatJid, $limit: limit })
    ) as ChatRow[];
    return rows.map(rowToMessage);
  }

  close(): void {
    this.db.close();
  }
}
