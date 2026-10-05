import { expect, test } from "bun:test";
import { WAMessageStubType } from "baileys-joss";
import type { WAMessage } from "baileys-joss";
import { extractChatContent, renderSystemText } from "./chat-content";

function msg(message: WAMessage["message"]): WAMessage {
  return { key: { remoteJid: "5511977770000@s.whatsapp.net", fromMe: false, id: "M1" }, message } as WAMessage;
}

function stubMsg(messageStubType: number): WAMessage {
  return { key: { remoteJid: "120363000000000000@g.us", fromMe: false, id: "M1" }, messageStubType } as WAMessage;
}

test("mensagem sem conteúdo nenhum: null", () => {
  expect(extractChatContent(msg(undefined))).toBeNull();
});

test("tipo realmente desconhecido ainda cai em 'unsupported'", () => {
  expect(extractChatContent(msg({ buttonsMessage: {} } as never))).toMatchObject({ type: "unsupported" });
});

test("mensagem com botão de link (interactiveMessage): corpo + rótulo e link do botão", () => {
  const content = extractChatContent(
    msg({
      interactiveMessage: {
        body: { text: "*ON*, chama pv 🚘" },
        nativeFlowMessage: {
          buttons: [{ name: "cta_url", buttonParamsJson: JSON.stringify({ display_text: "Receber atendimento", url: "https://wa.me/5511977770000" }) }],
        },
        contextInfo: { stanzaId: "PEDIDO" },
      },
    } as never)
  );
  expect(content).toMatchObject({ type: "text", quotedId: "PEDIDO" });
  expect(content!.text).toBe("*ON*, chama pv 🚘\n\n🔗 Receber atendimento: https://wa.me/5511977770000");
});

test("mensagem com botão que chega dentro de viewOnceMessage (como o WhatsApp entrega em grupo) também é lida", () => {
  const content = extractChatContent(
    msg({ viewOnceMessage: { message: { messageContextInfo: {}, interactiveMessage: { body: { text: "chama pv" }, nativeFlowMessage: { buttons: [] } } } } } as never)
  );
  expect(content).toMatchObject({ type: "text", text: "chama pv" });
});

test("botões nos formatos antigos (templateMessage e buttonsMessage) e JSON de botão quebrado", () => {
  const template = extractChatContent(
    msg({
      templateMessage: {
        hydratedTemplate: {
          hydratedContentText: "Fale com a gente",
          hydratedButtons: [{ urlButton: { displayText: "Abrir", url: "https://exemplo.com" } }, { callButton: { displayText: "Ligar", phoneNumber: "+5511977770000" } }],
        },
      },
    } as never)
  );
  expect(template!.text).toBe("Fale com a gente\n\n🔗 Abrir: https://exemplo.com\n📞 Ligar: +5511977770000");

  const buttons = extractChatContent(msg({ buttonsMessage: { contentText: "Confirma?", buttons: [{ buttonText: { displayText: "Sim" } }, { buttonText: { displayText: "Não" } }] } } as never));
  expect(buttons!.text).toBe("Confirma?\n\n🔘 Sim\n🔘 Não");

  const broken = extractChatContent(msg({ interactiveMessage: { body: { text: "oi" }, nativeFlowMessage: { buttons: [{ name: "cta_url", buttonParamsJson: "{" }] } } } as never));
  expect(broken!.text).toBe("oi");
});

test("resposta a um botão: mostra a opção que a pessoa escolheu", () => {
  expect(extractChatContent(msg({ buttonsResponseMessage: { selectedDisplayText: "Sim" } } as never))).toMatchObject({ type: "text", text: "Sim" });
  expect(extractChatContent(msg({ listResponseMessage: { title: "Opção 2" } } as never))).toMatchObject({ type: "text", text: "Opção 2" });
});

test("enquete (pollCreationMessage): vira texto legível com a pergunta e as opções", () => {
  const content = extractChatContent(
    msg({
      pollCreationMessage: { name: "Quem vai hoje?", options: [{ optionName: "Eu" }, { optionName: "Não vou" }] },
    } as never)
  );
  expect(content).toMatchObject({ type: "text" });
  expect(content!.text).toContain("Quem vai hoje?");
  expect(content!.text).toContain("• Eu");
  expect(content!.text).toContain("• Não vou");
});

test("enquete nas versões V2 e V3 também são reconhecidas", () => {
  expect(extractChatContent(msg({ pollCreationMessageV2: { name: "V2?", options: [] } } as never))?.text).toContain("V2?");
  expect(extractChatContent(msg({ pollCreationMessageV3: { name: "V3?", options: [] } } as never))?.text).toContain("V3?");
});

