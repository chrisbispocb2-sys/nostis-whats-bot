import { describe, expect, test } from "bun:test";
import { ChatRealtime } from "./chat-realtime";
import type { ChatMessageRecord } from "./chat-store";

function fakeSocket() {
  const sent: string[] = [];
  return { sent, send: (data: string) => sent.push(data) } as unknown as { sent: string[]; send(data: string): void };
}

function fakeMessage(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    chatJid: "5511977770000@s.whatsapp.net",
    id: "M1",
    senderJid: null,
    fromMe: false,
    isBot: false,
    pushName: null,
    type: "text",
    text: "Oi",
    mediaFile: null,
    mediaMimeType: null,
    mediaFileName: null,
    mediaSeconds: null,
    mediaDownloadFailed: false,
    isPtt: false,
    quotedId: null,
    reactionEmoji: null,
    reactionTargetId: null,
    status: null,
    timestamp: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("ChatRealtime", () => {
  test("publica só pra quem está conectado na mesma conta", () => {
    const rt = new ChatRealtime();
    const wsA1 = fakeSocket();
    const wsA2 = fakeSocket();
    const wsB1 = fakeSocket();
    rt.add("acc-a", wsA1 as never);
    rt.add("acc-a", wsA2 as never);
    rt.add("acc-b", wsB1 as never);

    rt.publish("acc-a", fakeMessage());

    expect(wsA1.sent.length).toBe(1);
    expect(wsA2.sent.length).toBe(1);
    expect(wsB1.sent.length).toBe(0);

    const payload = JSON.parse(wsA1.sent[0]!);
    expect(payload).toMatchObject({ type: "chat-message", message: { id: "M1", text: "Oi" } });
  });

  test("isNew vai junto no evento: só a mensagem que acabou de chegar toca o som no painel", () => {
    const rt = new ChatRealtime();
    const ws = fakeSocket();
    rt.add("acc-a", ws as never);

    rt.publish("acc-a", fakeMessage(), true); // chegou agora
    rt.publish("acc-a", fakeMessage()); // atualização da mesma mensagem (mídia baixada, status...)

    expect(ws.sent.map((raw) => JSON.parse(raw).isNew)).toEqual([true, false]);
  });

  test("publicar sem ninguém conectado não faz nada (nem lança erro)", () => {
    const rt = new ChatRealtime();
    expect(() => rt.publish("acc-sem-ninguem", fakeMessage())).not.toThrow();
  });

  test("remove tira o socket da lista (não recebe mais nada)", () => {
    const rt = new ChatRealtime();
    const ws = fakeSocket();
    rt.add("acc-a", ws as never);
    rt.remove("acc-a", ws as never);
    rt.publish("acc-a", fakeMessage());
    expect(ws.sent.length).toBe(0);
    expect(rt.countFor("acc-a")).toBe(0);
  });

  test("um socket que lança ao enviar não impede os outros de receber", () => {
    const rt = new ChatRealtime();
    const broken = {
      send: () => {
        throw new Error("socket morto");
      },
    };
    const ok = fakeSocket();
    rt.add("acc-a", broken as never);
    rt.add("acc-a", ok as never);

    expect(() => rt.publish("acc-a", fakeMessage())).not.toThrow();
    expect(ok.sent.length).toBe(1);
  });

  test("countFor reflete quantos sockets estão abertos por conta", () => {
    const rt = new ChatRealtime();
    expect(rt.countFor("acc-a")).toBe(0);
    rt.add("acc-a", fakeSocket() as never);
    rt.add("acc-a", fakeSocket() as never);
    expect(rt.countFor("acc-a")).toBe(2);
  });
});
