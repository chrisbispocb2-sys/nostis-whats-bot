import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// O servidor de licenças de verdade (pasta servidor/), rodando em memória: o teste cobre a conversa inteira
import { createLicenseServer } from "../../servidor/src/server";
import { openStores } from "../../servidor/src/stores";
import { generateKeyPair, loadPrivateKey, signLicense } from "../../servidor/src/license-token";
import { featuresWith as serverFeaturesWith } from "../../servidor/src/user-store";
import { RemoteAuthService } from "./remote-auth-service";
import { SessionStore } from "./session-store";
import { SESSION_COOKIE_NAME } from "./auth-provider";
import { AuthError, featuresWith } from "./user-store";

const HOUR = 60 * 60_000;

let dir: string;
let serverStores: ReturnType<typeof openStores>;
let serverHandler: (req: Request) => Promise<Response>;
let serverOnline: boolean;
let keys: ReturnType<typeof generateKeyPair>;
let computers: RemoteAuthService[];

/** O programa instalado num computador (cada um com a própria pasta de dados e identificador). */
function computer(deviceId: string, onChange?: () => void): RemoteAuthService {
  const service = new RemoteAuthService(new SessionStore(join(dir, `${deviceId}-sessions.json`)), {
    serverUrl: "https://licencas.test/",
    publicKey: keys.publicKey,
    licenseFile: join(dir, `${deviceId}-license.json`),
    deviceId,
    deviceName: `PC ${deviceId}`,
    onChange,
    fetch: async (req) => {
      if (!serverOnline) throw new Error("sem internet");
      return serverHandler(req);
    },
  });
  computers.push(service);
  return service;
}

/** Uma requisição do painel com o cookie de sessão que o login devolveu. */
function panelRequest(cookie: string): Request {
  const raw = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))![1]!;
  return new Request("http://127.0.0.1:3000/auth/status", { headers: { cookie: `${SESSION_COOKIE_NAME}=${raw}` } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-remote-auth-"));
  keys = generateKeyPair();
  serverStores = openStores(join(dir, "servidor"));
  serverHandler = createLicenseServer({ ...serverStores, privateKey: loadPrivateKey(keys.privateKey) });
  serverStores.users.create("dono", "senha-do-dono", "admin", serverFeaturesWith(true));
  serverOnline = true;
  computers = [];
});