test("voto numa enquete: avisa que foi um voto, sem tentar decifrar o conteúdo", () => {
  const content = extractChatContent(msg({ pollUpdateMessage: { vote: {} } } as never));
  expect(content).toMatchObject({ type: "text" });
  expect(content!.text).toContain("enquete");
});

test("convite de grupo: mostra o nome do grupo", () => {
  const content = extractChatContent(msg({ groupInviteMessage: { groupName: "Motoristas SP", inviteCode: "ABC" } } as never));
  expect(content).toMatchObject({ type: "text" });
  expect(content!.text).toContain("Motoristas SP");
});

test("vários contatos compartilhados de uma vez: conta quantos são", () => {
  const content = extractChatContent(
    msg({ contactsArrayMessage: { contacts: [{ displayName: "A" }, { displayName: "B" }, { displayName: "C" }] } } as never)
  );
  expect(content).toMatchObject({ type: "contact" });
  expect(content!.text).toContain("3 contatos");
});

test("álbum de fotos/vídeos: mostra quantos itens espera", () => {
  const content = extractChatContent(msg({ albumMessage: { expectedImageCount: 4, expectedVideoCount: 1 } } as never));
  expect(content).toMatchObject({ type: "text" });
  expect(content!.text).toContain("4 fotos");
  expect(content!.text).toContain("1 vídeo");
});

test("pedido de entrada no grupo (aprovação de admin): vira aviso de sistema com o nome de quem pediu, como no WhatsApp", () => {
  const request = JSON.stringify({ lid: ISABELLI.lid, pn: ISABELLI.pn });
  const stub = groupStub(WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD, [request, "created"], ISABELLI);
  expect(systemText(stub)).toBe("~Isabelli pediu para entrar no grupo");
});

test("pedido de entrada: também reconhece as outras duas variações do mesmo aviso (sem parâmetro, quem pediu é o autor)", () => {
  expect(systemText(groupStub(WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN, [], ISABELLI))).toBe("~Isabelli pediu para entrar no grupo");
  expect(systemText(groupStub(WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST, [], ISABELLI))).toBe("~Isabelli pediu para entrar no grupo");
});

test("pedido de entrada cancelado ou recusado: aviso próprio, não 'pediu para entrar' de novo", () => {
  const request = JSON.stringify({ lid: ISABELLI.lid, pn: ISABELLI.pn });
  const kind = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD;
  expect(systemText(groupStub(kind, [request, "revoked"], ISABELLI))).toBe("~Isabelli cancelou o pedido para entrar no grupo");
  expect(systemText(groupStub(kind, [request, "rejected"]))).toBe("O pedido de ~Isabelli para entrar no grupo foi recusado");
});

test("mudança no modo de aprovação do grupo: aviso diferente do pedido em si", () => {
  const content = extractChatContent(stubMsg(WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE));
  expect(content).toMatchObject({ type: "text" });
  expect(content!.text).toContain("aprovação");
});

const GROUP = "120363000000000000@g.us";
const XX = { lid: "111111111111@lid", pn: "5512988087430@s.whatsapp.net" };
const ISABELLI = { lid: "222222222222@lid", pn: "5511942412694@s.whatsapp.net" };

/** Nomes de mentira: o telefone vira "~Nome" pra quem é conhecido, igual o ChatService faz com o histórico. */
const NAMES: Record<string, string> = { [XX.pn]: "~Xx", [ISABELLI.pn]: "~Isabelli" };
const nameOf = (jids: string[], role: "actor" | "target") => {
  if (jids.includes("ME@s.whatsapp.net")) return role === "actor" ? "Você" : "você";
  return jids.map((j) => NAMES[j]).find(Boolean) ?? "um participante";
};

function groupStub(messageStubType: number, params: string[], actor = XX): WAMessage {
  return {
    key: { remoteJid: GROUP, fromMe: false, id: "S1", participant: actor.lid, participantAlt: actor.pn },
    messageStubType,
    messageStubParameters: params,
  } as unknown as WAMessage;
}

const participant = (p: { lid: string; pn: string }) => JSON.stringify({ id: p.lid, phoneNumber: p.pn });

function systemText(m: WAMessage): string {
  const content = extractChatContent(m);
  expect(content).toMatchObject({ type: "system" });
  return renderSystemText(content!.system!, nameOf);
}

