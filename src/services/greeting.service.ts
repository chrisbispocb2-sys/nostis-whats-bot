import { randomUUID } from "crypto";
import { generateMessageIDV2 } from "baileys-joss";
import type { WASocket, WAMessage } from "baileys-joss";
import { CONFIG } from "../config";
import {
  DEFAULT_GREETING_MESSAGE,
  DEFAULT_GREETING_PARTIAL_MESSAGE,
  DEFAULT_GREETING_COMPLETE_MESSAGE,
  type KeywordRule,
} from "../core/keyword-store";
import { analyzeAddresses, type AddressLevel } from "../utils/address";
import { readContent } from "../utils/message-content";
import { normalizeJid } from "../utils/jid";
import { sleep } from "../utils/sleep";
import { logger } from "../utils/logger";

/** O que a saudação precisa da conta a que pertence. */
export interface GreetingDeps {
  getRule(id: string): KeywordRule | undefined;
  isBotActive(): boolean;
  /** Registra o ID de uma mensagem enviada pelo bot (pra não ser confundida com uma resposta sua). */
  markSent(id: string): void;
}

export interface GreetingTiming {
  /**
   * Quem já chega com os endereços costuma mandá-los em várias mensagens
   * seguidas, então o bot espera o cliente parar de escrever antes de ler tudo.
   */
  quietWindowMs: number;
  /** Teto da espera, mesmo que o cliente continue mandando mensagens. */
  maxWaitMs: number;
  /** Tempo "digitando…" antes de enviar, proporcional ao tamanho da mensagem, pra não parecer robô. */
  typingDelayMs: (text: string) => number;
}

const DEFAULT_TIMING: GreetingTiming = {
  quietWindowMs: 8_000,
  maxWaitMs: 25_000,
  typingDelayMs: (text) => Math.min(4_000, 1_000 + text.length * 20),
};

/** Alguém que acabou de chamar no grupo por uma regra com saudação ligada. */
interface PendingTrigger {
  id: string;
  ruleId: string;
  at: number;
  /** JIDs da pessoa (telefone e/ou LID): no privado ela pode chegar por qualquer um. */
  aliases: string[];
}

