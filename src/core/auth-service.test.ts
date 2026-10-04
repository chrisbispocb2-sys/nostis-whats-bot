import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AuthService } from "./auth-service";
import { UserStore } from "./user-store";
import { InviteStore } from "./invite-store";
import { SessionStore } from "./session-store";
import { KeyStore } from "./key-store";

let dir: string;
let auth: AuthService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-auth-"));
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

/** Extrai o valor do cookie de um cabeçalho `Set-Cookie`, pra montar um pedido de volta com ele. */
function cookieValue(setCookieHeader: string): string {
  return Bun.Cookie.parse(setCookieHeader).value;
}

function requestWithSession(setCookieHeader: string, url = "http://127.0.0.1:3000/accounts/default/status"): Request {
  return new Request(url, { headers: { cookie: `brinzy_session=${cookieValue(setCookieHeader)}` } });
}

test("bootstrap: funciona só uma vez (a segunda tentativa dá 409)", () => {
  const first = auth.bootstrap("admin", "senha-forte-123");
  expect(first.user.role).toBe("admin");
  expect(auth.isBootstrapNeeded()).toBe(false);

  expect(() => auth.bootstrap("outroadmin", "senha-forte-123")).toThrow("Já existe uma conta");
});

test("o cookie de sessão é HttpOnly, SameSite=Lax e sem Secure (http puro em 127.0.0.1)", () => {
  const { cookie } = auth.bootstrap("admin", "senha-forte-123");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).not.toContain("Secure");
});

test("login certo autentica; login errado lança 401", () => {
  auth.bootstrap("admin", "senha-forte-123");

  const { cookie } = auth.login("admin", "senha-forte-123");
  const req = requestWithSession(cookie);
  expect(auth.currentUser(req)?.username).toBe("admin");

  expect(() => auth.login("admin", "errada")).toThrow("Usuário ou senha inválidos");
});

test("sem cookie nenhum, currentUser é null", () => {
  expect(auth.currentUser(new Request("http://127.0.0.1:3000/accounts/default/status"))).toBeNull();
});

test("registro por convite: funciona com convite válido e aplica o papel do convite", () => {
  const { user: adminUser } = auth.bootstrap("admin", "senha-forte-123");
  const invite = auth.createInvite(adminUser.id, "operator");

  const { user, cookie } = auth.registerViaInvite(invite.id, "novooperador", "senha-forte-123");
  expect(user.role).toBe("operator");
  expect(auth.currentUser(requestWithSession(cookie))?.username).toBe("novooperador");

  // o mesmo convite não serve de novo
  expect(() => auth.registerViaInvite(invite.id, "outraconta", "senha-forte-123")).toThrow(/inválido|usado|expirou/);
});

test("registro com convite inexistente/revogado/expirado falha", () => {
  const { user: adminUser } = auth.bootstrap("admin", "senha-forte-123");
  expect(() => auth.registerViaInvite("token-que-nao-existe", "x", "senha-forte-123")).toThrow();

  const revoked = auth.createInvite(adminUser.id, "operator");
  auth.revokeInvite(revoked.id);
  expect(() => auth.registerViaInvite(revoked.id, "x", "senha-forte-123")).toThrow();
});

test("logout invalida a sessão (o cookie antigo deixa de autenticar)", () => {
  const { cookie } = auth.bootstrap("admin", "senha-forte-123");
  const req = requestWithSession(cookie);
  expect(auth.currentUser(req)).not.toBeNull();

  auth.logoutCookieHeader(req);
  expect(auth.currentUser(req)).toBeNull();
});

test("requireAdmin: 401 sem sessão, 403 para operador, passa para admin", () => {
  const { user: adminUser } = auth.bootstrap("admin", "senha-forte-123");
  const invite = auth.createInvite(adminUser.id, "operator");
  const { cookie: operatorCookie } = auth.registerViaInvite(invite.id, "operador", "senha-forte-123");
  const { cookie: adminCookie } = auth.login("admin", "senha-forte-123");

  expect(() => auth.requireAdmin(new Request("http://127.0.0.1:3000/"))).toThrow();
  expect(() => auth.requireAdmin(requestWithSession(operatorCookie))).toThrow();
  expect(() => auth.requireAdmin(requestWithSession(adminCookie))).not.toThrow();
});

test("desativar um usuário derruba as sessões dele na hora", () => {
  const { user: adminUser } = auth.bootstrap("admin", "senha-forte-123");
  const invite = auth.createInvite(adminUser.id, "operator");
  const { user, cookie } = auth.registerViaInvite(invite.id, "operador", "senha-forte-123");
  const req = requestWithSession(cookie);
  expect(auth.currentUser(req)).not.toBeNull();

  auth.setUserDisabled(user.id, true);
  expect(auth.currentUser(req)).toBeNull();
});

test("isAuthorizedForAccount: aceita sessão de cookie normal", () => {
  const { cookie } = auth.bootstrap("admin", "senha-forte-123");
  const url = new URL("http://127.0.0.1:3000/accounts/default/mistic/config");
  expect(auth.isAuthorizedForAccount(requestWithSession(cookie), url)).toBe(true);
});

