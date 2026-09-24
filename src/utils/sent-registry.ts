/**
 * Guarda os IDs das mensagens que o próprio bot enviou. O WhatsApp devolve as
 * mensagens enviadas pela conta como `fromMe`, igual às que você digita no
 * celular — sem esse registro não dá pra distinguir uma da outra.
 */
export class SentMessageRegistry {
  private ids = new Map<string, number>();

  constructor(private readonly ttlMs = 10 * 60_000) {}

  mark(id: string | null | undefined): void {
    if (!id) return;
    this.prune();
    this.ids.set(id, Date.now());
  }

  has(id: string | null | undefined): boolean {
    if (!id) return false;
    const at = this.ids.get(id);
    return at !== undefined && Date.now() - at <= this.ttlMs;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, at] of this.ids) {
      if (now - at > this.ttlMs) this.ids.delete(id);
    }
  }
}
