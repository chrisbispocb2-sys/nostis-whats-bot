import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountManager } from "../core/account-manager";
import { fakeConnections, groupText, privateText, tempDirs, type FakeConnection } from "../testing/fakes";
import { handleApiRequest } from ".";

const CLIENT = "5511977770000@s.whatsapp.net";
const CLIENT_2 = "5511966660000@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

let dirs: ReturnType<typeof tempDirs>;
let manager: AccountManager;
let connection: FakeConnection;
let downloadMediaImpl: () => Promise<Buffer>;

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
  return { status: res?.status ?? 0, json, text };
}

const wait = (ms: number) => Bun.sleep(ms);

beforeEach(() => {
  dirs = tempDirs();
  downloadMediaImpl = async () => Buffer.from("fake-media-bytes");
  const fake = fakeConnections();
  manager = new AccountManager({
    appDataDir: dirs.appDataDir,
    tempDir: dirs.tempDir,
    createConnection: fake.factory,
    notify: () => {},
    chatDownloadMedia: () => downloadMediaImpl(),
    chatMediaRetryDelaysMs: [], // sem tentativa extra: os testes de falha não precisam esperar segundos de verdade
  });
  connection = fake.created[0]!;
  connection.connected = true;
});

afterEach(() => {
  manager.stopAll();
  dirs.cleanup();
});

describe("GET /chats", () => {
  test("começa vazio", async () => {
    const { json } = await api("GET", "/accounts/default/chats");
    expect(json.chats).toEqual([]);
  });

  test("mensagem privada recebida aparece na lista de conversas", async () => {
    await connection.deliver(privateText(CLIENT, "Oi, preciso de uma corrida", { pushName: "Maria" }));
    const { json } = await api("GET", "/accounts/default/chats");
    expect(json.chats).toMatchObject([{ jid: CLIENT, isGroup: false, name: "Maria", lastMessagePreview: "Oi, preciso de uma corrida" }]);
  });

  test("mensagem recebida soma no contador de não lidas", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));
    await connection.deliver(privateText(CLIENT, "De novo", { pushName: "Maria" }));
    const { json } = await api("GET", "/accounts/default/chats");
    expect(json.chats[0]).toMatchObject({ unreadCount: 2 });
  });

  test("mensagem de grupo também aparece, marcada como grupo", async () => {
    await connection.deliver(groupText(GROUP, CLIENT, "bom dia pessoal", { pushName: "Maria" }));
    const { json } = await api("GET", "/accounts/default/chats");
    expect(json.chats).toMatchObject([{ jid: GROUP, isGroup: true }]);
  });

  test("cada conversa privada já vem com o telefone pronto (grupo não tem telefone)", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));
    await connection.deliver(groupText(GROUP, CLIENT, "bom dia", { pushName: "Maria" }));
    const { json } = await api("GET", "/accounts/default/chats");
    const byJid = Object.fromEntries(json.chats.map((c: any) => [c.jid, c.phone]));
    expect(byJid[CLIENT]).toBe("5511977770000");
    expect(byJid[GROUP]).toBeNull();
  });

  test("conversa por LID (identidade oculta): telefone vem certo quando o painel já sabe, null quando não dá", async () => {
    const CLIENT_LID = "987654321@lid";
    connection.sock.lidToPhone[CLIENT_LID] = CLIENT;
    await connection.deliver(privateText(CLIENT_LID, "Oi", { pushName: "Bruno" }));

    const { json } = await api("GET", "/accounts/default/chats");
    expect(json.chats[0]).toMatchObject({ jid: CLIENT_LID, phone: "5511977770000" });
  });

  test("LID que não resolveu na hora da mensagem: a lista resolve ao vivo depois, não fica sem número pra sempre", async () => {
    const CLIENT_LID = "987654321@lid";
    // mensagem chega ANTES de o mapeamento existir: a resolução na hora falha
    await connection.deliver(privateText(CLIENT_LID, "Oi", { pushName: "Bruno" }));
    expect((await api("GET", "/accounts/default/chats")).json.chats[0]).toMatchObject({ jid: CLIENT_LID, phone: null });

    // agora o WhatsApp "aprende" o mapeamento — a lista tem que achar o telefone na próxima leitura
    connection.sock.lidToPhone[CLIENT_LID] = CLIENT;
    const { json } = await api("GET", "/accounts/default/chats");
    expect(json.chats[0]).toMatchObject({ jid: CLIENT_LID, phone: "5511977770000" });
  });
});

