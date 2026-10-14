import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { Curve } from "baileys-joss";
// O servidor de licenças de verdade (pasta servidor/), rodando em memória
import { createLicenseServer } from "../../servidor/src/server";
import { openStores } from "../../servidor/src/stores";
import { generateKeyPair, loadPrivateKey } from "../../servidor/src/license-token";
import { featuresWith as serverFeaturesWith } from "../../servidor/src/user-store";
import { AccountManager } from "./account-manager";
import { RemoteAuthService } from "./remote-auth-service";
import { SessionStore } from "./session-store";
import { SESSION_COOKIE_NAME } from "./auth-provider";
import { fakeConnections, privateText, tempDirs, type FakeConnection } from "../testing/fakes";
import { handleApiRequest } from "../routes";
import type { UberStatusFetcher } from "./uber-trip";

const CLIENT = "5511977770000@s.whatsapp.net";
const OTHER_CLIENT = "5511966660000@s.whatsapp.net";

let root: ReturnType<typeof tempDirs>;
let serverStores: ReturnType<typeof openStores>;
let serverHandler: (req: Request) => Promise<Response>;
let serverOnline: boolean;
let keys: ReturnType<typeof generateKeyPair>;
let cleanups: Array<() => void>;
let serverMistic: ReturnType<typeof makeFakeMistic>;

const MISTIC_BASE = "https://mistic.test";

/** MisticPay de mentira para o servidor de licenças do teste usar no lugar da de verdade. */
function makeFakeMistic() {
  const charges = new Map<string, { value: number; fee: number; state: string }>();
  const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: any, init?: any) => {
    const url: string = typeof input === "string" ? input : input.url;
    const path = url.replace(MISTIC_BASE, "");
    const rawBody = init?.body ?? (typeof input === "string" ? undefined : input.body);
    const body = rawBody ? JSON.parse(String(rawBody)) : {};
    if (path === "/users/info") return json({ data: { name: "Loja do Líder", availableBalance: 1000, document: "12345678900" } });
    if (path === "/transactions/create") {
      const id = `mp-${charges.size + 1}`;
      charges.set(id, { value: Number(body.amount), fee: 0, state: "PENDENTE" });
      return json({ data: { transactionId: id, transactionState: "PENDENTE", copyPaste: `PIX-${id}`, qrCodeBase64: "QR" } });
    }
    if (path === "/transactions/check") {
      const c = charges.get(String(body.transactionId));
      if (!c) return json({});
      return json({ transaction: { transactionId: body.transactionId, transactionState: c.state, value: c.value, fee: c.fee } });
    }
    if (path === "/transactions/withdraw") return json({ data: { transactionId: `wd-${charges.size + 1}`, status: "QUEUED" } });
    return json({ error: "não encontrado" }, 404);
  }) as typeof fetch;
  return { fetchImpl, charges, setPaid: (id: string, value: number, fee: number) => charges.set(id, { value, fee, state: "COMPLETO" }) };
}

/** Um computador com o programa instalado: login próprio no servidor e o MESMO WhatsApp conectado. */
interface Computer {
  remote: RemoteAuthService;
  manager: AccountManager;
  connection: FakeConnection;
  notices: string[];
  api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>;
  account: ReturnType<AccountManager["get"]> & {};
}

function rideStatus(clientStatus: string, eta: number) {
  return { data: { status: { clientStatus: "Looking", trips: [{ clientStatus, eta, etaToDestination: null, statusMessage: { title: "", detailMode: "" }, driver: { name: "EVERTON" }, vehicle: { licensePlate: "QPQ8I33" } }] } } };
}

