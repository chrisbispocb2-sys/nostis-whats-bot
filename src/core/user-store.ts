import { randomUUID } from "crypto";
import { JsonFileStore } from "./base-store";
import { hashPassword, verifyPassword, type PasswordHash } from "../utils/password";
import { CONFIG } from "../config";

export type UserRole = "admin" | "operator";

/**
 * Funcionalidades que o admin liga/desliga por usuário (venda por plano). "Bot de chamar no
 * grupo" = regras de resposta + ligar/desligar o bot + ativar grupos; os nomes em inglês são só
 * chaves internas, o texto que a pessoa vê fica no frontend.
 */
export const FEATURE_KEYS = ["groupBot", "campaigns", "metrics", "chat", "misticPay", "rideAssistant", "multiAccount"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, boolean>;

export function featuresWith(value: boolean): Features {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, value])) as Features;
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
}

/** O que pode ir para o painel: o hash da senha nunca sai daqui. */
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

export function toPublicUser(user: User | PublicUser): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user as User;
  return rest;
}

/**
 * `admin` nunca é restringido (as travas são para controlar clientes, não o dono do painel).
 * Para `operator`: vencido (expiresAt no passado) bloqueia tudo; senão, vale o interruptor.
 */
export function hasFeatureAccess(user: Pick<PublicUser, "role" | "expiresAt" | "features">, key: FeatureKey): boolean {
  if (user.role === "admin") return true;
  if (user.expiresAt !== null && user.expiresAt <= Date.now()) return false;
  return user.features[key] === true;
}

export class UserStore extends JsonFileStore<UsersData> {
  constructor(file: string) {
    super(file, { users: [] });
    this.data.users ??= [];
    // Contas criadas antes de existir prazo/funcionalidades não têm esses campos salvos
    for (const user of this.data.users) {
      user.expiresAt ??= null;
      user.features ??= featuresWith(false);
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
   * Cria um usuário novo. Lança se o usuário já existir ou se a entrada for inválida. Sem
   * `features`, começa com tudo desligado (quem convida libera o plano depois, pelo painel de
   * administração) — exceto o primeiro admin (bootstrap), que já pede tudo ligado explicitamente.
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
    };
    this.data.users.push(user);
    this.save();
    return user;
  }

  /**
   * Confere usuário e senha, aplicando bloqueio por tentativas erradas. Sempre devolve `null` em
   * qualquer tipo de falha (usuário inexistente, senha errada, conta bloqueada ou desativada) —
   * quem chama fora daqui usa sempre a mesma mensagem genérica, para não deixar descobrir qual
   * desses motivos foi, nem se o usuário existe.
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
    user.features = { ...user.features, ...partial };
    this.save();
    return user;
  }
}
