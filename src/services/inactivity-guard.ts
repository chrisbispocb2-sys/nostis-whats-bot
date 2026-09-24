import { normalizeJid } from "../utils/jid";

/** O que o guarda precisa da conta a que pertence. */
export interface GuardDeps {
  /** A segurança está ligada nas configurações? */
  isEnabled(): boolean;
  /** Quanto tempo esperar por uma resposta sua. */
  timeoutMs(): number;
  isBotActive(): boolean;
  /** Desliga o bot: ninguém respondeu a `chatJid` a tempo. */
  shutdown(info: { chatJid: string; waitedMs: number }): void;
}

/** Conversa privada em que o cliente escreveu e ainda ninguém respondeu. */
interface PendingChat {
  key: string;
  aliases: string[];
  chatJid: string;
  since: number;
  /** Horário (ms) da mensagem do cliente segundo o WhatsApp; respostas mais antigas que isso não contam. */
  clientMessageAt: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
}

// Tolerância pra diferença de relógio entre o celular e este computador
const CLOCK_SKEW_MS = 5_000;

/**
 * Segurança: se o bot está ligado, chega uma mensagem no privado e ninguém
 * responde dentro do prazo, é sinal de que não tem ninguém atendendo — então o
 * bot desliga sozinho em vez de continuar chamando clientes que não serão
 * atendidos. Responder na conversa (pelo celular ou pelo computador) cancela
 * a contagem daquela conversa.
 */
export class InactivityGuard {
  private pending = new Map<string, PendingChat>();

  constructor(private readonly deps: GuardDeps) {}

  /** Quantas conversas estão esperando resposta. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Quando o bot vai desligar se ninguém responder (epoch em ms), ou null se não há nada pendente. */
  get nextDeadline(): number | null {
    let next: number | null = null;
    for (const chat of this.pending.values()) {
      if (next === null || chat.deadline < next) next = chat.deadline;
    }
    return next;
  }

  /**
   * Chega uma mensagem de cliente no privado. A contagem começa na primeira
   * mensagem sem resposta e não reinicia enquanto o cliente insiste.
   */
  public onClientMessage(chatJid: string, jids: string[], messageAtMs?: number): void {
    if (!this.deps.isEnabled() || !this.deps.isBotActive()) return;

    const aliases = normalizeAll(jids.concat(chatJid));
    if (aliases.length === 0 || this.find(aliases)) return;

    const now = Date.now();
    const timeoutMs = this.deps.timeoutMs();
    const chat: PendingChat = {
      key: aliases[0]!,
      aliases,
      chatJid,
      since: now,
      clientMessageAt: messageAtMs ?? now,
      deadline: now + timeoutMs,
      timer: setTimeout(() => this.expire(aliases[0]!), timeoutMs),
    };
    this.pending.set(chat.key, chat);
  }

  /** Você respondeu na conversa (uma mensagem que NÃO foi enviada pelo bot). */
  public onOperatorReply(jids: string[], replyAtMs?: number): void {
    const chat = this.find(normalizeAll(jids));
    if (!chat) return;
    // Mensagem antiga (ex.: histórico sincronizado) não é uma resposta a este cliente
    if (replyAtMs !== undefined && replyAtMs < chat.clientMessageAt - CLOCK_SKEW_MS) return;
    this.drop(chat);
  }

  /** Cancela todas as contagens (bot desligado/ligado à mão, ou segurança desativada). */
  public reset(): void {
    for (const chat of this.pending.values()) clearTimeout(chat.timer);
    this.pending.clear();
  }

  private expire(key: string): void {
    const chat = this.pending.get(key);
    if (!chat) return;
    this.drop(chat);

    if (!this.deps.isEnabled() || !this.deps.isBotActive()) return;

    // O bot vai desligar: as outras contagens deixam de fazer sentido
    this.reset();
    this.deps.shutdown({ chatJid: chat.chatJid, waitedMs: Date.now() - chat.since });
  }

  private find(aliases: string[]): PendingChat | undefined {
    for (const chat of this.pending.values()) {
      if (chat.aliases.some((alias) => aliases.includes(alias))) return chat;
    }
    return undefined;
  }

  private drop(chat: PendingChat): void {
    clearTimeout(chat.timer);
    this.pending.delete(chat.key);
  }
}

function normalizeAll(jids: string[]): string[] {
  return [...new Set(jids.filter(Boolean).map(normalizeJid))];
}