function computer(name: string, { withServer = true } = {}): Computer {
  const dirs = tempDirs();
  const remote = new RemoteAuthService(new SessionStore(join(dirs.appDataDir, "sessions.json")), {
    serverUrl: "https://licencas.test",
    publicKey: keys.publicKey,
    licenseFile: join(dirs.appDataDir, "license.json"),
    deviceId: name,
    deviceName: name,
    fetch: async (req) => {
      if (!serverOnline) throw new Error("sem internet");
      return serverHandler(req);
    },
  });
  const fake = fakeConnections();
  const notices: string[] = [];
  const fetcher: UberStatusFetcher = { fetchStatus: async () => rideStatus("ArrivingAtPickup", 600), close: () => {} };
  const manager = new AccountManager({
    appDataDir: dirs.appDataDir,
    tempDir: dirs.tempDir,
    createConnection: fake.factory,
    notify: (title, body) => notices.push(`${title} | ${body}`),
    coordinator: withServer ? remote : undefined,
    money: withServer ? remote : undefined,
    coordinationIntervalMs: 0, // os testes chamam `tick()` na mão
    uberOpenStatusFetcher: async () => fetcher,
    uberTripPollIntervalMs: 60_000,
    chatMediaRetrySweepMs: 0,
  });
  const connection = fake.created[0]!;
  connection.connected = true;
  cleanups.push(() => {
    remote.stop();
    manager.stopAll();
    dirs.cleanup();
  });

  return {
    remote,
    manager,
    connection,
    notices,
    account: manager.get("default")!,
    async api(method, path, body) {
      const url = new URL(`http://127.0.0.1:3000/accounts/default${path}`);
      const res = await handleApiRequest(new Request(url.href, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }), url, manager);
      const text = res ? await res.text() : "";
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res?.status ?? 0, json };
    },
  };
}

function cookieRequest(cookie: string): Request {
  const raw = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))![1]!;
  return new Request("http://127.0.0.1:3000/", { headers: { cookie: `${SESSION_COOKIE_NAME}=${raw}` } });
}

/** Dono e atendente, cada um no seu computador, no mesmo WhatsApp. `sameTeam` põe os dois na mesma equipe. */
async function twoAttendants({ sameTeam = true } = {}) {
  const pcA = computer("PC-DONO");
  const pcB = computer("PC-ATENDENTE");

  const ownerLogin = await pcA.remote.login("dono", "senha-do-dono");
  const ownerReq = cookieRequest(ownerLogin.cookie);
  const invite = await pcA.remote.createInvite(ownerLogin.user.id, "operator");
  const attendant = await pcB.remote.registerViaInvite(invite.id, "maria", "senha-da-maria");

  if (sameTeam) {
    await pcA.remote.setUserAccess(ownerReq, ownerLogin.user.id, { team: "Atendimento" });
    await pcA.remote.setUserAccess(ownerReq, attendant.user.id, { team: "atendimento" });
  }
  return { pcA, pcB };
}

beforeEach(() => {
  root = tempDirs();
  keys = generateKeyPair();
  serverStores = openStores(join(root.appDataDir, "servidor"));
  serverMistic = makeFakeMistic();
  serverHandler = createLicenseServer({ ...serverStores, privateKey: loadPrivateKey(keys.privateKey), misticFetch: serverMistic.fetchImpl, misticBaseUrl: MISTIC_BASE });
  serverStores.users.create("dono", "senha-do-dono", "admin", serverFeaturesWith(true));
  serverOnline = true;
  cleanups = [];
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  root.cleanup();
});

