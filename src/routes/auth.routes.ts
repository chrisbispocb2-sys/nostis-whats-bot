import type { AuthService } from "../core/auth-service";
import { AuthError, toPublicUser, type UserRole } from "../core/user-store";

function errorResponse(err: unknown): Response {
  if (err instanceof AuthError) return Response.json({ error: err.message }, { status: err.status });
  console.error("Erro inesperado na autenticação:", err);
  return Response.json({ error: "Erro inesperado." }, { status: 500 });
}

async function readBody<T>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T;
}

function withCookie(body: unknown, cookie: string, status = 200): Response {
  return Response.json(body, { status, headers: { "Set-Cookie": cookie } });
}

function normalizeRole(value: unknown): UserRole {
  return value === "admin" ? "admin" : "operator";
}

export async function handleAuthRoutes(req: Request, url: URL, auth: AuthService): Promise<Response | null> {
  if (!url.pathname.startsWith("/auth/")) return null;

  try {
    if (url.pathname === "/auth/status" && req.method === "GET") {
      const user = auth.currentUser(req);
      return Response.json({
        authenticated: !!user,
        bootstrapNeeded: auth.isBootstrapNeeded(),
        user: user ? toPublicUser(user) : null,
      });
    }

    if (url.pathname === "/auth/bootstrap" && req.method === "POST") {
      const { username, password } = await readBody<{ username?: string; password?: string }>(req);
      const { user, cookie } = auth.bootstrap(String(username ?? ""), String(password ?? ""));
      return withCookie({ user }, cookie);
    }

    if (url.pathname === "/auth/login" && req.method === "POST") {
      const { username, password } = await readBody<{ username?: string; password?: string }>(req);
      const { user, cookie } = auth.login(String(username ?? ""), String(password ?? ""));
      return withCookie({ user }, cookie);
    }

    if (url.pathname === "/auth/logout" && req.method === "POST") {
      return withCookie({ ok: true }, auth.logoutCookieHeader(req));
    }

    if (url.pathname === "/auth/register" && req.method === "POST") {
      const { inviteToken, username, password } = await readBody<{ inviteToken?: string; username?: string; password?: string }>(req);
      const { user, cookie } = auth.registerViaInvite(String(inviteToken ?? ""), String(username ?? ""), String(password ?? ""));
      return withCookie({ user }, cookie);
    }

    if (url.pathname === "/auth/invites" && req.method === "GET") {
      auth.requireAdmin(req);
      return Response.json({ invites: auth.listInvites() });
    }

    if (url.pathname === "/auth/invites" && req.method === "POST") {
      const admin = auth.requireAdmin(req);
      const { role } = await readBody<{ role?: string }>(req);
      return Response.json({ invite: auth.createInvite(admin.id, normalizeRole(role)) });
    }

    const revokeMatch = url.pathname.match(/^\/auth\/invites\/([^/]+)\/revoke$/);
    if (revokeMatch && req.method === "POST") {
      auth.requireAdmin(req);
      const ok = auth.revokeInvite(decodeURIComponent(revokeMatch[1]!));
      return ok ? Response.json({ ok: true }) : Response.json({ error: "Convite não encontrado." }, { status: 404 });
    }

    if (url.pathname === "/auth/users" && req.method === "GET") {
      auth.requireAdmin(req);
      return Response.json({ users: auth.listUsers() });
    }

    const disableMatch = url.pathname.match(/^\/auth\/users\/([^/]+)\/(disable|enable)$/);
    if (disableMatch && req.method === "POST") {
      auth.requireAdmin(req);
      const user = auth.setUserDisabled(decodeURIComponent(disableMatch[1]!), disableMatch[2] === "disable");
      return Response.json({ user });
    }

    const accessMatch = url.pathname.match(/^\/auth\/users\/([^/]+)\/access$/);
    if (accessMatch && req.method === "POST") {
      const body = await readBody<{ expiresAt?: number | null; features?: Record<string, boolean> }>(req);
      const user = auth.setUserAccess(req, decodeURIComponent(accessMatch[1]!), body);
      return Response.json({ user });
    }

    if (url.pathname === "/auth/keys" && req.method === "GET") {
      return Response.json({ keys: auth.listKeys(req) });
    }

    if (url.pathname === "/auth/keys" && req.method === "POST") {
      const { durationDays } = await readBody<{ durationDays?: number }>(req);
      return Response.json({ key: auth.createKey(req, Number(durationDays)) });
    }

    const revokeKeyMatch = url.pathname.match(/^\/auth\/keys\/([^/]+)\/revoke$/);
    if (revokeKeyMatch && req.method === "POST") {
      const ok = auth.revokeKey(req, decodeURIComponent(revokeKeyMatch[1]!));
      return ok ? Response.json({ ok: true }) : Response.json({ error: "Chave não encontrada." }, { status: 404 });
    }

    if (url.pathname === "/auth/keys/redeem" && req.method === "POST") {
      const { code } = await readBody<{ code?: string }>(req);
      const user = auth.redeemKey(req, String(code ?? "").trim());
      return Response.json({ user });
    }
  } catch (err) {
    return errorResponse(err);
  }

  return null;
}