describe("GET /chats/:jid/messages", () => {
  test("lista as mensagens da conversa, mais recente primeiro", async () => {
    await connection.deliver(privateText(CLIENT, "Primeira", { pushName: "Maria" }));
    await connection.deliver(privateText(CLIENT, "Segunda", { pushName: "Maria" }));

    const { json } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`);
    expect(json.messages.map((m: any) => m.text)).toEqual(["Segunda", "Primeira"]);
  });

  test("conversa sem nenhuma mensagem devolve lista vazia", async () => {
    const { json } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`);
    expect(json.messages).toEqual([]);
  });
});

describe("POST /chats/:jid/messages (responder como operador)", () => {
  test("envia pelo WhatsApp e já grava a mensagem (otimista)", async () => {
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`, { text: "Já te atendo!" });
    expect(status).toBe(200);
    expect(json.message).toMatchObject({ text: "Já te atendo!", fromMe: true });
    expect(connection.sock.textsTo(CLIENT)).toEqual(["Já te atendo!"]);
  });

  test("não marca a mensagem como enviada pelo bot (o eco cancela a saudação/segurança como resposta sua)", async () => {
    const { json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`, { text: "Oi!" });
    const account = manager.get("default")!;
    expect(account.sent.has(json.message.id)).toBe(false);
  });

  test("o eco real da mesma mensagem não duplica no histórico", async () => {
    const { json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`, { text: "Oi!" });
    const messageId = json.message.id as string;

    // Simula o WhatsApp devolvendo a mesma mensagem como fromMe (o eco de verdade)
    await connection.deliver(privateText(CLIENT, "Oi!", { fromMe: true, id: messageId }));

    const { json: list } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`);
    expect(list.messages.length).toBe(1);
  });

  test("funciona também para grupo", async () => {
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(GROUP)}/messages`, { text: "Aviso geral" });
    expect(status).toBe(200);
    expect(connection.sock.textsTo(GROUP)).toEqual(["Aviso geral"]);
    expect(json.message).toMatchObject({ chatJid: GROUP, fromMe: true });
  });

  test("texto vazio é recusado", async () => {
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`, { text: "   " });
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
    expect(connection.sock.textsTo(CLIENT)).toEqual([]);
  });

  test("sem conexão: erro claro, nada é gravado", async () => {
    connection.connected = false;
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`, { text: "Oi" });
    expect(status).toBe(502);
    expect(json.error).toContain("desconectado");
  });

  test("envia uma foto (com legenda) e ela já sai gravada com arquivo", async () => {
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`, {
      text: "Olha essa",
      media: { type: "image", dataBase64: tinyPng, mimeType: "image/png" },
    });
    expect(status).toBe(200);
    expect(json.message).toMatchObject({ type: "image", text: "Olha essa" });
    expect(json.message.mediaFile).toBeTruthy();
  });
});

describe("GET /chats/:jid/media/:messageId", () => {
  test("404 quando a mensagem não existe ou não tem mídia", async () => {
    const { status } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/media/NAO_EXISTE`);
    expect(status).toBe(404);
  });

  test("404 enquanto o download ainda não terminou", async () => {
    downloadMediaImpl = async () => {
      await wait(30);
      return Buffer.from("fake-media-bytes");
    };

    await connection.deliver({
      key: { remoteJid: CLIENT, fromMe: false, id: "IMG1" },
      message: { imageMessage: { mimetype: "image/jpeg" } },
    } as never);

    const { status } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/media/IMG1`);
    expect(status).toBe(404);
  });

  test("depois de baixada, serve o arquivo com o Content-Type certo", async () => {
    await connection.deliver({
      key: { remoteJid: CLIENT, fromMe: false, id: "IMG1" },
      message: { imageMessage: { mimetype: "image/jpeg" } },
    } as never);
    await wait(20); // download assíncrono

    const url = new URL(`http://127.0.0.1:3000/accounts/default/chats/${encodeURIComponent(CLIENT)}/media/IMG1`);
    const res = await handleApiRequest(new Request(url.href), url, manager);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toBe("image/jpeg");
    expect(await res!.text()).toBe("fake-media-bytes");
  });

  test("mídia enviada pelo painel também fica disponível na hora (não precisa baixar)", async () => {
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const { json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`, {
      media: { type: "image", dataBase64: tinyPng, mimeType: "image/png" },
    });

    const url = new URL(`http://127.0.0.1:3000/accounts/default/chats/${encodeURIComponent(CLIENT)}/media/${json.message.id}`);
    const res = await handleApiRequest(new Request(url.href), url, manager);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toBe("image/png");
  });
});

