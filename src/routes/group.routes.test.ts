import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountManager } from "../core/account-manager";
import { fakeConnections, tempDirs, type FakeConnection } from "../testing/fakes";
import { handleApiRequest } from ".";

const GROUP = "120363000000000000@g.us";

let dirs: ReturnType<typeof tempDirs>;
let manager: AccountManager;
let connection: FakeConnection;

async function api(method: string, path: string, body?: unknown) {
  const url = new URL(`http://127.0.0.1:3000${path}`);
  const req = new Request(url.href, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleApiRequest(req, url, manager);
  const text = res ? await res.text() : "";
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // não era JSON
  }
  return { status: res?.status ?? 0, json };
}

beforeEach(() => {
  dirs = tempDirs();
  const fake = fakeConnections();
  manager = new AccountManager({ appDataDir: dirs.appDataDir, tempDir: dirs.tempDir, createConnection: fake.factory, notify: () => {} });
  connection = fake.created[0]!;
  connection.connected = true;
});

afterEach(() => {
  manager.stopAll();
  dirs.cleanup();
});

describe("GET /groups/metadata/:jid", () => {
  test("devolve descrição, total de membros e participantes (com admin e telefone)", async () => {
    connection.sock.groupMetadata = async () => ({
      id: GROUP,
      subject: "Uber 50%",
      owner: undefined,
      desc: "Regras do grupo",
      ephemeralDuration: 0,
      participants: [
        { id: "5511977770000@s.whatsapp.net", phoneNumber: "5511977770000@s.whatsapp.net", name: undefined, notify: "Bruno", admin: "superadmin" as const },
        { id: "5511966660000@s.whatsapp.net", phoneNumber: "5511966660000@s.whatsapp.net", name: "Maria Salva", notify: "Maria", admin: null },
      ],
    });

    const { status, json } = await api("GET", `/accounts/default/groups/metadata/${encodeURIComponent(GROUP)}`);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      description: "Regras do grupo",
      memberCount: 2,
      ephemeralDuration: 0,
      participants: [
        { jid: "5511977770000@s.whatsapp.net", phone: "5511977770000", name: "Bruno", isAdmin: false, isSuperAdmin: true },
        { jid: "5511966660000@s.whatsapp.net", phone: "5511966660000", name: "Maria Salva", isAdmin: false, isSuperAdmin: false },
      ],
    });
  });

  test("identifica você mesmo na lista (isSelf) e se você é admin (selfIsAdmin)", async () => {
    connection.sock.groupMetadata = async () => ({
      id: GROUP,
      subject: "Uber 50%",
      owner: undefined,
      participants: [
        { id: "5511900000000@s.whatsapp.net", phoneNumber: "5511900000000@s.whatsapp.net", notify: "Você", admin: "admin" as const },
        { id: "5511977770000@s.whatsapp.net", phoneNumber: "5511977770000@s.whatsapp.net", notify: "Bruno", admin: null },
      ],
    });

    const { json } = await api("GET", `/accounts/default/groups/metadata/${encodeURIComponent(GROUP)}`);
    expect(json.selfIsAdmin).toBe(true);
    expect(json.participants).toMatchObject([{ jid: "5511900000000@s.whatsapp.net", isSelf: true }, { jid: "5511977770000@s.whatsapp.net", isSelf: false }]);
  });

  test("identifica você mesmo mesmo quando sua própria entrada no grupo vem em LID (não em telefone)", async () => {
    // sock.user.id continua telefone, mas o grupo lista VOCÊ pelo LID — só bate comparando phoneNumber também
    connection.sock.groupMetadata = async () => ({
      id: GROUP,
      subject: "Uber 50%",
      owner: undefined,
      participants: [
        { id: "999888777@lid", phoneNumber: "5511900000000@s.whatsapp.net", notify: "Você", admin: "superadmin" as const },
        { id: "5511977770000@s.whatsapp.net", phoneNumber: "5511977770000@s.whatsapp.net", notify: "Bruno", admin: null },
      ],
    });

    const { json } = await api("GET", `/accounts/default/groups/metadata/${encodeURIComponent(GROUP)}`);
    expect(json.selfIsAdmin).toBe(true);
    expect(json.participants).toMatchObject([{ jid: "999888777@lid", isSelf: true }, { jid: "5511977770000@s.whatsapp.net", isSelf: false }]);
  });

  test("identifica você mesmo quando sock.user.id vem em LID (baileys preferindo lid) e o grupo te lista pelo telefone", async () => {
    connection.sock.user = { id: "999888777@lid", lid: "999888777@lid", phoneNumber: "5511900000000@s.whatsapp.net" } as never;
    connection.sock.groupMetadata = async () => ({
      id: GROUP,
      subject: "Uber 50%",
      owner: undefined,
      participants: [{ id: "5511900000000@s.whatsapp.net", phoneNumber: "5511900000000@s.whatsapp.net", notify: "Você", admin: "admin" as const }],
    });

    const { json } = await api("GET", `/accounts/default/groups/metadata/${encodeURIComponent(GROUP)}`);
    expect(json.selfIsAdmin).toBe(true);
  });

  test("falha ao buscar (grupo saiu, sem rede...) devolve 502 em vez de derrubar o painel", async () => {
    connection.sock.groupMetadata = async () => {
      throw new Error("not-authorized");
    };
    const { status, json } = await api("GET", `/accounts/default/groups/metadata/${encodeURIComponent(GROUP)}`);
    expect(status).toBe(502);
    expect(json.error).toBeTruthy();
  });
});

