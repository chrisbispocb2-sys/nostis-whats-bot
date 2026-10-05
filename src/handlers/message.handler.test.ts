import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WAMessageStubType, type WAMessage as StubMessage } from "baileys-joss";
import { Account } from "../core/account";
import { DEFAULT_GREETING_MESSAGE } from "../core/keyword-store";
import {
  FakeConnection,
  fakeConnections,
  groupText,
  privateText,
  tempDirs,
} from "../testing/fakes";

const GUARD_MS = 80;
const GROUP = "120363000000000000@g.us";
const CLIENT = "5511977770000@s.whatsapp.net";
const CLIENT_LID = "987654321@lid";
const CLIENT_2 = "5511966660000@s.whatsapp.net";

const wait = (ms: number) => Bun.sleep(ms);

let dirs: ReturnType<typeof tempDirs>;
let account: Account;
let connection: FakeConnection;
let notifications: Array<{ title: string; body: string }>;
/** Mídia do chat: por padrão "baixa" um conteúdo de mentira; os testes de mídia trocam isso. */
let downloadMediaImpl: () => Promise<Buffer>;
/** Eventos de tempo real (onChatMessage) publicados durante o teste. */
let publishedRealtime: Array<{ accountId: string; message: ReturnType<Account["chats"]["listMessages"]>[number]; isNew: boolean }>;

beforeEach(() => {
  dirs = tempDirs();
  notifications = [];
  downloadMediaImpl = async () => Buffer.from("fake-media-bytes");
  publishedRealtime = [];
  const { factory, created } = fakeConnections();
  account = new Account(
    { id: "acc1", name: "WhatsApp Teste", createdAt: Date.now() },
    {
      appDataDir: dirs.appDataDir,
      tempDir: dirs.tempDir,
      createConnection: factory,
      notify: (title, body) => void notifications.push({ title, body }),
      guardTimeoutMs: () => GUARD_MS,
      greetingTiming: { quietWindowMs: 30, maxWaitMs: 300, typingDelayMs: () => 5 },
      chatDownloadMedia: () => downloadMediaImpl(),
      chatMediaRetryDelaysMs: [], // sem tentativa extra: os testes de falha não precisam esperar segundos de verdade
      onChatMessage: (accountId, message, isNew) => publishedRealtime.push({ accountId, message, isNew }),
    }
  );
  connection = created[0]!;
});

afterEach(() => {
  account.stop();
  dirs.cleanup();
});

function enableSecurity() {
  account.settings.update({ autoShutdownEnabled: true });
}

/** A segurança só conta quem foi chamado num grupo há pouco: simula esse gatilho (regra padrão "uber on"). */
async function callFromGroup(callerJid: string = CLIENT) {
  account.bot.setGroups([{ jid: GROUP, name: "Grupo Teste", hasPicture: false }]);
  account.bot.setGroupEnabled(GROUP, true);
  await connection.deliver(groupText(GROUP, callerJid, "uber on"));
}

describe("segurança no fluxo real de mensagens", () => {
  test("mensagem no privado de quem NUNCA foi chamada num grupo não inicia a contagem", async () => {
    enableSecurity();
    await connection.deliver(privateText(CLIENT, "Oi, tem carro?"));
    expect(account.guard.pendingCount).toBe(0);

    await wait(GUARD_MS + 60);
    expect(account.bot.active).toBe(true);
  });

  test("agradecimento no fim da conversa não reinicia a contagem", async () => {
    enableSecurity();
    await callFromGroup();
    notifications.length = 0; // limpa o aviso de "mensagem enviada no grupo" do callFromGroup
    await connection.deliver(privateText(CLIENT, "Oi, tem carro?"));
    await connection.deliver(privateText(CLIENT, "Já te atendo!", { fromMe: true }));
    expect(account.guard.pendingCount).toBe(0);

    // agradece no fim, sem ter sido chamada de novo no grupo
    await connection.deliver(privateText(CLIENT, "Show, muito obrigado!"));
    expect(account.guard.pendingCount).toBe(0);

    await wait(GUARD_MS + 60);
    expect(account.bot.active).toBe(true);
    expect(notifications).toEqual([]);
  });

  test("cliente escreve no privado e ninguém responde: o bot desliga e avisa", async () => {
    enableSecurity();
    await callFromGroup();
    notifications.length = 0; // limpa o aviso de "mensagem enviada no grupo" do callFromGroup
    await connection.deliver(privateText(CLIENT, "Oi, tem carro?"));
    expect(account.bot.active).toBe(true);

    await wait(GUARD_MS + 60);
    expect(account.bot.active).toBe(false);
    expect(account.lastAutoShutdown?.chatJid).toBe(CLIENT);
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.title).toContain("WhatsApp Teste");
  });

  test("você responde pelo celular a tempo: o bot continua ligado", async () => {
    enableSecurity();
    await callFromGroup();
    notifications.length = 0; // limpa o aviso de "mensagem enviada no grupo" do callFromGroup
    await connection.deliver(privateText(CLIENT, "Oi, tem carro?"));
    await wait(GUARD_MS / 3);
    await connection.deliver(privateText(CLIENT, "Tenho sim! Onde você está?", { fromMe: true }));

    await wait(GUARD_MS + 60);
    expect(account.bot.active).toBe(true);
    expect(notifications).toEqual([]);
  });

  test("mensagem do PRÓPRIO BOT no privado não conta como você ter respondido", async () => {
    enableSecurity();
    await callFromGroup();
    await connection.deliver(privateText(CLIENT, "Oi, tem carro?"));
    account.sent.mark("ID_DO_BOT");
    await connection.deliver(privateText(CLIENT, "Olá! Me envie os endereços", { fromMe: true, id: "ID_DO_BOT" }));

    await wait(GUARD_MS + 60);
    expect(account.bot.active).toBe(false);
  });

  test("com a segurança desligada (padrão) o bot nunca desliga sozinho", async () => {
    await connection.deliver(privateText(CLIENT, "Oi, tem carro?"));
    await wait(GUARD_MS + 60);
    expect(account.bot.active).toBe(true);
  });

  test("desligar o bot à mão cancela a contagem", async () => {
    enableSecurity();
    await callFromGroup();
    notifications.length = 0; // limpa o aviso de "mensagem enviada no grupo" do callFromGroup
    await connection.deliver(privateText(CLIENT, "Oi"));
    account.setBotActive(false);
    account.setBotActive(true);

    await wait(GUARD_MS + 60);
    expect(account.bot.active).toBe(true);
    expect(notifications).toEqual([]);
  });

  test("mensagem de grupo não inicia a contagem", async () => {
    enableSecurity();
    await connection.deliver(groupText(GROUP, CLIENT, "bom dia pessoal"));
    expect(account.guard.pendingCount).toBe(0);

    await wait(GUARD_MS + 60);
    expect(account.bot.active).toBe(true);
  });

  test("status, transmissão e canais não iniciam a contagem", async () => {
    enableSecurity();
    await connection.deliver(privateText("status@broadcast", "meu status"));
    await connection.deliver(privateText("123@newsletter", "novidade"));
    await connection.deliver(privateText("999@broadcast", "lista"));
    expect(account.guard.pendingCount).toBe(0);
  });

  test("banido não inicia a contagem", async () => {
    enableSecurity();
    account.bans.ban(CLIENT, "Fulano");
    await connection.deliver(privateText(CLIENT, "Oi"));
    expect(account.guard.pendingCount).toBe(0);
    // e o bot avisa que ele está banido
    expect(connection.sock.textsTo(CLIENT).length).toBe(1);
  });

  test("reação sua conta como presença; reação do cliente não inicia contagem", async () => {
    enableSecurity();
    await connection.deliver({
      key: { remoteJid: CLIENT, fromMe: false, id: "R1" },
      message: { reactionMessage: { text: "👍" } },
    } as never);
    expect(account.guard.pendingCount).toBe(0);

    await callFromGroup();
    await connection.deliver(privateText(CLIENT, "Oi"));
    expect(account.guard.pendingCount).toBe(1);
    await connection.deliver({
      key: { remoteJid: CLIENT, fromMe: true, id: "R2" },
      message: { reactionMessage: { text: "👍" } },
    } as never);
    expect(account.guard.pendingCount).toBe(0);
  });

  test("cliente por LID, você responde pelo chat do telefone: conta como respondido", async () => {
    enableSecurity();
    connection.sock.lidToPhone[CLIENT_LID] = CLIENT;
    await callFromGroup(CLIENT_LID);
    await connection.deliver(privateText(CLIENT_LID, "Oi", { alt: CLIENT }));
    expect(account.guard.pendingCount).toBe(1);

    await connection.deliver(privateText(CLIENT, "Olá!", { fromMe: true }));
    expect(account.guard.pendingCount).toBe(0);
  });

  test("cliente por LID sem remoteJidAlt: resolve pelo mapa do WhatsApp", async () => {
    enableSecurity();
    connection.sock.lidToPhone[CLIENT_LID] = CLIENT;
    await callFromGroup(CLIENT_LID);
    await connection.deliver(privateText(CLIENT_LID, "Oi"));
    await connection.deliver(privateText(CLIENT, "Olá!", { fromMe: true }));
    expect(account.guard.pendingCount).toBe(0);
  });

  test("resposta antiga (histórico sincronizado) não cancela a contagem", async () => {
    enableSecurity();
    await callFromGroup();
    const now = Math.floor(Date.now() / 1000) + 5;
    await connection.deliver(privateText(CLIENT, "Oi", { timestamp: now }));
    await connection.deliver(privateText(CLIENT, "mensagem de ontem", { fromMe: true, timestamp: now - 86_400 }));
    expect(account.guard.pendingCount).toBe(1);
  });

  test("duas conversas: responder só uma não salva o bot", async () => {
    enableSecurity();
    await callFromGroup(CLIENT);
    await callFromGroup(CLIENT_2);
    await connection.deliver(privateText(CLIENT, "Oi"));
    await connection.deliver(privateText(CLIENT_2, "Oi também"));
    await connection.deliver(privateText(CLIENT, "Já te atendo", { fromMe: true }));

    await wait(GUARD_MS + 60);
    expect(account.bot.active).toBe(false);
    expect(account.lastAutoShutdown?.chatJid).toBe(CLIENT_2);
  });

  test("o painel enxerga o estado da segurança", async () => {
    enableSecurity();
    expect(account.guardStatus()).toMatchObject({ enabled: true, minutes: 5, pending: 0, deadlineAt: null });

    await callFromGroup();
    await connection.deliver(privateText(CLIENT, "Oi"));
    const status = account.guardStatus();
    expect(status.pending).toBe(1);
    expect(status.deadlineAt).toBeGreaterThan(Date.now() - 1);
  });
});

