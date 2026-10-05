import { randomUUID } from "crypto";
import { JsonFileStore } from "./base-store";
import { hashPassword, verifyPassword, type PasswordHash } from "./password";
import { CONFIG } from "./config";

export type UserRole = "admin" | "operator";

/**
 * Funcionalidades que o admin liga/desliga por usuário (venda por plano). As mesmas chaves existem
 * no app (app/src/core/user-store.ts) — mantenha as duas listas em sincronia.
 */
export const FEATURE_KEYS = ["groupBot", "campaigns", "metrics", "chat", "misticPay", "rideAssistant", "multiAccount"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, boolean>;

export function featuresWith(value: boolean): Features {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, value])) as Features;
}

/** Um computador em que a conta já entrou. */
export interface UserDevice {
  id: string;
  name: string;
  firstSeenAt: number;
}

export interface User {
  id: string;
  username: string;
  passwordHash: PasswordHash;
  role: UserRole;
  createdAt: number;
  disabled: boolean;
  failedLoginAttempts: number;
  lockedUntil: number | null;
  /** null = sem vencimento. Só vale para `operator` — `admin` nunca é restringido. */
  expiresAt: number | null;
  features: Features;
  /** Computadores em que a conta já entrou (cada um ocupa uma vaga de `maxDevices`). */
  devices: UserDevice[];
  /** Em quantos computadores a conta pode estar. Não vale para `admin`. */
  maxDevices: number;
}

/** O que pode sair do servidor: o hash da senha nunca sai daqui. */
export type PublicUser = Omit<User, "passwordHash">;

interface UsersData {
  users: User[];
}

export class AuthError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
  }
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

export class UserStore extends JsonFileStore<UsersData> {
  constructor(file: string) {
    super(file, { users: [] });
    this.data.users ??= [];
    for (const user of this.data.users) {
      user.expiresAt ??= null;
      user.features ??= featuresWith(false);
      user.devices ??= [];
      user.maxDevices ??= CONFIG.defaultMaxDevices;
    }
  }

  isEmpty(): boolean {
    return this.data.users.length === 0;
  }

  list(): PublicUser[] {
    return this.data.users.map(toPublicUser);
  }

  findById(id: string): User | null {
    return this.data.users.find((u) => u.id === id) ?? null;
  }

  findByUsername(username: string): User | null {
    const normalized = normalizeUsername(username);
    return this.data.users.find((u) => u.username === normalized) ?? null;
  }

  /**
   * Cria um usuário novo. Sem `features`, começa com tudo desligado (o administrador libera o plano
   * depois, pelo painel) — o administrador criado por `scripts/criar-admin.ts` já pede tudo ligado.
   */
  create(username: string, password: string, role: UserRole, features: Features = featuresWith(false)): User {
    const normalized = normalizeUsername(username);
    if (!normalized) throw new AuthError("Informe um nome de usuário.");
    if (password.length < CONFIG.minPasswordLength) {
      throw new AuthError(`A senha precisa ter pelo menos ${CONFIG.minPasswordLength} caracteres.`);
    }
    if (this.findByUsername(normalized)) throw new AuthError("Esse nome de usuário já está em uso.", 409);

    const user: User = {
      id: randomUUID(),
      username: normalized,
      passwordHash: hashPassword(password),
      role,
      createdAt: Date.now(),
      disabled: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
      expiresAt: null,
      features,
      devices: [],
      maxDevices: CONFIG.defaultMaxDevices,
    };
    this.data.users.push(user);
    this.save();
    return user;
  }

