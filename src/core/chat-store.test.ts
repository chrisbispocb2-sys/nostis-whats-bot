import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { ChatStore, type NewChatMessage } from "./chat-store";
import { tempDirs } from "../testing/fakes";

const CHAT = "5511977770000@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

let dirs: ReturnType<typeof tempDirs>;
let store: ChatStore;

beforeEach(() => {
  dirs = tempDirs();
  store = new ChatStore(join(dirs.appDataDir, "chat.db"));
});

afterEach(() => {
  store.close();
  dirs.cleanup();
});

function msg(overrides: Partial<NewChatMessage> = {}): NewChatMessage {
  return {
    chatJid: CHAT,
    id: "MSG1",
    senderJid: CHAT,
    fromMe: false,
    isBot: false,
    pushName: "Maria",
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
    ...overrides,
  };
}

describe("ChatStore", () => {
  test("mídia que já tinha gasto as tentativas automáticas ganha uma rodada nova, uma única vez por banco", () => {
    const file = join(dirs.appDataDir, "chat.db");
    store.recordMessage(msg({ id: "STK1", type: "sticker", text: null }), "Maria", { url: "https://a.whatsapp.net/x", directPath: "/v/x" });
    store.markMediaDownloadFailed(CHAT, "STK1");
    for (let i = 0; i < 5; i++) store.incrementMediaRetrySweepCount(CHAT, "STK1");
    expect(store.listFailedMediaMessages(5)).toEqual([]); // já desistiu
    store.close();

    // banco de antes dessa correção: ainda não passou pelo ajuste
    const raw = new Database(file);
    raw.run("PRAGMA user_version = 0");
    raw.close();

    store = new ChatStore(file);
    expect(store.listFailedMediaMessages(5)).toEqual([{ chatJid: CHAT, id: "STK1" }]);

    // gastou as tentativas de novo: reabrir não devolve mais uma rodada (o ajuste roda só uma vez)
    for (let i = 0; i < 5; i++) store.incrementMediaRetrySweepCount(CHAT, "STK1");
    store.close();
    store = new ChatStore(file);
    expect(store.listFailedMediaMessages(5)).toEqual([]);
  });

  test("grava e lê uma mensagem", () => {
    const stored = store.recordMessage(msg(), "Maria Silva");
    expect(stored.text).toBe("Oi");
    expect(stored.chatJid).toBe(CHAT);

    const [found] = store.listMessages(CHAT);
    expect(found).toMatchObject({ id: "MSG1", text: "Oi" });
  });

  test("mediaEnvelope: guarda e lê de volta, inclusive campos binários (Buffer/Uint8Array)", () => {
    const envelope = {
      mimetype: "image/webp",
      mediaKey: Buffer.from([1, 2, 3, 4]),
      fileEncSha256: new Uint8Array([9, 9, 9]),
      fileLength: 12345,
      url: "https://exemplo/media",
    };
    store.recordMessage(msg({ id: "M1", type: "sticker", text: null }), "Maria", envelope);

    const got = store.getMediaEnvelope(CHAT, "M1") as typeof envelope;
    expect(got.mimetype).toBe("image/webp");
    expect(got.url).toBe("https://exemplo/media");
    expect(Buffer.isBuffer(got.mediaKey)).toBe(true);
    expect((got.mediaKey as Buffer).equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(Buffer.isBuffer(got.fileEncSha256)).toBe(true);
    expect((got.fileEncSha256 as Buffer).equals(Buffer.from([9, 9, 9]))).toBe(true);
  });

  test("sem mediaEnvelope: getMediaEnvelope devolve null", () => {
    store.recordMessage(msg({ id: "M1" }), "Maria");
    expect(store.getMediaEnvelope(CHAT, "M1")).toBeNull();
  });

  test("markMediaDownloadFailed(chatJid, id, false) tira o estado de falha", () => {
    store.recordMessage(msg({ id: "M1", type: "document", mediaFile: null }), "Maria");
    store.markMediaDownloadFailed(CHAT, "M1");
    expect(store.getMessage(CHAT, "M1")).toMatchObject({ mediaDownloadFailed: true });

    store.markMediaDownloadFailed(CHAT, "M1", false);
    expect(store.getMessage(CHAT, "M1")).toMatchObject({ mediaDownloadFailed: false });
  });

  test("a mesma (chatJid, id) não duplica (dedupe pra reenvio otimista + eco real)", () => {
    store.recordMessage(msg({ id: "A1", text: "versão otimista" }), "Maria");
    store.recordMessage(msg({ id: "A1", text: "versão do eco (ignorada)" }), "Maria");

    const all = store.listMessages(CHAT);
    expect(all.length).toBe(1);
    expect(all[0]!.text).toBe("versão otimista");
  });

  test("listChats mostra a conversa com a prévia da última mensagem", () => {
    store.recordMessage(msg({ id: "A1", text: "Primeira", timestamp: 1000 }), "Maria");
    store.recordMessage(msg({ id: "A2", text: "Segunda", timestamp: 2000 }), "Maria");

    const [chat] = store.listChats();
    expect(chat).toMatchObject({ jid: CHAT, isGroup: false, name: "Maria", lastMessagePreview: "Segunda" });
  });

  test("listChats guarda quem mandou a última mensagem (pra mostrar '~Fulano: texto' no grupo)", () => {
    store.recordMessage(msg({ chatJid: GROUP, id: "G1", text: "bom dia", pushName: "Adm Soares", fromMe: false, timestamp: 1000 }), "Grupo Teste");
    let [chat] = store.listChats();
    expect(chat).toMatchObject({ lastMessageSenderName: "Adm Soares", lastMessageFromMe: false, lastMessagePreview: "bom dia" });

    store.recordMessage(msg({ chatJid: GROUP, id: "G2", text: "oi pessoal", pushName: "Minha Conta", fromMe: true, timestamp: 2000 }), "Grupo Teste");
    [chat] = store.listChats();
    expect(chat).toMatchObject({ lastMessageSenderName: "Minha Conta", lastMessageFromMe: true, lastMessagePreview: "oi pessoal" });
  });

  test("mensagem de backlog (mais antiga) não empurra o último-visto da conversa pra trás", () => {
    store.recordMessage(msg({ id: "NEW", text: "Mais nova", timestamp: 5000 }), "Maria");
    store.recordMessage(msg({ id: "OLD", text: "Backlog antigo", timestamp: 1000 }), "Maria");

    const [chat] = store.listChats();
    expect(chat!.lastMessagePreview).toBe("Mais nova");
    expect(chat!.lastMessageAt).toBe(5000);
  });

  test("grupo é marcado como isGroup e aparece com o nome do grupo", () => {
    store.recordMessage(msg({ chatJid: GROUP, id: "G1", text: "bom dia" }), "Grupo Teste");
    const [chat] = store.listChats();
    expect(chat).toMatchObject({ jid: GROUP, isGroup: true, name: "Grupo Teste" });
  });

  test("listMessages pagina por cursor (timestamp), mais recente primeiro", () => {
    for (let i = 1; i <= 5; i++) {
      store.recordMessage(msg({ id: `M${i}`, text: `msg ${i}`, timestamp: i * 1000 }), "Maria");
    }

    const firstPage = store.listMessages(CHAT, { limit: 2 });
    expect(firstPage.map((m) => m.id)).toEqual(["M5", "M4"]);

    const nextPage = store.listMessages(CHAT, { limit: 2, before: firstPage[1]!.timestamp });
    expect(nextPage.map((m) => m.id)).toEqual(["M3", "M2"]);
  });

  test("conversas sem nenhuma mensagem ainda não aparecem na lista", () => {
    store.touchChat(CHAT, false, "Maria");
    expect(store.listChats()).toEqual([]);
  });

  test("updateMediaFile preenche o arquivo depois que o download (assíncrono) termina", () => {
    store.recordMessage(msg({ id: "IMG1", type: "image", text: null, mediaMimeType: "image/jpeg" }), "Maria");
    expect(store.getMessage(CHAT, "IMG1")!.mediaFile).toBeNull();

    store.updateMediaFile(CHAT, "IMG1", "abc123.jpg");
    expect(store.getMessage(CHAT, "IMG1")!.mediaFile).toBe("abc123.jpg");
  });

  describe("não lidas", () => {
    test("mensagem de alguém conta como não lida; a sua própria não conta", () => {
      store.recordMessage(msg({ id: "A1" }), "Maria");
      store.recordMessage(msg({ id: "A2" }), "Maria");
      store.recordMessage(msg({ id: "A3", fromMe: true }), "Maria");

      expect(store.listChats()[0]!.unreadCount).toBe(2);
    });

    test("markRead zera o contador", () => {
      store.recordMessage(msg({ id: "A1" }), "Maria");
      store.recordMessage(msg({ id: "A2" }), "Maria");
      store.markRead(CHAT);

      expect(store.listChats()[0]!.unreadCount).toBe(0);
    });

    test("markRead numa conversa que não existe não lança erro", () => {
      expect(() => store.markRead("inexistente@s.whatsapp.net")).not.toThrow();
    });

    test("countUnreadChats conta CONVERSAS com não lida, não mensagens, e ignora arquivadas", () => {
      store.recordMessage(msg({ id: "A1" }), "Maria"); // CHAT: 2 mensagens não lidas = 1 conversa
      store.recordMessage(msg({ id: "A2" }), "Maria");
      store.recordMessage(msg({ chatJid: GROUP, id: "G1" }), "Grupo"); // GROUP: 1 conversa
      expect(store.countUnreadChats()).toBe(2);

      store.markRead(CHAT);
      expect(store.countUnreadChats()).toBe(1);

      store.setArchived(GROUP, true);
      expect(store.countUnreadChats()).toBe(0);
    });
  });

  describe("status de entrega/leitura", () => {
    test("updateStatus muda o status e devolve true quando a mensagem existe", () => {
      store.recordMessage(msg({ id: "A1", fromMe: true }), "Maria");
      expect(store.updateStatus(CHAT, "A1", "delivered")).toBe(true);
      expect(store.getMessage(CHAT, "A1")!.status).toBe("delivered");
    });

    test("updateStatus devolve false quando a mensagem não existe (nada pra atualizar)", () => {
      expect(store.updateStatus(CHAT, "NAO_EXISTE", "read")).toBe(false);
    });
  });

  describe("fixar e arquivar", () => {
    test("fixar põe no topo, mesmo que outra conversa tenha mensagem mais recente", () => {
      store.recordMessage(msg({ chatJid: CHAT, id: "A1", timestamp: 1000 }), "Maria");
      store.recordMessage(msg({ chatJid: GROUP, id: "G1", timestamp: 2000 }), "Grupo");

      store.setPinned(CHAT, true);
      expect(store.listChats().map((c) => c.jid)).toEqual([CHAT, GROUP]);
      expect(store.listChats()[0]!.pinnedAt).not.toBeNull();
    });

    test("desafixar volta a ordenar só por atividade", () => {
      store.recordMessage(msg({ chatJid: CHAT, id: "A1", timestamp: 1000 }), "Maria");
      store.recordMessage(msg({ chatJid: GROUP, id: "G1", timestamp: 2000 }), "Grupo");
      store.setPinned(CHAT, true);
      store.setPinned(CHAT, false);

      expect(store.listChats().map((c) => c.jid)).toEqual([GROUP, CHAT]);
      expect(store.listChats()[1]!.pinnedAt).toBeNull();
    });

    test("fixar temporariamente marca pinIsTemporary; fixar normal não", () => {
      store.recordMessage(msg({ id: "A1" }), "Maria");

      store.setPinned(CHAT, true, true);
      expect(store.listChats()[0]).toMatchObject({ pinIsTemporary: true });

      store.setPinned(CHAT, true, false);
      expect(store.listChats()[0]).toMatchObject({ pinIsTemporary: false });
    });

    test("unpinIfTemporary desafixa a fixada temporária, mas nunca mexe numa fixada permanente", () => {
      store.recordMessage(msg({ chatJid: CHAT, id: "A1" }), "Maria");
      store.recordMessage(msg({ chatJid: GROUP, id: "G1" }), "Grupo");
      store.setPinned(CHAT, true, true); // temporária
      store.setPinned(GROUP, true, false); // permanente

      store.unpinIfTemporary(CHAT);
      store.unpinIfTemporary(GROUP);

      const byJid = Object.fromEntries(store.listChats().map((c) => [c.jid, c]));
      expect(byJid[CHAT]).toMatchObject({ pinnedAt: null, pinIsTemporary: false });
      expect(byJid[GROUP]).toMatchObject({ pinIsTemporary: false });
      expect(byJid[GROUP]!.pinnedAt).not.toBeNull(); // continua fixada: não era temporária
    });

    test("arquivar some da lista principal; desarquivar devolve", () => {
      store.recordMessage(msg({ id: "A1" }), "Maria");
      store.setArchived(CHAT, true);
      expect(store.listChats()).toEqual([]);
      expect(store.listArchivedChats().map((c) => c.jid)).toEqual([CHAT]);

      store.setArchived(CHAT, false);
      expect(store.listChats().map((c) => c.jid)).toEqual([CHAT]);
      expect(store.listArchivedChats()).toEqual([]);
    });

    test("mensagem nova numa conversa arquivada não desarquiva sozinha (igual ao WhatsApp)", () => {
      store.recordMessage(msg({ id: "A1" }), "Maria");
      store.setArchived(CHAT, true);
      store.recordMessage(msg({ id: "A2", text: "De novo" }), "Maria");

      expect(store.listChats()).toEqual([]);
      expect(store.listArchivedChats()[0]!.lastMessagePreview).toBe("De novo");
    });
  });

  describe("apagar e revogar mensagens", () => {
    test("markRevoked vira uma tarja de apagada, sem sumir da conversa", () => {
      store.recordMessage(msg({ id: "A1", text: "Oi", fromMe: true }), "Maria");
      expect(store.markRevoked(CHAT, "A1")).toBe(true);

      const found = store.getMessage(CHAT, "A1")!;
      expect(found).toMatchObject({ type: "revoked", text: null, mediaFile: null });
      expect(store.listChats()[0]!.lastMessagePreview).toContain("apagada");
    });

    test("markRevoked de mensagem que não existe devolve false", () => {
      expect(store.markRevoked(CHAT, "NAO_EXISTE")).toBe(false);
    });

    test("deleteMessage remove de vez e recalcula a prévia pra mensagem anterior", () => {
      store.recordMessage(msg({ id: "A1", text: "Primeira", timestamp: 1000 }), "Maria");
      store.recordMessage(msg({ id: "A2", text: "Segunda", timestamp: 2000 }), "Maria");

      expect(store.deleteMessage(CHAT, "A2")).toBe(true);
      expect(store.listMessages(CHAT).map((m) => m.id)).toEqual(["A1"]);
      expect(store.listChats()[0]!.lastMessagePreview).toBe("Primeira");
    });

    test("deleteMessage da única mensagem zera a prévia da conversa (ela some da lista)", () => {
      store.recordMessage(msg({ id: "A1" }), "Maria");
      store.deleteMessage(CHAT, "A1");
      expect(store.listChats()).toEqual([]);
    });
  });

  describe("busca dentro da conversa", () => {
    test("acha mensagens que contêm o termo, sem diferenciar maiúscula/minúscula", () => {
      store.recordMessage(msg({ id: "A1", text: "Uber 50% de desconto" }), "Maria");
      store.recordMessage(msg({ id: "A2", text: "chegou o motorista" }), "Maria");

      expect(store.searchMessages(CHAT, "uber").map((m) => m.id)).toEqual(["A1"]);
    });

    test("escapa % e _ do termo buscado (texto literal, não curinga)", () => {
      store.recordMessage(msg({ id: "A1", text: "Uber 50% de desconto" }), "Maria");
      store.recordMessage(msg({ id: "A2", text: "nada a ver" }), "Maria");

      expect(store.searchMessages(CHAT, "50%").map((m) => m.id)).toEqual(["A1"]);
    });
  });

  describe("galeria de mídia e grupos em comum (dados do contato)", () => {
    test("listMediaMessages só traz mensagens com arquivo baixado, mais recente primeiro", () => {
      store.recordMessage(msg({ id: "A1", type: "text", text: "oi" }), "Maria");
      store.recordMessage(msg({ id: "A2", type: "image", timestamp: 1000 }), "Maria"); // sem mediaFile ainda (download não terminou)
      store.recordMessage(msg({ id: "A3", type: "image", mediaFile: "img3.jpg", timestamp: 2000 }), "Maria");
      store.recordMessage(msg({ id: "A4", type: "document", mediaFile: "doc4.pdf", timestamp: 3000 }), "Maria");

      expect(store.listMediaMessages(CHAT).map((m) => m.id)).toEqual(["A4", "A3"]);
    });

    test("groupsInCommon acha grupos onde a pessoa já mandou mensagem, mais ativo primeiro", () => {
      const PARTICIPANT = "5511977770000@s.whatsapp.net";
      const GROUP_A = "111111111111111111@g.us";
      const GROUP_B = "222222222222222222@g.us";
      store.recordMessage(msg({ chatJid: GROUP_A, id: "G1", senderJid: PARTICIPANT, timestamp: 1000 }), "Grupo A");
      store.recordMessage(msg({ chatJid: GROUP_B, id: "G2", senderJid: PARTICIPANT, timestamp: 2000 }), "Grupo B");
      store.recordMessage(msg({ chatJid: CHAT, id: "P1", senderJid: PARTICIPANT, timestamp: 3000 }), "Maria"); // privado não conta

      expect(store.groupsInCommon([PARTICIPANT]).map((c) => c.jid)).toEqual([GROUP_B, GROUP_A]);
    });

    test("groupsInCommon aceita vários apelidos (JIDs) da mesma pessoa — telefone numa, LID noutra", () => {
      const PHONE_JID = "5511977770000@s.whatsapp.net";
      const LID_JID = "233083580211439@lid";
      const GROUP_A = "111111111111111111@g.us";
      const GROUP_B = "222222222222222222@g.us";
      store.recordMessage(msg({ chatJid: GROUP_A, id: "G1", senderJid: PHONE_JID, timestamp: 1000 }), "Grupo A");
      store.recordMessage(msg({ chatJid: GROUP_B, id: "G2", senderJid: LID_JID, timestamp: 2000 }), "Grupo B");

      expect(store.groupsInCommon([PHONE_JID, LID_JID]).map((c) => c.jid)).toEqual([GROUP_B, GROUP_A]);
    });

    test("groupsInCommon de quem nunca falou em nenhum grupo devolve vazio", () => {
      expect(store.groupsInCommon(["5511900000000@s.whatsapp.net"])).toEqual([]);
    });

    test("groupsInCommon sem nenhum JID devolve vazio (sem quebrar a query)", () => {
      expect(store.groupsInCommon([])).toEqual([]);
    });
  });

  test("abrir um banco já existente (de antes de fixar/arquivar) ganha as colunas novas sem perder nada", () => {
    const file = join(dirs.appDataDir, "chat-legado.db");
    const legacy = new Database(file);
    legacy.run(`
      CREATE TABLE chats (
        jid TEXT PRIMARY KEY, is_group INTEGER NOT NULL, name TEXT,
        last_message_at INTEGER NOT NULL DEFAULT 0, last_message_preview TEXT, last_message_type TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      );
    `);
    legacy
      .query(
        "INSERT INTO chats (jid, is_group, name, last_message_at, last_message_preview, last_message_type, unread_count, updated_at) VALUES ($jid, 0, 'Maria', 1000, 'Oi', 'text', 1, 1000)"
      )
      .run({ $jid: CHAT });
    legacy.close();

    const reopened = new ChatStore(file);
    try {
      const [chat] = reopened.listChats();
      expect(chat).toMatchObject({ jid: CHAT, name: "Maria", unreadCount: 1, pinnedAt: null, archived: false });
      reopened.setPinned(CHAT, true);
      expect(reopened.listChats()[0]!.pinnedAt).not.toBeNull();
    } finally {
      reopened.close();
    }
  });

  describe("listas de conversas (pastas)", () => {
    test("cria, lista (na ordem de criação) e exclui", () => {
      const a = store.createFolder("Clientes Premium");
      const b = store.createFolder("Trabalho");
      expect(store.listFolders().map((f) => f.name)).toEqual(["Clientes Premium", "Trabalho"]);

      expect(store.deleteFolder(a.id)).toBe(true);
      expect(store.listFolders().map((f) => f.name)).toEqual(["Trabalho"]);
      void b;
    });

    test("excluir lista que não existe devolve false", () => {
      expect(store.deleteFolder("inexistente")).toBe(false);
    });

    test("adiciona e remove conversas da lista; não duplica a mesma conversa", () => {
      store.recordMessage(msg({ id: "A1" }), "Maria");
      const folder = store.createFolder("Clientes Premium");

      store.addChatToFolder(folder.id, CHAT);
      store.addChatToFolder(folder.id, CHAT); // de novo: não duplica
      expect(store.listChatsInFolder(folder.id).map((c) => c.jid)).toEqual([CHAT]);
      expect(store.foldersForChat(CHAT)).toEqual([folder.id]);

      store.removeChatFromFolder(folder.id, CHAT);
      expect(store.listChatsInFolder(folder.id)).toEqual([]);
      expect(store.foldersForChat(CHAT)).toEqual([]);
    });

    test("conversa fixada aparece primeiro dentro da lista também", () => {
      store.recordMessage(msg({ chatJid: CHAT, id: "A1", timestamp: 1000 }), "Maria");
      store.recordMessage(msg({ chatJid: GROUP, id: "G1", timestamp: 2000 }), "Grupo");
      const folder = store.createFolder("Clientes Premium");
      store.addChatToFolder(folder.id, CHAT);
      store.addChatToFolder(folder.id, GROUP);

      store.setPinned(CHAT, true);
      expect(store.listChatsInFolder(folder.id).map((c) => c.jid)).toEqual([CHAT, GROUP]);
    });

    test("conversa enviada pra uma lista some da lista principal, igual ao arquivado", () => {
      store.recordMessage(msg({ chatJid: CHAT, id: "A1", timestamp: 1000 }), "Maria");
      store.recordMessage(msg({ chatJid: GROUP, id: "G1", timestamp: 2000 }), "Grupo");
      const folder = store.createFolder("Clientes Premium");

      expect(store.listChats().map((c) => c.jid)).toEqual([GROUP, CHAT]);
      store.addChatToFolder(folder.id, CHAT);
      expect(store.listChats().map((c) => c.jid)).toEqual([GROUP]);

      store.removeChatFromFolder(folder.id, CHAT);
      expect(store.listChats().map((c) => c.jid)).toEqual([GROUP, CHAT]);
    });

    test("excluir uma lista não mexe nas conversas nem no histórico", () => {
      store.recordMessage(msg({ id: "A1" }), "Maria");
      const folder = store.createFolder("Clientes Premium");
      store.addChatToFolder(folder.id, CHAT);

      store.deleteFolder(folder.id);
      expect(store.listChats().map((c) => c.jid)).toEqual([CHAT]);
      expect(store.listMessages(CHAT).length).toBe(1);
    });
  });
});
