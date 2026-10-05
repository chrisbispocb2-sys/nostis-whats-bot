import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPair, loadPrivateKey, readLicense } from "./license-token";
import { createLicenseServer } from "./server";
import { openStores } from "./stores";
import { featuresWith } from "./user-store";

let dir: string;
let stores: ReturnType<typeof openStores>;
let handle: (req: Request) => Promise<Response>;
const privateKey = loadPrivateKey(generateKeyPair().privateKey);

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await handle(
    new Request(`http://licencas.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  return { status: res.status, json: (await res.json()) as any };
}

const login = (username: string, password: string, deviceId = "PC-1") => call("POST", "/v1/login", { username, password, deviceId, deviceName: deviceId });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-licencas-"));
  stores = openStores(dir);
  handle = createLicenseServer({ ...stores, privateKey });
  stores.users.create("dono", "senha-do-dono", "admin", featuresWith(true));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Convida e cadastra um cliente, devolvendo a licença dele e a do administrador. */
async function clientAccount(deviceId = "PC-CLIENTE") {
  const admin = (await login("dono", "senha-do-dono", "PC-DONO")).json.token as string;
  const { json: invited } = await call("POST", "/v1/admin/invites", { role: "operator" }, admin);
  const { json } = await call("POST", "/v1/register", { inviteToken: invited.invite.id, username: "Cliente", password: "senha-cliente", deviceId, deviceName: "Notebook" });
  const userId = readLicense(json.token, privateKey)!.userId;
  return { admin, token: json.token as string, userId };
}

describe("servidor de licenças", () => {
  test("login certo devolve uma licença assinada pro computador; senha errada não diz por quê", async () => {
    const ok = await login("DONO", "senha-do-dono");
    expect(ok.status).toBe(200);
    const payload = readLicense(ok.json.token, privateKey)!;
    expect(payload).toMatchObject({ v: 1, username: "dono", role: "admin", deviceId: "PC-1", expiresAt: null });
    expect(payload.validUntil).toBeGreaterThan(Date.now());

    expect(await login("dono", "errada")).toMatchObject({ status: 401, json: { error: "Usuário ou senha inválidos." } });
    expect(await login("ninguem", "senha-do-dono")).toMatchObject({ status: 401, json: { error: "Usuário ou senha inválidos." } });
  });

  test("licença adulterada ou assinada por outra chave não vale nada", async () => {
    const { json } = await login("dono", "senha-do-dono");
    const [body, signature] = (json.token as string).split(".");
    const forged = Buffer.from(JSON.stringify({ ...readLicense(json.token, privateKey), role: "admin", expiresAt: null, username: "outro" })).toString("base64url");

    expect((await call("POST", "/v1/refresh", { token: `${forged}.${signature}` })).status).toBe(401);
    expect(readLicense(`${body}.${signature}`, loadPrivateKey(generateKeyPair().privateKey))).toBeNull();
    expect((await call("GET", "/v1/admin/users", undefined, `${forged}.${signature}`)).status).toBe(401);
  });

  test("cadastro só por convite válido; a conta nova começa sem nenhuma funcionalidade e o convite não serve de novo", async () => {
    expect((await call("POST", "/v1/register", { inviteToken: "inventado", username: "x", password: "12345678", deviceId: "PC" })).status).toBe(410);

    const { admin, token } = await clientAccount();
    const payload = readLicense(token, privateKey)!;
    expect(payload).toMatchObject({ username: "cliente", role: "operator", features: featuresWith(false) });

    const { json: invites } = await call("GET", "/v1/admin/invites", undefined, admin);
    const again = await call("POST", "/v1/register", { inviteToken: invites.invites[0].id, username: "outro", password: "12345678", deviceId: "PC-2" });
    expect(again.status).toBe(410);
  });

  test("administração exige licença de administrador", async () => {
    const { token } = await clientAccount();
    expect((await call("GET", "/v1/admin/users", undefined, token)).status).toBe(403);
    expect((await call("GET", "/v1/admin/users")).status).toBe(401);
    expect((await call("POST", "/v1/admin/keys", { durationDays: 30 }, token)).status).toBe(403);
  });

  test("prazo e funcionalidades mudados pelo administrador chegam ao cliente na próxima renovação", async () => {
    const { admin, token, userId } = await clientAccount();
    const expiresAt = Date.now() + 5 * 24 * 60 * 60_000;
    const saved = await call("POST", `/v1/admin/users/${userId}/access`, { expiresAt, features: { chat: true, inventada: true } }, admin);
    expect(saved.json.user.features).toEqual({ ...featuresWith(false), chat: true });

    const { json } = await call("POST", "/v1/refresh", { token });
    expect(readLicense(json.token, privateKey)).toMatchObject({ expiresAt, features: { chat: true, campaigns: false } });
  });

  test("chave de renovação: soma os dias ao prazo da conta e só vale uma vez", async () => {
    const { admin, token } = await clientAccount();
    const { json: created } = await call("POST", "/v1/admin/keys", { durationDays: 30 }, admin);

    const redeemed = await call("POST", "/v1/redeem", { token, code: created.key.id.toLowerCase() });
    expect(redeemed.status).toBe(200);
    const days = (readLicense(redeemed.json.token, privateKey)!.expiresAt! - Date.now()) / (24 * 60 * 60_000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    expect((await call("POST", "/v1/redeem", { token, code: created.key.id })).status).toBe(410);
    expect((await call("POST", "/v1/redeem", { token, code: "NAO-EXISTE" })).status).toBe(410);
  });

  test("conta desativada: a licença para de renovar na hora e o login é recusado; reativar libera de novo", async () => {
    const { admin, token, userId } = await clientAccount();
    expect((await call("POST", `/v1/admin/users/${userId}/disable`, undefined, admin)).status).toBe(200);

    expect((await call("POST", "/v1/refresh", { token })).status).toBe(401);
    expect((await login("cliente", "senha-cliente", "PC-CLIENTE")).status).toBe(401);

    await call("POST", `/v1/admin/users/${userId}/enable`, undefined, admin);
    expect((await login("cliente", "senha-cliente", "PC-CLIENTE")).status).toBe(200);
  });

  test("limite de computadores: o cliente não entra num segundo computador até o administrador liberar", async () => {
    const { admin, token, userId } = await clientAccount("PC-A");

    const other = await login("cliente", "senha-cliente", "PC-B");
    expect(other.status).toBe(403);
    expect(other.json.error).toContain("outro computador");
    expect((await login("cliente", "senha-cliente", "PC-A")).status).toBe(200); // o computador de sempre continua entrando

    // liberar os computadores derruba a licença antiga e deixa entrar no novo
    expect((await call("POST", `/v1/admin/users/${userId}/reset-devices`, undefined, admin)).status).toBe(200);
    expect((await call("POST", "/v1/refresh", { token })).status).toBe(401);
    expect((await login("cliente", "senha-cliente", "PC-B")).status).toBe(200);
    expect((await login("cliente", "senha-cliente", "PC-A")).status).toBe(403);

    // com mais vagas, os dois entram
    await call("POST", `/v1/admin/users/${userId}/access`, { maxDevices: 2 }, admin);
    expect((await login("cliente", "senha-cliente", "PC-A")).status).toBe(200);
  });

  test("administrador entra em quantos computadores quiser, e não consegue desativar a si mesmo", async () => {
    const first = await login("dono", "senha-do-dono", "PC-1");
    expect((await login("dono", "senha-do-dono", "PC-2")).status).toBe(200);
    const self = readLicense(first.json.token, privateKey)!.userId;
    expect((await call("POST", `/v1/admin/users/${self}/disable`, undefined, first.json.token)).status).toBe(409);
  });

  test("sair encerra a sessão: a licença daquele computador não renova mais", async () => {
    const { token } = await clientAccount();
    expect((await call("POST", "/v1/logout", { token })).status).toBe(200);
    expect((await call("POST", "/v1/refresh", { token })).status).toBe(401);
  });

  test("lista de usuários pro administrador: sem hash de senha, com computadores e quem está online", async () => {
    const { admin } = await clientAccount();
    const { json } = await call("GET", "/v1/admin/users", undefined, admin);
    const client = json.users.find((u: any) => u.username === "cliente");
    expect(client).toMatchObject({ role: "operator", online: true, maxDevices: 1, devices: [{ id: "PC-CLIENTE", name: "Notebook" }] });
    expect(JSON.stringify(json)).not.toContain("passwordHash");
  });
});
