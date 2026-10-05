import type { KeyObject } from "crypto";
import { AuthError, toPublicUser, type Features, type PublicUser, type User, type UserRole, type UserStore } from "./user-store";
import type { InviteStore } from "./invite-store";
import type { KeyStore } from "./key-store";
import type { SessionStore } from "./session-store";
import { readLicense, signLicense, type LicensePayload } from "./license-token";
import { CONFIG } from "./config";

export interface LicenseServerDeps {
  users: UserStore;
  invites: InviteStore;
  keys: KeyStore;
  sessions: SessionStore;
  privateKey: KeyObject;
}

const MAX_BODY_BYTES = 16 * 1024;
const DEVICE_LIMIT_MESSAGE = "Esta conta já está em uso em outro computador. Peça ao administrador para liberar o acesso neste.";

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text().catch(() => "");
  if (!text || text.length > MAX_BODY_BYTES) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown, max = 200): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

function normalizeRole(value: unknown): UserRole {
  return value === "admin" ? "admin" : "operator";
}

/**
 * O servidor de licenças: quem tem conta, até quando, com quais funcionalidades e em quais
 * computadores. O programa do cliente (app/) só fala com ele por aqui — nunca guarda usuário,
 * senha nem prazo por conta própria, só a licença assinada que este servidor entrega.
 */