test("aviso de grupo: alguém adicionou outra pessoa (igual ao WhatsApp: '~Xx adicionou ~Isabelli')", () => {
  expect(systemText(groupStub(WAMessageStubType.GROUP_PARTICIPANT_ADD, [participant(ISABELLI)]))).toBe("~Xx adicionou ~Isabelli");
});

test("aviso de grupo: entrou pelo link (quem fez e quem entrou são a mesma pessoa)", () => {
  expect(systemText(groupStub(WAMessageStubType.GROUP_PARTICIPANT_ADD, [participant(ISABELLI)], ISABELLI))).toBe("~Isabelli entrou no grupo");
});

test("aviso de grupo: saiu, foi removida, virou admin, deixou de ser admin", () => {
  expect(systemText(groupStub(WAMessageStubType.GROUP_PARTICIPANT_LEAVE, [participant(ISABELLI)], ISABELLI))).toBe("~Isabelli saiu do grupo");
  expect(systemText(groupStub(WAMessageStubType.GROUP_PARTICIPANT_REMOVE, [participant(ISABELLI)]))).toBe("~Xx removeu ~Isabelli");
  expect(systemText(groupStub(WAMessageStubType.GROUP_PARTICIPANT_PROMOTE, [participant(ISABELLI)]))).toBe("~Isabelli agora é admin do grupo");
  expect(systemText(groupStub(WAMessageStubType.GROUP_PARTICIPANT_DEMOTE, [participant(ISABELLI)]))).toBe("~Isabelli não é mais admin do grupo");
});

test("aviso de grupo: várias pessoas de uma vez, e 'você' quando é a própria conta", () => {
  const me = JSON.stringify({ id: "ME@s.whatsapp.net" });
  expect(systemText(groupStub(WAMessageStubType.GROUP_PARTICIPANT_ADD, [participant(ISABELLI), me]))).toBe("~Xx adicionou ~Isabelli e você");
  expect(systemText(groupStub(WAMessageStubType.GROUP_PARTICIPANT_PROMOTE, [me]))).toBe("Você agora é admin do grupo");
});

test("aviso de grupo: participante no formato antigo (só o JID, sem JSON) e pessoa sem nome conhecido", () => {
  expect(systemText(groupStub(WAMessageStubType.GROUP_PARTICIPANT_ADD, [ISABELLI.pn]))).toBe("~Xx adicionou ~Isabelli");
  expect(systemText(groupStub(WAMessageStubType.GROUP_PARTICIPANT_ADD, ["999999@lid"]))).toBe("~Xx adicionou um participante");
});

test("aviso de grupo: nome, descrição, foto e configurações", () => {
  expect(systemText(groupStub(WAMessageStubType.GROUP_CHANGE_SUBJECT, ["Corridas ZN"]))).toBe('~Xx mudou o nome do grupo para "Corridas ZN"');
  expect(systemText(groupStub(WAMessageStubType.GROUP_CHANGE_DESCRIPTION, ["regras novas"]))).toBe("~Xx mudou a descrição do grupo");
  expect(systemText(groupStub(WAMessageStubType.GROUP_CHANGE_ICON, ["123"]))).toBe("~Xx mudou a foto do grupo");
  expect(systemText(groupStub(WAMessageStubType.GROUP_CHANGE_ANNOUNCE, ["on"]))).toBe("~Xx mudou as configurações: só admins podem enviar mensagens");
});

test("histórico de mensagens enviado pra quem entrou: '~Xx enviou o histórico de mensagens que começa em ... para ~Isabelli'", () => {
  const oldest = Math.floor(new Date(2026, 9, 1, 10, 5).getTime() / 1000);
  const m = {
    key: { remoteJid: GROUP, fromMe: false, id: "H1", participant: XX.lid, participantAlt: XX.pn },
    message: {
      messageContextInfo: {},
      messageHistoryBundle: { messageHistoryMetadata: { historyReceivers: [ISABELLI.pn], oldestMessageTimestamp: oldest, messageCount: 40 } },
    },
  } as unknown as WAMessage;

  const text = systemText(m);
  expect(text.startsWith("~Xx enviou o histórico de mensagens que começa em 1 de out. de 2026")).toBe(true);
  expect(text.endsWith("10:05 para ~Isabelli")).toBe(true);
});

test("só chaves de criptografia/contexto (o que chega quando alguém acaba de entrar no grupo): nada pra mostrar, não vira 'não suportada'", () => {
  expect(extractChatContent(msg({ senderKeyDistributionMessage: { groupId: GROUP } } as never))).toBeNull();
  expect(extractChatContent(msg({ messageContextInfo: {}, senderKeyDistributionMessage: { groupId: GROUP } } as never))).toBeNull();
  expect(extractChatContent(msg({ protocolMessage: { type: 5 } } as never))).toBeNull();
});

