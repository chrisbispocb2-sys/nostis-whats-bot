import { beforeEach, describe, expect, test } from "bun:test";
import type { WAMessage, WASocket } from "baileys-joss";
import {
  DEFAULT_GREETING_MESSAGE,
  type KeywordRule,
} from "../core/keyword-store";
import { GreetingService, type GreetingTiming } from "./greeting.service";

// Sem disco nem WhatsApp: as regras e o estado do bot são falsos e o socket só anota o que "enviou".
const rules = new Map<string, Partial<KeywordRule>>();
const bot = { active: true };
let markedAsSent: string[];

const deps = {
  getRule: (id: string) => rules.get(id) as KeywordRule | undefined,
  isBotActive: () => bot.active,
  markSent: (id: string) => void markedAsSent.push(id),
};

const PHONE = "5511999990000@s.whatsapp.net";
const LID = "123456789@lid";
const FAST: GreetingTiming = { quietWindowMs: 30, maxWaitMs: 300, typingDelayMs: () => 5 };

let sent: Array<{ jid: string; text: string; messageId?: string }>;
let sock: WASocket;

function text(body: string): WAMessage {
  return { key: { remoteJid: PHONE, fromMe: false }, message: { conversation: body } } as WAMessage;
}

function raw(message: object): WAMessage {
  return { key: { remoteJid: PHONE, fromMe: false }, message } as WAMessage;
}

function newService(timing = FAST) {
  return new GreetingService(deps, timing);
}

const wait = (ms: number) => Bun.sleep(ms);

/** O que foi enviado, sem o ID da mensagem. */
function texts() {
  return sent.map(({ jid, text }) => ({ jid, text }));
}

beforeEach(() => {
  sent = [];
  markedAsSent = [];
  bot.active = true;
  rules.clear();
  rules.set("r1", {
    id: "r1",
    enabled: true,
    greetingEnabled: true,
    greetingMessages: ["ASK"],
    greetingPartialMessages: ["PARTIAL"],
    greetingCompleteMessages: ["DONE"],
  });
  sock = {
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid: string, content: { text: string }, options?: { messageId?: string }) => {
      sent.push({ jid, text: content.text, messageId: options?.messageId });
    },
  } as unknown as WASocket;
});

describe("saudação no privado", () => {
  test("cliente que chega sem endereço: pergunta origem e destino", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi! Vim pelo grupo e quero ser atendido"), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([{ jid: PHONE, text: "ASK" }]);
  });

  test("cliente que já manda os dois endereços em mensagens seguidas: não pergunta de novo", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Rua das Flores, 123"), PHONE, [PHONE]);
    await wait(10);
    svc.handlePrivateMessage(sock, text("Av. Brasil, 500"), PHONE, [PHONE]);
    await wait(150);
    expect(texts()).toEqual([{ jid: PHONE, text: "DONE" }]);
  });

  test("cliente que manda os dois endereços numa mensagem só", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Rua A, 10 para Rua B, 20"), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([{ jid: PHONE, text: "DONE" }]);
  });

  test("cliente que manda só um endereço: pede o que falta", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Estou na Rua das Flores, 123"), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([{ jid: PHONE, text: "PARTIAL" }]);
  });

  test("localização do WhatsApp conta como endereço", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, raw({ locationMessage: { degreesLatitude: -23.5, degreesLongitude: -46.6 } }), PHONE, [PHONE]);
    await wait(10);
    svc.handlePrivateMessage(sock, text("Vou pro shopping"), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([{ jid: PHONE, text: "DONE" }]);
  });

  test("áudio: o bot não consegue ler, então não pergunta de novo", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, raw({ audioMessage: { ptt: true } }), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([{ jid: PHONE, text: "DONE" }]);
  });

  test("usa a mensagem padrão quando a regra não tem uma própria", async () => {
    rules.set("r1", { id: "r1", enabled: true, greetingEnabled: true, greetingMessages: [], greetingPartialMessages: [], greetingCompleteMessages: [] });
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([{ jid: PHONE, text: DEFAULT_GREETING_MESSAGE }]);
  });

  test("varias mensagens: o teto de espera impede de esperar pra sempre", async () => {
    const svc = new GreetingService(deps, { quietWindowMs: 60, maxWaitMs: 100, typingDelayMs: () => 5 });
    svc.registerTrigger([PHONE], "r1");
    // Uma mensagem a cada 40ms (sempre dentro da janela de silêncio) por 200ms
    for (let i = 0; i < 5; i++) {
      svc.handlePrivateMessage(sock, text("oi"), PHONE, [PHONE]);
      await wait(40);
    }
    await wait(60);
    expect(sent.length).toBe(1);
  });

  test("manda uma vez só, mesmo com o cliente continuando a escrever depois", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(120);
    svc.handlePrivateMessage(sock, text("Rua A, 10"), PHONE, [PHONE]);
    svc.handlePrivateMessage(sock, text("Rua B, 20"), PHONE, [PHONE]);
    await wait(120);
    expect(sent.length).toBe(1);
  });

  test("registra o ID da saudação como enviada pelo bot (não é uma resposta sua)", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(120);
    expect(sent[0]!.messageId).toBeTruthy();
    expect(markedAsSent).toEqual([sent[0]!.messageId!]);
  });
});

