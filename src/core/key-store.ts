import { randomBytes } from "crypto";
import { JsonFileStore } from "./base-store";
import { CONFIG } from "../config";

export interface AccessKey {
  /** Também é o próprio código: hex em grupos de 4, fácil de copiar/digitar (ex.: "A1B2-C3D4-..."). */
  id: string;
  durationDays: number;
  createdBy: string;
  createdAt: number;
  /** Prazo para resgatar — depois disso a chave expira sem nunca ter sido usada. */
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
  revoked: boolean;
}

interface KeysData {
  keys: AccessKey[];
}

function generateCode(): string {
  return randomBytes(10)
    .toString("hex")
    .toUpperCase()
    .match(/.{1,4}/g)!
    .join("-");
}

export class KeyStore extends JsonFileStore<KeysData> {
  constructor(file: string) {
    super(file, { keys: [] });
    this.data.keys ??= [];
  }

  list(): AccessKey[] {
    return this.data.keys;
  }

  create(adminId: string, durationDays: number): AccessKey {
    const now = Date.now();
    const key: AccessKey = {
      id: generateCode(),
      durationDays,
      createdBy: adminId,
      createdAt: now,
      expiresAt: now + CONFIG.keyRedeemWindowMs,
      usedAt: null,
      usedBy: null,
      revoked: false,
    };
    this.data.keys.unshift(key);
    this.save();
    return key;
  }

  /** Chave pronta para uso (existe, não foi usada, não foi revogada e não expirou sem uso). */
  findValid(code: string): AccessKey | null {
    const key = this.data.keys.find((k) => k.id === code);
    if (!key || key.usedAt || key.revoked || key.expiresAt <= Date.now()) return null;
    return key;
  }

  markUsed(code: string, userId: string): void {
    const key = this.data.keys.find((k) => k.id === code);
    if (!key) return;
    key.usedAt = Date.now();
    key.usedBy = userId;
    this.save();
  }

  revoke(id: string): boolean {
    const key = this.data.keys.find((k) => k.id === id);
    if (!key || key.revoked) return false;
    key.revoked = true;
    this.save();
    return true;
  }
}
