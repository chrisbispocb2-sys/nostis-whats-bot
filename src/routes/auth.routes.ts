import type { AuthProvider } from "../core/auth-provider";
import { AuthError, toPublicUser, type UserRole } from "../core/user-store";
import { APP_VERSION } from "../config/version";

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
  if (value === "admin") return "admin";
  if (value === "leader") return "leader";
  return "operator";
}

export async function handleAuthRoutes(req: Request, url: URL, auth: AuthProvider): Promise<Response | null> {
  if (!url.pathname.startsWith("/auth/")) return null;

  try {
    if (url.pathname === "/auth/status" && req.method === "GET") {
      const user = auth.currentUser(req);
      return Response.json({
        authenticated: !!user,
        bootstrapNeeded: auth.isBootstrapNeeded(),
        user: user ? toPublicUser(user) : null,
        // Só com servidor de licenças: o painel avisa quando está sem falar com ele
        license: user ? (auth.licenseStatus?.() ?? null) : null,
        // Atualização publicada pelo admin (botão "Baixar atualização"), se houver uma mais nova
        update: user ? (auth.availableUpdate?.() ?? null) : null,
        // Versão deste programa (o admin vê no painel; a publicação compara com ela)
        appVersion: APP_VERSION,
      });
    }

    if (url.pathname === "/auth/bootstrap" && req.method === "POST") {
      const { username, password } = await readBody<{ username?: string; password?: string }>(req);
      const { user, cookie } = await auth.bootstrap(String(username ?? ""), String(password ?? ""));
      return withCookie({ user }, cookie);
    }

    if (url.pathname === "/auth/login" && req.method === "POST") {
      const { username, password } = await readBody<{ username?: string; password?: string }>(req);
      const { user, cookie } = await auth.login(String(username ?? ""), String(password ?? ""));
      return withCookie({ user }, cookie);
    }

    if (url.pathname === "/auth/logout" && req.method === "POST") {
      return withCookie({ ok: true }, await auth.logoutCookieHeader(req));
    }

    if (url.pathname === "/auth/register" && req.method === "POST") {
      const { inviteToken, username, password } = await readBody<{ inviteToken?: string; username?: string; password?: string }>(req);
      const { user, cookie } = await auth.registerViaInvite(String(inviteToken ?? ""), String(username ?? ""), String(password ?? ""));
      return withCookie({ user }, cookie);
    }

    if (url.pathname === "/auth/invites" && req.method === "GET") {
      auth.requireAdmin(req);
      return Response.json({ invites: await auth.listInvites() });
    }

    if (url.pathname === "/auth/invites" && req.method === "POST") {
      const admin = auth.requireAdmin(req);
      const { role } = await readBody<{ role?: string }>(req);
      return Response.json({ invite: await auth.createInvite(admin.id, normalizeRole(role)) });
    }

    const revokeMatch = url.pathname.match(/^\/auth\/invites\/([^/]+)\/revoke$/);
    if (revokeMatch && req.method === "POST") {
      auth.requireAdmin(req);
      const ok = await auth.revokeInvite(decodeURIComponent(revokeMatch[1]!));
      return ok ? Response.json({ ok: true }) : Response.json({ error: "Convite não encontrado." }, { status: 404 });
    }

    if (url.pathname === "/auth/users" && req.method === "GET") {
      auth.requireAdmin(req);
      return Response.json({ users: await auth.listUsers() });
    }

    const disableMatch = url.pathname.match(/^\/auth\/users\/([^/]+)\/(disable|enable)$/);
    if (disableMatch && req.method === "POST") {
      auth.requireAdmin(req);
      const user = await auth.setUserDisabled(decodeURIComponent(disableMatch[1]!), disableMatch[2] === "disable");
      return Response.json({ user });
    }

    const accessMatch = url.pathname.match(/^\/auth\/users\/([^/]+)\/access$/);
    if (accessMatch && req.method === "POST") {
      const body = await readBody<{ expiresAt?: number | null; features?: Record<string, boolean>; maxDevices?: number; team?: string | null }>(req);
      const user = await auth.setUserAccess(req, decodeURIComponent(accessMatch[1]!), body);
      return Response.json({ user });
    }

    // Libera os computadores em que a conta já entrou (só existe com servidor de licenças)
    const resetDevicesMatch = url.pathname.match(/^\/auth\/users\/([^/]+)\/reset-devices$/);
    if (resetDevicesMatch && req.method === "POST" && auth.resetUserDevices) {
      const user = await auth.resetUserDevices(req, decodeURIComponent(resetDevicesMatch[1]!));
      return Response.json({ user });
    }

    // Muda o papel de uma conta já existente (promover a líder, rebaixar...) — só com servidor de licenças
    const roleMatch = url.pathname.match(/^\/auth\/users\/([^/]+)\/role$/);
    if (roleMatch && req.method === "POST" && auth.setUserRole) {
      const { role } = await readBody<{ role?: string }>(req);
      const user = await auth.setUserRole(req, decodeURIComponent(roleMatch[1]!), normalizeRole(role));
      return Response.json({ user });
    }

    if (url.pathname === "/auth/keys" && req.method === "GET") {
      return Response.json({ keys: await auth.listKeys(req) });
    }

    if (url.pathname === "/auth/keys" && req.method === "POST") {
      const { durationDays } = await readBody<{ durationDays?: number }>(req);
      return Response.json({ key: await auth.createKey(req, Number(durationDays)) });
    }

    const revokeKeyMatch = url.pathname.match(/^\/auth\/keys\/([^/]+)\/revoke$/);
    if (revokeKeyMatch && req.method === "POST") {
      const ok = await auth.revokeKey(req, decodeURIComponent(revokeKeyMatch[1]!));
      return ok ? Response.json({ ok: true }) : Response.json({ error: "Chave não encontrada." }, { status: 404 });
    }

    if (url.pathname === "/auth/keys/redeem" && req.method === "POST") {
      const { code } = await readBody<{ code?: string }>(req);
      const user = await auth.redeemKey(req, String(code ?? "").trim());
      return Response.json({ user });
    }

    // Versão do app disponível pra baixar (admin publica; vira o botão "Baixar atualização" dos usuários)
    if (url.pathname === "/auth/release" && req.method === "GET" && auth.getRelease) {
      auth.requireAdmin(req);
      return Response.json({ release: await auth.getRelease(req) });
    }

    if (url.pathname === "/auth/release" && req.method === "POST" && auth.setRelease) {
      const body = await readBody<{ version?: string; url?: string; notes?: string }>(req);
      return Response.json({ release: await auth.setRelease(req, { version: String(body.version ?? ""), url: String(body.url ?? ""), notes: body.notes ? String(body.notes) : undefined }) });
    }

    if (url.pathname === "/auth/release/clear" && req.method === "POST" && auth.clearRelease) {
      await auth.clearRelease(req);
      return Response.json({ ok: true });
    }

    /* ---------- Painel do líder: gerência dos próprios funcionários (só com servidor de licenças) ---------- */

    if (url.pathname === "/auth/leader/employees" && req.method === "GET" && auth.listEmployees) {
      auth.requireLeader!(req);
      return Response.json({ employees: await auth.listEmployees(req) });
    }

    const employeeConfigMatch = url.pathname.match(/^\/auth\/leader\/employees\/([^/]+)\/config$/);
    if (employeeConfigMatch && req.method === "POST" && auth.setEmployeeConfig) {
      const body = await readBody<{ feePercent?: number; maxWhatsapps?: number; withdrawBlocked?: boolean }>(req);
      return Response.json({ employee: await auth.setEmployeeConfig(req, decodeURIComponent(employeeConfigMatch[1]!), body) });
    }

    const employeeDisableMatch = url.pathname.match(/^\/auth\/leader\/employees\/([^/]+)\/(disable|enable)$/);
    if (employeeDisableMatch && req.method === "POST" && auth.setEmployeeDisabled) {
      const employee = await auth.setEmployeeDisabled(req, decodeURIComponent(employeeDisableMatch[1]!), employeeDisableMatch[2] === "disable");
      return Response.json({ employee });
    }

    const employeeResetWaMatch = url.pathname.match(/^\/auth\/leader\/employees\/([^/]+)\/reset-whatsapps$/);
    if (employeeResetWaMatch && req.method === "POST" && auth.resetEmployeeWhatsapps) {
      return Response.json({ employee: await auth.resetEmployeeWhatsapps(req, decodeURIComponent(employeeResetWaMatch[1]!)) });
    }

    if (url.pathname === "/auth/leader/invites" && req.method === "GET" && auth.listEmployeeInvites) {
      auth.requireLeader!(req);
      return Response.json({ invites: await auth.listEmployeeInvites(req) });
    }

    if (url.pathname === "/auth/leader/invites" && req.method === "POST" && auth.createEmployeeInvite) {
      return Response.json({ invite: await auth.createEmployeeInvite(req) });
    }

    const employeeInviteRevokeMatch = url.pathname.match(/^\/auth\/leader\/invites\/([^/]+)\/revoke$/);
    if (employeeInviteRevokeMatch && req.method === "POST" && auth.revokeEmployeeInvite) {
      const ok = await auth.revokeEmployeeInvite(req, decodeURIComponent(employeeInviteRevokeMatch[1]!));
      return ok ? Response.json({ ok: true }) : Response.json({ error: "Convite não encontrado." }, { status: 404 });
    }

    // MisticPay da empresa: o líder configura as credenciais (que ficam só no servidor)
    if (url.pathname === "/auth/leader/mistic" && req.method === "GET" && auth.misticStatus) {
      return Response.json(await auth.misticStatus(req));
    }

    if (url.pathname === "/auth/leader/mistic" && req.method === "POST" && auth.setMisticCredentials) {
      const body = await readBody<{ clientId?: string; clientSecret?: string; authHeader?: string }>(req);
      return Response.json(await auth.setMisticCredentials(req, { clientId: String(body.clientId ?? ""), clientSecret: String(body.clientSecret ?? ""), authHeader: body.authHeader ? String(body.authHeader) : undefined }));
    }

    if (url.pathname === "/auth/leader/mistic/clear" && req.method === "POST" && auth.clearMisticCredentials) {
      await auth.clearMisticCredentials(req);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/auth/leader/mistic/account" && req.method === "GET" && auth.leaderMisticAccount) {
      return Response.json(await auth.leaderMisticAccount(req));
    }

    if (url.pathname === "/auth/leader/money/summary" && req.method === "GET" && auth.leaderMoneySummary) {
      return Response.json(await auth.leaderMoneySummary(req));
    }

    if (url.pathname === "/auth/leader/mistic/withdraw-password" && req.method === "POST" && auth.setLeaderWithdrawPassword) {
      const body = await readBody<{ password?: string | null; currentPassword?: string }>(req);
      return Response.json(await auth.setLeaderWithdrawPassword(req, body.password === null ? null : String(body.password ?? ""), body.currentPassword));
    }

    if (url.pathname === "/auth/leader/mistic/withdraw" && req.method === "POST" && auth.leaderWithdraw) {
      const body = await readBody<{ amount?: number; pixKey?: string; pixKeyType?: string; description?: string; withdrawPassword?: string }>(req);
      return Response.json({ withdrawal: await auth.leaderWithdraw(req, { amount: Number(body.amount), pixKey: String(body.pixKey ?? ""), pixKeyType: String(body.pixKeyType ?? ""), description: body.description, withdrawPassword: String(body.withdrawPassword ?? "") }) });
    }
  } catch (err) {
    return errorResponse(err);
  }

  return null;
}