describe("GET /chats/:jid/media (galeria) e /groups-in-common", () => {
  test("galeria só traz mensagens com mídia já baixada", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));
    await connection.deliver({ key: { remoteJid: CLIENT, fromMe: false, id: "IMG1" }, message: { imageMessage: { mimetype: "image/jpeg" } } } as never);
    await wait(20);

    const { json } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/media`);
    expect(json.messages.map((m: any) => m.id)).toEqual(["IMG1"]);
  });

  test("grupos em comum: só os grupos onde a pessoa realmente falou", async () => {
    await connection.deliver(groupText(GROUP, CLIENT, "bom dia", { pushName: "Bruno" }));
    const { json } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/groups-in-common`);
    expect(json.chats).toMatchObject([{ jid: GROUP, isGroup: true }]);

    const { json: none } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT_2)}/groups-in-common`);
    expect(none.chats).toEqual([]);
  });

  test("grupos em comum acha os dois grupos mesmo quando a pessoa fala por telefone numa e por LID (identidade oculta) na outra", async () => {
    const CLIENT_LID = "987654321@lid";
    const GROUP_2 = "120363999999999999@g.us";
    connection.sock.lidToPhone[CLIENT_LID] = CLIENT;

    // conversa privada com ela (por LID, resolvendo pro telefone) — é isso que liga os dois JIDs na mesma pessoa
    await connection.deliver(privateText(CLIENT_LID, "Oi", { pushName: "Bruno" }));
    // um grupo em que ela fala pelo telefone, outro em que ela fala pelo LID
    await connection.deliver(groupText(GROUP, CLIENT, "bom dia", { pushName: "Bruno" }));
    await connection.deliver(groupText(GROUP_2, CLIENT_LID, "boa noite", { pushName: "Bruno" }));

    const { json } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT_LID)}/groups-in-common`);
    expect(json.chats.map((c: any) => c.jid).sort()).toEqual([GROUP, GROUP_2].sort());
  });
});

describe("GET /chats/:jid/identity", () => {
  test("JID de telefone: devolve o telefone direto, sem precisar de rede", async () => {
    const { json } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/identity`);
    expect(json.phone).toBe("5511977770000");
  });

  test("JID por LID que resolve: devolve o telefone de verdade, não os dígitos do LID", async () => {
    const CLIENT_LID = "987654321@lid";
    connection.sock.lidToPhone[CLIENT_LID] = CLIENT;

    const { json } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT_LID)}/identity`);
    expect(json.phone).toBe("5511977770000");
  });

  test("JID por LID que não resolve: devolve null em vez de inventar um número", async () => {
    const { json } = await api("GET", `/accounts/default/chats/${encodeURIComponent("000000000@lid")}/identity`);
    expect(json.phone).toBeNull();
  });
});

