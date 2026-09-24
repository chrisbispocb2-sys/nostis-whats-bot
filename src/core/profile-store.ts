import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
} from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

import type { AccountPaths } from "../config/paths";

export interface Profile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface ProfilesIndex {
  activeProfileId: string;
  profiles: Profile[];
}

// Arquivos/pastas que compõem os dados de um perfil (regras, campanhas e
// mídia de campanhas, e grupos habilitados).
const PROFILE_DATA_FILES = ["keyword-rules.json", "campaigns.json", "groups.json"] as const;
const PROFILE_MEDIA_DIR = "campaign-media";

export class ProfileStore {
  private profiles: Profile[] = [];
  private _activeProfileId = "";

  constructor(private readonly paths: Pick<AccountPaths, "root" | "profiles" | "profilesIndex">) {
    this.load();
  }

  private load(): void {
    if (existsSync(this.paths.profilesIndex)) {
      try {
        const data = JSON.parse(readFileSync(this.paths.profilesIndex, "utf-8")) as ProfilesIndex;
        if (Array.isArray(data.profiles) && data.profiles.length > 0) {
          this.profiles = data.profiles;
          this._activeProfileId =
            data.activeProfileId && data.profiles.some((p) => p.id === data.activeProfileId)
              ? data.activeProfileId
              : data.profiles[0]!.id;
          return;
        }
      } catch (err) {
        console.error("Falha ao carregar profiles.json:", err);
      }
    }
    this.bootstrapDefaultProfile();
  }

  private save(): void {
    mkdirSync(this.paths.root, { recursive: true });
    const data: ProfilesIndex = {
      activeProfileId: this._activeProfileId,
      profiles: this.profiles,
    };
    writeFileSync(this.paths.profilesIndex, JSON.stringify(data, null, 2), "utf-8");
  }

  /** Cria o perfil padrão inicial em branco. */
  private bootstrapDefaultProfile(): void {
    const id = randomUUID();
    const now = Date.now();
    const dir = this.dirFor(id);
    mkdirSync(dir, { recursive: true });

    this.profiles = [{ id, name: "Padrão", createdAt: now, updatedAt: now }];
    this._activeProfileId = id;
    this.save();
  }

  dirFor(id: string): string {
    return join(this.paths.profiles, id);
  }

  activeDir(): string {
    return this.dirFor(this._activeProfileId);
  }

  get activeId(): string {
    return this._activeProfileId;
  }

  getActive(): Profile {
    return this.profiles.find((p) => p.id === this._activeProfileId) ?? this.profiles[0]!;
  }

  list(): Profile[] {
    return this.profiles;
  }

  get(id: string): Profile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  /** Copia regras, campanhas (+ mídia) e grupos habilitados de um perfil pra outro. */
  private copyProfileData(fromId: string, toId: string): void {
    const fromDir = this.dirFor(fromId);
    const toDir = this.dirFor(toId);
    mkdirSync(toDir, { recursive: true });

    for (const file of PROFILE_DATA_FILES) {
      const src = join(fromDir, file);
      if (existsSync(src)) {
        writeFileSync(join(toDir, file), readFileSync(src));
      }
    }

    const srcMedia = join(fromDir, PROFILE_MEDIA_DIR);
    if (existsSync(srcMedia)) {
      cpSync(srcMedia, join(toDir, PROFILE_MEDIA_DIR), { recursive: true });
    }
  }

  create(name: string, cloneFromId?: string | null): Profile {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Informe um nome para o perfil.");
    if (this.profiles.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`Já existe um perfil chamado "${trimmed}".`);
    }
    if (cloneFromId && !this.get(cloneFromId)) {
      throw new Error("Perfil de origem para importação não encontrado.");
    }

    const id = randomUUID();
    const now = Date.now();
    mkdirSync(this.dirFor(id), { recursive: true });

    if (cloneFromId) {
      this.copyProfileData(cloneFromId, id);
    }

    const profile: Profile = { id, name: trimmed, createdAt: now, updatedAt: now };
    this.profiles.push(profile);
    this.save();
    return profile;
  }

  /** Importa (substitui) os dados de outro perfil dentro de um perfil já existente. */
  importInto(targetId: string, sourceId: string): void {
    if (targetId === sourceId) {
      throw new Error("Escolha um perfil de origem diferente do atual.");
    }
    const target = this.get(targetId);
    if (!target || !this.get(sourceId)) {
      throw new Error("Perfil não encontrado.");
    }
    this.copyProfileData(sourceId, targetId);
    target.updatedAt = Date.now();
    this.save();
  }

  rename(id: string, name: string): Profile | undefined {
    const profile = this.get(id);
    if (!profile) return undefined;
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Informe um nome para o perfil.");
    if (this.profiles.some((p) => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`Já existe um perfil chamado "${trimmed}".`);
    }
    profile.name = trimmed;
    profile.updatedAt = Date.now();
    this.save();
    return profile;
  }

  setActive(id: string): void {
    if (!this.get(id)) throw new Error("Perfil não encontrado.");
    this._activeProfileId = id;
    this.save();
  }

  delete(id: string): boolean {
    if (!this.get(id)) return false;
    if (this.profiles.length <= 1) {
      throw new Error("Não é possível excluir o único perfil existente.");
    }
    if (id === this._activeProfileId) {
      throw new Error("Troque para outro perfil antes de excluir este.");
    }
    this.profiles = this.profiles.filter((p) => p.id !== id);
    try {
      rmSync(this.dirFor(id), { recursive: true, force: true });
    } catch (err) {
      console.error(`Falha ao remover arquivos do perfil ${id}:`, err);
    }
    this.save();
    return true;
  }
}
