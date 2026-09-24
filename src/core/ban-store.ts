import { JsonFileStore } from "./base-store";
import { normalizeJid } from "../utils/jid";

export interface BanEntry {
  jid: string;
  name: string | null;
  bannedAt: number;
}

export class BanStore extends JsonFileStore<BanEntry[]> {
  constructor(file: string) {
    super(file, []);
  }

  list(): BanEntry[] {
    return this.data;
  }

  isBanned(jid: string): boolean {
    const normalized = normalizeJid(jid);
    return this.data.some((b) => b.jid === normalized);
  }

  ban(jid: string, name: string | null): BanEntry {
    const normalized = normalizeJid(jid);
    const existing = this.data.find((b) => b.jid === normalized);
    if (existing) {
      if (name) existing.name = name;
      this.save();
      return existing;
    }

    const entry: BanEntry = { jid: normalized, name, bannedAt: Date.now() };
    this.data.unshift(entry);
    this.save();
    return entry;
  }

  unban(jid: string): boolean {
    const normalized = normalizeJid(jid);
    const before = this.data.length;
    this.data = this.data.filter((b) => b.jid !== normalized);
    if (this.data.length === before) return false;
    this.save();
    return true;
  }
}
