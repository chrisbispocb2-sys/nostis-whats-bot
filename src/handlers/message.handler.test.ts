import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

beforeEach(() => {
  dirs = tempDirs();
  notifications = [];
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

describe("segurança no fluxo real de mensagens", () => {
  test("cliente escreve no privado e ninguém responde: o bot desliga e avisa", async () => {
    enableSecurity();
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
    await connection.deliver(privateText(CLIENT, "Oi, tem carro?"));
    await wait(GUARD_MS / 3);
    await connection.deliver(privateText(CLIENT, "Tenho sim! Onde você está?", { fromMe: true }));

    await wait(GUARD_MS + 60);
    expect(account.bot.active).toBe(true);
    expect(notifications).toEqual([]);
  });

  test("mensagem do PRÓPRIO BOT no privado não conta como você ter respondido", async () => {
    enableSecurity();
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
    await connection.deliver(privateText(CLIENT_LID, "Oi", { alt: CLIENT }));
    expect(account.guard.pendingCount).toBe(1);

    await connection.deliver(privateText(CLIENT, "Olá!", { fromMe: true }));
    expect(account.guard.pendingCount).toBe(0);
  });

  test("cliente por LID sem remoteJidAlt: resolve pelo mapa do WhatsApp", async () => {
    enableSecurity();
    connection.sock.lidToPhone[CLIENT_LID] = CLIENT;
    await connection.deliver(privateText(CLIENT_LID, "Oi"));
    await connection.deliver(privateText(CLIENT, "Olá!", { fromMe: true }));
    expect(account.guard.pendingCount).toBe(0);
  });

  test("resposta antiga (histórico sincronizado) não cancela a contagem", async () => {
    enableSecurity();
    const now = Math.floor(Date.now() / 1000) + 5;
    await connection.deliver(privateText(CLIENT, "Oi", { timestamp: now }));
    await connection.deliver(privateText(CLIENT, "mensagem de ontem", { fromMe: true, timestamp: now - 86_400 }));
    expect(account.guard.pendingCount).toBe(1);
  });

  test("duas conversas: responder só uma não salva o bot", async () => {
    enableSecurity();
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

    await connection.deliver(privateText(CLIENT, "Oi"));
    const status = account.guardStatus();
    expect(status.pending).toBe(1);
    expect(status.deadlineAt).toBeGreaterThan(Date.now() - 1);
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
