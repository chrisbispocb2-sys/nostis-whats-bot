import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { randomUUID, createHash } from "crypto";
import { join } from "path";
import { JsonFileStore } from "./base-store";
import { CONFIG } from "../config";

export interface LibrarySticker {
  id: string;
  file: string;
  hash: string;
  sourceGroupName: string;
  firstSeenAt: number;
  timesSeen: number;
  /** Última vez que foi enviada de propósito pelo painel (não conta só "ter passado" num grupo). */
  lastUsedAt: number | null;
}

export class StickerLibrary extends JsonFileStore<LibrarySticker[]> {
  constructor(file: string, private readonly mediaDir: string) {
    super(file, []);
    // Figurinhas salvas antes de existir "usadas recentemente" não têm esse campo ainda.
    for (const s of this.data) s.lastUsedAt ??= null;
  }

  list(): LibrarySticker[] {
    return [...this.data].sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  }

  /** Mais usadas recentemente primeiro (só as que já foram enviadas de propósito ao menos uma vez). */
  listRecentlyUsed(limit = 16): LibrarySticker[] {
    return this.data
      .filter((s) => s.lastUsedAt !== null)
      .sort((a, b) => b.lastUsedAt! - a.lastUsedAt!)
      .slice(0, limit);
  }

  get(id: string): LibrarySticker | undefined {
    return this.data.find((s) => s.id === id);
  }

  /** Marca que essa figurinha acabou de ser usada de propósito (enviada pelo painel). */
  markUsed(id: string): boolean {
    const sticker = this.get(id);
    if (!sticker) return false;
    sticker.lastUsedAt = Date.now();
    this.save();
    return true;
  }

  getMediaPath(sticker: LibrarySticker): string {
    return join(this.mediaDir, sticker.file);
  }

  /** Chamado quando o bot vê uma figurinha passar em algum grupo. Deduplica por hash do conteúdo. */
  addSeen(buffer: Buffer, groupName: string): void {
    const hash = createHash("sha256").update(buffer).digest("hex");
    const existing = this.data.find((s) => s.hash === hash);
    if (existing) {
      existing.timesSeen++;
      this.save();
      return;
    }

    mkdirSync(this.mediaDir, { recursive: true });
    const id = randomUUID();
    const filename = `${id}.webp`;
    writeFileSync(join(this.mediaDir, filename), buffer);

    this.data.unshift({
      id,
      file: filename,
      hash,
      sourceGroupName: groupName,
      firstSeenAt: Date.now(),
      timesSeen: 1,
      lastUsedAt: null,
    });

    if (this.data.length > CONFIG.maxStickers) {
      const removed = this.data.splice(CONFIG.maxStickers);
      for (const r of removed) {
        try {
          unlinkSync(this.getMediaPath(r));
        } catch {
          // ignora
        }
      }
    }

    this.save();
  }

  delete(id: string): boolean {
    const sticker = this.get(id);
    if (!sticker) return false;
    try {
      unlinkSync(this.getMediaPath(sticker));
    } catch {
      // ignora se já não existir
    }
    this.data = this.data.filter((s) => s.id !== id);
    this.save();
    return true;
  }
}