describe("ignorar DDD em grupo", () => {
  test("DDD na lista e opção ligada: ignora por completo, nem responde no grupo", async () => {
    account.settings.update({ ignoreGroupDddsEnabled: true, ignoredGroupDdds: ["21"] });
    await callFromGroup("5521999990000@s.whatsapp.net"); // DDD 21
    expect(connection.sock.textsTo(GROUP)).toEqual([]);
  });

  test("DDD fora da lista: responde normalmente", async () => {
    account.settings.update({ ignoreGroupDddsEnabled: true, ignoredGroupDdds: ["21"] });
    await callFromGroup(CLIENT); // CLIENT é DDD 11
    expect(connection.sock.textsTo(GROUP).length).toBe(1);
  });

  test("DDD na lista mas a opção está desligada: responde normalmente", async () => {
    account.settings.update({ ignoreGroupDddsEnabled: false, ignoredGroupDdds: ["21"] });
    await callFromGroup("5521999990000@s.whatsapp.net");
    expect(connection.sock.textsTo(GROUP).length).toBe(1);
  });

  test("não mexe em mensagem de privado (só vale em grupo)", async () => {
    account.settings.update({ ignoreGroupDddsEnabled: true, ignoredGroupDdds: ["21"] });
    await connection.deliver(privateText("5521999990000@s.whatsapp.net", "Oi, tudo bem?"));
    const messages = account.chats.listMessages("5521999990000@s.whatsapp.net");
    expect(messages.length).toBe(1); // continua sendo gravada no histórico normalmente
  });
});

describe("recado automático", () => {
  beforeEach(() => {
    // O recado é enviado via account.sendPrivate(), que exige a conexão "ligada" (ao contrário da
    // saudação e das respostas de regra, que usam o sock recebido na própria mensagem, sempre disponível)
    connection.connected = true;
  });

  function enableAway(message?: string) {
    account.settings.update({ awayMessageEnabled: true, ...(message !== undefined ? { awayMessage: message } : {}) });
  }

  test("desligado (padrão): bot desligado não manda nada no privado", async () => {
    account.setBotActive(false);
    await connection.deliver(privateText(CLIENT, "Oi, tem carro?"));
    expect(connection.sock.textsTo(CLIENT)).toEqual([]);
  });

  test("ligado + bot desligado: manda o recado uma vez, mesmo insistindo", async () => {
    enableAway("Voltamos já, aguarde!");
    account.setBotActive(false);

    await connection.deliver(privateText(CLIENT, "Oi, tem carro?"));
    await connection.deliver(privateText(CLIENT, "Alguém aí?"));
    await connection.deliver(privateText(CLIENT, "???"));

    expect(connection.sock.textsTo(CLIENT)).toEqual(["Voltamos já, aguarde!"]);
  });

  test("sem mensagem configurada, usa a padrão", async () => {
    enableAway();
    account.setBotActive(false);
    await connection.deliver(privateText(CLIENT, "Oi"));
    expect(connection.sock.textsTo(CLIENT)[0]!.length).toBeGreaterThan(10);
  });

  test("ligado + bot LIGADO: não manda nada (é só para quando está desligado)", async () => {
    enableAway();
    await connection.deliver(privateText(CLIENT, "Oi, tem carro?"));
    expect(connection.sock.textsTo(CLIENT)).toEqual([]);
  });

  test("ligar o bot de novo rearma o recado: desligando outra vez, avisa de novo", async () => {
    enableAway("Voltamos já!");
    account.setBotActive(false);
    await connection.deliver(privateText(CLIENT, "Oi"));
    expect(connection.sock.textsTo(CLIENT)).toEqual(["Voltamos já!"]);

    account.setBotActive(true);
    account.setBotActive(false);
    await connection.deliver(privateText(CLIENT, "Oi de novo"));
    expect(connection.sock.textsTo(CLIENT)).toEqual(["Voltamos já!", "Voltamos já!"]);
  });

  test("cada cliente recebe o seu, mas só uma vez cada", async () => {
    enableAway("Voltamos já!");
    account.setBotActive(false);
    await connection.deliver(privateText(CLIENT, "Oi"));
    await connection.deliver(privateText(CLIENT_2, "Oi"));
    await connection.deliver(privateText(CLIENT, "De novo"));

    expect(connection.sock.textsTo(CLIENT)).toEqual(["Voltamos já!"]);
    expect(connection.sock.textsTo(CLIENT_2)).toEqual(["Voltamos já!"]);
  });

  test("número banido: só o aviso de banimento, nunca o recado", async () => {
    enableAway("Voltamos já!");
    account.setBotActive(false);
    account.bans.ban(CLIENT, "Fulano");
    await connection.deliver(privateText(CLIENT, "Oi"));
    expect(connection.sock.textsTo(CLIENT).length).toBe(1);
    expect(connection.sock.textsTo(CLIENT)).not.toContain("Voltamos já!");
  });

  test("número da lista \"sem resposta\" (operador) não recebe o recado", async () => {
    enableAway("Voltamos já!");
    account.settings.update({ noReplyNumbers: ["5511977770000"] });
    account.setBotActive(false);
    await connection.deliver(privateText(CLIENT, "Oi"));
    expect(connection.sock.textsTo(CLIENT)).toEqual([]);
  });

  test("cliente por LID: o alias por telefone também fica marcado (não manda duas vezes pela mesma pessoa)", async () => {
    enableAway("Voltamos já!");
    account.setBotActive(false);
    connection.sock.lidToPhone[CLIENT_LID] = CLIENT;
    await connection.deliver(privateText(CLIENT_LID, "Oi", { alt: CLIENT }));
    await connection.deliver(privateText(CLIENT_LID, "De novo", { alt: CLIENT }));
    expect(connection.sock.textsTo(CLIENT_LID)).toEqual(["Voltamos já!"]);
  });

  test("reação não conta como mensagem (não dispara o recado)", async () => {
    enableAway("Voltamos já!");
    account.setBotActive(false);
    await connection.deliver({
      key: { remoteJid: CLIENT, fromMe: false, id: "R1" },
      message: { reactionMessage: { text: "👍" } },
    } as never);
    expect(connection.sock.textsTo(CLIENT)).toEqual([]);
  });
});