/** Conversa privada em andamento, esperando o cliente terminar de escrever. */
interface Session {
  trigger: PendingTrigger;
  sock: WASocket;
  chatJid: string;
  texts: string[];
  locations: number;
  hasOpaqueMedia: boolean;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

function pickMessage(rule: KeywordRule, level: AddressLevel): string {
  const custom = {
    none: rule.greetingMessages,
    partial: rule.greetingPartialMessages,
    complete: rule.greetingCompleteMessages,
  }[level];
  const fallback = {
    none: DEFAULT_GREETING_MESSAGE,
    partial: DEFAULT_GREETING_PARTIAL_MESSAGE,
    complete: DEFAULT_GREETING_COMPLETE_MESSAGE,
  }[level];

  const pool = custom.length > 0 ? custom : [fallback];
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Puxa a conversa no privado de quem chamou no grupo: cumprimenta e pergunta
 * os endereços, mas só o que ainda falta — quem já chega mandando os
 * endereços não é perguntado de novo. Tudo em memória: se o bot reiniciar,
 * quem chamou antes simplesmente não recebe a saudação.
 */
export class GreetingService {
  private triggers = new Map<string, PendingTrigger>();
  private sessions = new Map<string, Session>();
  private lastGreeted = new Map<string, number>();

  constructor(
    private readonly deps: GreetingDeps,
    private readonly timing: GreetingTiming = DEFAULT_TIMING
  ) {}

  /** Chamado quando uma regra com saudação ligada dispara no grupo. */
  public registerTrigger(jids: Array<string | null | undefined>, ruleId: string): void {
    const aliases = [...new Set(jids.filter((jid): jid is string => !!jid).map(normalizeJid))];
    if (aliases.length === 0) return;

    this.prune();

    const existing = this.findTrigger(aliases);
    // Já está no meio da saudação: não reinicia
    if (existing && this.sessions.has(existing.id)) return;
    if (existing) this.dropTrigger(existing);

    const trigger: PendingTrigger = { id: randomUUID(), ruleId, at: Date.now(), aliases };
    for (const alias of aliases) this.triggers.set(alias, trigger);
  }

  /** Chamado a cada mensagem privada recebida. Só faz algo se a pessoa chamou no grupo antes. */
  public handlePrivateMessage(
    sock: WASocket,
    msg: WAMessage,
    chatJid: string,
    contactJids: string[]
  ): void {
    const trigger = this.findTrigger(contactJids);
    if (!trigger) return;

    if (Date.now() - trigger.at > CONFIG.correlationWindowMs) {
      this.dropTrigger(trigger);
      return;
    }

    const content = readContent(msg);
    if (!content) return;

    let session = this.sessions.get(trigger.id);
    if (!session) {
      if (!this.canGreet(trigger)) {
        this.dropTrigger(trigger);
        return;
      }
      session = {
        trigger,
        sock,
        chatJid,
        texts: [],
        locations: 0,
        hasOpaqueMedia: false,
        startedAt: Date.now(),
      };
      this.sessions.set(trigger.id, session);
    }

    // A conexão pode ter sido recriada desde a primeira mensagem
    session.sock = sock;
    session.chatJid = chatJid;
    if (content.text) session.texts.push(content.text);
    session.locations += content.locations;
    session.hasOpaqueMedia ||= content.hasOpaqueMedia;
    this.schedule(session);
  }

  /** Você respondeu direto no privado: o bot não puxa a conversa por cima. */
  public cancelForChat(jids: string[]): void {
    const keys = new Set(jids.map(normalizeJid));
    for (const session of [...this.sessions.values()]) {
      const matches =
        keys.has(normalizeJid(session.chatJid)) || session.trigger.aliases.some((a) => keys.has(a));
      if (matches) this.dropTrigger(session.trigger);
    }
  }

  private findTrigger(jids: string[]): PendingTrigger | undefined {
    for (const jid of jids) {
      const trigger = this.triggers.get(normalizeJid(jid));
      if (trigger) return trigger;
    }
    return undefined;
  }

  private dropTrigger(trigger: PendingTrigger): void {
    for (const alias of trigger.aliases) {
      if (this.triggers.get(alias) === trigger) this.triggers.delete(alias);
    }
    const session = this.sessions.get(trigger.id);
    if (session) {
      if (session.timer) clearTimeout(session.timer);
      this.sessions.delete(trigger.id);
    }
  }

  private canGreet(trigger: PendingTrigger): boolean {
    const rule = this.deps.getRule(trigger.ruleId);
    if (!rule || !rule.enabled || !rule.greetingEnabled || !this.deps.isBotActive()) return false;

    const now = Date.now();
    return !trigger.aliases.some((alias) => {
      const last = this.lastGreeted.get(alias);
      return last !== undefined && now - last < CONFIG.greetingCooldownMs;
    });
  }

  private schedule(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    const elapsed = Date.now() - session.startedAt;
    const wait = Math.max(0, Math.min(this.timing.quietWindowMs, this.timing.maxWaitMs - elapsed));
    session.timer = setTimeout(() => void this.fire(session), wait);
  }

  private async fire(session: Session): Promise<void> {
    if (this.sessions.get(session.trigger.id) !== session) return;

    const rule = this.deps.getRule(session.trigger.ruleId);
    if (!rule || !rule.enabled || !rule.greetingEnabled || !this.deps.isBotActive()) {
      this.dropTrigger(session.trigger);
      return;
    }

    const analysis = analyzeAddresses({
      texts: session.texts,
      locations: session.locations,
      hasOpaqueMedia: session.hasOpaqueMedia,
    });
    const text = pickMessage(rule, analysis.level);
    const { sock, chatJid } = session;

    try {
      await sock.sendPresenceUpdate("composing", chatJid);
      await sleep(this.timing.typingDelayMs(text));

      // Você pode ter respondido enquanto o bot "digitava"
      if (this.sessions.get(session.trigger.id) !== session) {
        await sock.sendPresenceUpdate("paused", chatJid);
        return;
      }

      // Consome o gatilho antes de enviar: a saudação sai uma vez só, e o eco
      // da própria mensagem (fromMe) não encontra mais nada pra cancelar.
      this.dropTrigger(session.trigger);
      const now = Date.now();
      for (const alias of session.trigger.aliases) this.lastGreeted.set(alias, now);

      // O ID é gerado antes pra já estar registrado quando o eco (fromMe) chegar
      const messageId = generateMessageIDV2(sock.user?.id);
      this.deps.markSent(messageId);
      await sock.sendMessage(chatJid, { text }, { messageId });
      await sock.sendPresenceUpdate("paused", chatJid);
      logger.info({ chatJid, addressLevel: analysis.level, addresses: analysis.count }, "Saudação enviada no privado");
    } catch (err) {
      this.dropTrigger(session.trigger);
      logger.error({ err, chatJid }, "Falha ao enviar saudação no privado");
    }
  }

  /** Descarta gatilhos e saudações antigos (a memória não cresce indefinidamente). */
  private prune(): void {
    const now = Date.now();
    for (const [alias, trigger] of this.triggers) {
      if (now - trigger.at > CONFIG.correlationWindowMs && !this.sessions.has(trigger.id)) {
        this.triggers.delete(alias);
      }
    }
    for (const [alias, at] of this.lastGreeted) {
      if (now - at > CONFIG.greetingCooldownMs) this.lastGreeted.delete(alias);
    }
  }
}