describe("descrição do grupo", () => {
  const ME = { id: "5511900000000@s.whatsapp.net", phoneNumber: "5511900000000@s.whatsapp.net", notify: "Você" };

  test("canEditInfo: admin sempre pode; membro comum só se o grupo não trava a edição pra admins; quem não está no grupo, nunca", async () => {
    const metadata = (admin: "admin" | null, restrict: boolean, participants = [{ ...ME, admin }]) =>
      (connection.sock.groupMetadata = async () => ({ id: GROUP, subject: "Grupo", owner: undefined, restrict, participants }) as never);
    const canEdit = async () => (await api("GET", `/accounts/default/groups/metadata/${encodeURIComponent(GROUP)}`)).json.canEditInfo;

    metadata("admin", true);
    expect(await canEdit()).toBe(true);
    metadata(null, true);
    expect(await canEdit()).toBe(false);
    metadata(null, false);
    expect(await canEdit()).toBe(true);
    metadata(null, false, []);
    expect(await canEdit()).toBe(false);
  });

  test("PUT muda a descrição no WhatsApp; vazia apaga; texto que não é texto ou longo demais é recusado", async () => {
    const path = `/accounts/default/groups/${encodeURIComponent(GROUP)}/description`;

    expect(await api("PUT", path, { description: "  Regras novas\nSem spam  " })).toMatchObject({ status: 200, json: { description: "Regras novas\nSem spam" } });
    expect(await api("PUT", path, { description: "   " })).toMatchObject({ status: 200, json: { description: null } });
    expect(connection.sock.descriptionUpdates).toEqual([
      { jid: GROUP, description: "Regras novas\nSem spam" },
      { jid: GROUP, description: undefined },
    ]);

    expect((await api("PUT", path, {})).status).toBe(400);
    expect((await api("PUT", path, { description: "x".repeat(2049) })).status).toBe(400);
    expect(connection.sock.descriptionUpdates.length).toBe(2);
  });

  test("WhatsApp recusa (sem permissão) ou conta desconectada: erro claro em vez de fingir que salvou", async () => {
    const path = `/accounts/default/groups/${encodeURIComponent(GROUP)}/description`;

    connection.sock.descriptionUpdateFails = true;
    const refused = await api("PUT", path, { description: "Tentativa" });
    expect(refused.status).toBe(502);
    expect(refused.json.error).toContain("permissão");

    connection.connected = false;
    expect((await api("PUT", path, { description: "Tentativa" })).status).toBe(503);
  });
});

describe("POST /groups/:jid/participants/:participantJid", () => {
  const BRUNO = "5511977770000@s.whatsapp.net";

  test("remove, promove e rebaixa um participante de verdade (via Baileys)", async () => {
    const remove = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/participants/${encodeURIComponent(BRUNO)}`, { action: "remove" });
    expect(remove.status).toBe(200);

    const promote = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/participants/${encodeURIComponent(BRUNO)}`, { action: "promote" });
    expect(promote.status).toBe(200);

    expect(connection.sock.participantUpdates).toEqual([
      { jid: GROUP, participants: [BRUNO], action: "remove" },
      { jid: GROUP, participants: [BRUNO], action: "promote" },
    ]);
  });

  test("ação inválida é recusada (400) sem chamar o WhatsApp", async () => {
    const { status, json } = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/participants/${encodeURIComponent(BRUNO)}`, { action: "virar-adm-supremo" });
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
    expect(connection.sock.participantUpdates).toEqual([]);
  });

  test("falha do WhatsApp (sem permissão, por exemplo) devolve 502 em vez de derrubar o painel", async () => {
    connection.sock.groupParticipantsUpdate = async () => {
      throw new Error("forbidden");
    };
    const { status, json } = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/participants/${encodeURIComponent(BRUNO)}`, { action: "demote" });
    expect(status).toBe(502);
    expect(json.error).toBeTruthy();
  });

  test("'add' funciona igual às outras ações (adicionar participante ao grupo)", async () => {
    const { status } = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/participants/${encodeURIComponent(BRUNO)}`, { action: "add" });
    expect(status).toBe(200);
    expect(connection.sock.participantUpdates).toEqual([{ jid: GROUP, participants: [BRUNO], action: "add" }]);
  });

  test("'add' recusado pela privacidade da pessoa (status != 200 por participante): 409 com mensagem clara", async () => {
    connection.sock.participantUpdateStatus = "403";
    const { status, json } = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/participants/${encodeURIComponent(BRUNO)}`, { action: "add" });
    expect(status).toBe(409);
    expect(json.error).toBeTruthy();
  });
});

