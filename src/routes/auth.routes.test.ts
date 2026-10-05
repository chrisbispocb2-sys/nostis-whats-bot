import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleAuthRoutes } from "./auth.routes";
import { AuthService } from "../core/auth-service";
import { UserStore } from "../core/user-store";
import { InviteStore } from "../core/invite-store";
import { SessionStore } from "../core/session-store";
import { KeyStore } from "../core/key-store";

let dir: string;
let auth: AuthService;
const PORT = 3000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-auth-routes-"));
  auth = new AuthService(
    new UserStore(join(dir, "users.json")),
    new InviteStore(join(dir, "invites.json")),
    new SessionStore(join(dir, "sessions.json")),
    new KeyStore(join(dir, "keys.json"))
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, { body, cookie }: { body?: unknown; cookie?: string } = {}) {
  const url = `http://127.0.0.1:${PORT}${path}`;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers["cookie"] = cookie;
  const req = new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const res = (await handleAuthRoutes(req, new URL(url), auth))!;
  const json: any = await res.json().catch(() => null);
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

function cookieHeaderFrom(setCookie: string | null): string {
  if (!setCookie) return "";
  return `brinzy_session=${Bun.Cookie.parse(setCookie).value}`;
}

test("status: antes de qualquer usuário, pede bootstrap", async () => {
  const res = await call("GET", "/auth/status");
  expect(res.json).toEqual({ authenticated: false, bootstrapNeeded: true, user: null, license: null });
});

test("bootstrap cria o primeiro admin e já loga (cookie volta pronto)", async () => {
  const res = await call("POST", "/auth/bootstrap", { body: { username: "admin", password: "senha-forte-123" } });
  expect(res.status).toBe(200);
  expect(res.json.user.role).toBe("admin");
  expect(res.setCookie).toContain("HttpOnly");

  const again = await call("POST", "/auth/bootstrap", { body: { username: "outro", password: "senha-forte-123" } });
  expect(again.status).toBe(409);
});

test("login certo funciona, login errado dá 401", async () => {
  await call("POST", "/auth/bootstrap", { body: { username: "admin", password: "senha-forte-123" } });

  const ok = await call("POST", "/auth/login", { body: { username: "admin", password: "senha-forte-123" } });
  expect(ok.status).toBe(200);

  const bad = await call("POST", "/auth/login", { body: { username: "admin", password: "errada" } });
  expect(bad.status).toBe(401);
});

test("logout sempre responde ok, mesmo sem sessão nenhuma", async () => {
  const res = await call("POST", "/auth/logout");
  expect(res.status).toBe(200);
});

test("rotas admin: 401 sem login, 403 para operador comum, 200 para admin", async () => {
  const bootstrap = await call("POST", "/auth/bootstrap", { body: { username: "admin", password: "senha-forte-123" } });
  const adminCookie = cookieHeaderFrom(bootstrap.setCookie);

  const noAuth = await call("GET", "/auth/invites");
  expect(noAuth.status).toBe(401);

  const invite = await call("POST", "/auth/invites", { body: { role: "operator" }, cookie: adminCookie });
  expect(invite.status).toBe(200);
  const token = invite.json.invite.id as string;

  const registered = await call("POST", "/auth/register", { body: { inviteToken: token, username: "operador", password: "senha-forte-123" } });
  const operatorCookie = cookieHeaderFrom(registered.setCookie);

  const forbidden = await call("GET", "/auth/invites", { cookie: operatorCookie });
  expect(forbidden.status).toBe(403);

  const allowed = await call("GET", "/auth/invites", { cookie: adminCookie });
  expect(allowed.status).toBe(200);
  expect(allowed.json.invites.length).toBe(1);
});

test("registro com convite inválido dá erro claro", async () => {
  const res = await call("POST", "/auth/register", { body: { inviteToken: "nao-existe", username: "x", password: "senha-forte-123" } });
  expect(res.status).toBe(410);
});

test("admin consegue desativar e reativar um usuário", async () => {
  const bootstrap = await call("POST", "/auth/bootstrap", { body: { username: "admin", password: "senha-forte-123" } });
  const adminCookie = cookieHeaderFrom(bootstrap.setCookie);
  const invite = await call("POST", "/auth/invites", { body: {}, cookie: adminCookie });
  const registered = await call("POST", "/auth/register", {
    body: { inviteToken: invite.json.invite.id, username: "operador", password: "senha-forte-123" },
  });
  const userId = registered.json.user.id as string;

  const disabled = await call("POST", `/auth/users/${userId}/disable`, { cookie: adminCookie });
  expect(disabled.status).toBe(200);
  expect(disabled.json.user.disabled).toBe(true);

  const loginAfterDisable = await call("POST", "/auth/login", { body: { username: "operador", password: "senha-forte-123" } });
  expect(loginAfterDisable.status).toBe(401);

  const enabled = await call("POST", `/auth/users/${userId}/enable`, { cookie: adminCookie });
  expect(enabled.json.user.disabled).toBe(false);
});
