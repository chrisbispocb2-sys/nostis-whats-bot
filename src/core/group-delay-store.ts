import { JsonFileStore } from "./base-store";

export class GroupDelayStore extends JsonFileStore<Record<string, number>> {
  constructor(file: string) {
    super(file, {});
  }

  get(jid: string): number {
    return this.data[jid] ?? 0;
  }

  getAll(): Record<string, number> {
    return this.data;
  }

  set(jid: string, delayMs: number): void {
    const clamped = Math.max(0, Math.floor(delayMs) || 0);
    if (clamped === 0) {
      delete this.data[jid];
    } else {
      this.data[jid] = clamped;
    }
    this.save();
  }
}
