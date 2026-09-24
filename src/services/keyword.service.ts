// src/services/keyword.service.ts
import type { KeywordStore, KeywordRule } from "../core/keyword-store";

export class KeywordService {
  constructor(private readonly keywords: KeywordStore) {}

  /**
   * Verifica se uma mensagem bate com alguma regra ativa e fora do cooldown
   * para o grupo informado.
   */
  public findMatchingResponse(message: string, jid: string): KeywordRule | undefined {
    const rule = this.keywords.findMatch(message);
    if (!rule) return undefined;
    if (this.keywords.isOnCooldown(rule.id, jid)) return undefined;
    return rule;
  }

  public markTriggered(ruleId: string, jid: string): void {
    this.keywords.markTriggered(ruleId, jid);
  }
}
