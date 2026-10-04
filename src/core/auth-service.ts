import { randomBytes } from "crypto";
import {
  UserStore,
  AuthError,
  toPublicUser,
  featuresWith,
  hasFeatureAccess,
  type User,
  type PublicUser,
  type UserRole,
  type FeatureKey,
  type Features,
} from "./user-store";
import { InviteStore, type Invite } from "./invite-store";
import { SessionStore } from "./session-store";
import { KeyStore, type AccessKey } from "./key-store";
import { CONFIG } from "../config";

export const SESSION_COOKIE_NAME = "brinzy_session";

export interface AuthResult {
  user: PublicUser;
  cookie: string;
}

interface PayToken {
  accountId: string;
  expiresAt: number;
}

function readCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  return new Bun.CookieMap(header).get(SESSION_COOKIE_NAME);
}

function sessionCookieHeader(rawToken: string, maxAgeSeconds: number): string {
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

/**
 * Cola entre `UserStore`/`InviteStore`/`SessionStore` e o HTTP: login, registro por convite,
 * sessão via cookie e os pay-tokens de curta duração usados pela janela de pagamento (ver o
 * plano de login — ela tem perfil de navegador isolado e não carrega o cookie do painel).
 */
export class AuthService {
  private readonly payTokens = new Map<string, PayToken>();

  constructor(
    private readonly users: UserStore,
    private readonly invites: InviteStore,
    private readonly sessions: SessionStore,
    private readonly keys: KeyStore
  ) {}

  isBootstrapNeeded(): boolean {
    return this.users.isEmpty();
  }

  private sessionResult(user: User): AuthResult {
    const { rawToken } = this.sessions.create(user.id);
    return { user: toPublicUser(user), cookie: sessionCookieHeader(rawToken, CONFIG.sessionMaxAgeMs / 1000) };
  }

  bootstrap(username: string, password: string): AuthResult {
    if (!this.isBootstrapNeeded()) throw new AuthError("Já existe uma conta configurada.", 409);
    const user = this.users.create(username, password, "admin", featuresWith(true));
    return this.sessionResult(user);
  }

  login(username: string, password: string): AuthResult {
    const user = this.users.verifyCredentials(username, password);
    if (!user) throw new AuthError("Usuário ou senha inválidos.", 401);
    return this.sessionResult(user);
  }

  registerViaInvite(token: string, username: string, password: string): AuthResult {
    const invite = this.invites.findValid(token);
    if (!invite) throw new AuthError("Este convite é inválido, já foi usado ou expirou.", 410);
    const user = this.users.create(username, password, invite.role);
    this.invites.markUsed(token, user.id);
    return this.sessionResult(user);
  }

  logoutCookieHeader(req: Request): string {
    const rawToken = readCookie(req);
    if (rawToken) this.sessions.deleteByToken(rawToken);
    return sessionCookieHeader("", 0);
  }

  /** Sessão válida (cookie presente, não expirada, dono não desativado) para esta requisição. */
  currentUser(req: Request): User | null {
    const rawToken = readCookie(req);
    if (!rawToken) return null;
    const session = this.sessions.findByToken(rawToken);
    if (!session) return null;
    const user = this.users.findById(session.userId);
    if (!user || user.disabled) return null;
    this.sessions.touch(rawToken);
    return user;
  }

  hasActiveSession(): boolean {
    return this.sessions.hasActive();
  }

  /** Token de vida curta para a janela de pagamento (perfil de navegador isolado, sem cookie do painel). */
  issuePayToken(accountId: string): string {
    const now = Date.now();
    for (const [key, entry] of this.payTokens) if (entry.expiresAt <= now) this.payTokens.delete(key);

    const token = randomBytes(32).toString("hex");
    this.payTokens.set(token, { accountId, expiresAt: now + CONFIG.payTokenTtlMs });
    return token;
  }

  private payTokenAuthorizes(req: Request, url: URL): boolean {
    const match = url.pathname.match(/^\/accounts\/([^/]+)\//);
    if (!match) return false;
    const accountId = decodeURIComponent(match[1]!);

    const token = req.headers.get("x-pay-token") || url.searchParams.get("token");
    if (!token) return false;

    const entry = this.payTokens.get(token);
    return !!entry && entry.expiresAt > Date.now() && entry.accountId === accountId;
  }

  /** Autoriza uma rota de conta: sessão de cookie normal, ou um pay-token válido para aquela conta. */
  isAuthorizedForAccount(req: Request, url: URL): boolean {
    return !!this.currentUser(req) || this.payTokenAuthorizes(req, url);
  }

  /* ---------- Administração (convites e usuários) ---------- */

  requireAdmin(req: Request): User {
    const user = this.currentUser(req);
    if (!user) throw new AuthError("Não autenticado.", 401);
    if (user.role !== "admin") throw new AuthError("Só um administrador pode fazer isso.", 403);
    return user;
  }

  /** Usuários do painel, com `online` calculado na hora a partir das sessões ativas — nunca persistido. */
  listUsers(): (PublicUser & { online: boolean })[] {
    const onlineIds = this.sessions.onlineUserIds();
    return this.users.list().map((u) => ({ ...u, online: onlineIds.has(u.id) }));
  }

  setUserDisabled(id: string, disabled: boolean): PublicUser {
    const user = this.users.setDisabled(id, disabled);
    if (disabled) this.sessions.deleteAllForUser(id);
    return toPublicUser(user);
  }

  listInvites(): Invite[] {
    return this.invites.list();
  }

  createInvite(adminId: string, role: UserRole): Invite {
    return this.invites.create(adminId, role);
  }

  revokeInvite(id: string): boolean {
    return this.invites.revoke(id);
  }

  setUserAccess(req: Request, id: string, input: { expiresAt?: number | null; features?: Partial<Features> }): PublicUser {
    this.requireAdmin(req);
    let user = this.users.findById(id);
    if (!user) throw new AuthError("Usuário não encontrado.", 404);
    if (input.expiresAt !== undefined) user = this.users.setExpiresAt(id, input.expiresAt);
    if (input.features !== undefined) user = this.users.setFeatures(id, input.features);
    return toPublicUser(user);
  }

  /* ---------- Chaves de renovação ---------- */

  createKey(req: Request, durationDays: number): AccessKey {
    const admin = this.requireAdmin(req);
    if (!Number.isFinite(durationDays) || durationDays <= 0) throw new AuthError("Informe quantos dias a chave vai conceder.");
    return this.keys.create(admin.id, Math.floor(durationDays));
  }

  /** Chaves com o nome de quem criou já resolvido — útil pra distinguir quando há mais de um administrador. */
  listKeys(req: Request): (AccessKey & { createdByUsername: string | null })[] {
    this.requireAdmin(req);
    return this.keys.list().map((k) => ({ ...k, createdByUsername: this.users.findById(k.createdBy)?.username ?? null }));
  }

  revokeKey(req: Request, id: string): boolean {
    this.requireAdmin(req);
    return this.keys.revoke(id);
  }

  /** Qualquer pessoa logada resgata uma chave na própria conta, para estender o prazo dela. */
  redeemKey(req: Request, code: string): PublicUser {
    const user = this.currentUser(req);
    if (!user) throw new AuthError("Não autenticado.", 401);
    const key = this.keys.findValid(code);
    if (!key) throw new AuthError("Essa chave é inválida, já foi usada ou expirou.", 410);
    const updated = this.users.extendExpiry(user.id, key.durationDays);
    this.keys.markUsed(code, user.id);
    return toPublicUser(updated);
  }

  /** Usado pelo guard de funcionalidades (ver feature-guard.ts): a sessão desta requisição pode usar X? */
  canUse(req: Request, feature: FeatureKey): boolean {
    const user = this.currentUser(req);
    return !!user && hasFeatureAccess(user, feature);
  }
}
