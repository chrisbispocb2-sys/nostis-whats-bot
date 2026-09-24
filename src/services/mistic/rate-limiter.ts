/**
 * Limita quantas consultas por janela de tempo podem sair. A MisticPay aceita
 * 60 consultas por minuto por IP na verificação de pagamentos, e esse limite
 * é compartilhado por todas as contas de WhatsApp deste programa.
 */
export class RateLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  /** Pede uma "vaga". Devolve false se o limite da janela já foi usado. */
  tryAcquire(now = Date.now()): boolean {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(now);
    return true;
  }
}

/** Uma folga abaixo dos 60/min da MisticPay, pra sobrar espaço pras consultas manuais do painel. */
export const sharedCheckLimiter = new RateLimiter(45, 60_000);