describe("saudação + segurança juntas", () => {
  function setupGreetingRule() {
    account.bot.setGroups([{ jid: GROUP, name: "Grupo Teste", hasPicture: false }]);
    account.bot.setGroupEnabled(GROUP, true);
    // Toda conta nova já vem com a regra padrão "uber on"
    for (const rule of [...account.keywords.list()]) account.keywords.delete(rule.id);
    return account.keywords.create({
      keywords: ["uber on"],
      responses: ["pv"],
      greetingEnabled: true,
      greetingMessages: ["Olá! Me manda origem e destino"],
      replyToTrigger: false,
    });
  }

  test("cliente chama no grupo, escreve no privado e recebe a saudação; o eco dela NÃO cancela a segurança", async () => {
    setupGreetingRule();
    enableSecurity();

    await connection.deliver(groupText(GROUP, CLIENT, "uber on"));
    expect(connection.sock.textsTo(GROUP)).toEqual(["pv"]);

    await connection.deliver(privateText(CLIENT, "Oi, vim pelo grupo"));
    expect(account.guard.pendingCount).toBe(1);

    // a saudação sai depois da janela de silêncio
    await wait(30 + 5 + 25);
    expect(connection.sock.textsTo(CLIENT)).toEqual(["Olá! Me manda origem e destino"]);

    // o WhatsApp devolve a mensagem do bot como fromMe: não pode contar como resposta sua
    const echoId = connection.sock.sent.find((m) => m.jid === CLIENT)!.options!.messageId!;
    expect(account.sent.has(echoId)).toBe(true);
    await connection.deliver(privateText(CLIENT, "Olá! Me manda origem e destino", { fromMe: true, id: echoId }));
    expect(account.guard.pendingCount).toBe(1);

    // ninguém respondeu de verdade: o bot desliga
    await wait(GUARD_MS + 40);
    expect(account.bot.active).toBe(false);
  });

  test("você responde no privado antes da saudação: o bot não manda nada e a segurança é satisfeita", async () => {
    setupGreetingRule();
    enableSecurity();

    await connection.deliver(groupText(GROUP, CLIENT, "uber on"));
    await connection.deliver(privateText(CLIENT, "Oi"));
    await connection.deliver(privateText(CLIENT, "Pode falar!", { fromMe: true }));

    await wait(GUARD_MS + 60);
    expect(connection.sock.textsTo(CLIENT)).toEqual([]);
    expect(account.bot.active).toBe(true);
  });

  test("o bot responde no grupo com o nome da conta na notificação", async () => {
    setupGreetingRule();
    await connection.deliver(groupText(GROUP, CLIENT, "uber on"));
    await wait(30);

    expect(notifications.some((n) => n.title.startsWith("WhatsApp Teste"))).toBe(true);
  });

  test("padrão da saudação existe (regra sem mensagem própria)", () => {
    expect(DEFAULT_GREETING_MESSAGE.length).toBeGreaterThan(10);
  });
});

describe("métricas: cliente que chama direto no privado, sem gatilho de grupo", () => {
  test("mensagem privada sem nenhuma chamada no grupo entra nas métricas, sem grupo", async () => {
    await connection.deliver(privateText(CLIENT, "Oi, preciso de uma corrida", { pushName: "Maria Silva" }));

    const leads = account.leads.list();
    expect(leads.length).toBe(1);
    expect(leads[0]).toMatchObject({ groupJid: "", groupName: "", callerName: "Maria Silva", status: "pending", value: null });
    expect(leads[0]!.privateContactAt).not.toBeNull();
  });

  test("funciona mesmo com o bot DESLIGADO (só precisa da conta online)", async () => {
    account.setBotActive(false);
    await connection.deliver(privateText(CLIENT, "Oi, preciso de uma corrida"));
    expect(account.leads.list().length).toBe(1);
  });

  test("insistindo na mesma conversa não duplica a linha", async () => {
    await connection.deliver(privateText(CLIENT, "Oi"));
    await connection.deliver(privateText(CLIENT, "Alguém aí?"));
    await connection.deliver(privateText(CLIENT, "???"));
    expect(account.leads.list().length).toBe(1);
  });

  test("quem CHAMOU NO GRUPO (regra com métrica ligada) continua funcionando como antes, com o grupo preenchido", async () => {
    account.bot.setGroups([{ jid: GROUP, name: "Grupo Teste", hasPicture: false }]);
    account.bot.setGroupEnabled(GROUP, true);
    for (const rule of [...account.keywords.list()]) account.keywords.delete(rule.id);
    account.keywords.create({ keywords: ["uber on"], responses: ["pv"], trackMetrics: true });

    await connection.deliver(groupText(GROUP, CLIENT, "uber on"));
    await connection.deliver(privateText(CLIENT, "Oi, vim pelo grupo"));

    const leads = account.leads.list();
    expect(leads.length).toBe(1);
    expect(leads[0]!.groupName).toBe("Grupo Teste");
    expect(leads[0]!.privateContactAt).not.toBeNull();
  });

  test("número banido não entra nas métricas", async () => {
    account.bans.ban(CLIENT, "Fulano");
    await connection.deliver(privateText(CLIENT, "Oi"));
    expect(account.leads.list()).toEqual([]);
  });

  test("reação não conta como chamada (precisa ser mensagem de verdade)", async () => {
    await connection.deliver({
      key: { remoteJid: CLIENT, fromMe: false, id: "R1" },
      message: { reactionMessage: { text: "👍" } },
    } as never);
    expect(account.leads.list()).toEqual([]);
  });

  test("pessoas diferentes geram linhas separadas", async () => {
    await connection.deliver(privateText(CLIENT, "Oi"));
    await connection.deliver(privateText(CLIENT_2, "Oi também"));
    expect(account.leads.list().length).toBe(2);
  });

  test("depois de fechada, uma nova mensagem da mesma pessoa abre uma corrida nova", async () => {
    await connection.deliver(privateText(CLIENT, "Oi"));
    const [lead] = account.leads.list();
    account.leads.update(lead!.id, { status: "closed", value: 20 });

    await connection.deliver(privateText(CLIENT, "Oi, de novo"));
    expect(account.leads.list().length).toBe(2);
  });

  test("um pagamento pela MisticPay fecha a corrida e preenche o valor, mesmo sem grupo", async () => {
    await connection.deliver(privateText(CLIENT, "Oi, quanto custa até o centro?"));
    const [lead] = account.leads.list();

    // Simula o que o Account.onPaid faz quando a MisticPay confirma um pagamento (sem precisar de uma
    // cobrança de verdade aqui — isso já é coberto nos testes do serviço da MisticPay)
    account.leads.applyPayment({
      chargeId: "charge-teste",
      jids: [CLIENT],
      phone: "5511977770000",
      amountCents: 3290,
      paidAt: Date.now(),
      chargeCreatedAt: lead!.triggeredAt + 1000,
    });

    expect(account.leads.get(lead!.id)).toMatchObject({ status: "closed", value: 32.9, groupName: "" });
  });
});

