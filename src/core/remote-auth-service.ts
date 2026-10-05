import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { AuthError, featuresWith, hasFeatureAccess, type FeatureKey, type Features, type PublicUser, type UserRole } from "./user-store";
import type { Invite } from "./invite-store";
import type { AccessKey } from "./key-store";
import type { SessionStore } from "./session-store";
import { verifyLicense, type LicensePayload } from "./license-token";
import { PayTokenRegistry, readSessionCookie, sessionCookieHeader, type AdminUserView, type AuthProvider, type AuthResult, type LicenseStatus } from "./auth-provider";
import { CONFIG } from "../config";
import { logger } from "../utils/logger";

export interface RemoteAuthOptions {
  /** Endereço do servidor de licenças (ver config/license.ts). */
  serverUrl: string;
  /** Chave pública do servidor: só vale licença assinada por ele. */
  publicKey: string;
  /** Onde a licença deste computador fica guardada entre uma abertura e outra do programa. */
  licenseFile: string;
  deviceId: string;
  deviceName: string;
  /** De quanto em quanto tempo a licença é renovada (padrão: 10 min). */
  refreshIntervalMs?: number;
  /** Chamado sempre que a licença muda (renovada, perdida, vencida) — ver `index.ts`. */
  onChange?: () => void;
  /** Só pra testes: falar com um servidor de mentira sem abrir porta. */
  fetch?: (req: Request) => Promise<Response>;
}

const UNREACHABLE_MESSAGE = "Não foi possível falar com o servidor de licenças. Confira sua internet e tente de novo.";
const REQUEST_TIMEOUT_MS = 15_000;
/** Folga pro relógio do computador estar um pouco atrasado em relação ao do servidor. */
const CLOCK_SKEW_MS = 10 * 60_000;

/** O servidor não respondeu (sem internet, fora do ar): diferente de ele responder "não". */
class ServerUnreachableError extends AuthError {
  constructor() {
    super(UNREACHABLE_MESSAGE, 503);
  }
}

/**
 * Login e controle de acesso com o servidor de licenças mandando (é o que vai no exe). Este
 * computador não guarda usuário, senha, prazo nem funcionalidades: só a licença assinada que o
 * servidor entrega no login, conferida com a chave pública e renovada de tempos em tempos.
 *
 * - Conta desativada, computador liberado pra outro ou sessão encerrada: a renovação é recusada e
 *   o programa desloga na hora.
 * - Sem internet: segue funcionando com a última licença até `validUntil`; depois disso tudo fica
 *   bloqueado até conseguir renovar.
 * - A administração (usuários, convites, chaves) que o painel mostra pro administrador é só
 *   repassada pro servidor, com a licença dele.
 */
