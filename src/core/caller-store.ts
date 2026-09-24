import { JsonFileStore } from "./base-store";
import { normalizeJid } from "../utils/jid";
import { CONFIG } from "../config";

export interface CallerStats {
  jid: string;
  name: string | null;
  count: number;
  lastCallAt: number;
}

export class CallerStore extends JsonFileStore<CallerStats[]> {
  constructor(file: string) {
    super(file, []);
  }

  list(): CallerStats[] {
    return this.data;
  }

  registerCall(jid: string, name: string | null): CallerStats {
    const normalized = normalizeJid(jid);
    const now = Date.now();
    const existing = this.data.find((c) => c.jid === normalized);

    if (!existing) {
      const stats: CallerStats = { jid: normalized, name, count: 1, lastCallAt: now };
      this.data.unshift(stats);
      this.save();
      return stats;
    }

    if (name) existing.name = name;
    if (now - existing.lastCallAt >= CONFIG.callGapMs) {
      existing.count += 1;
    }
    existing.lastCallAt = now;
    this.save();
    return existing;
  }
}
