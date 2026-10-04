import { normalizeJid } from "../utils/jid";
import { logger } from "../utils/logger";

/** O que o recado automático precisa da conta a que pertence. */
export interface AwayMessageDeps {
  /** A opção está ligada nas configurações? */
  isEnabled(): boolean;
  isBotActive(): boolean;
  /** Texto a enviar (a mensagem configurada, ou a padrão se estiver vazia). */
  message(): string;
  /** Números na lista "sem resposta" (operadores) não recebem o recado. */
  isNoReplyNumber(phoneDigits: string): boolean;
  send(chatJid: string, text: string): Promise<void>;
  accountName(): string;
}

// Evita crescer sem limite numa conta com muitos contatos e o bot desligado por muito tempo
const MAX_TRACKED = 1000;

/**
 * Recado automático: com o bot desligado (à mão ou pela segurança), quem chamar no privado recebe
 * uma mensagem avisando que não há ninguém para atender agora, em vez de ficar sem nenhuma resposta.
 * Manda uma vez por pessoa a cada vez que o bot fica desligado — insistir escrevendo não repete o
 * recado, e ligar o bot de novo "rearma" o aviso para a próxima vez que ele desligar.
 */
export class AwayMessageService {
  private notified = new Set<string>();

  constructor(private readonly deps: AwayMessageDeps) {}

  /** Chamado a cada mensagem privada recebida (só quando é conversa de verdade, não reação/protocolo). */
  async handlePrivateMessage(chatJid: string, jids: string[], phone: string | null): Promise<void> {
    if (!this.deps.isEnabled() || this.deps.isBotActive()) return;
    if (phone && this.deps.isNoReplyNumber(phone)) return;

    const aliases = [...new Set([chatJid, ...jids].filter(Boolean).map(normalizeJid))];
    if (aliases.length === 0 || aliases.some((a) => this.notified.has(a))) return;

    // Marca antes de enviar: uma segunda mensagem chegando enquanto a primeira ainda está sendo
    // enviada não dispara um segundo envio
    for (const alias of aliases) this.notified.add(alias);
    this.trim();

    try {
      await this.deps.send(chatJid, this.deps.message());
    } catch (err) {
      // Não conseguiu enviar (ex.: WhatsApp fora do ar): tenta de novo na próxima mensagem dela
      for (const alias of aliases) this.notified.delete(alias);
      logger.warn({ err, account: this.deps.accountName(), chatJid }, "Não foi possível enviar o recado automático");
    }
  }

  /** O bot ligou de novo: a próxima vez que desligar, todo mundo pode receber o recado outra vez. */
  reset(): void {
    this.notified.clear();
  }

  private trim(): void {
    if (this.notified.size <= MAX_TRACKED) return;
    const excess = this.notified.size - MAX_TRACKED;
    let i = 0;
    for (const alias of this.notified) {
      if (i++ >= excess) break;
      this.notified.delete(alias);
    }
  }
}