  /**
   * Confere usuário e senha, aplicando bloqueio por tentativas erradas. Sempre devolve `null` em
   * qualquer tipo de falha (usuário inexistente, senha errada, conta bloqueada ou desativada), pra
   * não deixar descobrir qual desses motivos foi, nem se o usuário existe.
   */
  verifyCredentials(username: string, password: string): User | null {
    const user = this.findByUsername(username);
    if (!user || user.disabled) return null;

    const now = Date.now();
    if (user.lockedUntil && now < user.lockedUntil) return null;

    if (!verifyPassword(password, user.passwordHash)) {
      user.failedLoginAttempts++;
      if (user.failedLoginAttempts >= CONFIG.loginLockoutAttempts) {
        user.lockedUntil = now + CONFIG.loginLockoutMs;
        user.failedLoginAttempts = 0;
      }
      this.save();
      return null;
    }

    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    this.save();
    return user;
  }

  /**
   * A conta pode usar este computador? Um computador já conhecido sempre pode; um novo ocupa uma
   * vaga, enquanto houver. Administrador não tem limite (é o dono, não um cliente).
   */
  claimDevice(id: string, deviceId: string, deviceName: string): boolean {
    const user = this.findById(id);
    if (!user) return false;
    const known = user.devices.find((d) => d.id === deviceId);
    if (known) {
      if (deviceName && known.name !== deviceName) {
        known.name = deviceName;
        this.save();
      }
      return true;
    }
    if (user.role !== "admin" && user.devices.length >= user.maxDevices) return false;
    user.devices.push({ id: deviceId, name: deviceName, firstSeenAt: Date.now() });
    this.save();
    return true;
  }

  /** Libera todas as vagas de computador da conta (o cliente trocou de máquina, por exemplo). */
  resetDevices(id: string): User {
    const user = this.findById(id);
    if (!user) throw new AuthError("Usuário não encontrado.", 404);
    user.devices = [];
    this.save();
    return user;
  }

  setMaxDevices(id: string, maxDevices: number): User {
    const user = this.findById(id);
    if (!user) throw new AuthError("Usuário não encontrado.", 404);
    if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 50) throw new AuthError("Informe de 1 a 50 computadores.");
    user.maxDevices = maxDevices;
    this.save();
    return user;
  }

  private activeAdminCount(): number {
    return this.data.users.filter((u) => u.role === "admin" && !u.disabled).length;
  }

  /** Liga/desliga o acesso de um usuário. Nunca deixa ficar sem nenhum admin ativo. */
  setDisabled(id: string, disabled: boolean): User {
    const user = this.findById(id);
    if (!user) throw new AuthError("Usuário não encontrado.", 404);
    if (disabled && user.role === "admin" && this.activeAdminCount() <= 1) {
      throw new AuthError("Não é possível desativar o último administrador ativo.", 409);
    }
    user.disabled = disabled;
    this.save();
    return user;
  }

  /** Define o prazo de acesso direto (edição manual do admin). `null` remove o vencimento. */
  setExpiresAt(id: string, expiresAt: number | null): User {
    const user = this.findById(id);
    if (!user) throw new AuthError("Usuário não encontrado.", 404);
    user.expiresAt = expiresAt;
    this.save();
    return user;
  }

  /**
   * Estende o prazo a partir do maior entre "agora" e o prazo atual — resgatar uma chave antes de
   * vencer não desperdiça os dias que ainda restavam.
   */
  extendExpiry(id: string, days: number): User {
    const user = this.findById(id);
    if (!user) throw new AuthError("Usuário não encontrado.", 404);
    const base = Math.max(user.expiresAt ?? 0, Date.now());
    user.expiresAt = base + days * 24 * 60 * 60 * 1000;
    this.save();
    return user;
  }

  /** Mescla só as funcionalidades informadas — as outras continuam como estavam. */
  setFeatures(id: string, partial: Partial<Features>): User {
    const user = this.findById(id);
    if (!user) throw new AuthError("Usuário não encontrado.", 404);
    const known = Object.fromEntries(FEATURE_KEYS.filter((k) => typeof partial[k] === "boolean").map((k) => [k, partial[k]]));
    user.features = { ...user.features, ...known };
    this.save();
    return user;
  }
}
