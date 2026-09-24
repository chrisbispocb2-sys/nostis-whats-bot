import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { isValidStickerWebP } from "baileys-joss";
import type { ProfileStore } from "./profile-store";

export type CampaignMediaType = "none" | "sticker" | "image";

export interface Campaign {
  id: string;
  name: string;
  message: string;
  mediaType: CampaignMediaType;
  mediaFile: string | null;
  mediaMimeType: string | null;
  groupJids: string[];
  intervalSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CampaignMediaInput {
  type: "sticker" | "image";
  dataBase64: string;
  mimeType: string;
}

export interface CampaignInput {
  name: string;
  message: string;
  groupJids: string[];
  intervalSeconds?: number;
  media?: CampaignMediaInput | null;
  removeMedia?: boolean;
}

function extFromMime(mime: string): string {
  if (mime.includes("webp")) return "webp";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("gif")) return "gif";
  return "bin";
}

export class CampaignStore {
  private campaigns: Campaign[] = [];

  constructor(private readonly profiles: ProfileStore) {
    this.load();
  }

  private campaignsFile(): string {
    return join(this.profiles.activeDir(), "campaigns.json");
  }

  private mediaDir(): string {
    return join(this.profiles.activeDir(), "campaign-media");
  }

  private load(): void {
    const file = this.campaignsFile();
    if (!existsSync(file)) {
      this.campaigns = [];
      return;
    }
    try {
      this.campaigns = JSON.parse(readFileSync(file, "utf-8")) as Campaign[];
    } catch (err) {
      console.error("Falha ao carregar campaigns.json:", err);
      this.campaigns = [];
    }
  }

  private save(): void {
    try {
      const file = this.campaignsFile();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(this.campaigns, null, 2), "utf-8");
    } catch (err) {
      console.error("Falha ao salvar campaigns.json:", err);
    }
  }

  /** Recarrega as campanhas do perfil atualmente ativo (chamado ao trocar/importar perfil). */
  reload(): void {
    this.load();
  }

  list(): Campaign[] {
    return this.campaigns;
  }

  get(id: string): Campaign | undefined {
    return this.campaigns.find((c) => c.id === id);
  }

  getMediaPath(campaign: Campaign): string | null {
    if (!campaign.mediaFile) return null;
    return join(this.mediaDir(), campaign.mediaFile);
  }

  /** Grava a mídia em disco. Para figurinhas, valida que o webp é realmente válido antes de salvar. */
  private saveMedia(
    id: string,
    media: CampaignMediaInput
  ): { file: string; mimeType: string } {
    const buffer = Buffer.from(media.dataBase64, "base64");

    if (media.type === "sticker") {
      const check = isValidStickerWebP(buffer);
      if (!check.valid) {
        throw new Error(`Figurinha inválida: ${check.reason ?? "formato webp incorreto"}`);
      }
    }

    const dir = this.mediaDir();
    mkdirSync(dir, { recursive: true });
    const ext = media.type === "sticker" ? "webp" : extFromMime(media.mimeType);
    const filename = `${id}-${Date.now()}.${ext}`;
    writeFileSync(join(dir, filename), buffer);
    return { file: filename, mimeType: media.type === "sticker" ? "image/webp" : media.mimeType };
  }

  private deleteMediaFile(campaign: Campaign): void {
    if (!campaign.mediaFile) return;
    try {
      unlinkSync(join(this.mediaDir(), campaign.mediaFile));
    } catch {
      // ignora se já não existir
    }
  }

  create(input: CampaignInput): Campaign {
    const now = Date.now();
    const id = randomUUID();

    let mediaType: CampaignMediaType = "none";
    let mediaFile: string | null = null;
    let mediaMimeType: string | null = null;

    if (input.media) {
      const saved = this.saveMedia(id, input.media);
      mediaType = input.media.type;
      mediaFile = saved.file;
      mediaMimeType = saved.mimeType;
    }

    const campaign: Campaign = {
      id,
      name: input.name.trim(),
      message: input.message.trim(),
      mediaType,
      mediaFile,
      mediaMimeType,
      groupJids: [...new Set(input.groupJids)],
      intervalSeconds: Math.max(1, input.intervalSeconds ?? 5),
      createdAt: now,
      updatedAt: now,
    };

    this.campaigns.push(campaign);
    this.save();
    return campaign;
  }

  update(id: string, input: Partial<CampaignInput>): Campaign | undefined {
    const campaign = this.get(id);
    if (!campaign) return undefined;

    if (input.name !== undefined) campaign.name = input.name.trim();
    if (input.message !== undefined) campaign.message = input.message.trim();
    if (input.groupJids) campaign.groupJids = [...new Set(input.groupJids)];
    if (input.intervalSeconds !== undefined) {
      campaign.intervalSeconds = Math.max(1, input.intervalSeconds);
    }

    if (input.removeMedia) {
      this.deleteMediaFile(campaign);
      campaign.mediaType = "none";
      campaign.mediaFile = null;
      campaign.mediaMimeType = null;
    } else if (input.media) {
      const saved = this.saveMedia(id, input.media);
      this.deleteMediaFile(campaign);
      campaign.mediaType = input.media.type;
      campaign.mediaFile = saved.file;
      campaign.mediaMimeType = saved.mimeType;
    }

    campaign.updatedAt = Date.now();
    this.save();
    return campaign;
  }

  delete(id: string): boolean {
    const campaign = this.get(id);
    if (!campaign) return false;
    this.deleteMediaFile(campaign);
    this.campaigns = this.campaigns.filter((c) => c.id !== id);
    this.save();
    return true;
  }
}
