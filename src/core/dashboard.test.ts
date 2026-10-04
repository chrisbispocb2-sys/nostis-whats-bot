import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountManager } from "./account-manager";
import { createDashboardHandler } from "./dashboard";
import { fakeConnections, tempDirs } from "../testing/fakes";
import { AuthService } from "./auth-service";
import { UserStore } from "./user-store";
import { InviteStore } from "./invite-store";
import { SessionStore } from "./session-store";
import { KeyStore } from "./key-store";
import { join } from "path";

const PORT = 3000;

let dirs: ReturnType<typeof tempDirs>;
let manager: AccountManager;

beforeEach(() => {
  dirs = tempDirs();
  const { factory } = fakeConnections();
  manager = new AccountManager({ appDataDir: dirs.appDataDir, tempDir: dirs.tempDir, createConnection: factory, notify: () => {} });
});

afterEach(() => {
  manager.stopAll();
  dirs.cleanup();
});

async function call(handler: (req: Request) => Promise<Response>, method: string, path: string) {
  const res = await handler(new Request(`http://127.0.0.1:${PORT}${path}`, { method }));
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // não era JSON (a página em si, por exemplo)
  }
  return { status: res.status, json, text };
}

describe("login por convite: exigir sessão para usar o painel", () => {
  let authDir: ReturnType<typeof tempDirs>;
  let auth: AuthService;

  beforeEach(() => {
    authDir = tempDirs();
    auth = new AuthService(
      new UserStore(join(authDir.appDataDir, "users.json")),
      new InviteStore(join(authDir.appDataDir, "invites.json")),
      new SessionStore(join(authDir.appDataDir, "sessions.json")),
      new KeyStore(join(authDir.appDataDir, "keys.json"))
    );
  });

  afterEach(() => authDir.cleanup());

  function cookieHeader(setCookie: string): string {
    return `brinzy_session=${Bun.Cookie.parse(setCookie).value}`;
  }

  test("sem o 'auth' nas opções (como nos testes acima), continua livre — compatibilidade com quem não liga login", async () => {
    const handler = createDashboardHandler(manager, PORT);
    expect((await call(handler, "GET", "/accounts/default/status")).status).toBe(200);
  });

  test("com login ligado e sem sessão, rota de conta devolve 401 — mas a página em si continua de pé", async () => {
    const handler = createDashboardHandler(manager, PORT, { auth });

    const status = await call(handler, "GET", "/accounts/default/status");
    expect(status.status).toBe(401);

    const home = await call(handler, "GET", "/");
    expect(home.status).toBe(200);
    expect(home.text.toLowerCase()).toContain("<html");
  });

  test("com sessão válida (cookie), a rota de conta funciona normalmente", async () => {
    const handler = createDashboardHandler(manager, PORT, { auth });
    const { cookie } = auth.bootstrap("admin", "senha-forte-123");

    const res = await handler(
      new Request(`http://127.0.0.1:${PORT}/accounts/default/status`, { headers: { cookie: cookieHeader(cookie) } })
    );
    expect(res.status).toBe(200);
  });

  test("/auth/status funciona sem sessão nenhuma e reflete o login depois", async () => {
    const handler = createDashboardHandler(manager, PORT, { auth });

    const before = await call(handler, "GET", "/auth/status");
    expect(before.json).toMatchObject({ authenticated: false, bootstrapNeeded: true });

    const { cookie } = auth.bootstrap("admin", "senha-forte-123");
    const after = await handler(new Request(`http://127.0.0.1:${PORT}/auth/status`, { headers: { cookie: cookieHeader(cookie) } }));
    const afterJson = await after.json();
    expect(afterJson).toMatchObject({ authenticated: true, bootstrapNeeded: false, user: { username: "admin", role: "admin" } });
  });

  test("/overlay/state não exige sessão (não é dado sensível)", async () => {
    // sem passar `overlay`, a rota devolve null e cai em 404 — aqui só confirmamos que o login não barra antes disso (nada de 401)
    const handler = createDashboardHandler(manager, PORT, { auth });
    const res = await call(handler, "GET", "/overlay/state");
    expect(res.status).not.toBe(401);
  });
});