describe("duas pessoas atendendo no mesmo WhatsApp, cada uma no seu computador", () => {
  test("os dois computadores enxergam o mesmo número de WhatsApp", async () => {
    const { pcA, pcB } = await twoAttendants();
    expect(pcA.account.phone).toBe("5511900000000");
    expect(pcB.account.phone).toBe(pcA.account.phone);
  });

  describe("bot: só um ligado por vez", () => {
    test("quem tenta ligar com o bot do outro já ligado recebe o aviso com o nome de quem está", async () => {
      const { pcA, pcB } = await twoAttendants();
      pcA.account.setBotActive(false);
      pcB.account.setBotActive(false);

      expect((await pcA.api("POST", "/on")).status).toBe(200);
      const refused = await pcB.api("POST", "/on");
      expect(refused.status).toBe(409);
      expect(refused.json.error).toContain("dono (computador PC-DONO) já está com o bot ligado neste WhatsApp");
      expect(refused.json.holder).toMatchObject({ username: "dono", deviceName: "PC-DONO" });
      expect(pcB.account.bot.active).toBe(false);

      // o dono desliga: a vez fica livre e a atendente consegue ligar; agora é o dono que é barrado
      expect((await pcA.api("POST", "/off")).status).toBe(200);
      await Bun.sleep(20); // soltar a vez é assíncrono
      expect((await pcB.api("POST", "/on")).status).toBe(200);
      expect(pcB.account.bot.active).toBe(true);
      const nowRefused = await pcA.api("POST", "/on");
      expect(nowRefused.status).toBe(409);
      expect(nowRefused.json.error).toContain("maria (computador PC-ATENDENTE)");
    });

    test("dois computadores abrindo com o bot já ligado: o segundo desliga sozinho e avisa quem está com ele", async () => {
      const { pcA, pcB } = await twoAttendants();
      pcA.account.setBotActive(true);
      pcB.account.setBotActive(true); // estado guardado de antes: os dois sobem "ligados"

      await pcA.account.coordination.tick();
      await pcB.account.coordination.tick();

      expect(pcA.account.bot.active).toBe(true);
      expect(pcB.account.bot.active).toBe(false);
      expect(pcB.notices.join("\n")).toContain("dono (computador PC-DONO) já está com o bot ligado neste WhatsApp");
      expect((await pcB.api("GET", "/status")).json.botConflict).toMatchObject({ who: "dono (computador PC-DONO)" });
      expect((await pcA.api("GET", "/status")).json.botConflict).toBeNull();

      // quem está com a vez renova sem problema
      await pcA.account.coordination.tick();
      expect(pcA.account.bot.active).toBe(true);
    });

    test("bot desligado por qualquer caminho (segurança, licença...) solta a vez", async () => {
      const { pcA, pcB } = await twoAttendants();
      await pcA.api("POST", "/on");
      pcA.account.setBotActive(false);
      await Bun.sleep(20);
      expect((await pcB.api("POST", "/on")).status).toBe(200);
    });

    test("pessoas de equipes diferentes (ou sem equipe) não se bloqueiam", async () => {
      const { pcA, pcB } = await twoAttendants({ sameTeam: false });
      expect((await pcA.api("POST", "/on")).status).toBe(200);
      expect((await pcB.api("POST", "/on")).status).toBe(200);
    });

    test("servidor fora do ar: o bot liga do mesmo jeito (não trava o atendimento)", async () => {
      const { pcA, pcB } = await twoAttendants();
      await pcA.api("POST", "/on");
      serverOnline = false;
      expect((await pcB.api("POST", "/on")).status).toBe(200);
    });

    test("modo local (sem servidor de licenças): nada é combinado e o bot liga normalmente", async () => {
      const solo = computer("PC-SOLO", { withServer: false });
      expect((await solo.api("POST", "/on")).status).toBe(200);
      expect((await solo.api("GET", "/status")).json.botConflict).toBeNull();
    });
  });

  describe("listas de conversas compartilhadas", () => {
    test("a lista que um cria (e a conversa que ele põe nela) aparece igual no outro computador", async () => {
      const { pcA, pcB } = await twoAttendants();
      for (const pc of [pcA, pcB]) await pc.connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));

      const created = await pcA.api("POST", "/folders", { name: "Atendente Maria" });
      expect(created.status).toBe(200);
      const folderId = created.json.folder.id as string;
      expect((await pcA.api("POST", `/folders/${folderId}/chats`, { chatJid: CLIENT })).status).toBe(200);

      await pcB.account.coordination.syncLists({ force: true });
      expect((await pcB.api("GET", "/folders")).json.folders).toMatchObject([{ id: folderId, name: "Atendente Maria" }]);
      expect((await pcB.api("GET", `/folders/${folderId}/chats`)).json.chats).toMatchObject([{ jid: CLIENT }]);
      expect((await pcB.api("GET", "/chats")).json.chats.some((c: any) => c.jid === CLIENT)).toBe(false); // saiu da lista principal lá também

      // o outro tira a conversa e apaga a lista: some no primeiro
      expect((await pcB.api("DELETE", `/folders/${folderId}/chats/${encodeURIComponent(CLIENT)}`)).status).toBe(200);
      await pcA.account.coordination.syncLists({ force: true });
      expect((await pcA.api("GET", `/folders/${folderId}/chats`)).json.chats).toEqual([]);

      expect((await pcB.api("DELETE", `/folders/${folderId}`)).status).toBe(200);
      await pcA.account.coordination.syncLists({ force: true });
      expect((await pcA.api("GET", "/folders")).json.folders).toEqual([]);
    });

    test("quem já tinha listas só no computador dele: na primeira sincronização elas sobem e se juntam às do outro", async () => {
      const { pcA, pcB } = await twoAttendants();
      // cada um criou listas antes de o compartilhamento existir (direto no banco local)
      const mine = pcA.account.chats.createFolder("Premium");
      pcA.account.chats.addChatToFolder(mine.id, CLIENT);
      const hers = pcB.account.chats.createFolder("premium");
      pcB.account.chats.addChatToFolder(hers.id, OTHER_CLIENT);
      pcB.account.chats.createFolder("Novos");

      await pcA.account.coordination.syncLists({ force: true });
      await pcB.account.coordination.syncLists({ force: true });
      await pcA.account.coordination.syncLists({ force: true });

      for (const pc of [pcA, pcB]) {
        expect(pc.account.chats.listFolders().map((f) => f.name)).toEqual(["Premium", "Novos"]);
        expect(pc.account.chats.listFolderMemberships().map((m) => m.chatJid).sort()).toEqual([OTHER_CLIENT, CLIENT].sort());
      }
    });

    test("servidor fora do ar com listas já compartilhadas: a mudança é recusada com aviso, em vez de sumir depois", async () => {
      const { pcA } = await twoAttendants();
      const created = await pcA.api("POST", "/folders", { name: "Premium" });
      serverOnline = false;

      const refused = await pcA.api("POST", "/folders", { name: "Outra" });
      expect(refused.status).toBe(503);
      expect(refused.json.error).toContain("compartilhadas");
      expect((await pcA.api("GET", "/folders")).json.folders).toMatchObject([{ id: created.json.folder.id }]); // o que já estava continua visível
    });

    test("modo local: as listas continuam funcionando só neste computador", async () => {
      const solo = computer("PC-SOLO", { withServer: false });
      const created = await solo.api("POST", "/folders", { name: "Minhas" });
      expect(created.status).toBe(200);
      expect((await solo.api("POST", `/folders/${created.json.folder.id}/chats`, { chatJid: CLIENT })).status).toBe(200);
      expect((await solo.api("GET", "/folders")).json.folders).toMatchObject([{ name: "Minhas" }]);
      expect((await solo.api("DELETE", `/folders/${created.json.folder.id}`)).status).toBe(200);
    });
  });

  describe("junta sozinho quem está conectado no mesmo WhatsApp, sem ninguém configurar equipe", () => {
    type KeyPair = ReturnType<typeof Curve.generateKeyPair>;

    /** O que o celular entrega a um computador ao ler o QR Code: a chave do computador, assinada pela chave da conta. */
    function linkTo(pc: Computer, whatsappAccount: KeyPair): { device: KeyPair; details: Buffer; accountSignature: Uint8Array } {
      const device = Curve.generateKeyPair();
      const details = Buffer.from(`dados-do-aparelho-${Math.random()}`);
      const accountSignature = Curve.sign(whatsappAccount.private, Buffer.concat([Buffer.from([6, 0]), details, device.public]));
      pc.connection.sock.authState = { creds: { account: { details, accountSignatureKey: whatsappAccount.public, accountSignature }, signedIdentityKey: device } };
      return { device, details, accountSignature };
    }

    test("duas contas de licença diferentes, sem equipe, no mesmo WhatsApp: listas e vez do bot são compartilhadas", async () => {
      const { pcA, pcB } = await twoAttendants({ sameTeam: false });
      const whatsapp = Curve.generateKeyPair();
      linkTo(pcA, whatsapp);
      linkTo(pcB, whatsapp);
      pcA.account.setBotActive(false);
      pcB.account.setBotActive(false);

      expect((await pcA.api("POST", "/on")).status).toBe(200);
      const refused = await pcB.api("POST", "/on");
      expect(refused.status).toBe(409);
      expect(refused.json.error).toContain("dono (computador PC-DONO) já está com o bot ligado neste WhatsApp");

      const created = await pcA.api("POST", "/folders", { name: "Atendente Maria" });
      await pcA.api("POST", `/folders/${created.json.folder.id}/chats`, { chatJid: CLIENT });
      await pcB.account.coordination.syncLists({ force: true });
      expect(pcB.account.chats.listFolders()).toMatchObject([{ name: "Atendente Maria" }]);
      expect(pcB.account.chats.listFolderMemberships()).toEqual([{ folderId: created.json.folder.id, chatJid: CLIENT }]);
    });

    test("o servidor reinicia (perde as provas da memória): o programa prova de novo sozinho e segue compartilhando", async () => {
      const { pcA, pcB } = await twoAttendants({ sameTeam: false });
      const whatsapp = Curve.generateKeyPair();
      linkTo(pcA, whatsapp);
      linkTo(pcB, whatsapp);
      await pcA.api("POST", "/folders", { name: "Premium" });

      serverHandler = createLicenseServer({ ...serverStores, privateKey: loadPrivateKey(keys.privateKey) });
      await pcB.account.coordination.syncLists({ force: true });
      expect(pcB.account.chats.listFolders()).toMatchObject([{ name: "Premium" }]);
    });

    test("mesmo número informado, mas outra conta de WhatsApp: não é juntado", async () => {
      const { pcA, pcB } = await twoAttendants({ sameTeam: false });
      linkTo(pcA, Curve.generateKeyPair());
      linkTo(pcB, Curve.generateKeyPair()); // diz o mesmo número (o de mentira é igual pros dois), mas a credencial é de outra conta
      pcA.account.setBotActive(false);
      pcB.account.setBotActive(false);

      await pcA.api("POST", "/folders", { name: "Só do dono" });
      expect((await pcA.api("POST", "/on")).status).toBe(200);

      await pcB.account.coordination.syncLists({ force: true });
      expect(pcB.account.chats.listFolders()).toEqual([]);
      expect((await pcB.api("POST", "/on")).status).toBe(200);
    });

    test("copiar a credencial pública de outra pessoa não basta: sem a chave do computador dela, a prova é recusada", async () => {
      const { pcA, pcB } = await twoAttendants({ sameTeam: false });
      const whatsapp = Curve.generateKeyPair();
      const victim = linkTo(pcA, whatsapp);
      // o curioso tem tudo que é público da vítima, mas a chave privada é a dele
      const ownKeys = Curve.generateKeyPair();
      pcB.connection.sock.authState = {
        creds: {
          account: { details: victim.details, accountSignatureKey: whatsapp.public, accountSignature: victim.accountSignature },
          signedIdentityKey: { public: victim.device.public, private: ownKeys.private },
        },
      };
      pcA.account.setBotActive(false);
      pcB.account.setBotActive(false);

      await pcA.api("POST", "/folders", { name: "Clientes do dono" });
      await pcA.api("POST", "/on");

      await pcB.account.coordination.syncLists({ force: true });
      expect(pcB.account.chats.listFolders()).toEqual([]); // não enxerga as listas da vítima
      expect((await pcB.api("POST", "/on")).status).toBe(200); // nem disputa (ou trava) a vez do bot dela
      expect(pcA.account.bot.active).toBe(true);
    });

    test("uma instalação prova e a outra não (programa antigo): a equipe continua valendo entre as que não provam", async () => {
      const { pcA, pcB } = await twoAttendants({ sameTeam: true }); // nenhum dos dois tem credencial: caem na equipe
      await pcA.api("POST", "/folders", { name: "Pela equipe" });
      await pcB.account.coordination.syncLists({ force: true });
      expect(pcB.account.chats.listFolders()).toMatchObject([{ name: "Pela equipe" }]);
    });
  });

  describe("corrida: só um computador acompanha (avisos e cobrança não saem em dobro)", () => {
    test("o primeiro que pega a corrida acompanha; o outro não, e o painel dele explica por quê", async () => {
      const { pcA, pcB } = await twoAttendants();

      await pcA.account.uberTrips.startTracking(CLIENT, "TOKENABC", 3500);
      expect(pcA.account.uberTrips.isTracking(CLIENT)).toBe(true);

      // o outro computador vê o link (mensagem enviada pela mesma conta) e tentaria acompanhar também
      await pcB.account.uberTrips.startTracking(CLIENT, "TOKENABC", 3500);
      expect(pcB.account.uberTrips.isTracking(CLIENT)).toBe(false);

      const viaPanel = await pcB.api("POST", `/chats/${encodeURIComponent(CLIENT)}/uber-trip`, { link: "https://trip.uber.com/TOKENABC", agreedAmount: "35,00" });
      expect(viaPanel.status).toBe(409);
      expect(viaPanel.json.error).toContain("já está acompanhando essa corrida");

      // outra corrida, de outro cliente, a atendente pega normalmente
      await pcB.account.uberTrips.startTracking(OTHER_CLIENT, "TOKENXYZ", 2000);
      expect(pcB.account.uberTrips.isTracking(OTHER_CLIENT)).toBe(true);
      // e quem já está acompanhando pode receber o mesmo link de novo (eco do WhatsApp) sem perder a corrida
      await pcA.account.uberTrips.startTracking(CLIENT, "TOKENABC", 3500);
      expect(pcA.account.uberTrips.isTracking(CLIENT)).toBe(true);
    });
  });
});