describe("POST /chats/:jid/read", () => {
  test("zera o contador de não lidas da conversa", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));
    await connection.deliver(privateText(CLIENT, "De novo", { pushName: "Maria" }));

    const { status, json: ok } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/read`);
    expect(status).toBe(200);
    expect(ok).toEqual({ ok: true });

    const { json } = await api("GET", "/accounts/default/chats");
    expect(json.chats[0]).toMatchObject({ unreadCount: 0 });
  });
});

describe("POST /chats/read-all", () => {
  test("zera o contador de não lidas de todas as conversas de uma vez (inclusive arquivadas)", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));
    await connection.deliver(privateText(CLIENT, "De novo", { pushName: "Maria" }));
    await connection.deliver(groupText(GROUP, CLIENT_2, "bom dia", { pushName: "Bruno" }));
    await api("POST", `/accounts/default/chats/${encodeURIComponent(GROUP)}/archive`);

    const { status, json: ok } = await api("POST", "/accounts/default/chats/read-all");
    expect(status).toBe(200);
    expect(ok).toEqual({ ok: true });

    const main = await api("GET", "/accounts/default/chats");
    expect(main.json.chats.every((c: any) => c.unreadCount === 0)).toBe(true);
    const archived = await api("GET", "/accounts/default/chats/archived");
    expect(archived.json.chats.every((c: any) => c.unreadCount === 0)).toBe(true);
  });
});

describe("Fixar e arquivar", () => {
  test("POST .../pin fixa (padrão) e desafixa com {pinned:false}", async () => {
    // GROUP é a conversa mais ANTIGA das duas: só fica em primeiro se estiver fixada
    await connection.deliver(groupText(GROUP, CLIENT, "bom dia", { pushName: "Maria" }));
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));

    await api("POST", `/accounts/default/chats/${encodeURIComponent(GROUP)}/pin`);
    let { json } = await api("GET", "/accounts/default/chats");
    expect(json.chats[0]).toMatchObject({ jid: GROUP, pinnedAt: expect.any(Number) });

    await api("POST", `/accounts/default/chats/${encodeURIComponent(GROUP)}/pin`, { pinned: false });
    ({ json } = await api("GET", "/accounts/default/chats"));
    expect(json.chats[0]).toMatchObject({ jid: CLIENT }); // volta a ordenar por atividade (mais recente primeiro)
    expect(json.chats.find((c: any) => c.jid === GROUP).pinnedAt).toBeNull();
  });

  test("POST .../pin com temporary:true é recusado (409) sem a MisticPay cadastrada", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/pin`, { temporary: true });
    expect(status).toBe(409);
    expect(json.error).toBeTruthy();
    expect((await api("GET", "/accounts/default/chats")).json.chats[0].pinnedAt).toBeNull();
  });

  test("POST .../pin com temporary:true funciona com a MisticPay cadastrada, e marca pinIsTemporary", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));
    await api("PUT", "/accounts/default/mistic/config", { enabled: true, clientId: "abc", clientSecret: "xyz" });

    await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/pin`, { temporary: true });
    const { json } = await api("GET", "/accounts/default/chats");
    expect(json.chats[0]).toMatchObject({ jid: CLIENT, pinIsTemporary: true });
    expect(json.chats[0].pinnedAt).not.toBeNull();
  });

  test("POST .../archive esconde da lista principal; GET /chats/archived mostra; desarquivar devolve", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));

    await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/archive`);
    expect((await api("GET", "/accounts/default/chats")).json.chats).toEqual([]);
    expect((await api("GET", "/accounts/default/chats/archived")).json.chats).toMatchObject([{ jid: CLIENT }]);

    await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/archive`, { archived: false });
    expect((await api("GET", "/accounts/default/chats")).json.chats).toMatchObject([{ jid: CLIENT }]);
  });
});

describe("GET /chats/:jid/search", () => {
  test("acha mensagens pelo texto; sem termo devolve lista vazia", async () => {
    await connection.deliver(privateText(CLIENT, "Uber 50% de desconto", { pushName: "Maria" }));
    await connection.deliver(privateText(CLIENT, "chegou o motorista", { pushName: "Maria" }));

    const { json } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/search?q=uber`);
    expect(json.messages).toMatchObject([{ text: "Uber 50% de desconto" }]);

    const { json: empty } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/search?q=`);
    expect(empty.messages).toEqual([]);
  });
});

describe("Apagar e encaminhar mensagens", () => {
  test("DELETE .../messages/:id apaga pra mim (some do histórico)", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { id: "M1", pushName: "Maria" }));

    const { status, json } = await api("DELETE", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages/M1`);
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });

    const { json: list } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`);
    expect(list.messages).toEqual([]);
  });

  test("DELETE de mensagem inexistente dá 404", async () => {
    const { status } = await api("DELETE", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages/NAO_EXISTE`);
    expect(status).toBe(404);
  });

  test("POST .../delete-everyone apaga a mensagem sua de verdade no WhatsApp e vira 'revoked' aqui", async () => {
    const { json: sent } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`, { text: "Ops" });
    const { status, json } = await api(
      "POST",
      `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages/${sent.message.id}/delete-everyone`
    );
    expect(status).toBe(200);
    expect(json.message).toMatchObject({ type: "revoked" });
  });

  test("POST .../delete-everyone numa mensagem do cliente dá erro (só vale pra mensagem sua)", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { id: "M1", pushName: "Maria" }));
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages/M1/delete-everyone`);
    expect(status).toBe(502);
    expect(json.error).toBeTruthy();
  });

  test("POST .../forward manda a mensagem pra outra conversa", async () => {
    await connection.deliver(privateText(CLIENT, "Olha isso", { id: "M1", pushName: "Maria" }));

    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages/M1/forward`, {
      to: CLIENT_2,
    });
    expect(status).toBe(200);
    expect(json.message).toMatchObject({ chatJid: CLIENT_2, text: "Olha isso", fromMe: true });
  });

  test("POST .../forward sem destino é recusado", async () => {
    await connection.deliver(privateText(CLIENT, "Olha isso", { id: "M1" }));
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages/M1/forward`, {});
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
  });
});