afterEach(() => {
  setSystemTime();
  for (const c of computers) c.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** O dono convida, o cliente se cadastra no computador dele. Devolve os dois programas e os cookies. */
async function ownerAndClient() {
  const owner = computer("DONO");
  const ownerLogin = await owner.login("dono", "senha-do-dono");
  const ownerReq = panelRequest(ownerLogin.cookie);

  const invite = await owner.createInvite(owner.requireAdmin(ownerReq).id, "operator");
  const client = computer("CLIENTE");
  const registered = await client.registerViaInvite(invite.id, "cliente", "senha-cliente");
  return { owner, ownerReq, client, clientReq: panelRequest(registered.cookie), clientId: registered.user.id };
}

describe("RemoteAuthService (login pelo servidor de licenças)", () => {
  test("nunca oferece criar a primeira conta por aqui; login errado repassa a recusa do servidor", async () => {
    const pc = computer("PC1");
    expect(pc.isBootstrapNeeded()).toBe(false);
    expect(() => pc.bootstrap()).toThrow(AuthError);

    await expect(pc.login("dono", "errada")).rejects.toMatchObject({ status: 401, message: "Usuário ou senha inválidos." });
    expect(pc.hasActiveSession()).toBe(false);
  });

  test("login certo: sessão do painel aberta, licença guardada e reaproveitada ao reabrir o programa", async () => {
    const pc = computer("PC1");
    const { user, cookie } = await pc.login("dono", "senha-do-dono");
    expect(user).toMatchObject({ username: "dono", role: "admin", features: featuresWith(true) });
    expect(pc.currentUser(panelRequest(cookie))).toMatchObject({ username: "dono" });
    expect(pc.licenseStatus()).toMatchObject({ state: "ok" });
    expect(pc.allows("groupBot")).toBe(true);

    // fechou e abriu o programa: mesma pasta de dados, sem precisar logar de novo
    const reopened = computer("PC1");
    expect(reopened.currentUser(panelRequest(cookie))).toMatchObject({ username: "dono" });
    expect(reopened.currentUser(new Request("http://127.0.0.1:3000/"))).toBeNull();
  });

  test("licença guardada que não veio do servidor (ou é de outro computador) é ignorada", async () => {
    const pc = computer("PC1");
    const { cookie } = await pc.login("dono", "senha-do-dono");
    const file = join(dir, "PC1-license.json");
    const real = JSON.parse(readFileSync(file, "utf-8")).token as string;

    // assinada por outra chave, se dizendo administrador sem prazo
    const payload = JSON.parse(Buffer.from(real.split(".")[0]!, "base64url").toString("utf-8"));
    writeFileSync(file, JSON.stringify({ token: signLicense({ ...payload, username: "pirata" }, loadPrivateKey(generateKeyPair().privateKey)) }));
    expect(computer("PC1").currentUser(panelRequest(cookie))).toBeNull();

    // a licença verdadeira copiada pra outro computador
    writeFileSync(join(dir, "PC2-license.json"), JSON.stringify({ token: real }));
    expect(computer("PC2").licenseStatus()).toBeNull();
  });

  test("cliente convidado começa sem nada liberado; o que o administrador muda chega na renovação", async () => {
    const { owner, ownerReq, client, clientReq, clientId } = await ownerAndClient();
    expect(client.currentUser(clientReq)).toMatchObject({ role: "operator", features: featuresWith(false) });
    expect(client.allows("chat")).toBe(false);
    expect(() => client.requireAdmin(clientReq)).toThrow(AuthError);
    await expect(client.listUsers()).rejects.toMatchObject({ status: 403 }); // o servidor também recusa

    const expiresAt = Date.now() + 10 * 24 * HOUR;
    await owner.setUserAccess(ownerReq, clientId, { expiresAt, features: { chat: true } });
    await client.refresh();
    expect(client.currentUser(clientReq)).toMatchObject({ expiresAt, features: { chat: true, campaigns: false } });
    expect(client.allows("chat")).toBe(true);

    const listed = (await owner.listUsers()).find((u) => u.id === clientId)!;
    expect(listed).toMatchObject({ online: true, maxDevices: 1, devices: [{ name: "PC CLIENTE" }] });
  });

  test("chave de renovação resgatada pelo cliente estende o prazo dele na hora", async () => {
    const { owner, ownerReq, client, clientReq } = await ownerAndClient();
    const key = await owner.createKey(ownerReq, 30);

    const updated = await client.redeemKey(clientReq, key.id);
    expect(updated.expiresAt! - Date.now()).toBeGreaterThan(29 * 24 * HOUR);
    await expect(client.redeemKey(clientReq, key.id)).rejects.toMatchObject({ status: 410 });
    expect((await owner.listKeys(ownerReq))[0]).toMatchObject({ id: key.id, usedBy: updated.id });
  });

  test("conta desativada: na próxima renovação o programa desloga e avisa quem depende da licença", async () => {
    const changes: number[] = [];
    const { owner, clientId } = await ownerAndClient();
    const client = computer("OUTRO-PC", () => changes.push(Date.now()));
    await owner.resetUserDevices(panelRequest((await owner.login("dono", "senha-do-dono")).cookie), clientId);
    const { cookie } = await client.login("cliente", "senha-cliente");
    await owner.setUserAccess(panelRequest((await owner.login("dono", "senha-do-dono")).cookie), clientId, { features: { groupBot: true } });
    await client.refresh();
    expect(client.allows("groupBot")).toBe(true);

    await owner.setUserDisabled(clientId, true);
    changes.length = 0;
    await client.refresh();

    expect(changes.length).toBe(1);
    expect(client.currentUser(panelRequest(cookie))).toBeNull();
    expect(client.allows("groupBot")).toBe(false);
    expect(client.licenseStatus()).toBeNull();
  });

  test("segundo computador com a mesma conta é recusado até o administrador liberar", async () => {
    const { owner, ownerReq, clientId } = await ownerAndClient();
    const second = computer("NOTEBOOK");
    await expect(second.login("cliente", "senha-cliente")).rejects.toMatchObject({ status: 403 });

    await owner.resetUserDevices(ownerReq, clientId);
    expect((await second.login("cliente", "senha-cliente")).user.username).toBe("cliente");
  });

  test("sem internet: segue com a licença guardada dentro da tolerância; passou dela, bloqueia tudo até renovar", async () => {
    const { owner, ownerReq, client, clientReq, clientId } = await ownerAndClient();
    await owner.setUserAccess(ownerReq, clientId, { features: { groupBot: true, chat: true } });
    await client.refresh();

    serverOnline = false;
    await client.refresh();
    expect(client.licenseStatus()).toMatchObject({ state: "offline" });
    expect(client.allows("groupBot")).toBe(true);
    expect(client.currentUser(clientReq)).toMatchObject({ features: { chat: true } });
    await expect(computer("PC-NOVO").login("dono", "senha-do-dono")).rejects.toMatchObject({ status: 503 });

    // tolerância esgotada (o servidor de teste usa o padrão de 24 h)
    setSystemTime(new Date(Date.now() + 25 * HOUR));
    expect(client.licenseStatus()).toMatchObject({ state: "blocked" });
    expect(client.allows("groupBot")).toBe(false);
    expect(client.currentUser(clientReq)).toMatchObject({ username: "cliente", features: featuresWith(false) });

    // nem administrador escapa: sem isso bastava desligar a internet
    await owner.refresh();
    expect(owner.currentUser(ownerReq)).toMatchObject({ role: "operator", features: featuresWith(false) });

    serverOnline = true;
    await client.refresh();
    expect(client.licenseStatus()).toMatchObject({ state: "ok" });
    expect(client.allows("groupBot")).toBe(true);
  });

  test("voltar o relógio do computador pra antes da emissão da licença não estica o prazo", async () => {
    const pc = computer("PC1");
    await pc.login("dono", "senha-do-dono");
    serverOnline = false;

    setSystemTime(new Date(Date.now() - 3 * HOUR));
    expect(pc.licenseStatus()).toMatchObject({ state: "blocked" });
    expect(pc.allows("groupBot")).toBe(false);
  });

  test("sair encerra a sessão no servidor e apaga a licença deste computador", async () => {
    const { client, clientReq, owner, clientId } = await ownerAndClient();
    await client.logoutCookieHeader(clientReq);

    expect(client.currentUser(clientReq)).toBeNull();
    expect(client.licenseStatus()).toBeNull();
    expect((await owner.listUsers()).find((u) => u.id === clientId)).toMatchObject({ online: false });
  });
});
