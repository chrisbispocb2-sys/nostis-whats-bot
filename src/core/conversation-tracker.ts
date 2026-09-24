import { normalizeJid } from "../utils/jid";

export interface Conversation {
  /** Telefone (só dígitos) quando conhecido; senão, o JID normalizado. */
  key: string;
  /** JID do chat, do jeito que o WhatsApp entregou por último (é pra ele que se envia). */
  chatJid: string;
  phone: string | null;
  name: string | null;
  lastActivityAt: number;
  /** Quem escreveu por último: o cliente ou você (o que o bot envia sozinho não conta). */
  lastFrom: "client" | "operator";
}

export interface TouchInput {
  chatJid: string;
  /** Outros JIDs da mesma pessoa (telefone e/ou LID). */
  jids: string[];
  phone: string | null;
  name: string | null;
  from: "client" | "operator";
  at?: number;
}

interface Entry extends Conversation {
  aliases: Set<string>;
}

/**
 * Guarda as conversas privadas recentes (em memória). O WhatsApp não avisa
 * qual conversa está aberta na sua tela, então "em conversa" aqui significa
 * "houve mensagem — do cliente ou sua — há pouco tempo".
 */
export class ConversationTracker {
  private entries = new Map<string, Entry>();

  constructor(private readonly maxEntries = 200) {}

  touch(input: TouchInput): Conversation {
    const aliases = new Set([input.chatJid, ...input.jids].filter(Boolean).map(normalizeJid));
    let entry = this.findEntry(aliases, input.phone);

    if (!entry) {
      entry = {
        key: input.phone ?? normalizeJid(input.chatJid),
        chatJid: input.chatJid,
        phone: input.phone,
        name: input.name,
        lastActivityAt: input.at ?? Date.now(),
        lastFrom: input.from,
        aliases,
      };
      this.entries.set(entry.key, entry);
      this.trim();
    } else {
      // Se antes só se conhecia o LID e agora apareceu o telefone, a chave passa a ser o telefone
      if (input.phone && entry.key !== input.phone) {
        this.entries.delete(entry.key);
        entry.key = input.phone;
        this.entries.set(entry.key, entry);
      }
      for (const alias of aliases) entry.aliases.add(alias);
      entry.chatJid = input.chatJid;
      entry.phone = input.phone ?? entry.phone;
      entry.name = input.name || entry.name;
      entry.lastActivityAt = Math.max(entry.lastActivityAt, input.at ?? Date.now());
      entry.lastFrom = input.from;
    }

    return this.publicOf(entry);
  }

  /** Mais recentes primeiro. */
  list(): Conversation[] {
    return [...this.entries.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt).map((e) => this.publicOf(e));
  }

  /** Acha uma conversa por qualquer JID conhecido dela. */
  find(jid: string): Conversation | undefined {
    const target = normalizeJid(jid);
    for (const entry of this.entries.values()) {
      if (entry.aliases.has(target)) return this.publicOf(entry);
    }
    return undefined;
  }

  /** Todos os JIDs conhecidos da pessoa dona deste JID (telefone e/ou LID). Vazio se a conversa não é conhecida. */
  aliasesOf(jid: string): string[] {
    const target = normalizeJid(jid);
    for (const entry of this.entries.values()) {
      if (entry.aliases.has(target)) return [...entry.aliases];
    }
    return [];
  }

  private findEntry(aliases: Set<string>, phone: string | null): Entry | undefined {
    if (phone && this.entries.has(phone)) return this.entries.get(phone);
    for (const entry of this.entries.values()) {
      for (const alias of aliases) if (entry.aliases.has(alias)) return entry;
    }
    return undefined;
  }

  private trim(): void {
    if (this.entries.size <= this.maxEntries) return;
    const oldest = [...this.entries.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    for (const entry of oldest.slice(0, this.entries.size - this.maxEntries)) this.entries.delete(entry.key);
  }

  private publicOf({ aliases: _aliases, ...conversation }: Entry): Conversation {
    return { ...conversation };
  }
}