test("mensagens temporárias ligadas/desligadas e chamada perdida viram aviso", () => {
  const ephemeral = { ...msg({ protocolMessage: { type: 3, ephemeralExpiration: 86400 } } as never), key: { remoteJid: GROUP, fromMe: false, id: "E1", participant: XX.pn } } as WAMessage;
  expect(systemText(ephemeral)).toBe("~Xx ativou as mensagens temporárias");
  expect(systemText(stubMsg(WAMessageStubType.CALL_MISSED_VOICE))).toBe("📞 Chamada de voz perdida");
});

test("tipo realmente desconhecido continua como 'não suportada' (e não some), guardando qual era o tipo", () => {
  expect(extractChatContent(msg({ messageContextInfo: {}, highlyStructuredMessage: { namespace: "x" } } as never))).toMatchObject({
    type: "unsupported",
    text: "highlyStructuredMessage",
  });
});

test("recado de vídeo (ptvMessage, a bolinha redonda): é um vídeo, com a mídia pra baixar", () => {
  const ptv = { mimetype: "video/mp4", seconds: 7, mediaKey: "k" };
  const content = extractChatContent(msg({ messageContextInfo: {}, ptvMessage: ptv } as never));
  expect(content).toMatchObject({ type: "video", mimeType: "video/mp4", seconds: 7 });
  expect(content!.mediaEnvelope).toEqual(ptv);
});

test("figurinha animada (embrulhada em lottieStickerMessage): é uma figurinha", () => {
  const sticker = { mimetype: "application/was", isLottie: true };
  const content = extractChatContent(msg({ lottieStickerMessage: { message: { stickerMessage: sticker } } } as never));
  expect(content).toMatchObject({ type: "sticker", mimeType: "application/was" });
  expect(content!.mediaEnvelope).toEqual(sticker);
});

test("conteúdo que o WhatsApp esconde de aparelhos conectados: avisa que só abre no celular", () => {
  const content = extractChatContent(msg({ placeholderMessage: { type: 0 } } as never));
  expect(content).toMatchObject({ type: "text" });
  expect(content!.text).toContain("só pode ser vista no celular");
});

test("tipos menos comuns viram uma linha de texto dizendo o que é", () => {
  const text = (message: unknown) => {
    const content = extractChatContent(msg(message as never));
    expect(content).toMatchObject({ type: "text" });
    return content!.text!;
  };

  expect(text({ eventMessage: { name: "Churrasco", description: "Traga gelo", location: { name: "Casa do Zé" } } })).toBe("📅 Evento: Churrasco\nOnde: Casa do Zé\nTraga gelo");
  expect(text({ callLogMesssage: { isVideo: false, callOutcome: 1 } })).toBe("📞 Chamada de voz não atendida");
  expect(text({ callLogMesssage: { isVideo: true, callOutcome: 0, durationSecs: 75 } })).toBe("📹 Chamada de vídeo · 1:15");
  expect(text({ stickerPackMessage: { name: "Gatinhos" } })).toBe("🧩 Pacote de figurinhas: Gatinhos");
  expect(text({ productMessage: { product: { title: "Camiseta", priceAmount1000: 59900, currencyCode: "BRL" } } })).toContain("🛍️ Produto: Camiseta\nR$");
  expect(text({ orderMessage: { orderTitle: "Loja", itemCount: 2, message: "Quero esses" } })).toBe("🧾 Pedido: Loja\n2 itens\nQuero esses");
  expect(text({ requestPaymentMessage: { amount1000: 25000, currencyCodeIso4217: "BRL", noteMessage: { conversation: "corrida" } } })).toContain("💸 Pedido de pagamento: R$");
  expect(text({ requestPhoneNumberMessage: {} })).toBe("📱 Pediu o seu número de telefone");
  expect(text({ pollResultSnapshotMessage: { name: "Vai?", pollVotes: [{ optionName: "Sim", optionVoteCount: 3 }] } })).toBe("📊 Resultado da enquete: Vai?\n• Sim: 3");
});

test("respostas cifradas e edições que só valem aplicadas a outra mensagem não viram bolha", () => {
  expect(extractChatContent(msg({ messageContextInfo: {}, secretEncryptedMessage: { encPayload: "x" } } as never))).toBeNull();
  expect(extractChatContent(msg({ encEventResponseMessage: {} } as never))).toBeNull();
});