describe("histórico de chat: tudo que acontece numa conversa fica salvo", () => {
  test("mensagem do cliente no privado entra no histórico", async () => {
    await connection.deliver(privateText(CLIENT, "Oi, preciso de uma corrida", { pushName: "Maria" }));

    const messages = account.chats.listMessages(CLIENT);
    expect(messages).toMatchObject([{ text: "Oi, preciso de uma corrida", fromMe: false, pushName: "Maria" }]);
  });

  test("sua resposta pelo celular entra como fromMe e NÃO fica marcada como mensagem do bot", async () => {
    await connection.deliver(privateText(CLIENT, "Oi"));
    await connection.deliver(privateText(CLIENT, "Já te atendo!", { fromMe: true }));

    const [last] = account.chats.listMessages(CLIENT);
    expect(last).toMatchObject({ text: "Já te atendo!", fromMe: true, isBot: false });
  });

  test("nome do contato na lista não vira o seu próprio nome quando você responde", async () => {
    await connection.deliver(privateText(CLIENT, "Oi, preciso de uma corrida", { pushName: "Maria" }));
    // o eco "fromMe" do WhatsApp traz o SEU pushName (o dono da conta), não o da Maria
    await connection.deliver(privateText(CLIENT, "Já te atendo!", { fromMe: true, pushName: "Dono Da Conta" }));

    const chat = account.chats.listChats().find((c) => c.jid === CLIENT);
    expect(chat?.name).toBe("Maria");
  });

  test("mensagem automática do bot entra no histórico marcada como isBot", async () => {
    connection.connected = true;
    account.settings.update({ awayMessageEnabled: true, awayMessage: "Voltamos já!" });
    account.setBotActive(false);
    await connection.deliver(privateText(CLIENT, "Oi, tem carro?"));

    // Assim como no WhatsApp de verdade, o envio do bot só entra no histórico quando o eco
    // "fromMe" volta pela conexão (o fake não devolve sozinho: simulamos como os outros testes já fazem).
    const echoId = connection.sock.sent.find((m) => m.jid === CLIENT)!.options!.messageId!;
    await connection.deliver(privateText(CLIENT, "Voltamos já!", { fromMe: true, id: echoId }));

    const [last] = account.chats.listMessages(CLIENT);
    expect(last).toMatchObject({ text: "Voltamos já!", fromMe: true, isBot: true });
  });

  test("mensagem de grupo é gravada mesmo com o bot desligado", async () => {
    account.setBotActive(false);
    account.bot.setGroups([{ jid: GROUP, name: "Grupo Teste", hasPicture: false }]);
    await connection.deliver(groupText(GROUP, CLIENT, "bom dia pessoal"));

    expect(account.chats.listMessages(GROUP)).toMatchObject([{ text: "bom dia pessoal", fromMe: false }]);
  });

  test("marcação em grupo (@número interno): vira o nome de quem foi marcado, ou o telefone se o nome não é conhecido", async () => {
    const OTHER = "5511966660000@s.whatsapp.net";
    account.bot.setGroups([{ jid: GROUP, name: "Grupo Teste", hasPicture: false }]);
    connection.connected = true;
    connection.sock.lidToPhone[CLIENT_LID] = CLIENT;
    connection.sock.lidToPhone["111222333444@lid"] = "5521988887777@s.whatsapp.net";

    await connection.deliver(groupText(GROUP, CLIENT, "bom dia", { pushName: "Maria" }));
    await connection.deliver(groupText(GROUP, OTHER, "bora @987654321 ?"));
    await connection.deliver(groupText(GROUP, OTHER, "e você @111222333444, e @555666777888?"));

    const texts = account.chats.listMessages(GROUP).map((m) => m.text);
    expect(texts).toContain("bora @~Maria ?");
    // sem nome conhecido: o telefone de verdade; sem conseguir descobrir de quem é: fica como veio
    expect(texts).toContain("e você @+55 21 98888-7777, e @555666777888?");
  });

  test("marcação gravada antes (só o número): é trocada pelo nome na hora de mostrar a conversa", async () => {
    account.bot.setGroups([{ jid: GROUP, name: "Grupo Teste", hasPicture: false }]);
    connection.sock.lidToPhone[CLIENT_LID] = CLIENT;

    // WhatsApp desconectado na hora: não dá pra descobrir de quem é a marcação, grava como veio
    await connection.deliver(groupText(GROUP, CLIENT, "bom dia", { pushName: "Maria" }));
    await connection.deliver(groupText(GROUP, "5511966660000@s.whatsapp.net", "bora @987654321 ?"));
    expect(account.chats.listMessages(GROUP).map((m) => m.text)).toContain("bora @987654321 ?");

    connection.connected = true;
    expect((await account.chats.listMessagesWithMentions(GROUP)).map((m) => m.text)).toContain("bora @~Maria ?");
  });

  test("aviso de remoção em que quem removeu vem só pelo número interno (LID): mostra o nome (ou o telefone) em vez de 'Alguém'", async () => {
    const ADMIN_LID = "150170008293498@lid";
    const ADMIN = "5538991539584@s.whatsapp.net";
    account.bot.setGroups([{ jid: GROUP, name: "Grupo Teste", hasPicture: false }]);
    connection.connected = true;
    connection.sock.lidToPhone[ADMIN_LID] = ADMIN;
    connection.sock.lidToPhone[CLIENT_LID] = CLIENT;

    const removal = () =>
      ({
        key: { remoteJid: GROUP, fromMe: false, id: `STUB${Math.random()}`, participant: ADMIN_LID },
        messageStubType: WAMessageStubType.GROUP_PARTICIPANT_REMOVE,
        messageStubParameters: [JSON.stringify({ id: CLIENT_LID })],
      }) as unknown as StubMessage;

    // ninguém escreveu ainda: sem nome, vale o telefone de verdade dos dois
    await connection.deliver(removal());
    expect(account.chats.listMessages(GROUP)[0]!.text).toBe("+55 38 99153-9584 removeu +55 11 97777-0000");

    // depois que escreveram no grupo, o nome do WhatsApp de cada um
    await connection.deliver(groupText(GROUP, ADMIN, "regras do grupo", { pushName: "ADM Ozy" }));
    await connection.deliver(groupText(GROUP, CLIENT, "oi", { pushName: "Maria" }));
    await connection.deliver(removal());
    expect(account.chats.listMessages(GROUP)[0]!.text).toBe("~ADM Ozy removeu ~Maria");
  });

  test("som de mensagem nova: segue a configuração desta conta, e conversa arquivada não toca", async () => {
    await connection.deliver(privateText(CLIENT, "oi"));
    expect(account.playsSoundFor(CLIENT)).toBe(true);

    account.chats.setArchived(CLIENT, true);
    expect(account.playsSoundFor(CLIENT)).toBe(false);
    account.chats.setArchived(CLIENT, false);

    account.settings.update({ notificationSoundEnabled: false });
    expect(account.playsSoundFor(CLIENT)).toBe(false);
    expect(account.playsSoundFor("5511900000000@s.whatsapp.net")).toBe(false);
  });

  test("mensagem de grupo é gravada mesmo com o grupo desabilitado", async () => {
    account.bot.setGroups([{ jid: GROUP, name: "Grupo Teste", hasPicture: false }]);
    account.bot.setGroupEnabled(GROUP, false);
    await connection.deliver(groupText(GROUP, CLIENT, "bom dia pessoal"));

    expect(account.chats.listMessages(GROUP).length).toBe(1);
  });

  test("você escrevendo direto num grupo (fromMe) também entra no histórico — não existia antes", async () => {
    await connection.deliver({
      key: { remoteJid: GROUP, fromMe: true, id: "OWN1" },
      message: { conversation: "Aviso do grupo" },
    } as never);

    expect(account.chats.listMessages(GROUP)).toMatchObject([{ text: "Aviso do grupo", fromMe: true }]);
  });

  test("reação fica anexada à mensagem que ela reagiu, não aparece como linha própria", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { id: "MSG_OI" }));
    await connection.deliver({
      key: { remoteJid: CLIENT, fromMe: false, id: "R1" },
      message: { reactionMessage: { text: "👍", key: { id: "MSG_OI" } } },
    } as never);

    const messages = account.chats.listMessages(CLIENT);
    expect(messages.length).toBe(1);
    expect(messages[0]).toMatchObject({ id: "MSG_OI", text: "Oi" });
    expect(messages[0]!.reactions).toEqual([{ emoji: "👍", fromMe: false, pushName: null }]);
  });

  test("reagir pelo painel: manda a reação de verdade pro WhatsApp e já aparece anexada na hora", async () => {
    connection.connected = true;
    await connection.deliver(privateText(CLIENT, "Oi", { id: "MSG_OI" }));

    const stored = await account.chats.reactToMessage(CLIENT, "MSG_OI", "👍");
    expect(stored).toMatchObject({ type: "reaction", reactionEmoji: "👍", reactionTargetId: "MSG_OI", fromMe: true });

    const sentContent = connection.sock.sent.find((m) => m.jid === CLIENT)?.content as any;
    expect(sentContent.react).toMatchObject({ text: "👍", key: { remoteJid: CLIENT, id: "MSG_OI", fromMe: false } });

    const [target] = account.chats.listMessages(CLIENT);
    expect(target!.reactions).toEqual([{ emoji: "👍", fromMe: true, pushName: null }]);
  });

  test("reagir com emoji vazio tira a reação (igual ao WhatsApp)", async () => {
    connection.connected = true;
    await connection.deliver(privateText(CLIENT, "Oi", { id: "MSG_OI" }));
    await account.chats.reactToMessage(CLIENT, "MSG_OI", "👍");

    await account.chats.reactToMessage(CLIENT, "MSG_OI", "");

    const [target] = account.chats.listMessages(CLIENT);
    expect(target!.reactions ?? []).toEqual([]);
  });

  test("reagir sem WhatsApp conectado dá erro e não grava nada", async () => {
    connection.connected = false;
    await connection.deliver(privateText(CLIENT, "Oi", { id: "MSG_OI" }));

    await expect(account.chats.reactToMessage(CLIENT, "MSG_OI", "👍")).rejects.toThrow();
    const [target] = account.chats.listMessages(CLIENT);
    expect(target!.reactions ?? []).toEqual([]);
  });

  test("mensagem de backlog (antes de o bot ligar) não dispara automação, mas ainda entra no histórico", async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 86_400;
    await connection.deliver(privateText(CLIENT, "mensagem de ontem", { timestamp: oldTimestamp }));

    expect(account.leads.list()).toEqual([]); // sem automação
    expect(account.chats.listMessages(CLIENT)).toMatchObject([{ text: "mensagem de ontem" }]); // mas no histórico
  });

  test("responder como operador pelo painel: envia e já aparece no histórico (otimista)", async () => {
    connection.connected = true;
    const sent = await account.chats.sendAsOperator(CLIENT, { text: "Olá! Já estou vendo." });

    expect(connection.sock.textsTo(CLIENT)).toEqual(["Olá! Já estou vendo."]);
    expect(account.sent.has(sent.id)).toBe(false); // não marcado como bot: o eco conta como resposta sua
    expect(account.chats.listMessages(CLIENT)).toMatchObject([{ text: "Olá! Já estou vendo.", fromMe: true }]);
  });

  describe("mídia (fotos, áudios, vídeos, documentos)", () => {
    test("foto recebida entra na hora sem arquivo, e ganha o arquivo quando o download termina", async () => {
      // download "lento" de propósito: dá tempo de ver o estado antes de terminar
      downloadMediaImpl = async () => {
        await wait(30);
        return Buffer.from("fake-media-bytes");
      };

      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "IMG1" },
        message: { imageMessage: { mimetype: "image/jpeg", caption: "Minha foto" } },
        pushName: "Maria",
      } as never);

      const [justArrived] = account.chats.listMessages(CLIENT);
      expect(justArrived).toMatchObject({ type: "image", text: "Minha foto", mediaFile: null });

      await wait(60); // o download roda em segundo plano (fire-and-forget)
      const [afterDownload] = account.chats.listMessages(CLIENT);
      expect(afterDownload!.mediaFile).toBeTruthy();
    });

    test("falha ao baixar a mídia não derruba nada: a mensagem fica registrada, marcada como falha (não fica 'baixando' pra sempre)", async () => {
      downloadMediaImpl = async () => {
        throw new Error("falha de rede simulada");
      };

      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "DOC1" },
        message: { documentMessage: { mimetype: "application/pdf", fileName: "contrato.pdf" } },
      } as never);

      await wait(20);
      const [doc] = account.chats.listMessages(CLIENT);
      expect(doc).toMatchObject({ type: "document", mediaFileName: "contrato.pdf", mediaFile: null, mediaDownloadFailed: true });
    });

    describe("varredura automática (retryAllFailedMedia): tenta de novo sozinho, sem precisar clicar mensagem por mensagem", () => {
      test("baixa de novo tudo que tinha falhado, em conversas diferentes, numa chamada só", async () => {
        downloadMediaImpl = async () => {
          throw new Error("falha de rede simulada");
        };
        await connection.deliver({ key: { remoteJid: CLIENT, fromMe: false, id: "STK1" }, message: { stickerMessage: { mimetype: "image/webp" } } } as never);
        await connection.deliver({ key: { remoteJid: CLIENT_2, fromMe: false, id: "STK2" }, message: { stickerMessage: { mimetype: "image/webp" } } } as never);
        await wait(20);
        expect(account.chats.listMessages(CLIENT)[0]).toMatchObject({ mediaDownloadFailed: true });
        expect(account.chats.listMessages(CLIENT_2)[0]).toMatchObject({ mediaDownloadFailed: true });

        connection.connected = true;
        downloadMediaImpl = async () => Buffer.from("figurinha-de-verdade");
        await account.chats.retryAllFailedMedia();

        expect(account.chats.listMessages(CLIENT)[0]).toMatchObject({ mediaDownloadFailed: false });
        expect(account.chats.listMessages(CLIENT)[0]!.mediaFile).toBeTruthy();
        expect(account.chats.listMessages(CLIENT_2)[0]).toMatchObject({ mediaDownloadFailed: false });
        expect(account.chats.listMessages(CLIENT_2)[0]!.mediaFile).toBeTruthy();
      });

      test("sem WhatsApp conectado: não tenta nada (e não lança erro)", async () => {
        downloadMediaImpl = async () => {
          throw new Error("falha de rede simulada");
        };
        await connection.deliver({ key: { remoteJid: CLIENT, fromMe: false, id: "STK1" }, message: { stickerMessage: { mimetype: "image/webp" } } } as never);
        await wait(20);

        connection.connected = false;
        await expect(account.chats.retryAllFailedMedia()).resolves.toBeUndefined();
        expect(account.chats.listMessages(CLIENT)[0]).toMatchObject({ mediaDownloadFailed: true, mediaFile: null });
      });

      test("continua falhando: a mídia segue marcada como falha, pra tentar de novo na próxima varredura", async () => {
        downloadMediaImpl = async () => {
          throw new Error("falha de rede simulada");
        };
        await connection.deliver({ key: { remoteJid: CLIENT, fromMe: false, id: "STK1" }, message: { stickerMessage: { mimetype: "image/webp" } } } as never);
        await wait(20);

        connection.connected = true;
        await account.chats.retryAllFailedMedia();
        expect(account.chats.listMessages(CLIENT)[0]).toMatchObject({ mediaDownloadFailed: true, mediaFile: null });
      });

      test("falha persistente (ex.: DNS fora do ar por horas): depois de algumas varreduras, para de tentar sozinha", async () => {
        let attempts = 0;
        downloadMediaImpl = async () => {
          attempts++;
          throw new Error("getaddrinfo ENOTFOUND a.whatsapp.net");
        };
        await connection.deliver({ key: { remoteJid: CLIENT, fromMe: false, id: "STK1" }, message: { stickerMessage: { mimetype: "image/webp" } } } as never);
        await wait(20);
        connection.connected = true;

        // bem mais varreduras do que o limite — teria tentado dezenas de vezes se não parasse sozinha
        for (let i = 0; i < 20; i++) await account.chats.retryAllFailedMedia();

        const attemptsAfterGivingUp = attempts;
        await account.chats.retryAllFailedMedia(); // mais uma: não deveria mexer em nada
        expect(attempts).toBe(attemptsAfterGivingUp);
        expect(account.chats.listMessages(CLIENT)[0]).toMatchObject({ mediaDownloadFailed: true, mediaFile: null });

        // mas "Tentar de novo" manual (não passa pela varredura) sempre funciona, sem limite
        downloadMediaImpl = async () => Buffer.from("figurinha-de-verdade");
        const retried = await account.chats.retryMediaDownload(CLIENT, "STK1");
        expect(retried.mediaFile).toBeTruthy();
      });

      test("mídia que já baixou não entra na varredura de novo", async () => {
        await connection.deliver({ key: { remoteJid: CLIENT, fromMe: false, id: "IMG1" }, message: { imageMessage: { mimetype: "image/jpeg" } } } as never);
        await wait(20);
        expect(account.chats.listMessages(CLIENT)[0]!.mediaFile).toBeTruthy();

        let calledAgain = false;
        downloadMediaImpl = async () => {
          calledAgain = true;
          return Buffer.from("não deveria ser chamado de novo");
        };
        connection.connected = true;
        await account.chats.retryAllFailedMedia();
        expect(calledAgain).toBe(false);
      });

      test("a própria conta tenta de novo sozinha, de tempos em tempos (varredura ligada em start())", async () => {
        downloadMediaImpl = async () => {
          throw new Error("falha de rede simulada");
        };
        const sweepAccount = new Account(
          { id: "acc-sweep", name: "WhatsApp Sweep", createdAt: Date.now() },
          {
            appDataDir: dirs.appDataDir,
            tempDir: dirs.tempDir,
            createConnection: fakeConnections().factory,
            chatDownloadMedia: () => downloadMediaImpl(),
            chatMediaRetryDelaysMs: [],
            chatMediaRetrySweepMs: 15,
          }
        );
        try {
          const sweepConnection = (sweepAccount as unknown as { connection: FakeConnection }).connection;
          await sweepConnection.deliver({ key: { remoteJid: CLIENT, fromMe: false, id: "STK1" }, message: { stickerMessage: { mimetype: "image/webp" } } } as never);
          await wait(10);
          expect(sweepAccount.chats.listMessages(CLIENT)[0]).toMatchObject({ mediaDownloadFailed: true });

          await sweepAccount.start();
          sweepConnection.connected = true;
          downloadMediaImpl = async () => Buffer.from("figurinha-de-verdade");

          await wait(40); // a varredura (a cada 15ms) já deve ter rodado sozinha
          expect(sweepAccount.chats.listMessages(CLIENT)[0]!.mediaFile).toBeTruthy();
        } finally {
          sweepAccount.stop();
        }
      });
    });

    test("falha só na primeira tentativa: tenta de novo e consegue (não perde a mídia por uma falha passageira)", async () => {
      let attempts = 0;
      downloadMediaImpl = async () => {
        attempts++;
        if (attempts === 1) throw new Error("falha de rede passageira");
        return Buffer.from("fake-media-bytes");
      };

      // essa conta específica usa um tempo de verdade (ainda que bem curto) entre as tentativas,
      // pra provar que o mecanismo de "tentar de novo" funciona, não só que zero tentativas falha
      const retryAccount = new Account(
        { id: "acc-retry", name: "WhatsApp Retry", createdAt: Date.now() },
        {
          appDataDir: dirs.appDataDir,
          tempDir: dirs.tempDir,
          createConnection: fakeConnections().factory,
          chatDownloadMedia: () => downloadMediaImpl(),
          chatMediaRetryDelaysMs: [15],
        }
      );
      try {
        const retryConnection = (retryAccount as unknown as { connection: FakeConnection }).connection;
        await retryConnection.deliver({
          key: { remoteJid: CLIENT, fromMe: false, id: "IMG_RETRY" },
          message: { imageMessage: { mimetype: "image/jpeg" } },
        } as never);

        expect(retryAccount.chats.listMessages(CLIENT)[0]).toMatchObject({ mediaFile: null, mediaDownloadFailed: false });
        await wait(60);
        expect(retryAccount.chats.listMessages(CLIENT)[0]).toMatchObject({ mediaDownloadFailed: false });
        expect(retryAccount.chats.listMessages(CLIENT)[0]!.mediaFile).toBeTruthy();
        expect(attempts).toBe(2);
      } finally {
        retryAccount.stop();
      }
    });

    test("desistiu de baixar a figurinha: 'tentar de novo' manual consegue baixar", async () => {
      downloadMediaImpl = async () => {
        throw new Error("falha de rede simulada");
      };

      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "STK1" },
        message: { stickerMessage: { mimetype: "image/webp" } },
      } as never);

      await wait(20);
      expect(account.chats.listMessages(CLIENT)[0]).toMatchObject({ mediaFile: null, mediaDownloadFailed: true });

      connection.connected = true;
      downloadMediaImpl = async () => Buffer.from("figurinha-de-verdade");
      const retried = await account.chats.retryMediaDownload(CLIENT, "STK1");

      expect(retried).toMatchObject({ mediaDownloadFailed: false });
      expect(retried.mediaFile).toBeTruthy();
    });

    test("'tentar de novo' sem WhatsApp conectado dá erro claro (e não mexe no estado)", async () => {
      downloadMediaImpl = async () => {
        throw new Error("falha de rede simulada");
      };
      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "STK2" },
        message: { stickerMessage: { mimetype: "image/webp" } },
      } as never);
      await wait(20);

      connection.connected = false;
      await expect(account.chats.retryMediaDownload(CLIENT, "STK2")).rejects.toThrow("desconectado");
      expect(account.chats.listMessages(CLIENT)[0]).toMatchObject({ mediaDownloadFailed: true, mediaFile: null });
    });

    test("responder com uma foto pelo painel: envia pro WhatsApp, grava o arquivo e some no histórico", async () => {
      connection.connected = true;
      const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

      const sent = await account.chats.sendAsOperator(CLIENT, {
        text: "Olha a foto",
        media: { type: "image", dataBase64: tinyPng, mimeType: "image/png" },
      });

      expect(sent).toMatchObject({ type: "image", text: "Olha a foto", fromMe: true });
      expect(sent.mediaFile).toBeTruthy();

      const sentContent = connection.sock.sent.find((m) => m.jid === CLIENT)?.content as any;
      expect(Buffer.isBuffer(sentContent.image)).toBe(true);
      expect(sentContent.caption).toBe("Olha a foto");
    });

    test("responder com uma figurinha pelo painel: envia como sticker, não como imagem", async () => {
      connection.connected = true;
      const tinyWebp = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

      const sent = await account.chats.sendAsOperator(CLIENT, {
        media: { type: "sticker", dataBase64: tinyWebp, mimeType: "image/webp" },
      });

      expect(sent).toMatchObject({ type: "sticker", fromMe: true });
      const sentContent = connection.sock.sent.find((m) => m.jid === CLIENT)?.content as any;
      expect(Buffer.isBuffer(sentContent.sticker)).toBe(true);
    });
  });

  describe("tempo real (onChatMessage): o painel aberto é avisado sem precisar esperar o próximo ciclo", () => {
    test("avisa quando uma mensagem do cliente chega", async () => {
      await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));
      expect(publishedRealtime).toMatchObject([{ accountId: "acc1", message: { text: "Oi", fromMe: false } }]);
    });

    test("avisa quando você responde pelo painel", async () => {
      connection.connected = true;
      await account.chats.sendAsOperator(CLIENT, { text: "Já te atendo" });
      expect(publishedRealtime.some((p) => p.message.text === "Já te atendo" && p.message.fromMe === true)).toBe(true);
    });

    test("avisa de novo quando a mídia termina de baixar (mesma mensagem, agora com arquivo)", async () => {
      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "IMG1" },
        message: { imageMessage: { mimetype: "image/jpeg" } },
      } as never);
      await wait(20);

      const mediaEvents = publishedRealtime.filter((p) => p.message.id === "IMG1");
      expect(mediaEvents.length).toBe(2); // uma na hora (sem arquivo), outra quando o download termina
      expect(mediaEvents[0]!.message.mediaFile).toBeNull();
      expect(mediaEvents[1]!.message.mediaFile).toBeTruthy();
    });

    // O painel toca o som em todo evento com isNew: tudo que é atualização de mensagem antiga tem
    // que vir com isNew=false, senão toca "mensagem nova" sem mensagem nenhuma ter chegado.
    test("só a chegada da mensagem é 'nova': a mídia terminando de baixar é atualização (não toca o som de novo)", async () => {
      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "IMG1" },
        message: { imageMessage: { mimetype: "image/jpeg" } },
      } as never);
      await wait(20);

      expect(publishedRealtime.filter((p) => p.message.id === "IMG1").map((p) => p.isNew)).toEqual([true, false]);
    });

    test("mídia que falhou e a nova tentativa automática (varredura) são atualizações, nunca 'mensagem nova'", async () => {
      connection.connected = true;
      downloadMediaImpl = async () => {
        throw new Error("falha de rede simulada");
      };
      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "IMG1" },
        message: { imageMessage: { mimetype: "image/jpeg" } },
      } as never);
      await wait(20);
      publishedRealtime.length = 0;

      await account.chats.retryAllFailedMedia(); // o que roda sozinho de tempos em tempos

      const events = publishedRealtime.filter((p) => p.message.id === "IMG1");
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((p) => p.isNew === false)).toBe(true);
    });

    test("a mesma mensagem reentregue pelo WhatsApp não é 'nova' de novo, nem conta duas vezes como não lida", async () => {
      await connection.deliver(privateText(CLIENT, "Oi", { id: "M1" }));
      await connection.deliver(privateText(CLIENT, "Oi", { id: "M1" }));

      expect(publishedRealtime.filter((p) => p.message.id === "M1").map((p) => p.isNew)).toEqual([true, false]);
      expect(account.chats.listChats()[0]!.unreadCount).toBe(1);
    });

    test("mensagem apagada por quem mandou e status de entrega são atualizações", async () => {
      connection.connected = true;
      await connection.deliver(privateText(CLIENT, "Será apagada", { id: "M1" }));
      const sent = await account.chats.sendAsOperator(CLIENT, { text: "Oi!" });
      publishedRealtime.length = 0;

      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "R1" },
        message: { protocolMessage: { type: 0, key: { remoteJid: CLIENT, id: "M1", fromMe: false } } },
      } as never);
      connection.deliverStatus(CLIENT, sent.id, 3);

      expect(publishedRealtime.length).toBe(2);
      expect(publishedRealtime.every((p) => p.isNew === false)).toBe(true);
    });

    test("aviso de grupo ('adicionou'): entra no histórico como aviso de sistema com os nomes, sem contar como não lida nem como mensagem 'de alguém'", async () => {
      const XX = "5512988087430@s.whatsapp.net";
      const ISABELLI = "5511942412694@s.whatsapp.net";
      await connection.deliver(groupText(GROUP, XX, "bom dia", { pushName: "Xx" })); // o nome do Xx já é conhecido pelo histórico
      account.chats.markRead(GROUP);

      await connection.deliver({
        key: { remoteJid: GROUP, fromMe: false, id: "STUB1", participant: XX },
        messageStubType: 27, // GROUP_PARTICIPANT_ADD
        messageStubParameters: [JSON.stringify({ id: "222222222222@lid", phoneNumber: ISABELLI })],
      } as never);

      const [aviso] = account.chats.listMessages(GROUP);
      expect(aviso).toMatchObject({ id: "STUB1", type: "system", text: "~Xx adicionou +55 11 94241-2694", fromMe: false, pushName: null });
      expect(account.chats.listChats()[0]).toMatchObject({ unreadCount: 0, lastMessagePreview: "~Xx adicionou +55 11 94241-2694" });
    });

    test("mensagem de grupo também avisa, com o accountId certo", async () => {
      await connection.deliver(groupText(GROUP, CLIENT, "bom dia pessoal"));
      expect(publishedRealtime).toMatchObject([{ accountId: "acc1", message: { chatJid: GROUP, text: "bom dia pessoal" } }]);
    });
  });

  describe("citação, status de entrega e não lidas", () => {
    test("mensagem que cita outra ganha uma prévia (quotedPreview) com o que foi citado", async () => {
      await connection.deliver(privateText(CLIENT, "Qual o endereço?", { id: "PERGUNTA", pushName: "Maria" }));
      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "RESPOSTA" },
        message: { extendedTextMessage: { text: "Rua Um, 123", contextInfo: { stanzaId: "PERGUNTA" } } },
        pushName: "Maria",
      } as never);

      const [resposta] = account.chats.listMessages(CLIENT);
      expect(resposta).toMatchObject({ id: "RESPOSTA", text: "Rua Um, 123" });
      expect(resposta!.quotedPreview).toMatchObject({ id: "PERGUNTA", text: "Qual o endereço?", fromMe: false });
    });

    test("citação de mensagem que não existe mais no histórico vem como null (não quebra nada)", async () => {
      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "RESPOSTA" },
        message: { extendedTextMessage: { text: "Rua Um, 123", contextInfo: { stanzaId: "NUNCA_EXISTIU" } } },
      } as never);

      const [resposta] = account.chats.listMessages(CLIENT);
      expect(resposta!.quotedPreview).toBeNull();
    });

    test("status de entrega: o WhatsApp avisando que a mensagem chegou/foi lida atualiza o histórico e avisa em tempo real", async () => {
      connection.connected = true;
      const sent = await account.chats.sendAsOperator(CLIENT, { text: "Oi!" });

      connection.deliverStatus(CLIENT, sent.id, 3); // DELIVERY_ACK
      expect(account.chats.listMessages(CLIENT)[0]).toMatchObject({ id: sent.id, status: "delivered" });

      connection.deliverStatus(CLIENT, sent.id, 4); // READ
      expect(account.chats.listMessages(CLIENT)[0]).toMatchObject({ id: sent.id, status: "read" });

      const statusEvents = publishedRealtime.filter((p) => p.message.id === sent.id && p.message.status != null);
      expect(statusEvents.map((p) => p.message.status)).toEqual(["delivered", "read"]);
    });

    test("status de uma mensagem que não está no histórico não faz nada (nem avisa em tempo real)", () => {
      publishedRealtime.length = 0;
      connection.deliverStatus(CLIENT, "NAO_EXISTE", 4);
      expect(publishedRealtime).toEqual([]);
    });

    test("não lidas: conta mensagens do cliente e markRead zera", async () => {
      await connection.deliver(privateText(CLIENT, "Oi"));
      await connection.deliver(privateText(CLIENT, "Alguém aí?"));

      expect(account.chats.listChats()[0]!.unreadCount).toBe(2);

      account.chats.markRead(CLIENT);
      expect(account.chats.listChats()[0]!.unreadCount).toBe(0);
    });
  });

  describe("fixar, arquivar, apagar, revogar e encaminhar", () => {
    test("fixar e arquivar refletem em listChats/listArchivedChats", async () => {
      await connection.deliver(privateText(CLIENT, "Oi"));
      account.chats.setPinned(CLIENT, true);
      expect(account.chats.listChats()[0]!.pinnedAt).not.toBeNull();

      account.chats.setArchived(CLIENT, true);
      expect(account.chats.listChats()).toEqual([]);
      expect(account.chats.listArchivedChats().map((c) => c.jid)).toEqual([CLIENT]);
    });

    test("responder (quotedId) marca a citação e manda o 'quoted' pro WhatsApp", async () => {
      connection.connected = true;
      await connection.deliver(privateText(CLIENT, "Qual o endereço?", { id: "PERGUNTA", pushName: "Maria" }));

      const sent = await account.chats.sendAsOperator(CLIENT, { text: "Rua Um, 123", quotedId: "PERGUNTA" });
      expect(sent.quotedId).toBe("PERGUNTA");

      const call = connection.sock.sent.find((m) => m.jid === CLIENT && m.content.text === "Rua Um, 123");
      expect((call?.options as any)?.quoted?.key?.id).toBe("PERGUNTA");
    });

    test("apagar para mim remove do histórico e avisa em tempo real", async () => {
      await connection.deliver(privateText(CLIENT, "Oi", { id: "M1" }));
      expect(account.chats.deleteForMe(CLIENT, "M1")).toBe(true);
      expect(account.chats.listMessages(CLIENT)).toEqual([]);
    });

    test("apagar para mim de mensagem inexistente devolve false", () => {
      expect(account.chats.deleteForMe(CLIENT, "NAO_EXISTE")).toBe(false);
    });

    test("apagar para todos: só funciona pra mensagem sua, avisa o WhatsApp e vira 'revoked'", async () => {
      connection.connected = true;
      const sent = await account.chats.sendAsOperator(CLIENT, { text: "Ops, errei" });

      const updated = await account.chats.deleteForEveryone(CLIENT, sent.id);
      expect(updated.type).toBe("revoked");

      const deleteCall = connection.sock.sent.find((m) => m.jid === CLIENT && (m.content as any).delete);
      expect((deleteCall!.content as any).delete).toMatchObject({ remoteJid: CLIENT, id: sent.id, fromMe: true });
    });

    test("apagar para todos uma mensagem do cliente é recusado", async () => {
      connection.connected = true;
      await connection.deliver(privateText(CLIENT, "Oi", { id: "M1" }));
      await expect(account.chats.deleteForEveryone(CLIENT, "M1")).rejects.toThrow();
    });

    test("alguém apaga a mensagem pra todos (revoke chegando de fora): vira 'revoked' aqui também", async () => {
      await connection.deliver(privateText(CLIENT, "Será apagada", { id: "M1" }));
      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "R1" },
        message: { protocolMessage: { type: 0, key: { remoteJid: CLIENT, id: "M1", fromMe: false } } },
      } as never);

      const [msg1] = account.chats.listMessages(CLIENT);
      expect(msg1).toMatchObject({ id: "M1", type: "revoked", text: null });
    });

    test("encaminhar texto pra outra conversa", async () => {
      connection.connected = true;
      await connection.deliver(privateText(CLIENT, "Olha isso", { id: "M1", pushName: "Maria" }));

      const forwarded = await account.chats.forwardMessage(CLIENT, "M1", CLIENT_2);
      expect(forwarded).toMatchObject({ chatJid: CLIENT_2, text: "Olha isso", fromMe: true });
      expect(connection.sock.textsTo(CLIENT_2)).toEqual(["Olha isso"]);
    });

    test("encaminhar uma reação (não dá pra encaminhar) é recusado com erro claro", async () => {
      connection.connected = true;
      await connection.deliver(privateText(CLIENT, "Oi", { id: "M1" }));
      await connection.deliver({
        key: { remoteJid: CLIENT, fromMe: false, id: "R1" },
        message: { reactionMessage: { text: "👍", key: { id: "M1" } } },
      } as never);

      await expect(account.chats.forwardMessage(CLIENT, "R1", CLIENT_2)).rejects.toThrow();
    });
  });
});