export function createLicenseServer(deps: LicenseServerDeps): (req: Request) => Promise<Response> {
  const { users, invites, keys, sessions, privateKey } = deps;

  /** Abre a sessão da conta naquele computador e emite a licença dele. */
  function openSession(user: User, deviceId: string, deviceName: string): { token: string } {
    if (!deviceId) throw new AuthError("Não foi possível identificar este computador.");
    if (!users.claimDevice(user.id, deviceId, deviceName)) throw new AuthError(DEVICE_LIMIT_MESSAGE, 403);
    return { token: issue(user, sessions.create(user.id, deviceId).id, deviceId) };
  }

  function issue(user: User, sessionId: string, deviceId: string): string {
    const now = Date.now();
    const payload: LicensePayload = {
      v: 1,
      sessionId,
      userId: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      expiresAt: user.expiresAt,
      features: user.features,
      deviceId,
      issuedAt: now,
      validUntil: now + CONFIG.offlineGraceMs,
    };
    return signLicense(payload, privateKey);
  }

  /**
   * Quem está por trás de uma licença, se ela ainda vale no servidor: sessão aberta, conta ativa e
   * o computador ainda liberado pra ela. Qualquer outra coisa é 401 — o programa desloga na hora.
   */
  function authenticate(token: string): { user: User; payload: LicensePayload } {
    const payload = readLicense(token, privateKey);
    const session = payload ? sessions.find(payload.sessionId) : null;
    const user = session ? users.findById(session.userId) : null;
    const deviceOk = !!user && !!payload && session!.deviceId === payload.deviceId && user.devices.some((d) => d.id === payload.deviceId);
    if (!payload || !session || !user || user.disabled || !deviceOk) {
      throw new AuthError("Sua sessão não é mais válida. Entre de novo.", 401);
    }
    return { user, payload };
  }

  function bearer(req: Request): string {
    return (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  }

  function requireAdmin(req: Request): User {
    const { user } = authenticate(bearer(req));
    if (user.role !== "admin") throw new AuthError("Só um administrador pode fazer isso.", 403);
    return user;
  }

  function adminUserView(user: PublicUser, online: Set<string>) {
    return { ...user, online: online.has(user.id) };
  }

  async function route(req: Request, url: URL): Promise<Response | null> {
    const { pathname } = url;
    const method = req.method;

    if (pathname === "/health" && method === "GET") return Response.json({ ok: true });

    /* ---------- Programa do cliente: entrar, renovar, sair ---------- */

    if (pathname === "/v1/login" && method === "POST") {
      const body = await readBody(req);
      const user = users.verifyCredentials(text(body["username"]), typeof body["password"] === "string" ? body["password"] : "");
      if (!user) throw new AuthError("Usuário ou senha inválidos.", 401);
      return Response.json(openSession(user, text(body["deviceId"]), text(body["deviceName"])));
    }

    if (pathname === "/v1/register" && method === "POST") {
      const body = await readBody(req);
      const inviteToken = text(body["inviteToken"]);
      const invite = invites.findValid(inviteToken);
      if (!invite) throw new AuthError("Este convite é inválido, já foi usado ou expirou.", 410);
      const deviceId = text(body["deviceId"]);
      if (!deviceId) throw new AuthError("Não foi possível identificar este computador.");
      const user = users.create(text(body["username"]), typeof body["password"] === "string" ? body["password"] : "", invite.role);
      invites.markUsed(inviteToken, user.id);
      return Response.json(openSession(user, deviceId, text(body["deviceName"])));
    }

    if (pathname === "/v1/refresh" && method === "POST") {
      const { user, payload } = authenticate(text((await readBody(req))["token"], 4000));
      sessions.touch(payload.sessionId);
      return Response.json({ token: issue(user, payload.sessionId, payload.deviceId) });
    }

    if (pathname === "/v1/logout" && method === "POST") {
      const payload = readLicense(text((await readBody(req))["token"], 4000), privateKey);
      if (payload) sessions.delete(payload.sessionId);
      return Response.json({ ok: true });
    }

    /** Qualquer pessoa logada resgata uma chave na própria conta, pra estender o prazo dela. */
    if (pathname === "/v1/redeem" && method === "POST") {
      const body = await readBody(req);
      const { user, payload } = authenticate(text(body["token"], 4000));
      const code = text(body["code"]).toUpperCase();
      if (!keys.findValid(code)) throw new AuthError("Essa chave é inválida, já foi usada ou expirou.", 410);
      const updated = users.extendExpiry(user.id, keys.findValid(code)!.durationDays);
      keys.markUsed(code, user.id);
      return Response.json({ token: issue(updated, payload.sessionId, payload.deviceId) });
    }

    /* ---------- Administração (o painel do app repassa pra cá, com a licença de um administrador) ---------- */

    if (!pathname.startsWith("/v1/admin/")) return null;
    const admin = requireAdmin(req);

    if (pathname === "/v1/admin/users" && method === "GET") {
      const online = sessions.onlineUserIds();
      return Response.json({ users: users.list().map((u) => adminUserView(u, online)) });
    }

    const userAction = pathname.match(/^\/v1\/admin\/users\/([^/]+)\/(disable|enable|access|reset-devices)$/);
    if (userAction && method === "POST") {
      const id = decodeURIComponent(userAction[1]!);
      const action = userAction[2]!;

      if (action === "disable" || action === "enable") {
        if (action === "disable" && id === admin.id) throw new AuthError("Você não pode desativar a própria conta.", 409);
        const user = users.setDisabled(id, action === "disable");
        if (action === "disable") sessions.deleteAllForUser(id);
        return Response.json({ user: toPublicUser(user) });
      }

      if (action === "reset-devices") {
        const user = users.resetDevices(id);
        sessions.deleteAllForUser(id); // quem estava logado precisa entrar de novo (e ocupa a vaga de novo)
        return Response.json({ user: toPublicUser(user) });
      }

      const body = await readBody(req);
      let user = users.findById(id);
      if (!user) throw new AuthError("Usuário não encontrado.", 404);
      const expiresAt = body["expiresAt"];
      if (expiresAt === null || (typeof expiresAt === "number" && Number.isFinite(expiresAt))) user = users.setExpiresAt(id, expiresAt);
      if (body["features"] && typeof body["features"] === "object") user = users.setFeatures(id, body["features"] as Partial<Features>);
      if (body["maxDevices"] !== undefined) user = users.setMaxDevices(id, Number(body["maxDevices"]));
      return Response.json({ user: toPublicUser(user) });
    }

    if (pathname === "/v1/admin/invites" && method === "GET") return Response.json({ invites: invites.list() });

    if (pathname === "/v1/admin/invites" && method === "POST") {
      return Response.json({ invite: invites.create(admin.id, normalizeRole((await readBody(req))["role"])) });
    }

    const inviteRevoke = pathname.match(/^\/v1\/admin\/invites\/([^/]+)\/revoke$/);
    if (inviteRevoke && method === "POST") {
      if (!invites.revoke(decodeURIComponent(inviteRevoke[1]!))) throw new AuthError("Convite não encontrado.", 404);
      return Response.json({ ok: true });
    }

    if (pathname === "/v1/admin/keys" && method === "GET") {
      return Response.json({ keys: keys.list().map((k) => ({ ...k, createdByUsername: users.findById(k.createdBy)?.username ?? null })) });
    }

    if (pathname === "/v1/admin/keys" && method === "POST") {
      const durationDays = Number((await readBody(req))["durationDays"]);
      if (!Number.isFinite(durationDays) || durationDays <= 0) throw new AuthError("Informe quantos dias a chave vai conceder.");
      return Response.json({ key: keys.create(admin.id, Math.floor(durationDays)) });
    }

    const keyRevoke = pathname.match(/^\/v1\/admin\/keys\/([^/]+)\/revoke$/);
    if (keyRevoke && method === "POST") {
      if (!keys.revoke(decodeURIComponent(keyRevoke[1]!))) throw new AuthError("Chave não encontrada.", 404);
      return Response.json({ ok: true });
    }

    return null;
  }

  return async function handle(req: Request): Promise<Response> {
    try {
      return (await route(req, new URL(req.url))) ?? Response.json({ error: "Não encontrado." }, { status: 404 });
    } catch (err) {
      if (err instanceof AuthError) return Response.json({ error: err.message }, { status: err.status });
      console.error("Erro inesperado no servidor de licenças:", err);
      return Response.json({ error: "Erro inesperado." }, { status: 500 });
    }
  };
}