describe("empresa: o líder libera quantos WhatsApp cada funcionário pode usar", () => {
  type KeyPair = ReturnType<typeof Curve.generateKeyPair>;

  /** O que o celular entrega ao computador ao ler o QR Code: a chave do computador, assinada pela chave da conta. */
  function linkTo(pc: Computer, whatsappAccount: KeyPair): void {
    const device = Curve.generateKeyPair();
    const details = Buffer.from(`dados-do-aparelho-${Math.random()}`);
    const accountSignature = Curve.sign(whatsappAccount.private, Buffer.concat([Buffer.from([6, 0]), details, device.public]));
    pc.connection.sock.authState = { creds: { account: { details, accountSignatureKey: whatsappAccount.public, accountSignature }, signedIdentityKey: device } };
  }

  /** Admin cria um líder; o líder cadastra um funcionário. Cada um no seu computador. */
  async function companyWithEmployee() {
    const pcAdmin = computer("PC-ADMIN");
    const pcLeader = computer("PC-LIDER");
    const pcEmp = computer("PC-FUNC");

    const ownerLogin = await pcAdmin.remote.login("dono", "senha-do-dono");
    const leaderInvite = await pcAdmin.remote.createInvite(ownerLogin.user.id, "leader");
    const leaderReg = await pcLeader.remote.registerViaInvite(leaderInvite.id, "lider", "senha-lider");
    const leaderReq = cookieRequest(leaderReg.cookie);

    const empInvite = await pcLeader.remote.createEmployeeInvite(leaderReq);
    const empReg = await pcEmp.remote.registerViaInvite(empInvite.id, "func", "senha-func");

    return { pcLeader, pcEmp, leaderReq, empId: empReg.user.id };
  }

  test("conectou mais WhatsApp do que o líder liberou: o bot desliga sozinho e avisa o funcionário", async () => {
    const { pcLeader, pcEmp, leaderReq, empId } = await companyWithEmployee();
    await pcLeader.remote.setEmployeeConfig(leaderReq, empId, { maxWhatsapps: 1 });

    // Primeiro WhatsApp: cabe no limite, o bot continua ligado
    linkTo(pcEmp, Curve.generateKeyPair());
    pcEmp.account.setBotActive(true);
    await pcEmp.account.coordination.checkWhatsappAllowed();
    expect(pcEmp.account.bot.active).toBe(true);

    // Troca para OUTRO WhatsApp (a vaga já foi ocupada pelo primeiro): passa do limite
    linkTo(pcEmp, Curve.generateKeyPair());
    await pcEmp.account.coordination.checkWhatsappAllowed();
    expect(pcEmp.account.bot.active).toBe(false);
    expect(pcEmp.notices.join("\n")).toContain("líder liberou só 1 WhatsApp");
  });

  test("conta sem líder (operador comum) não tem limite de WhatsApp", async () => {
    const { pcA } = await twoAttendants({ sameTeam: false });
    pcA.account.setBotActive(true);
    await pcA.account.coordination.checkWhatsappAllowed();
    expect(pcA.account.bot.active).toBe(true);
  });

  test("servidor fora do ar não bloqueia o funcionário (a trava de verdade é no dinheiro, na próxima fase)", async () => {
    const { pcEmp, pcLeader, leaderReq, empId } = await companyWithEmployee();
    await pcLeader.remote.setEmployeeConfig(leaderReq, empId, { maxWhatsapps: 1 });
    linkTo(pcEmp, Curve.generateKeyPair());
    pcEmp.account.setBotActive(true);

    serverOnline = false;
    await pcEmp.account.coordination.checkWhatsappAllowed();
    expect(pcEmp.account.bot.active).toBe(true); // não dá pra confirmar com o servidor: não bloqueia
  });

  // CPF de teste válido (passa na validação de dígito verificador do app).
  const VALID_CPF = "11144477735";

  test("dinheiro: o funcionário cobra e confere pela MisticPay do líder; o split cai no saldo dele", async () => {
    const { pcLeader, pcEmp, leaderReq, empId } = await companyWithEmployee();
    await pcLeader.remote.setEmployeeConfig(leaderReq, empId, { feePercent: 20 });
    await pcLeader.remote.setMisticCredentials(leaderReq, { clientId: "cid", clientSecret: "sec" });

    // A cobrança é criada pelo serviço do funcionário, mas executada no servidor (MisticPay do líder)
    const charge = await pcEmp.account.mistic.createCharge({ chatJid: CLIENT, amount: "100,00", payerDocument: VALID_CPF, send: false });
    expect(charge.status).toBe("pending");
    expect(charge.copyPaste).toBe(`PIX-${charge.misticId}`);

    // o cliente paga: bruto 100, taxa da MisticPay 10 → líquido 90; taxa do líder 20% → funcionário 72
    serverMistic.setPaid(charge.misticId!, 100, 10);
    const checked = await pcEmp.account.mistic.checkNow(charge.id);
    expect(checked.status).toBe("paid");

    expect(serverStores.money.employeeBalanceCents(empId)).toBe(7200);
    expect((await pcEmp.account.mistic.accountInfo()).availableBalance).toBe(72);
  });

  test("dinheiro: operador comum (sem líder) usa a MisticPay local, não o servidor", async () => {
    const { pcA } = await twoAttendants({ sameTeam: false });
    // Sem líder e sem credenciais locais: a cobrança é recusada localmente (não vai parar no servidor).
    expect(pcA.account.mistic.createCharge({ chatJid: CLIENT, amount: "10,00", payerDocument: VALID_CPF, send: false })).rejects.toThrow(/MisticPay/i);
    expect(serverStores.money.listForLeader("qualquer")).toEqual([]);
  });

  test("dinheiro: o funcionário cria senha de saque e saca pelo servidor; o bloqueio do líder barra o saque", async () => {
    const { pcLeader, pcEmp, leaderReq, empId } = await companyWithEmployee();
    await pcLeader.remote.setMisticCredentials(leaderReq, { clientId: "cid", clientSecret: "sec" });

    // o funcionário cobra e recebe 100 (taxa do líder padrão 0%)
    const charge = await pcEmp.account.mistic.createCharge({ chatJid: CLIENT, amount: "100,00", payerDocument: VALID_CPF, send: false });
    serverMistic.setPaid(charge.misticId!, 100, 0);
    await pcEmp.account.mistic.checkNow(charge.id);
    expect(serverStores.money.employeeBalanceCents(empId)).toBe(10000);

    // cria a senha de saque (guardada no servidor) e saca: o saldo cai
    await pcEmp.account.mistic.setWithdrawPassword("1234");
    const wd = await pcEmp.account.mistic.withdraw({ amount: "40,00", pixKeyType: "CPF", pixKey: VALID_CPF, withdrawPassword: "1234" });
    expect(wd.kind).toBe("withdraw");
    expect(serverStores.money.employeeBalanceCents(empId)).toBe(6000);

    // o líder bloqueia o saque: o funcionário é barrado com a mensagem do líder
    await pcLeader.remote.setEmployeeConfig(leaderReq, empId, { withdrawBlocked: true });
    expect(
      pcEmp.account.mistic.withdraw({ amount: "10,00", pixKeyType: "CPF", pixKey: VALID_CPF, withdrawPassword: "1234" })
    ).rejects.toThrow(/líder bloqueou/i);
  });
});