describe("Link de convite do grupo", () => {
  test("GET /groups/:jid/invite devolve o código e o link completo", async () => {
    connection.sock.inviteCode = "QUAF2AH";
    const { status, json } = await api("GET", `/accounts/default/groups/${encodeURIComponent(GROUP)}/invite`);
    expect(status).toBe(200);
    expect(json).toEqual({ code: "QUAF2AH", link: "https://chat.whatsapp.com/QUAF2AH" });
  });

  test("POST /groups/:jid/invite (gerar novo link) devolve um código diferente", async () => {
    connection.sock.inviteCode = "ANTIGO1";
    const { json } = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/invite`);
    expect(json.code).not.toBe("ANTIGO1");
    expect(json.link).toBe(`https://chat.whatsapp.com/${json.code}`);
  });

  test("sem permissão de buscar o link: 502 em vez de derrubar o painel", async () => {
    connection.sock.groupInviteCode = async () => {
      throw new Error("forbidden");
    };
    const { status, json } = await api("GET", `/accounts/default/groups/${encodeURIComponent(GROUP)}/invite`);
    expect(status).toBe(502);
    expect(json.error).toBeTruthy();
  });
});

describe("Pedidos de entrada pendentes (grupo com aprovação de admin)", () => {
  const BRUNO = "5511977770000@s.whatsapp.net";
  const MARIA = "5511966660000@s.whatsapp.net";

  test("GET /groups/:jid/join-requests lista os pedidos pendentes de verdade (via Baileys)", async () => {
    connection.sock.pendingJoinRequests = [
      { jid: BRUNO, request_method: "invite_link", request_time: "1700000000" },
      { jid: MARIA },
    ];
    const { status, json } = await api("GET", `/accounts/default/groups/${encodeURIComponent(GROUP)}/join-requests`);
    expect(status).toBe(200);
    expect(json.requests).toEqual([
      { jid: BRUNO, method: "invite_link", requestedAt: 1700000000000 },
      { jid: MARIA, method: null, requestedAt: null },
    ]);
  });

  test("sem pedido nenhum: lista vazia", async () => {
    const { status, json } = await api("GET", `/accounts/default/groups/${encodeURIComponent(GROUP)}/join-requests`);
    expect(status).toBe(200);
    expect(json.requests).toEqual([]);
  });

  test("falha ao buscar: 502 em vez de derrubar o painel", async () => {
    connection.sock.groupRequestParticipantsList = async () => {
      throw new Error("forbidden");
    };
    const { status, json } = await api("GET", `/accounts/default/groups/${encodeURIComponent(GROUP)}/join-requests`);
    expect(status).toBe(502);
    expect(json.error).toBeTruthy();
  });

  test("POST aprova um ou mais pedidos de verdade (via Baileys)", async () => {
    connection.sock.pendingJoinRequests = [{ jid: BRUNO }, { jid: MARIA }];
    const { status } = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/join-requests`, { jids: [BRUNO], action: "approve" });
    expect(status).toBe(200);
    expect(connection.sock.joinRequestUpdates).toEqual([{ jid: GROUP, participants: [BRUNO], action: "approve" }]);
    // o aprovado sai da lista de pendentes, a outra pessoa continua
    expect(connection.sock.pendingJoinRequests).toEqual([{ jid: MARIA }]);
  });

  test("POST recusa um pedido", async () => {
    connection.sock.pendingJoinRequests = [{ jid: BRUNO }];
    const { status } = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/join-requests`, { jids: [BRUNO], action: "reject" });
    expect(status).toBe(200);
    expect(connection.sock.joinRequestUpdates).toEqual([{ jid: GROUP, participants: [BRUNO], action: "reject" }]);
  });

  test("sem jids ou ação inválida: 400 sem chamar o WhatsApp", async () => {
    const semJids = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/join-requests`, { action: "approve" });
    expect(semJids.status).toBe(400);
    const acaoInvalida = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/join-requests`, { jids: [BRUNO], action: "banir" });
    expect(acaoInvalida.status).toBe(400);
    expect(connection.sock.joinRequestUpdates).toEqual([]);
  });

  test("falha ao responder: 502 em vez de derrubar o painel", async () => {
    connection.sock.groupRequestParticipantsUpdate = async () => {
      throw new Error("forbidden");
    };
    const { status, json } = await api("POST", `/accounts/default/groups/${encodeURIComponent(GROUP)}/join-requests`, { jids: [BRUNO], action: "approve" });
    expect(status).toBe(502);
    expect(json.error).toBeTruthy();
  });
});
