import { describe, expect, test, beforeEach } from "bun:test";
import { AwayMessageService } from "./away-message.service";

const CLIENT = "5511977770000@s.whatsapp.net";
const CLIENT_LID = "98765432100@lid";

let enabled: boolean;
let botActive: boolean;
let noReply: Set<string>;
let sent: Array<{ chatJid: string; text: string }>;
let failSending: boolean;
let svc: AwayMessageService;

beforeEach(() => {
  enabled = true;
  botActive = false;
  noReply = new Set();
  sent = [];
  failSending = false;
  svc = new AwayMessageService({
    isEnabled: () => enabled,
    isBotActive: () => botActive,
    message: () => "Voltamos já!",
    isNoReplyNumber: (phone) => noReply.has(phone),
    accountName: () => "Loja",
    send: async (chatJid, text) => {
      if (failSending) throw new Error("WhatsApp desconectado");
      sent.push({ chatJid, text });
    },
  });
});

describe("AwayMessageService", () => {
  test("desligado nas configurações: não manda nada", async () => {
    enabled = false;
    await svc.handlePrivateMessage(CLIENT, [CLIENT], "5511977770000");
    expect(sent).toEqual([]);
  });

  test("bot ativo: não manda nada (é só para quando está desligado)", async () => {
    botActive = true;
    await svc.handlePrivateMessage(CLIENT, [CLIENT], "5511977770000");
    expect(sent).toEqual([]);
  });

  test("manda uma vez; a segunda mensagem da mesma pessoa não gera outro envio", async () => {
    await svc.handlePrivateMessage(CLIENT, [CLIENT], "5511977770000");
    await svc.handlePrivateMessage(CLIENT, [CLIENT], "5511977770000");
    expect(sent).toEqual([{ chatJid: CLIENT, text: "Voltamos já!" }]);
  });

  test("qualquer alias (LID e telefone) da mesma pessoa conta como já avisada", async () => {
    await svc.handlePrivateMessage(CLIENT, [CLIENT, CLIENT_LID], "5511977770000");
    await svc.handlePrivateMessage(CLIENT_LID, [CLIENT_LID], null);
    expect(sent.length).toBe(1);
  });

  test("reset() rearma: depois dele, a mesma pessoa recebe de novo", async () => {
    await svc.handlePrivateMessage(CLIENT, [CLIENT], "5511977770000");
    svc.reset();
    await svc.handlePrivateMessage(CLIENT, [CLIENT], "5511977770000");
    expect(sent.length).toBe(2);
  });

  test("número da lista \"sem resposta\" não recebe", async () => {
    noReply.add("5511977770000");
    await svc.handlePrivateMessage(CLIENT, [CLIENT], "5511977770000");
    expect(sent).toEqual([]);
  });

  test("sem telefone (ex.: só LID) não é barrado pela checagem de \"sem resposta\"", async () => {
    await svc.handlePrivateMessage(CLIENT_LID, [CLIENT_LID], null);
    expect(sent.length).toBe(1);
  });

  test("falha ao enviar: não marca como avisada, tenta de novo na próxima mensagem", async () => {
    failSending = true;
    await svc.handlePrivateMessage(CLIENT, [CLIENT], "5511977770000");
    expect(sent).toEqual([]);

    failSending = false;
    await svc.handlePrivateMessage(CLIENT, [CLIENT], "5511977770000");
    expect(sent.length).toBe(1);
  });

  test("pessoas diferentes recebem cada uma a sua", async () => {
    await svc.handlePrivateMessage(CLIENT, [CLIENT], "5511977770000");
    await svc.handlePrivateMessage("5511900001111@s.whatsapp.net", ["5511900001111@s.whatsapp.net"], "5511900001111");
    expect(sent.length).toBe(2);
  });

  test("não estoura com muita gente diferente (limite de memória)", async () => {
    for (let i = 0; i < 1200; i++) {
      const jid = `55119${String(i).padStart(8, "0")}@s.whatsapp.net`;
      await svc.handlePrivateMessage(jid, [jid], null);
    }
    expect(sent.length).toBe(1200);
    // não deve lançar nem travar; um teste de memória seria demorado demais, então só confere que seguiu funcionando
    await svc.handlePrivateMessage(CLIENT, [CLIENT], null);
    expect(sent.length).toBe(1201);
  });
});