test("isAuthorizedForAccount: aceita um pay-token válido só para a conta dele", () => {
  const token = auth.issuePayToken("default");

  const urlOk = new URL("http://127.0.0.1:3000/accounts/default/mistic/config?token=" + token);
  expect(auth.isAuthorizedForAccount(new Request(urlOk.href), urlOk)).toBe(true);

  const urlOtherAccount = new URL("http://127.0.0.1:3000/accounts/outraconta/mistic/config?token=" + token);
  expect(auth.isAuthorizedForAccount(new Request(urlOtherAccount.href), urlOtherAccount)).toBe(false);
});

test("isAuthorizedForAccount: sem cookie e sem token, nega", () => {
  const url = new URL("http://127.0.0.1:3000/accounts/default/mistic/config");
  expect(auth.isAuthorizedForAccount(new Request(url.href), url)).toBe(false);
});

test("hasActiveSession reflete se existe alguém logado em algum lugar", () => {
  expect(auth.hasActiveSession()).toBe(false);
  auth.bootstrap("admin", "senha-forte-123");
  expect(auth.hasActiveSession()).toBe(true);
});

/* ---------- Painel de administração: prazo, funcionalidades e chaves ---------- */

function makeOperator() {
  const { user: adminUser, cookie: adminCookie } = auth.bootstrap("admin", "senha-forte-123");
  const invite = auth.createInvite(adminUser.id, "operator");
  const { user, cookie } = auth.registerViaInvite(invite.id, "operador", "senha-forte-123");
  return { adminCookie: requestWithSession(adminCookie), operatorCookie: requestWithSession(cookie), user };
}

test("setUserAccess exige admin e aplica prazo + funcionalidades", () => {
  const { adminCookie, operatorCookie, user } = makeOperator();

  expect(() => auth.setUserAccess(operatorCookie, user.id, { features: { chat: true } })).toThrow();

  const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const updated = auth.setUserAccess(adminCookie, user.id, { expiresAt: future, features: { chat: true, metrics: true } });
  expect(updated.expiresAt).toBe(future);
  expect(updated.features.chat).toBe(true);
  expect(updated.features.metrics).toBe(true);
  expect(updated.features.campaigns).toBe(false); // não mexeu, continua desligado
});

test("createKey/listKeys/revokeKey exigem admin", () => {
  const { adminCookie, operatorCookie } = makeOperator();

  expect(() => auth.createKey(operatorCookie, 30)).toThrow();
  const key = auth.createKey(adminCookie, 30);
  expect(key.durationDays).toBe(30);

  expect(() => auth.listKeys(operatorCookie)).toThrow();
  expect(auth.listKeys(adminCookie).length).toBe(1);

  expect(() => auth.revokeKey(operatorCookie, key.id)).toThrow();
  expect(auth.revokeKey(adminCookie, key.id)).toBe(true);
});

test("listKeys resolve o nome de quem criou a chave", () => {
  const { adminCookie } = makeOperator();
  auth.createKey(adminCookie, 30);

  const [key] = auth.listKeys(adminCookie);
  expect(key.createdByUsername).toBe("admin");
});

test("listUsers: só entra como online quem fez uma requisição autenticada recentemente", () => {
  const { adminCookie, operatorCookie, user } = makeOperator();

  // adminCookie e operatorCookie já representam uma requisição de cada: currentUser() já tocou as sessões
  auth.currentUser(adminCookie);
  auth.currentUser(operatorCookie);

  const users = auth.listUsers();
  expect(users.find((u) => u.id === user.id)?.online).toBe(true);
  expect(users.every((u) => typeof u.online === "boolean")).toBe(true);
});

test("redeemKey: qualquer pessoa logada resgata na própria conta e estende o prazo", () => {
  const { adminCookie, operatorCookie, user } = makeOperator();
  const key = auth.createKey(adminCookie, 15);

  const updated = auth.redeemKey(operatorCookie, key.id);
  expect(updated.id).toBe(user.id);
  expect(updated.expiresAt).toBeGreaterThan(Date.now());

  // a mesma chave não serve de novo
  expect(() => auth.redeemKey(operatorCookie, key.id)).toThrow();
});

test("redeemKey: sem sessão, código errado/revogado — tudo falha", () => {
  const { adminCookie, operatorCookie } = makeOperator();
  expect(() => auth.redeemKey(new Request("http://127.0.0.1:3000/"), "qualquer")).toThrow();
  expect(() => auth.redeemKey(operatorCookie, "codigo-que-nao-existe")).toThrow();

  const revoked = auth.createKey(adminCookie, 10);
  auth.revokeKey(adminCookie, revoked.id);
  expect(() => auth.redeemKey(operatorCookie, revoked.id)).toThrow();
});

test("canUse: admin sempre pode, operador segue a funcionalidade liberada", () => {
  const { adminCookie, operatorCookie, user } = makeOperator();
  expect(auth.canUse(adminCookie, "chat")).toBe(true);
  expect(auth.canUse(operatorCookie, "chat")).toBe(false);

  auth.setUserAccess(adminCookie, user.id, { features: { chat: true } });
  expect(auth.canUse(operatorCookie, "chat")).toBe(true);
});