describe("assistente de corrida: detecta o link mandado direto do celular (sem passar pelo painel)", () => {
  function fakeUberFetcher() {
    const closed: boolean[] = [];
    return {
      fetchStatus: async () => ({ data: { status: { clientStatus: "Looking", trips: [] } } }),
      close: () => closed.push(true),
    };
  }

  /** Conta própria: o painel manda o link por uma rota HTTP à parte, mas aqui simulamos a mensagem chegando pelo celular (eco do socket), sem passar por ela. */
  function makeRideAccount() {
    const rideAccount = new Account(
      { id: "acc-ride", name: "WhatsApp Corrida", createdAt: Date.now() },
      {
        appDataDir: dirs.appDataDir,
        tempDir: dirs.tempDir,
        createConnection: fakeConnections().factory,
        uberOpenStatusFetcher: async () => fakeUberFetcher(),
      }
    );
    const rideConnection = (rideAccount as unknown as { connection: FakeConnection }).connection;
    rideConnection.connected = true;
    return { rideAccount, rideConnection };
  }

  test("link da Uber mandado do celular (fromMe, sem o bot ter enviado) começa a acompanhar sozinho", async () => {
    const { rideAccount, rideConnection } = makeRideAccount();
    try {
      rideAccount.settings.update({ rideAssistantEnabled: true });
      await rideConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1" }));
      await rideConnection.deliver(privateText(CLIENT, "Chamei, olha o motorista: https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
      await wait(10); // startTracking é assíncrono (abre a "torneira" de leituras antes de marcar como acompanhando)

      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(true);
    } finally {
      rideAccount.stop();
    }
  });

  test("assistente de corrida desligado: não começa a acompanhar", async () => {
    const { rideAccount, rideConnection } = makeRideAccount();
    try {
      rideAccount.settings.update({ rideAssistantEnabled: false }); // padrão é ligado — desliga explicitamente pra este teste
      await rideConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1" }));
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
      await wait(10);

      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(false);
    } finally {
      rideAccount.stop();
    }
  });

  test("link pelo celular sem nenhum 'NN,NN chama ?' recente: acompanha e avisa o cliente, mas sem cobrar — e avisa você", async () => {
    const { rideAccount, rideConnection } = makeRideAccount();
    try {
      rideAccount.settings.update({ rideAssistantEnabled: true });
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
      await wait(10);

      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(true);
      expect(rideAccount.uberTrips.status(CLIENT)).toMatchObject({ agreedAmountCents: null });
      const selfTexts = rideConnection.sock.textsTo("5511900000000@s.whatsapp.net");
      expect(selfTexts.length).toBe(1);
      expect(selfTexts[0]).toContain("sem cobrar");
    } finally {
      rideAccount.stop();
    }
  });

  test("link mandado PELO PAINEL sem valor: quem pergunta o valor é o painel — o eco do WhatsApp não começa nada nem avisa você", async () => {
    const { rideAccount, rideConnection } = makeRideAccount();
    try {
      const sent = await rideAccount.chats.sendAsOperator(CLIENT, { text: "https://trip.uber.com/ABC123" });
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: sent.id }));
      await wait(10);

      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(false);
      expect(rideConnection.sock.textsTo("5511900000000@s.whatsapp.net")).toEqual([]);
    } finally {
      rideAccount.stop();
    }
  });

  test("mensagem enviada PELO BOT (automação) com um link não dispara o acompanhamento automático", async () => {
    const { rideAccount, rideConnection } = makeRideAccount();
    try {
      rideAccount.settings.update({ rideAssistantEnabled: true });
      await rideConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1" }));
      rideAccount.sent.mark("LINK1");
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
      await wait(10);

      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(false);
    } finally {
      rideAccount.stop();
    }
  });

  test("já estava acompanhando essa conversa: o link de novo não reinicia o acompanhamento", async () => {
    const { rideAccount, rideConnection } = makeRideAccount();
    try {
      rideAccount.settings.update({ rideAssistantEnabled: true });
      await rideConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1" }));
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
      await wait(10);
      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(true);

      // o painel (ou o próprio celular, de novo) manda o mesmo link: continua acompanhando normalmente, sem erro
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK2" }));
      await wait(10);
      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(true);
    } finally {
      rideAccount.stop();
    }
  });

  // O próprio número do bot (ver fakes.ts) — uma falha silenciosa do navegador/rede antes não avisava
  // ninguém: o cliente nunca era avisado nem cobrado e o motorista nem ficava sabendo.
  const OWN_JID = "5511900000000@s.whatsapp.net";

  test("falha ao ABRIR o navegador pra acompanhar a corrida: avisa você mesmo no WhatsApp", async () => {
    const rideAccount = new Account(
      { id: "acc-ride-fail-open", name: "WhatsApp Corrida", createdAt: Date.now() },
      {
        appDataDir: dirs.appDataDir,
        tempDir: dirs.tempDir,
        createConnection: fakeConnections().factory,
        uberOpenStatusFetcher: async () => {
          throw new Error("Nenhum navegador encontrado");
        },
      }
    );
    const rideConnection = (rideAccount as unknown as { connection: FakeConnection }).connection;
    rideConnection.connected = true;
    try {
      rideAccount.settings.update({ rideAssistantEnabled: true });
      await rideConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1" }));
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
      await wait(10);

      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(false);
      const selfTexts = rideConnection.sock.textsTo(OWN_JID);
      expect(selfTexts.length).toBe(1);
      expect(selfTexts[0]).toContain("Não consegui começar a acompanhar");
    } finally {
      rideAccount.stop();
    }
  });

  test("desiste depois de falhar várias vezes seguidas consultando a Uber: avisa você mesmo no WhatsApp", async () => {
    const rideAccount = new Account(
      { id: "acc-ride-give-up", name: "WhatsApp Corrida", createdAt: Date.now() },
      {
        appDataDir: dirs.appDataDir,
        tempDir: dirs.tempDir,
        createConnection: fakeConnections().factory,
        uberTripPollIntervalMs: 5,
        uberOpenStatusFetcher: async () => ({
          fetchStatus: async () => {
            throw new Error("Falha ao consultar a Uber");
          },
          close: () => {},
        }),
      }
    );
    const rideConnection = (rideAccount as unknown as { connection: FakeConnection }).connection;
    rideConnection.connected = true;
    try {
      rideAccount.settings.update({ rideAssistantEnabled: true });
      await rideConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1" }));
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
      await wait(10);
      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(true); // começou, só falha nas leituras seguintes

      await wait(200); // tempo suficiente pra bater o limite de falhas seguidas (5 leituras a cada 5ms)

      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(false);
      const selfTexts = rideConnection.sock.textsTo(OWN_JID);
      expect(selfTexts.length).toBe(1);
      expect(selfTexts[0]).toContain("Não consegui acompanhar automaticamente a corrida");
    } finally {
      rideAccount.stop();
    }
  });

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  test("link de corrida antiga reentregue pelo WhatsApp (histórico ao reconectar) não abre acompanhamento", async () => {
    const { rideAccount, rideConnection } = makeRideAccount();
    try {
      await rideConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1" }));
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/VELHO1", { fromMe: true, id: "LINK1", timestamp: nowSeconds() - 3600 }));
      await wait(10);

      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(false);
    } finally {
      rideAccount.stop();
    }
  });

  test("'chama ?' de outro dia não vale como valor da corrida de agora (não cobra o valor errado sozinho)", async () => {
    const { rideAccount, rideConnection } = makeRideAccount();
    try {
      await rideConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1", timestamp: nowSeconds() - 2 * 24 * 3600 }));
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
      await wait(10);

      // acompanha (pra avisar o cliente), mas sem valor: não cobra nada sozinho
      expect(rideAccount.uberTrips.status(CLIENT)).toMatchObject({ agreedAmountCents: null });
    } finally {
      rideAccount.stop();
    }
  });

  test("fechar e abrir o programa: a corrida guardada é retomada quando o WhatsApp conecta", async () => {
    const options = {
      appDataDir: dirs.appDataDir,
      tempDir: dirs.tempDir,
      uberResumeCheckMs: 5,
      uberOpenStatusFetcher: async () => ({ fetchStatus: async () => ({ data: { status: { clientStatus: "Looking", trips: [] } } }), close: () => {} }),
    };
    const meta = { id: "acc-ride-restart", name: "WhatsApp Corrida", createdAt: Date.now() };

    const first = new Account(meta, { ...options, createConnection: fakeConnections().factory });
    const firstConnection = (first as unknown as { connection: FakeConnection }).connection;
    firstConnection.connected = true;
    await firstConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1" }));
    await firstConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
    await wait(10);
    expect(first.uberTrips.isTracking(CLIENT)).toBe(true);
    first.stop(); // programa fechou no meio da corrida

    const second = new Account(meta, { ...options, createConnection: fakeConnections().factory });
    const secondConnection = (second as unknown as { connection: FakeConnection }).connection;
    try {
      void second.start();
      await wait(30);
      expect(second.uberTrips.isTracking(CLIENT)).toBe(false); // WhatsApp ainda não conectou: espera

      secondConnection.connected = true;
      await wait(40);
      expect(second.uberTrips.status(CLIENT)).toMatchObject({ agreedAmountCents: 2500 });
    } finally {
      second.stop();
    }
  });

  test("avisos da corrida usam o texto das Configurações; sem os dados do carro quando a opção está desligada", async () => {
    const rideAccount = new Account(
      { id: "acc-ride-custom-text", name: "WhatsApp Corrida", createdAt: Date.now() },
      {
        appDataDir: dirs.appDataDir,
        tempDir: dirs.tempDir,
        createConnection: fakeConnections().factory,
        uberOpenStatusFetcher: async () => ({
          fetchStatus: async () => ({
            data: {
              status: {
                clientStatus: "Looking",
                trips: [{ clientStatus: "ArrivingAtPickup", eta: 0, driver: { name: "EVERTON" }, vehicle: { licensePlate: "QPQ8I33", make: "Nissan", model: "Versa", colorTranslatedName: "Cinza" } }],
              },
            },
          }),
          close: () => {},
        }),
      }
    );
    const rideConnection = (rideAccount as unknown as { connection: FakeConnection }).connection;
    rideConnection.connected = true;
    try {
      rideAccount.settings.update({ rideAutoChargeEnabled: false, rideArrivedMessage: "Chegou! Pode descer 😊", rideVehicleDetailsEnabled: false });
      await rideConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1" }));
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
      await wait(30);

      // pulou direto pra "chegou": só o aviso atual, com o seu texto
      expect(rideConnection.sock.textsTo(CLIENT)).toEqual(["Chegou! Pode descer 😊"]);
    } finally {
      rideAccount.stop();
    }
  });

  test("link DIFERENTE na mesma conversa (pediu outro carro) troca o acompanhamento pra corrida nova", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const rideAccount = new Account(
      { id: "acc-ride-swap", name: "WhatsApp Corrida", createdAt: Date.now() },
      {
        appDataDir: dirs.appDataDir,
        tempDir: dirs.tempDir,
        createConnection: fakeConnections().factory,
        uberOpenStatusFetcher: async (token) => {
          opened.push(token);
          return { fetchStatus: async () => ({ data: { status: { clientStatus: "Looking", trips: [] } } }), close: () => closed.push(token) };
        },
      }
    );
    const rideConnection = (rideAccount as unknown as { connection: FakeConnection }).connection;
    rideConnection.connected = true;
    try {
      await rideConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1" }));
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
      await wait(10);
      await rideConnection.deliver(privateText(CLIENT, "cancelou, pedi outro: https://trip.uber.com/XYZ789", { fromMe: true, id: "LINK2" }));
      await wait(10);

      expect(opened).toEqual(["ABC123", "XYZ789"]);
      expect(closed).toEqual(["ABC123"]);
      expect(rideAccount.uberTrips.isTracking(CLIENT)).toBe(true);
    } finally {
      rideAccount.stop();
    }
  });

  test("aviso de 2 min leva carro, placa e motorista; cobrança automática que falha avisa você mesmo", async () => {
    const rideAccount = new Account(
      { id: "acc-ride-details", name: "WhatsApp Corrida", createdAt: Date.now() },
      {
        appDataDir: dirs.appDataDir,
        tempDir: dirs.tempDir,
        createConnection: fakeConnections().factory,
        uberOpenStatusFetcher: async () => ({
          fetchStatus: async () => ({
            data: {
              status: {
                clientStatus: "Looking",
                trips: [
                  {
                    clientStatus: "ArrivingAtPickup",
                    eta: 90,
                    etaToDestination: 900,
                    statusMessage: { title: "", detailMode: "" },
                    driver: { name: "EVERTON", rating: 5 },
                    vehicle: { licensePlate: "QPQ8I33", make: "Nissan", model: "Versa", colorTranslatedName: "Cinza" },
                  },
                ],
              },
            },
          }),
          close: () => {},
        }),
      }
    );
    const rideConnection = (rideAccount as unknown as { connection: FakeConnection }).connection;
    rideConnection.connected = true;
    try {
      // MisticPay não configurada nesta conta: a cobrança automática vai falhar
      await rideConnection.deliver(privateText(CLIENT, "25,00 chama ?", { fromMe: true, id: "CHAMA1" }));
      await rideConnection.deliver(privateText(CLIENT, "https://trip.uber.com/ABC123", { fromMe: true, id: "LINK1" }));
      await wait(50);

      const clientTexts = rideConnection.sock.textsTo(CLIENT);
      expect(clientTexts[0]).toBe("🚗 Seu motorista está chegando, mais ou menos 2 minutinhos!\nCinza Nissan Versa · placa QPQ8I33 · motorista Everton");

      const selfTexts = rideConnection.sock.textsTo(OWN_JID);
      expect(selfTexts.length).toBe(1);
      expect(selfTexts[0]).toContain("Não consegui gerar a cobrança automática de R$ 25,00");
    } finally {
      rideAccount.stop();
    }
  });
});
