import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { AccountManager } from "./account-manager";
import { handleApiRequest } from "../routes";
import { fakeConnections, tempDirs, type FakeConnection } from "../testing/fakes";

let dirs: ReturnType<typeof tempDirs>;
let created: FakeConnection[];
let factory: ReturnType<typeof fakeConnections>["factory"];

function newManager() {
  return new AccountManager({
    appDataDir: dirs.appDataDir,
    tempDir: dirs.tempDir,
    createConnection: factory,
    notify: () => {},
  });
}

/** Chama a API do painel como o navegador chamaria. */
async function api(manager: AccountManager, method: string, path: string, body?: unknown) {
  const url = new URL(`http://127.0.0.1:3000${path}`);
  const req = new Request(url.href, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleApiRequest(req, url, manager);
  if (!res) return { status: 0, json: null as any, res: null };
  const isJson = res.headers.get("content-type")?.includes("json");
  return { status: res.status, json: (isJson ? await res.json() : null) as any, res };
}

beforeEach(() => {
  dirs = tempDirs();
  const fake = fakeConnections();
  created = fake.created;
  factory = fake.factory;
});

afterEach(() => dirs.cleanup());

describe("contas", () => {
  test("na primeira execução existe uma conta, que usa a pasta de dados de sempre", () => {
    const manager = newManager();
    const accounts = manager.list();

    expect(accounts.length).toBe(1);
    expect(accounts[0]!.id).toBe("default");
    expect(accounts[0]!.name).toBe("WhatsApp 1");
    // nada de mover arquivos: a sessão e os dados de quem já usa o bot continuam onde estavam
    expect(accounts[0]!.paths.root).toBe(dirs.appDataDir);
    expect(accounts[0]!.paths.auth).toBe(join(dirs.appDataDir, "auth"));
    expect(accounts[0]!.paths.callLeads).toBe(join(dirs.appDataDir, "call-leads.json"));
  });

  test("dados já existentes da conta original são lidos (não são apagados nem recriados)", () => {
    mkdirSync(dirs.appDataDir, { recursive: true });
    writeFileSync(
      join(dirs.appDataDir, "settings.json"),
      JSON.stringify({ ignoreAdminNames: true, noReplyNumbers: ["5511999990000"] })
    );
    writeFileSync(
      join(dirs.appDataDir, "bans.json"),
      JSON.stringify([{ jid: "5511911110000@s.whatsapp.net", name: "Fulano", bannedAt: 1 }])
    );

    const account = newManager().get("default")!;
    expect(account.settings.get().ignoreAdminNames).toBe(true);
    expect(account.settings.get().noReplyNumbers).toEqual(["5511999990000"]);
    // settings antigos ganham os campos novos com o padrão
    expect(account.settings.get().autoShutdownEnabled).toBe(false);
    expect(account.settings.get().autoShutdownMinutes).toBe(5);
    expect(account.bans.isBanned("5511911110000@s.whatsapp.net")).toBe(true);
  });

  test("criar uma conta nova: pasta própria, conexão iniciada e persistida no índice", async () => {
    const manager = newManager();
    const account = await manager.create("  Meu segundo zap  ");

    expect(account.name).toBe("Meu segundo zap");
    expect(account.paths.root).toBe(join(dirs.appDataDir, "accounts", account.id));
    expect(existsSync(account.paths.auth)).toBe(true);
    expect(created[1]!.started).toBe(true);

    const index = JSON.parse(readFileSync(join(dirs.appDataDir, "accounts.json"), "utf-8"));
    expect(index.accounts.map((a: { id: string }) => a.id)).toEqual(["default", account.id]);
  });

  test("as contas continuam existindo depois de reabrir o programa", async () => {
    const first = newManager();
    const created2 = await first.create("Segunda");
    first.rename("default", "Principal");

    const second = newManager();
    expect(second.list().map((a) => a.name)).toEqual(["Principal", "Segunda"]);
    expect(second.get(created2.id)).toBeDefined();
  });

  test("nome vazio, muito longo ou repetido é recusado", async () => {
    const manager = newManager();
    await expect(manager.create("   ")).rejects.toThrow("Informe um nome");
    await expect(manager.create("x".repeat(41))).rejects.toThrow("no máximo 40");
    await expect(manager.create("whatsapp 1")).rejects.toThrow("Já existe");
    expect(manager.list().length).toBe(1);
  });

  test("renomear", async () => {
    const manager = newManager();
    const account = await manager.create("Segunda");
    manager.rename(account.id, "Loja");
    expect(manager.get(account.id)!.name).toBe("Loja");
    expect(() => manager.rename(account.id, "WhatsApp 1")).toThrow("Já existe");
    expect(manager.rename("nao-existe", "x")).toBeUndefined();
  });

  test("remover uma conta desvincula o aparelho e apaga os dados dela", async () => {
    const manager = newManager();
    const account = await manager.create("Segunda");
    const root = account.paths.root;
    const connection = created[1]!;

    expect(await manager.remove(account.id)).toBe(true);
    expect(manager.get(account.id)).toBeUndefined();
    expect(existsSync(root)).toBe(false);
    expect(connection.logouts).toEqual([{ reconnect: false }]);
    expect(connection.stopped).toBe(true);
    expect(newManager().list().length).toBe(1);
  });

  test("a primeira conta não pode ser removida", async () => {
    const manager = newManager();
    await manager.create("Segunda");
    await expect(manager.remove("default")).rejects.toThrow("primeira conta");
    expect(existsSync(dirs.appDataDir)).toBe(true);
  });

  test("uma conta que falha ao conectar não derruba as outras", async () => {
    const manager = newManager();
    await manager.create("Segunda");
    created[0]!.start = async () => {
      throw new Error("sem rede");
    };
    await manager.startAll();
    expect(created[1]!.started).toBe(true);
  });

  test("as contas são independentes entre si", async () => {
    const manager = newManager();
    const a = manager.get("default")!;
    const b = await manager.create("Segunda");

    a.keywords.create({ keywords: ["so na a"], responses: ["ok"] });
    a.bans.ban("5511911110000@s.whatsapp.net", "Fulano");
    a.settings.update({ autoShutdownEnabled: true, autoShutdownMinutes: 9 });
    a.setBotActive(false);

    expect(b.keywords.list().some((r) => r.keywords.includes("so na a"))).toBe(false);
    expect(b.bans.isBanned("5511911110000@s.whatsapp.net")).toBe(false);
    expect(b.settings.get().autoShutdownEnabled).toBe(false);
    expect(b.settings.get().autoShutdownMinutes).toBe(5);
    expect(b.bot.active).toBe(true);
  });
});

describe("API do painel", () => {
  test("lista as contas com o estado de cada uma", async () => {
    const manager = newManager();
    created[0]!.connected = true;

    const { status, json } = await api(manager, "GET", "/accounts");
    expect(status).toBe(200);
    expect(json.accounts).toEqual([
      expect.objectContaining({
        id: "default",
        name: "WhatsApp 1",
        active: true,
        connected: true,
        needsQr: false,
        guardEnabled: false,
        guardPending: 0,
      }),
    ]);
  });

  test("criar, renomear e remover pela API", async () => {
    const manager = newManager();

    const made = await api(manager, "POST", "/accounts", { name: "Segunda" });
    expect(made.status).toBe(200);
    const id = made.json.account.id as string;

    const renamed = await api(manager, "PUT", `/accounts/${id}`, { name: "Loja" });
    expect(renamed.json.account.name).toBe("Loja");

    const dup = await api(manager, "PUT", `/accounts/${id}`, { name: "WhatsApp 1" });
    expect(dup.status).toBe(400);
    expect(dup.json.error).toContain("Já existe");

    const empty = await api(manager, "POST", "/accounts", { name: "" });
    expect(empty.status).toBe(400);

    const removed = await api(manager, "DELETE", `/accounts/${id}`);
    expect(removed.status).toBe(200);
    expect((await api(manager, "GET", "/accounts")).json.accounts.length).toBe(1);

    const removeDefault = await api(manager, "DELETE", "/accounts/default");
    expect(removeDefault.status).toBe(400);
  });

  test("conta inexistente dá 404 (inclusive nas rotas de dentro da conta)", async () => {
    const manager = newManager();
    expect((await api(manager, "PUT", "/accounts/nope", { name: "x" })).status).toBe(404);
    expect((await api(manager, "GET", "/accounts/nope/rules")).status).toBe(404);
    expect((await api(manager, "GET", "/accounts/nope/status")).status).toBe(404);
  });

  test("as rotas de dentro da conta funcionam em cada conta separadamente", async () => {
    const manager = newManager();
    const b = (await api(manager, "POST", "/accounts", { name: "Segunda" })).json.account.id as string;

    const made = await api(manager, "POST", `/accounts/${b}/rules`, {
      keywords: ["oi da b"],
      responses: ["resposta b"],
      greetingEnabled: true,
    });
    expect(made.status).toBe(200);
    expect(made.json.rule.greetingEnabled).toBe(true);

    const rulesA = (await api(manager, "GET", "/accounts/default/rules")).json.rules as Array<{ keywords: string[] }>;
    const rulesB = (await api(manager, "GET", `/accounts/${b}/rules`)).json.rules as Array<{ keywords: string[] }>;
    expect(rulesA.some((r) => r.keywords.includes("oi da b"))).toBe(false);
    expect(rulesB.some((r) => r.keywords.includes("oi da b"))).toBe(true);
  });

  test("ligar e desligar o bot é por conta", async () => {
    const manager = newManager();
    const b = (await api(manager, "POST", "/accounts", { name: "Segunda" })).json.account.id as string;

    await api(manager, "POST", "/accounts/default/off");
    expect((await api(manager, "GET", "/accounts/default/status")).json.active).toBe(false);
    expect((await api(manager, "GET", `/accounts/${b}/status`)).json.active).toBe(true);

    await api(manager, "POST", "/accounts/default/on");
    expect((await api(manager, "GET", "/accounts/default/status")).json.active).toBe(true);
  });

  test("status traz o estado da segurança e do QR Code", async () => {
    const manager = newManager();
    created[0]!.qr = "2@abc";

    const { json } = await api(manager, "GET", "/accounts/default/status");
    expect(json.needsQr).toBe(true);
    expect(json.whatsappConnected).toBe(false);
    expect(json.guard).toEqual({ enabled: false, minutes: 5, pending: 0, deadlineAt: null, lastShutdown: null });
  });

  test("configurar a segurança pelas configurações (com limites)", async () => {
    const manager = newManager();

    let res = await api(manager, "PUT", "/accounts/default/settings", { autoShutdownEnabled: true, autoShutdownMinutes: 7 });
    expect(res.json).toMatchObject({ autoShutdownEnabled: true, autoShutdownMinutes: 7 });

    // valor inválido volta para o padrão; enorme é limitado
    res = await api(manager, "PUT", "/accounts/default/settings", { autoShutdownMinutes: 0 });
    expect(res.json.autoShutdownMinutes).toBe(5);
    res = await api(manager, "PUT", "/accounts/default/settings", { autoShutdownMinutes: 999999 });
    expect(res.json.autoShutdownMinutes).toBe(720);
    res = await api(manager, "PUT", "/accounts/default/settings", { autoShutdownMinutes: "abc" });
    expect(res.json.autoShutdownMinutes).toBe(5);

    // mexer só no que veio: o resto fica como estava
    res = await api(manager, "PUT", "/accounts/default/settings", { ignoreAdminNames: true });
    expect(res.json).toMatchObject({ ignoreAdminNames: true, autoShutdownEnabled: true });

    const status = (await api(manager, "GET", "/accounts/default/status")).json;
    expect(status.guard.enabled).toBe(true);
  });

  test("desligar a segurança limpa contagens em andamento", async () => {
    const manager = newManager();
    const account = manager.get("default")!;
    await api(manager, "PUT", "/accounts/default/settings", { autoShutdownEnabled: true });
    account.guard.onClientMessage("5511977770000@s.whatsapp.net", []);
    expect(account.guard.pendingCount).toBe(1);

    await api(manager, "PUT", "/accounts/default/settings", { autoShutdownEnabled: false });
    expect(account.guard.pendingCount).toBe(0);
  });

  test("QR Code: 404 sem QR, imagem PNG com QR", async () => {
    const manager = newManager();
    expect((await api(manager, "GET", "/accounts/default/qr")).status).toBe(404);

    created[0]!.qr = "2@AbCdEfGhIjKlMnOpQrStUvWxYz,abc,def==";
    const { status, res } = await api(manager, "GET", "/accounts/default/qr");
    expect(status).toBe(200);
    expect(res!.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res!.arrayBuffer());
    expect(Array.from(bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]); // "PNG"
  });

  test("desconectar (trocar número) pede um novo QR Code à conexão", async () => {
    const manager = newManager();
    const { status } = await api(manager, "POST", "/accounts/default/logout");
    expect(status).toBe(200);
    expect(created[0]!.logouts).toEqual([undefined]);
  });

  test("foto do perfil: 404 quando o WhatsApp não tem foto", async () => {
    const manager = newManager();
    expect((await api(manager, "GET", "/accounts/default/avatar")).status).toBe(404);
  });

  test("rotas sem prefixo de conta não existem mais (o painel sempre escolhe uma conta)", async () => {
    const manager = newManager();
    expect((await api(manager, "GET", "/rules")).status).toBe(0);
  });
});