export class RemoteAuthService implements AuthProvider {
  private readonly payTokens = new PayTokenRegistry();
  private token: string | null = null;
  private payload: LicensePayload | null = null;
  /** A última tentativa de falar com o servidor deu certo? */
  private serverReachable = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessions: SessionStore,
    private readonly options: RemoteAuthOptions
  ) {
    this.loadSavedLicense();
  }

  /** Renova a licença agora e passa a renovar de tempos em tempos. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.refreshIntervalMs ?? 10 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ---------- Licença deste computador ---------- */

  private loadSavedLicense(): void {
    try {
      if (!existsSync(this.options.licenseFile)) return;
      const saved = JSON.parse(readFileSync(this.options.licenseFile, "utf-8")) as { token?: unknown };
      if (typeof saved.token === "string") this.setLicense(saved.token, { persist: false });
    } catch (err) {
      logger.warn({ err }, "Não consegui ler a licença guardada (vai pedir login de novo)");
    }
  }

  /** Aceita uma licença nova, se for mesmo do servidor e deste computador. Devolve false se não for. */
  private setLicense(token: string, { persist = true } = {}): boolean {
    const payload = verifyLicense(token, this.options.publicKey);
    if (!payload || payload.deviceId !== this.options.deviceId) return false;
    this.token = token;
    this.payload = payload;
    if (persist) this.saveLicense();
    return true;
  }

  private clearLicense(): void {
    if (this.payload) this.sessions.deleteAllForUser(this.payload.userId);
    this.token = null;
    this.payload = null;
    this.saveLicense();
  }

  private saveLicense(): void {
    try {
      mkdirSync(dirname(this.options.licenseFile), { recursive: true });
      writeFileSync(this.options.licenseFile, JSON.stringify({ token: this.token }), "utf-8");
    } catch (err) {
      logger.error({ err }, "Falha ao guardar a licença (ignorado)");
    }
  }

  /**
   * A licença ainda dá direito a usar o programa sem falar com o servidor? Não, se a tolerância
   * acabou — ou se o relógio do computador está antes de a licença ter sido emitida (voltar o
   * relógio não estica o prazo).
   */
  private licenseIsFresh(payload: LicensePayload): boolean {
    const now = Date.now();
    return now <= payload.validUntil && now >= payload.issuedAt - CLOCK_SKEW_MS;
  }

  /** Pede uma licença nova ao servidor. Recusa = desloga; servidor fora do ar = segue com a que tem. */
  async refresh(): Promise<void> {
    if (!this.token) return;
    try {
      const { token } = await this.call<{ token: string }>("POST", "/v1/refresh", { token: this.token });
      if (!this.setLicense(token)) throw new AuthError("Licença inválida.", 401);
    } catch (err) {
      // Só um "não" explícito do servidor (sessão encerrada, conta desativada, computador liberado
      // pra outro) desloga. Qualquer outra falha é tratada como servidor fora do ar.
      if (err instanceof AuthError && (err.status === 401 || err.status === 403)) {
        logger.warn({ err }, "O servidor de licenças não renovou a licença: é preciso entrar de novo");
        this.clearLicense();
      } else {
        this.serverReachable = false;
        logger.warn("Servidor de licenças fora de alcance: seguindo com a licença guardada");
      }
    }
    this.options.onChange?.();
  }

  licenseStatus(): LicenseStatus | null {
    if (!this.payload) return null;
    const state = !this.licenseIsFresh(this.payload) ? "blocked" : this.serverReachable ? "ok" : "offline";
    return { state, validUntil: this.payload.validUntil };
  }

  /**
   * Quem está logado neste computador, do jeito que o resto do programa enxerga um usuário. Com a
   * tolerância esgotada a pessoa continua "logada" (pra ver o aviso), mas sem nenhuma
   * funcionalidade — nem administrador escapa, senão bastava ficar sem internet.
   */
  licensedUser(): PublicUser | null {
    const p = this.payload;
    if (!p) return null;
    const fresh = this.licenseIsFresh(p);
    return {
      id: p.userId,
      username: p.username,
      role: fresh ? p.role : "operator",
      createdAt: p.createdAt,
      disabled: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
      expiresAt: p.expiresAt,
      features: fresh ? p.features : featuresWith(false),
    };
  }

  /** A licença deste computador libera esta funcionalidade agora? (vale pro bot rodando, não só pro painel) */
  allows(feature: FeatureKey): boolean {
    const user = this.licensedUser();
    return !!user && hasFeatureAccess(user, feature);
  }

  /* ---------- Conversa com o servidor ---------- */

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, bearer?: string): Promise<T> {
    const req = new Request(`${this.options.serverUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(req);
    } catch {
      this.serverReachable = false;
      throw new ServerUnreachableError();
    }

    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    // 5xx (ou resposta que não é do servidor de licenças, tipo página de erro do proxy) conta como fora do ar
    if (res.status >= 500 || data === null) {
      this.serverReachable = false;
      throw new ServerUnreachableError();
    }
    this.serverReachable = true;
    if (!res.ok) throw new AuthError(data.error || "O servidor de licenças recusou o pedido.", res.status);
    return data;
  }

  /** Pedido de administração, com a licença de quem está logado (o servidor confere se é administrador). */
  private admin<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!this.token) throw new AuthError("Não autenticado.", 401);
    return this.call<T>(method, `/v1/admin${path}`, body, this.token);
  }

  private device() {
    return { deviceId: this.options.deviceId, deviceName: this.options.deviceName };
  }

  /** Guarda a licença recebida no login e abre a sessão do painel (cookie) pra ela. */
  private openPanelSession(token: string): AuthResult {
    const previousUserId = this.payload?.userId;
    if (!this.setLicense(token)) throw new AuthError("O servidor de licenças devolveu uma licença que não vale neste computador.", 502);
    if (previousUserId && previousUserId !== this.payload!.userId) this.sessions.deleteAllForUser(previousUserId);
    const { rawToken } = this.sessions.create(this.payload!.userId);
    this.options.onChange?.();
    return { user: this.licensedUser()!, cookie: sessionCookieHeader(rawToken, CONFIG.sessionMaxAgeMs / 1000) };
  }

  /* ---------- Login ---------- */

  /** A primeira conta é criada no servidor (`bun run criar-admin`), nunca por aqui. */
  isBootstrapNeeded(): boolean {
    return false;
  }

  bootstrap(): AuthResult {
    throw new AuthError("As contas são criadas pelo administrador, por convite.", 403);
  }

  async login(username: string, password: string): Promise<AuthResult> {
    const { token } = await this.call<{ token: string }>("POST", "/v1/login", { username, password, ...this.device() });
    return this.openPanelSession(token);
  }

  async registerViaInvite(inviteToken: string, username: string, password: string): Promise<AuthResult> {
    const { token } = await this.call<{ token: string }>("POST", "/v1/register", { inviteToken, username, password, ...this.device() });
    return this.openPanelSession(token);
  }

  /** Sair encerra a sessão no servidor também: a licença deste computador deixa de renovar. */
  async logoutCookieHeader(req: Request): Promise<string> {
    const rawToken = readSessionCookie(req);
    if (rawToken) this.sessions.deleteByToken(rawToken);
    if (this.token) {
      await this.call("POST", "/v1/logout", { token: this.token }).catch(() => {}); // sem internet: sai só daqui
      this.clearLicense();
      this.options.onChange?.();
    }
    return sessionCookieHeader("", 0);
  }

  /** Sessão do painel válida (cookie presente, não expirada) e da mesma conta que a licença deste computador. */
  currentUser(req: Request): PublicUser | null {
    const rawToken = readSessionCookie(req);
    if (!rawToken) return null;
    const session = this.sessions.findByToken(rawToken);
    const user = this.licensedUser();
    if (!session || !user || session.userId !== user.id) return null;
    this.sessions.touch(rawToken);
    return user;
  }

  hasActiveSession(): boolean {
    return !!this.payload && this.sessions.hasActive();
  }

  issuePayToken(accountId: string): string {
    return this.payTokens.issue(accountId);
  }

  isAuthorizedForAccount(req: Request, url: URL): boolean {
    return !!this.currentUser(req) || (!!this.payload && this.payTokens.authorizes(req, url));
  }

  canUse(req: Request, feature: FeatureKey): boolean {
    const user = this.currentUser(req);
    return !!user && hasFeatureAccess(user, feature);
  }

  /* ---------- Administração: tudo repassado pro servidor ---------- */

  requireAdmin(req: Request): PublicUser {
    const user = this.currentUser(req);
    if (!user) throw new AuthError("Não autenticado.", 401);
    if (user.role !== "admin") throw new AuthError("Só um administrador pode fazer isso.", 403);
    return user;
  }

  async listUsers(): Promise<AdminUserView[]> {
    return (await this.admin<{ users: AdminUserView[] }>("GET", "/users")).users;
  }

  async setUserDisabled(id: string, disabled: boolean): Promise<PublicUser> {
    return (await this.admin<{ user: PublicUser }>("POST", `/users/${encodeURIComponent(id)}/${disabled ? "disable" : "enable"}`)).user;
  }

  async setUserAccess(req: Request, id: string, input: { expiresAt?: number | null; features?: Partial<Features>; maxDevices?: number }): Promise<PublicUser> {
    this.requireAdmin(req);
    return (await this.admin<{ user: PublicUser }>("POST", `/users/${encodeURIComponent(id)}/access`, input)).user;
  }

  async resetUserDevices(req: Request, id: string): Promise<PublicUser> {
    this.requireAdmin(req);
    return (await this.admin<{ user: PublicUser }>("POST", `/users/${encodeURIComponent(id)}/reset-devices`)).user;
  }

  async listInvites(): Promise<Invite[]> {
    return (await this.admin<{ invites: Invite[] }>("GET", "/invites")).invites;
  }

  async createInvite(_adminId: string, role: UserRole): Promise<Invite> {
    return (await this.admin<{ invite: Invite }>("POST", "/invites", { role })).invite;
  }

  async revokeInvite(id: string): Promise<boolean> {
    return this.adminRevoke(`/invites/${encodeURIComponent(id)}/revoke`);
  }

  async createKey(req: Request, durationDays: number): Promise<AccessKey> {
    this.requireAdmin(req);
    return (await this.admin<{ key: AccessKey }>("POST", "/keys", { durationDays })).key;
  }

  async listKeys(req: Request): Promise<(AccessKey & { createdByUsername: string | null })[]> {
    this.requireAdmin(req);
    return (await this.admin<{ keys: (AccessKey & { createdByUsername: string | null })[] }>("GET", "/keys")).keys;
  }

  async revokeKey(req: Request, id: string): Promise<boolean> {
    this.requireAdmin(req);
    return this.adminRevoke(`/keys/${encodeURIComponent(id)}/revoke`);
  }

  /** false = o servidor não achou (as rotas do painel respondem 404 nesse caso). */
  private async adminRevoke(path: string): Promise<boolean> {
    try {
      await this.admin("POST", path);
      return true;
    } catch (err) {
      if (err instanceof AuthError && err.status === 404) return false;
      throw err;
    }
  }

  /** Qualquer pessoa logada resgata uma chave na própria conta: o servidor soma os dias e manda a licença nova. */
  async redeemKey(req: Request, code: string): Promise<PublicUser> {
    if (!this.currentUser(req) || !this.token) throw new AuthError("Não autenticado.", 401);
    const { token } = await this.call<{ token: string }>("POST", "/v1/redeem", { token: this.token, code });
    if (!this.setLicense(token)) throw new AuthError("O servidor de licenças devolveu uma licença que não vale neste computador.", 502);
    this.options.onChange?.();
    return this.licensedUser()!;
  }
}
