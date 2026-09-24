import { describe, expect, test } from "bun:test";
import { ConversationTracker } from "./conversation-tracker";
import { RateLimiter } from "../services/mistic/rate-limiter";

const PHONE = "5511977770000";
const CHAT = `${PHONE}@s.whatsapp.net`;
const LID = "987654321@lid";

describe("conversas recentes", () => {
  test("registra e lista a mais recente primeiro", () => {
    const t = new ConversationTracker();
    t.touch({ chatJid: CHAT, jids: [CHAT], phone: PHONE, name: "Maria", from: "client", at: 1000 });
    t.touch({ chatJid: "5511966660000@s.whatsapp.net", jids: [], phone: "5511966660000", name: "João", from: "client", at: 2000 });

    expect(t.list().map((c) => c.name)).toEqual(["João", "Maria"]);
  });

  test("mensagem nova da mesma pessoa atualiza a conversa (não duplica)", () => {
    const t = new ConversationTracker();
    t.touch({ chatJid: CHAT, jids: [CHAT], phone: PHONE, name: "Maria", from: "client", at: 1000 });
    t.touch({ chatJid: CHAT, jids: [CHAT], phone: PHONE, name: null, from: "operator", at: 5000 });

    const [c, ...rest] = t.list();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ name: "Maria", lastActivityAt: 5000, lastFrom: "operator", phone: PHONE });
  });

  test("a mesma pessoa por LID e por telefone é uma conversa só", () => {
    const t = new ConversationTracker();
    t.touch({ chatJid: LID, jids: [LID], phone: null, name: "Maria", from: "client", at: 1000 });
    expect(t.list()[0]!.phone).toBeNull();

    // depois o telefone dela aparece (resolvido pelo WhatsApp)
    t.touch({ chatJid: LID, jids: [LID, CHAT], phone: PHONE, name: null, from: "client", at: 2000 });
    expect(t.list().length).toBe(1);
    expect(t.list()[0]).toMatchObject({ phone: PHONE, key: PHONE, name: "Maria" });

    // e uma mensagem sua pelo chat do telefone cai na mesma conversa
    t.touch({ chatJid: CHAT, jids: [CHAT], phone: PHONE, name: null, from: "operator", at: 3000 });
    expect(t.list().length).toBe(1);
    expect(t.list()[0]!.lastFrom).toBe("operator");
  });

  test("acha a conversa por qualquer JID conhecido", () => {
    const t = new ConversationTracker();
    t.touch({ chatJid: LID, jids: [LID, CHAT], phone: PHONE, name: "Maria", from: "client" });
    expect(t.find(CHAT)?.name).toBe("Maria");
    expect(t.find(`${PHONE}:12@s.whatsapp.net`)?.name).toBe("Maria");
    expect(t.find(LID)?.name).toBe("Maria");
    expect(t.find("5500000000000@s.whatsapp.net")).toBeUndefined();
  });

  test("mantém o nome conhecido quando a mensagem nova não traz nome", () => {
    const t = new ConversationTracker();
    t.touch({ chatJid: CHAT, jids: [], phone: PHONE, name: "Maria", from: "client" });
    t.touch({ chatJid: CHAT, jids: [], phone: PHONE, name: null, from: "operator" });
    expect(t.list()[0]!.name).toBe("Maria");
  });

  test("não passa do limite: descarta as mais antigas", () => {
    const t = new ConversationTracker(3);
    for (let i = 1; i <= 5; i++) {
      t.touch({ chatJid: `55119000000${i}@s.whatsapp.net`, jids: [], phone: `55119000000${i}`, name: `P${i}`, from: "client", at: i * 1000 });
    }
    expect(t.list().map((c) => c.name)).toEqual(["P5", "P4", "P3"]);
  });

  test("não expõe detalhes internos", () => {
    const t = new ConversationTracker();
    const c = t.touch({ chatJid: CHAT, jids: [], phone: PHONE, name: "Maria", from: "client" });
    expect("aliases" in c).toBe(false);
  });
});

describe("limitador de consultas", () => {
  test("deixa passar até o máximo e bloqueia depois", () => {
    const limiter = new RateLimiter(3, 1000);
    expect([limiter.tryAcquire(0), limiter.tryAcquire(10), limiter.tryAcquire(20), limiter.tryAcquire(30)]).toEqual([true, true, true, false]);
  });

  test("libera de novo quando a janela passa", () => {
    const limiter = new RateLimiter(2, 1000);
    limiter.tryAcquire(0);
    limiter.tryAcquire(100);
    expect(limiter.tryAcquire(500)).toBe(false);
    expect(limiter.tryAcquire(1001)).toBe(true); // a primeira saiu da janela
    expect(limiter.tryAcquire(1002)).toBe(false);
    expect(limiter.tryAcquire(1101)).toBe(true);
  });
});
