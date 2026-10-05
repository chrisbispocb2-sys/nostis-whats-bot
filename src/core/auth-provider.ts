import { randomBytes } from "crypto";
import type { PublicUser, UserRole, FeatureKey, Features } from "./user-store";
import type { Invite } from "./invite-store";
import type { AccessKey } from "./key-store";
import { CONFIG } from "../config";

export const SESSION_COOKIE_NAME = "brinzy_session";

export interface AuthResult {
  user: PublicUser;
  cookie: string;
}

type MaybePromise<T> = T | Promise<T>;

/** Um usuário como o painel de administração mostra. `devices`/`maxDevices` só existem com servidor de licenças. */
export type AdminUserView = PublicUser & { online: boolean; devices?: Array<{ id: string; name: string; firstSeenAt: number }>; maxDevices?: number };

/** Como anda a licença deste computador (só com servidor de licenças). */
export interface LicenseStatus {
  /** ok = em dia · offline = sem falar com o servidor, ainda dentro da tolerância · blocked = tolerância esgotada. */
  state: "ok" | "offline" | "blocked";
  /** Até quando o programa segue funcionando sem conseguir falar com o servidor. */
  validUntil: number;
}

/**
 * Quem responde pelo login e pelo controle de acesso do painel. Duas implementações:
 * `AuthService` (modo local: contas guardadas neste computador, só pra desenvolver e testar) e
 * `RemoteAuthService` (o que vai no exe: tudo vem do servidor de licenças).
 */
export interface AuthProvider {
  isBootstrapNeeded(): boolean;
  bootstrap(username: string, password: string): MaybePromise<AuthResult>;
  login(username: string, password: string): MaybePromise<AuthResult>;
  registerViaInvite(token: string, username: string, password: string): MaybePromise<AuthResult>;
  logoutCookieHeader(req: Request): MaybePromise<string>;
  currentUser(req: Request): PublicUser | null;
  hasActiveSession(): boolean;
  issuePayToken(accountId: string): string;
  isAuthorizedForAccount(req: Request, url: URL): boolean;
  canUse(req: Request, feature: FeatureKey): boolean;
  requireAdmin(req: Request): PublicUser;
  listUsers(): MaybePromise<AdminUserView[]>;
  setUserDisabled(id: string, disabled: boolean): MaybePromise<PublicUser>;
  setUserAccess(req: Request, id: string, input: { expiresAt?: number | null; features?: Partial<Features>; maxDevices?: number }): MaybePromise<PublicUser>;
  listInvites(): MaybePromise<Invite[]>;
  createInvite(adminId: string, role: UserRole): MaybePromise<Invite>;
  revokeInvite(id: string): MaybePromise<boolean>;
  createKey(req: Request, durationDays: number): MaybePromise<AccessKey>;
  listKeys(req: Request): MaybePromise<(AccessKey & { createdByUsername: string | null })[]>;
  revokeKey(req: Request, id: string): MaybePromise<boolean>;
  redeemKey(req: Request, code: string): MaybePromise<PublicUser>;
  /** Só com servidor de licenças: libera os computadores em que a conta já entrou. */
  resetUserDevices?(req: Request, id: string): Promise<PublicUser>;
  /** Só com servidor de licenças (null = ninguém logado neste computador). */
  licenseStatus?(): LicenseStatus | null;
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  return new Bun.CookieMap(header).get(SESSION_COOKIE_NAME);
}

export function sessionCookieHeader(rawToken: string, maxAgeSeconds: number): string {
  return new Bun.Cookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // O painel é servido em http://127.0.0.1 (texto puro): "Secure" faria o navegador nunca mandar
    // o cookie de volta, derrubando o login inteiro.
    secure: false,
    maxAge: maxAgeSeconds,
  }).serialize();
}

interface PayToken {
  accountId: string;
  expiresAt: number;
}

/**
 * Tokens de vida curta da janela de pagamento (ela tem perfil de navegador isolado e não carrega o
 * cookie do painel): cada um autoriza só as rotas de uma conta de WhatsApp, por alguns minutos.
 */
export class PayTokenRegistry {
  private readonly tokens = new Map<string, PayToken>();

  issue(accountId: string): string {
    const now = Date.now();
    for (const [key, entry] of this.tokens) if (entry.expiresAt <= now) this.tokens.delete(key);

    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, { accountId, expiresAt: now + CONFIG.payTokenTtlMs });
    return token;
  }

  authorizes(req: Request, url: URL): boolean {
    const match = url.pathname.match(/^\/accounts\/([^/]+)\//);
    if (!match) return false;
    const accountId = decodeURIComponent(match[1]!);

    const token = req.headers.get("x-pay-token") || url.searchParams.get("token");
    if (!token) return false;

    const entry = this.tokens.get(token);
    return !!entry && entry.expiresAt > Date.now() && entry.accountId === accountId;
  }
}