describe("POST /chats/:jid/messages/:id/retry-media", () => {
  test("mídia que desistiu: tentar de novo e conseguir atualiza a mensagem", async () => {
    downloadMediaImpl = async () => {
      throw new Error("falha de rede simulada");
    };
    await connection.deliver({
      key: { remoteJid: CLIENT, fromMe: false, id: "STK1" },
      message: { stickerMessage: { mimetype: "image/webp" } },
    } as never);
    await wait(20);

    const { json: before } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`);
    expect(before.messages[0]).toMatchObject({ mediaDownloadFailed: true, mediaFile: null });

    downloadMediaImpl = async () => Buffer.from("figurinha-de-verdade");
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages/STK1/retry-media`);
    expect(status).toBe(200);
    expect(json.message).toMatchObject({ mediaDownloadFailed: false });
    expect(json.message.mediaFile).toBeTruthy();
  });

  test("mensagem sem mídia nenhuma pra tentar de novo dá erro", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { id: "M1" }));
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages/M1/retry-media`);
    expect(status).toBe(502);
    expect(json.error).toBeTruthy();
  });

  test("mensagem inexistente dá erro", async () => {
    const { status } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages/NAO_EXISTE/retry-media`);
    expect(status).toBe(502);
  });
});

describe("POST /chats/:jid/messages com quotedId (responder)", () => {
  test("a mensagem enviada guarda o quotedId", async () => {
    await connection.deliver(privateText(CLIENT, "Qual o endereço?", { id: "PERGUNTA", pushName: "Maria" }));
    const { json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`, {
      text: "Rua Um, 123",
      quotedId: "PERGUNTA",
    });
    expect(json.message).toMatchObject({ text: "Rua Um, 123", quotedId: "PERGUNTA" });
  });
});

describe("/chats/:jid/uber-trip (acompanhar corrida pelo link público)", () => {
  function fakeOpener(sequence: Array<unknown>) {
    let i = 0;
    const closed: boolean[] = [];
    const opener = async () => ({
      fetchStatus: async () => sequence[Math.min(i++, sequence.length - 1)],
      close: () => closed.push(true),
    });
    return { opener, isClosed: () => closed.length > 0 };
  }

  function statusResponse(clientStatus: string, extra: Record<string, unknown> = {}) {
    return {
      data: {
        status: {
          clientStatus: "Looking",
          trips: [
            {
              clientStatus,
              eta: null,
              etaToDestination: null,
              statusMessage: { title: "", detailMode: "" },
              driver: { name: "EVERTON", rating: 5 },
              vehicle: { licensePlate: "QPQ8I33", make: "Nissan", model: "Versa", colorTranslatedName: "Cinza" },
              ...extra,
            },
          ],
        },
      },
    };
  }

  test("link que não é da Uber é recusado", async () => {
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`, {
      link: "https://google.com",
      agreedAmount: 35,
    });
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
  });

  test("sem valor combinado e sem nenhum 'chama ?' recente: recusa pedindo o valor", async () => {
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`, {
      link: "https://trip.uber.com/QUAF2AH",
    });
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
    expect(json.needsAmount).toBe(true);
  });

  test("sem valor combinado, mas com um '25,00 chama ?' recente: acha sozinho", async () => {
    const fake = fakeConnections();
    const { opener } = fakeOpener([statusResponse("Looking")]);
    manager.stopAll();
    manager = new AccountManager({
      appDataDir: dirs.appDataDir,
      tempDir: dirs.tempDir,
      createConnection: fake.factory,
      notify: () => {},
      uberOpenStatusFetcher: opener,
    });
    connection = fake.created[0]!;
    connection.connected = true;

    await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/messages`, { text: "25,00 chama ?" });
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`, {
      link: "https://trip.uber.com/QUAF2AH",
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  test("GET começa sem acompanhamento nenhum", async () => {
    const { json } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`);
    expect(json.tracking).toBe(false);
  });

  test("GET /chats/uber-trips lista as corridas em andamento; POST sem link define o valor de uma corrida sem valor", async () => {
    const fake = fakeConnections();
    const { opener } = fakeOpener([statusResponse("ArrivingAtPickup", { eta: 400 })]);
    manager.stopAll();
    manager = new AccountManager({ appDataDir: dirs.appDataDir, tempDir: dirs.tempDir, createConnection: fake.factory, notify: () => {}, uberOpenStatusFetcher: opener });
    connection = fake.created[0]!;
    connection.connected = true;

    expect((await api("GET", "/accounts/default/chats/uber-trips")).json.trips).toEqual([]);

    // link mandado pelo celular, sem "chama ?": começa sem valor
    await connection.deliver(privateText(CLIENT, "https://trip.uber.com/QUAF2AH", { fromMe: true }));
    await wait(10);

    const { json } = await api("GET", "/accounts/default/chats/uber-trips");
    expect(json.trips).toMatchObject([{ chatJid: CLIENT, phone: "5511977770000", phase: "waiting_pickup", etaSeconds: 400, agreedAmountCents: null }]);

    const semValor = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`, { agreedAmount: "abc" });
    expect(semValor.status).toBe(400);

    const definido = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`, { agreedAmount: "35,00" });
    expect(definido.status).toBe(200);
    const { json: depois } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`);
    expect(depois.trip).toMatchObject({ agreedAmountCents: 3500 });
  });

  test("com o assistente de corrida desligado nas configurações, recusa com 409", async () => {
    manager.get("default")!.settings.update({ rideAssistantEnabled: false });
    const { status, json } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`, {
      link: "https://trip.uber.com/QUAF2AH",
      agreedAmount: 35,
    });
    expect(status).toBe(409);
    expect(json.error).toBeTruthy();
  });

  test("link válido: cobra a 2 min (com aviso), avisa quando chega e quando embarca", async () => {
    const fake = fakeConnections();
    const { opener } = fakeOpener([
      statusResponse("ArrivingAtPickup", { eta: 90 }),
      statusResponse("ArrivingAtPickup", { eta: 0 }),
      statusResponse("OnTrip"),
    ]);
    // a cobrança automática de verdade (a 2 min) precisa da MisticPay configurada e respondendo
    const misticFetch = (async (url: string, _init: RequestInit) => {
      const path = String(url).replace("https://api.misticpay.com/api", "");
      if (path === "/transactions/create") {
        return new Response(JSON.stringify({ data: { transactionId: "tx1", transactionState: "PENDENTE", copyPaste: "000201PIXtx1" } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    manager.stopAll(); // fecha a conta criada no beforeEach antes de trocar de manager (senão vaza o handle do sqlite dela)
    manager = new AccountManager({
      appDataDir: dirs.appDataDir,
      tempDir: dirs.tempDir,
      createConnection: fake.factory,
      notify: () => {},
      uberTripPollIntervalMs: 15,
      uberOpenStatusFetcher: opener,
      mistic: { fetch: misticFetch },
    });
    connection = fake.created[0]!;
    connection.connected = true;

    await api("PUT", "/accounts/default/mistic/config", {
      enabled: true,
      clientId: "ci_123",
      clientSecret: "cs_segredo_bem_grande_123",
      defaultPayerDocument: "52998224725",
    });

    const { status, json: postJson } = await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`, {
      link: "https://trip.uber.com/QUAF2AH",
      agreedAmount: 35,
    });
    expect(status).toBe(200);
    expect(postJson.ok).toBe(true);

    const { json: getJson } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`);
    expect(getJson.tracking).toBe(true);

    await wait(150);

    const texts = connection.sock.textsTo(CLIENT);
    expect(texts.some((t) => t.includes("5 minutos"))).toBe(true); // aviso do pagamento antecipado, a 2 min
    expect(texts.some((t) => t.toLowerCase().includes("chegou"))).toBe(true);
    expect(texts.some((t) => t.toLowerCase().includes("corrida iniciada"))).toBe(true);

    const account = manager.get("default")!;
    const charges = account.charges.list();
    expect(charges).toMatchObject([{ amountCents: 3500, chatJid: CLIENT }]);
  });

  test("gatilho configurado pra 'assim que mandar o link': cobra na hora, sem esperar o motorista se aproximar", async () => {
    const fake = fakeConnections();
    const { opener } = fakeOpener([statusResponse("Looking")]); // nunca chega nem perto — só prova que não precisava
    const misticFetch = (async (url: string, _init: RequestInit) => {
      const path = String(url).replace("https://api.misticpay.com/api", "");
      if (path === "/transactions/create") {
        return new Response(JSON.stringify({ data: { transactionId: "tx1", transactionState: "PENDENTE", copyPaste: "000201PIXtx1" } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    manager.stopAll();
    manager = new AccountManager({
      appDataDir: dirs.appDataDir,
      tempDir: dirs.tempDir,
      createConnection: fake.factory,
      notify: () => {},
      uberOpenStatusFetcher: opener,
      mistic: { fetch: misticFetch },
    });
    connection = fake.created[0]!;
    connection.connected = true;

    await api("PUT", "/accounts/default/mistic/config", {
      enabled: true,
      clientId: "ci_123",
      clientSecret: "cs_segredo_bem_grande_123",
      defaultPayerDocument: "52998224725",
    });
    await api("PUT", "/accounts/default/settings", { rideChargeTrigger: "on_link" });

    await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`, {
      link: "https://trip.uber.com/QUAF2AH",
      agreedAmount: 35,
    });

    const account = manager.get("default")!;
    expect(account.charges.list()).toMatchObject([{ amountCents: 3500, chatJid: CLIENT }]);
  });

  test("cobrança automática desligada: acompanha e avisa, mas não cria cobrança nenhuma", async () => {
    const fake = fakeConnections();
    const { opener } = fakeOpener([statusResponse("ArrivingAtPickup", { eta: 90 })]);
    manager.stopAll();
    manager = new AccountManager({
      appDataDir: dirs.appDataDir,
      tempDir: dirs.tempDir,
      createConnection: fake.factory,
      notify: () => {},
      uberTripPollIntervalMs: 15,
      uberOpenStatusFetcher: opener,
    });
    connection = fake.created[0]!;
    connection.connected = true;

    await api("PUT", "/accounts/default/settings", { rideAutoChargeEnabled: false });
    await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`, {
      link: "https://trip.uber.com/QUAF2AH",
      agreedAmount: 35,
    });
    await wait(60);

    const account = manager.get("default")!;
    expect(account.charges.list()).toEqual([]); // sem cobrança
    expect(connection.sock.textsTo(CLIENT).some((t) => t.includes("5 minutos"))).toBe(false); // e sem o aviso do pagamento
  });

  test("DELETE para de acompanhar", async () => {
    const fake = fakeConnections();
    const { opener, isClosed } = fakeOpener([statusResponse("Looking")]);
    manager.stopAll(); // fecha a conta criada no beforeEach antes de trocar de manager (senão vaza o handle do sqlite dela)
    manager = new AccountManager({
      appDataDir: dirs.appDataDir,
      tempDir: dirs.tempDir,
      createConnection: fake.factory,
      notify: () => {},
      uberTripPollIntervalMs: 15,
      uberOpenStatusFetcher: opener,
    });
    connection = fake.created[0]!;
    connection.connected = true;

    await api("POST", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`, {
      link: "https://trip.uber.com/QUAF2AH",
      agreedAmount: 35,
    });
    const { status } = await api("DELETE", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`);
    expect(status).toBe(200);
    expect(isClosed()).toBe(true);

    const { json } = await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/uber-trip`);
    expect(json.tracking).toBe(false);
  });
});

describe("Listas de conversas (pastas)", () => {
  test("cria, lista, adiciona/remove conversa e exclui a lista", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));

    const { status: createStatus, json: created } = await api("POST", "/accounts/default/folders", { name: "Clientes Premium" });
    expect(createStatus).toBe(200);
    expect(created.folder).toMatchObject({ name: "Clientes Premium" });
    const folderId = created.folder.id;

    expect((await api("GET", "/accounts/default/folders")).json.folders).toMatchObject([{ name: "Clientes Premium" }]);

    await api("POST", `/accounts/default/folders/${folderId}/chats`, { chatJid: CLIENT });
    expect((await api("GET", `/accounts/default/folders/${folderId}/chats`)).json.chats).toMatchObject([{ jid: CLIENT }]);
    expect((await api("GET", `/accounts/default/chats/${encodeURIComponent(CLIENT)}/folders`)).json.folderIds).toEqual([folderId]);

    await api("DELETE", `/accounts/default/folders/${folderId}/chats/${encodeURIComponent(CLIENT)}`);
    expect((await api("GET", `/accounts/default/folders/${folderId}/chats`)).json.chats).toEqual([]);

    const { status: delStatus, json: delJson } = await api("DELETE", `/accounts/default/folders/${folderId}`);
    expect(delStatus).toBe(200);
    expect(delJson).toEqual({ ok: true });
    expect((await api("GET", "/accounts/default/folders")).json.folders).toEqual([]);
  });

  test("criar lista sem nome é recusado", async () => {
    const { status, json } = await api("POST", "/accounts/default/folders", { name: "   " });
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
  });

  test("excluir lista inexistente dá 404", async () => {
    const { status } = await api("DELETE", "/accounts/default/folders/NAO_EXISTE");
    expect(status).toBe(404);
  });

  test("conversa enviada pra uma lista some da lista principal", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));
    expect((await api("GET", "/accounts/default/chats")).json.chats).toMatchObject([{ jid: CLIENT }]);

    const { json: created } = await api("POST", "/accounts/default/folders", { name: "Clientes Premium" });
    await api("POST", `/accounts/default/folders/${created.folder.id}/chats`, { chatJid: CLIENT });

    expect((await api("GET", "/accounts/default/chats")).json.chats).toEqual([]);
    expect((await api("GET", `/accounts/default/folders/${created.folder.id}/chats`)).json.chats).toMatchObject([{ jid: CLIENT }]);
  });
});

describe("Respostas rápidas (chips + variantes)", () => {
  test("começa vazio e desligado; salva e relê as configurações", async () => {
    const initial = await api("GET", "/accounts/default/chat-quick-replies");
    expect(initial.status).toBe(200);
    expect(initial.json).toMatchObject({ enabled: false, chipsSendOnClick: false, replyVariantAlsoSends: false, variants: [], chips: [] });

    const { status, json } = await api("PUT", "/accounts/default/chat-quick-replies", {
      enabled: true,
      chipsSendOnClick: true,
      replyVariantAlsoSends: true,
      variants: ["chama aqui", "pode chamar"],
      chips: [
        { label: "ok", type: "fixed", value: "ok" },
        { label: "Simular", type: "random" },
      ],
    });
    expect(status).toBe(200);
    expect(json.enabled).toBe(true);
    expect(json.variants).toEqual(["chama aqui", "pode chamar"]);
    expect(json.chips).toMatchObject([
      { label: "ok", type: "fixed", value: "ok" },
      { label: "Simular", type: "random", value: "" },
    ]);
    expect(json.chips[0].id).toBeTruthy();

    const reread = await api("GET", "/accounts/default/chat-quick-replies");
    expect(reread.json).toEqual(json);
  });

  test("atualização parcial não apaga o que não foi enviado", async () => {
    await api("PUT", "/accounts/default/chat-quick-replies", { variants: ["a", "b"] });
    const { json } = await api("PUT", "/accounts/default/chat-quick-replies", { enabled: true });
    expect(json).toMatchObject({ enabled: true, variants: ["a", "b"] });
  });
});