describe("quando o bot NÃO deve saudar", () => {
  test("pessoa que nunca chamou no grupo", async () => {
    const svc = newService();
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([]);
  });

  test("regra com a saudação desligada", async () => {
    rules.set("r1", { ...rules.get("r1"), greetingEnabled: false });
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([]);
  });

  test("saudação desligada no meio da espera", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    rules.set("r1", { ...rules.get("r1"), greetingEnabled: false });
    await wait(120);
    expect(texts()).toEqual([]);
  });

  test("regra inativa", async () => {
    rules.set("r1", { ...rules.get("r1"), enabled: false });
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([]);
  });

  test("bot desligado", async () => {
    bot.active = false;
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([]);
  });

  test("regra que foi apagada depois do gatilho", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    rules.delete("r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([]);
  });

  test("você respondeu antes do fim da espera", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(10);
    svc.cancelForChat([PHONE]);
    await wait(150);
    expect(texts()).toEqual([]);
  });

  test("você respondeu enquanto o bot 'digitava'", async () => {
    const svc = new GreetingService(deps, { quietWindowMs: 30, maxWaitMs: 300, typingDelayMs: () => 100 });
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(60); // a espera acabou e o bot está "digitando"
    svc.cancelForChat([PHONE]);
    await wait(150);
    expect(texts()).toEqual([]);
  });

  test("resposta sua em outra conversa não cancela esta", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    svc.cancelForChat(["5511888880000@s.whatsapp.net"]);
    await wait(120);
    expect(sent.length).toBe(1);
  });

  test("mensagem que não é conversa (reação, protocolo) não inicia a espera", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, raw({ reactionMessage: { text: "👍" } }), PHONE, [PHONE]);
    svc.handlePrivateMessage(sock, raw({ protocolMessage: {} }), PHONE, [PHONE]);
    await wait(120);
    expect(texts()).toEqual([]);

    // e o gatilho continua valendo para a primeira mensagem de verdade
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(120);
    expect(sent.length).toBe(1);
  });

  test("não saúda de novo a mesma pessoa em seguida (cooldown)", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(120);
    expect(sent.length).toBe(1);

    // chama de novo no grupo e escreve no privado, mas ainda está no meio da conversa
    svc.registerTrigger([PHONE], "r1");
    svc.handlePrivateMessage(sock, text("de novo"), PHONE, [PHONE]);
    await wait(120);
    expect(sent.length).toBe(1);
  });
});

describe("identidade (telefone x LID)", () => {
  test("chamou no grupo com LID + telefone e escreveu no privado pelo LID", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE, LID], "r1");
    svc.handlePrivateMessage(sock, { key: { remoteJid: LID, fromMe: false }, message: { conversation: "Oi" } } as WAMessage, LID, [LID]);
    await wait(120);
    expect(texts()).toEqual([{ jid: LID, text: "ASK" }]);
  });

  test("dispositivo no JID (:12) não atrapalha", async () => {
    const svc = newService();
    svc.registerTrigger(["5511999990000:12@s.whatsapp.net"], "r1");
    svc.handlePrivateMessage(sock, text("Oi"), PHONE, [PHONE]);
    await wait(120);
    expect(sent.length).toBe(1);
  });

  test("responde pelo chat certo mesmo quando a resposta sua vem pelo outro JID", async () => {
    const svc = newService();
    svc.registerTrigger([PHONE, LID], "r1");
    svc.handlePrivateMessage(sock, { key: { remoteJid: LID, fromMe: false }, message: { conversation: "Oi" } } as WAMessage, LID, [PHONE, LID]);
    await wait(10);
    svc.cancelForChat([PHONE]); // você respondeu e o WhatsApp entregou o evento com o telefone
    await wait(150);
    expect(texts()).toEqual([]);
  });
});
