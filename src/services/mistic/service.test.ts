import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ChargeStore, type ChargeRecord } from "../../core/charge-store";
import { DEFAULT_CHARGE_MESSAGE, DEFAULT_THANKS_MESSAGE, MisticStore } from "../../core/mistic-store";
import { MisticError, MISTIC_BASE_URL } from "./client";
import { RateLimiter } from "./rate-limiter";
import { MisticService, normalizePhone, normalizePixKey, type MisticTiming } from "./service";

const CHAT = "5511977770000@s.whatsapp.net";
const VALID_CPF = "52998224725";
const OTHER_CPF = "12345678909";

const FAST: MisticTiming = {
  tickMs: 5,
  maxChecksPerTick: 3,
  messageGapMs: 0,
  thanksRetryGapMs: 0,
  intervalFor: () => 0,
};

let dir: string;
let store: MisticStore;
let charges: ChargeStore;

/** Envia de mentira: guarda na ordem o que iria pro cliente. */
let outbox: Array<{ kind: "text" | "image"; chatJid: string; text: string; bytes?: number }>;
let failSending = false;
let operatorActions: string[];
let notifications: Array<{ title: string; body: string }>;

/** MisticPay de mentira. */
interface Api {
  calls: Array<{ path: string; method: string; body?: any; auth: string }>;
  /** Estado que a consulta devolve por ID de transação. */
  states: Record<string, string>;
  createStatus: number;
  createError: string;
  checkStatus: number;
  withdrawStatus: number;
  nextId: number;
}
let api: Api;

const fakeFetch = (async (url: string, init: RequestInit) => {
  const path = String(url).replace(MISTIC_BASE_URL, "");
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const auth = String((init.headers as Record<string, string>)["Authorization"]);
  api.calls.push({ path, method: String(init.method), body, auth });
  const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });

  if (path === "/transactions/create") {
    if (api.createStatus !== 200) return reply(api.createStatus, { error: api.createError });
    const id = String(api.nextId++);
    api.states[id] = "PENDENTE";
    return reply(200, { data: { transactionId: id, transactionState: "PENDENTE", copyPaste: `000201COPIACOLA${id}`, qrCodeBase64: "data:image/png;base64,AA" } });
  }
  if (path === "/transactions/check") {
    if (api.checkStatus !== 200) return reply(api.checkStatus, { error: api.checkStatus === 401 ? "invalid" : "erro" });
    const state = api.states[body.transactionId];
    if (!state) return reply(404, { message: "não encontrada" });
    return reply(200, { transaction: { transactionId: body.transactionId, value: 1, fee: 0, transactionState: state } });
  }
  if (path === "/transactions/withdraw") {
    if (api.withdrawStatus !== 200) return reply(api.withdrawStatus, { error: "Saldo insuficiente" });
    const id = String(api.nextId++);
    api.states[id] = "PENDENTE";
    return reply(200, { data: { transactionId: id, jobId: `job-${id}`, status: "QUEUED" } });
  }
  if (path === "/users/info") {
    return reply(200, { data: { name: "Fulano", email: "f@x.com", document: "12345678909", phone: "1199", accountVerified: true, documentVerified: true, withdrawBlocked: false, availableBalance: 100, blockedBalance: 5 } });
  }
  return reply(404, {});
}) as unknown as typeof fetch;

function newService(overrides: Partial<ConstructorParameters<typeof MisticService>[0]> = {}) {
  return new MisticService({
    store,
    charges,
    sender: {
      sendText: async (chatJid, text) => {
        if (failSending) throw new Error("WhatsApp desconectado");
        outbox.push({ kind: "text", chatJid, text });
      },
      sendImage: async (chatJid, image, caption) => {
        if (failSending) throw new Error("WhatsApp desconectado");
        outbox.push({ kind: "image", chatJid, text: caption, bytes: image.length });
      },
    },
    contacts: {
      find: (jid) => (jid.startsWith("5511977770000") ? { name: "Maria Silva", phone: "5511977770000" } : undefined),
      lookupPhone: async (phone) => (phone === "5511988880000" ? { chatJid: `${phone}@s.whatsapp.net`, phone } : null),
    },
    notify: (title, body) => void notifications.push({ title, body }),
    accountName: () => "Loja",
    onOperatorAction: (jid) => void operatorActions.push(jid),
    fetch: fakeFetch,
    limiter: new RateLimiter(1000, 60_000),
    timing: FAST,
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-mistic-"));
  store = new MisticStore(join(dir, "mistic.json"));
  charges = new ChargeStore(join(dir, "charges.json"));
  store.update({ enabled: true, clientId: "ci_1", clientSecret: "cs_1", defaultPayerDocument: VALID_CPF });
  outbox = [];
  failSending = false;
  operatorActions = [];
  notifications = [];
  api = { calls: [], states: {}, createStatus: 200, createError: "recusado", checkStatus: 200, withdrawStatus: 200, nextId: 1001 };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const onlyCalls = (path: string) => api.calls.filter((c) => c.path === path);

describe("cobrar o cliente", () => {
  test("cria a cobrança e manda mensagem, copia e cola e QR Code, nessa ordem", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 25.5, description: "Corrida até o centro" });

    expect(onlyCalls("/transactions/create")[0]!.body).toEqual({
      amount: 25.5,
      payerName: "Maria Silva",
      payerDocument: VALID_CPF,
      transactionId: `brinzy-${charge.id}`,
      description: "Corrida até o centro",
    });
    expect(onlyCalls("/transactions/create")[0]!.auth).toBe("Basic " + Buffer.from("ci_1:cs_1").toString("base64"));

    expect(outbox.map((m) => m.kind)).toEqual(["text", "text", "image"]);
    expect(outbox.every((m) => m.chatJid === CHAT)).toBe(true);
    expect(outbox[0]!.text).toContain("R$ 25,50");
    expect(outbox[0]!.text).toContain("Corrida até o centro");
    expect(outbox[1]!.text).toBe("000201COPIACOLA1001"); // só o código, fácil de copiar
    expect(outbox[2]!.bytes).toBeGreaterThan(500); // um PNG de verdade
    expect(outbox[2]!.text).toContain("R$ 25,50");

    expect(charge).toMatchObject({
      kind: "charge", status: "pending", amountCents: 2550, misticId: "1001", chatJid: CHAT,
      phone: "5511977770000", name: "Maria Silva", sendError: null, sent: { charge: true, code: true, qr: true },
    });
    expect(charge.payerDocumentMasked).toBe("•••••••4725");
    expect(operatorActions).toEqual([CHAT]);
  });

  test("a cobrança fica salva no disco", async () => {
    const charge = await newService().createCharge({ chatJid: CHAT, amount: 10 });
    const reloaded = new ChargeStore(join(dir, "charges.json"));
    expect(reloaded.get(charge.id)).toMatchObject({ status: "pending", amountCents: 1000, copyPaste: "000201COPIACOLA1001" });
  });

  test("sem descrição usa 'Cobrança' na API, mas a mensagem não repete o título", async () => {
    await newService().createCharge({ chatJid: CHAT, amount: 10 });
    expect(onlyCalls("/transactions/create")[0]!.body.description).toBe("Cobrança");
    expect(outbox[0]!.text).not.toMatch(/\n\n\n/);
    expect(outbox[0]!.text.startsWith("💳 *Cobrança de R$ 10,00*")).toBe(true);
  });

  test("mensagens configuradas com marcadores", async () => {
    store.update({
      chargeMessage: "Oi {nome}! Segue {valor} ({descricao}) - tel {numero}",
      qrCaption: "Pague {valor} aqui",
    });
    await newService().createCharge({ chatJid: CHAT, amount: 7, description: "Taxa" });
    expect(outbox[0]!.text).toBe("Oi Maria! Segue R$ 7,00 (Taxa) - tel 5511977770000");
    expect(outbox[2]!.text).toBe("Pague R$ 7,00 aqui");
  });

  test("sem QR Code quando desligado", async () => {
    store.update({ sendQr: false });
    await newService().createCharge({ chatJid: CHAT, amount: 7 });
    expect(outbox.map((m) => m.kind)).toEqual(["text", "text"]);
  });

  test("CPF do formulário vale no lugar do padrão", async () => {
    await newService().createCharge({ chatJid: CHAT, amount: 5, payerDocument: "123.456.789-09", payerName: "João" });
    expect(onlyCalls("/transactions/create")[0]!.body).toMatchObject({ payerDocument: OTHER_CPF, payerName: "João" });
  });

  test("valor inválido e CPF inválido são recusados antes de chamar a API", async () => {
    const svc = newService();
    await expect(svc.createCharge({ chatJid: CHAT, amount: 0 })).rejects.toMatchObject({ code: "validation" });
    await expect(svc.createCharge({ chatJid: CHAT, amount: "abc" })).rejects.toMatchObject({ code: "validation" });
    await expect(svc.createCharge({ chatJid: CHAT, amount: 10.005 })).rejects.toMatchObject({ code: "validation" });
    await expect(svc.createCharge({ chatJid: CHAT, amount: 10, payerDocument: "11111111111" })).rejects.toThrow("CPF informado não é válido");

    expect(api.calls.length).toBe(0);
    expect(charges.list()).toEqual([]);
  });

  // A MisticPay exige payerDocument em toda cobrança ("Um ou mais campos obrigatórios da transação não foram enviados")
  test("sem CPF nenhum (nem digitado nem padrão): explica o que fazer, sem chamar a API nem criar nada", async () => {
    store.update({ defaultPayerDocument: "" });
    const err = await newService().createCharge({ chatJid: CHAT, amount: 10 }).catch((e) => e);

    expect(err).toBeInstanceOf(MisticError);
    expect(err.code).toBe("validation");
    expect(err.message).toContain("exige um CPF");
    expect(api.calls.length).toBe(0);
    expect(charges.list()).toEqual([]);
    expect(outbox).toEqual([]);
  });

  test("sem CPF padrão, o CPF digitado no formulário resolve (e vai só com dígitos)", async () => {
    store.update({ defaultPayerDocument: "" });
    const charge = await newService().createCharge({ chatJid: CHAT, amount: 10, payerDocument: "529.982.247-25" });

    expect(onlyCalls("/transactions/create")[0]!.body.payerDocument).toBe(VALID_CPF);
    expect(charge).toMatchObject({ status: "pending", payerDocumentMasked: "•••••••4725", sendError: null });
    expect(outbox.length).toBe(3); // mensagem, copia e cola e QR Code
  });

  test("com CPF padrão salvo, cobrar sem digitar nada usa o padrão", async () => {
    await newService().createCharge({ chatJid: CHAT, amount: 10 });
    expect(onlyCalls("/transactions/create")[0]!.body.payerDocument).toBe(VALID_CPF);
  });

  test("recusa da MisticPay por outro motivo chega como veio", async () => {
    api.createStatus = 422;
    api.createError = "Conta bloqueada";
    const err = await newService().createCharge({ chatJid: CHAT, amount: 10 }).catch((e) => e);
    expect(err.message).toBe("Conta bloqueada");
  });

  test("integração desligada ou sem credenciais não cria nada", async () => {
    store.update({ enabled: false });
    await expect(newService().createCharge({ chatJid: CHAT, amount: 10 })).rejects.toMatchObject({ code: "not_configured" });

    store.update({ enabled: true, clientSecret: null, authHeader: null });
    await expect(newService().createCharge({ chatJid: CHAT, amount: 10 })).rejects.toMatchObject({ code: "not_configured" });
    expect(api.calls.length).toBe(0);
  });

  test("precisa de uma conversa privada ou de um número", async () => {
    const svc = newService();
    await expect(svc.createCharge({ amount: 10 })).rejects.toThrow("Escolha a conversa");
    await expect(svc.createCharge({ chatJid: "1203@g.us", amount: 10 })).rejects.toThrow("conversa privada");
    await expect(svc.createCharge({ chatJid: "status@broadcast", amount: 10 })).rejects.toThrow("conversa privada");
  });

  test("cliente digitado à mão: confere no WhatsApp", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ phone: "(11) 98888-0000", amount: 10 });
    expect(charge).toMatchObject({ chatJid: "5511988880000@s.whatsapp.net", phone: "5511988880000" });
    expect(outbox[0]!.chatJid).toBe("5511988880000@s.whatsapp.net");

    await expect(svc.createCharge({ phone: "11 90000-0000", amount: 10 })).rejects.toThrow("não foi encontrado no WhatsApp");
    await expect(svc.createCharge({ phone: "123", amount: 10 })).rejects.toThrow("com DDD");
  });

  test("a MisticPay recusa: nada é salvo nem enviado", async () => {
    api.createStatus = 422;
    await expect(newService().createCharge({ chatJid: CHAT, amount: 10 })).rejects.toMatchObject({ code: "api", status: 422 });
    expect(charges.list()).toEqual([]);
    expect(outbox).toEqual([]);
    expect(operatorActions).toEqual([]);
  });

  test("falha ao enviar ao cliente: a cobrança existe, o erro fica registrado e dá pra reenviar", async () => {
    failSending = true;
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 10 });
    expect(charge.sendError).toBe("WhatsApp desconectado");
    expect(charge.sent).toEqual({ charge: false, code: false, qr: false });
    expect(charge.status).toBe("pending");

    failSending = false;
    const resent = await svc.resend(charge.id);
    expect(resent.sendError).toBeNull();
    expect(resent.sent).toEqual({ charge: true, code: true, qr: true });
    expect(outbox.map((m) => m.kind)).toEqual(["text", "text", "image"]);
  });

  test("só reenvia cobrança pendente", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 10 });
    api.states[charge.misticId!] = "COMPLETO";
    await svc.tick();
    await expect(svc.resend(charge.id)).rejects.toThrow("aguardando pagamento");
    await expect(svc.resend("nao-existe")).rejects.toThrow("não encontrada");
  });
});

describe("identificar o pagamento e agradecer", () => {
  test("pagou: marca como pago, avisa no computador e agradece UMA vez", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 25.5 });
    outbox.length = 0;

    await svc.tick(); // ainda pendente
    expect(charges.get(charge.id)!.status).toBe("pending");
    expect(outbox).toEqual([]);

    api.states[charge.misticId!] = "COMPLETO";
    await svc.tick();

    const paid = charges.get(charge.id)!;
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).not.toBeNull();
    expect(paid.thanksSent).toBe(true);
    expect(outbox).toEqual([{ kind: "text", chatJid: CHAT, text: "✅ Pagamento de R$ 25,50 recebido! Muito obrigado, Maria! 🙏" }]);
    expect(notifications).toEqual([{ title: "Loja: pagamento recebido", body: "R$ 25,50 de Maria Silva." }]);

    // mais ciclos não repetem nada
    await svc.tick();
    await svc.tick();
    expect(outbox.length).toBe(1);
    expect(notifications.length).toBe(1);
    expect(onlyCalls("/transactions/check").length).toBe(2); // parou de consultar depois de pago
  });

  test("agradecimento personalizado", async () => {
    store.update({ thanksMessage: "Valeu {nome}! Recebi os {valor}." });
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 3 });
    outbox.length = 0;
    api.states[charge.misticId!] = "COMPLETO";
    await svc.tick();
    expect(outbox[0]!.text).toBe("Valeu Maria! Recebi os R$ 3,00.");
  });

  test("agradecimento desligado: identifica o pagamento mas não manda mensagem", async () => {
    store.update({ sendThanks: false });
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 3 });
    outbox.length = 0;
    api.states[charge.misticId!] = "COMPLETO";
    await svc.tick();

    expect(charges.get(charge.id)).toMatchObject({ status: "paid", thanksSent: true });
    expect(outbox).toEqual([]);
    expect(notifications.length).toBe(1);
  });

  test("WhatsApp fora do ar na hora do pagamento: agradece assim que voltar", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 3 });
    outbox.length = 0;

    failSending = true;
    api.states[charge.misticId!] = "COMPLETO";
    await svc.tick();
    expect(charges.get(charge.id)).toMatchObject({ status: "paid", thanksSent: false });
    expect(outbox).toEqual([]);

    failSending = false;
    await svc.tick();
    expect(charges.get(charge.id)!.thanksSent).toBe(true);
    expect(outbox.length).toBe(1);
  });

  test("desiste do agradecimento depois de várias tentativas", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 3 });
    failSending = true;
    api.states[charge.misticId!] = "COMPLETO";
    for (let i = 0; i < 15; i++) await svc.tick();
    expect(charges.get(charge.id)!.thanksAttempts).toBe(8);
    expect(charges.get(charge.id)!.thanksSent).toBe(false);
  });

  test("falhou ou foi cancelada: muda o estado e NÃO agradece", async () => {
    const svc = newService();
    const a = await svc.createCharge({ chatJid: CHAT, amount: 1 });
    const b = await svc.createCharge({ chatJid: CHAT, amount: 2 });
    outbox.length = 0;
    api.states[a.misticId!] = "FALHA";
    api.states[b.misticId!] = "CANCELADO";
    await svc.tick();

    expect(charges.get(a.id)!.status).toBe("failed");
    expect(charges.get(b.id)!.status).toBe("canceled");
    expect(outbox).toEqual([]);
  });

  test("consulta pelo ID da MisticPay; se ela não achar, tenta o nosso", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 1 });
    delete api.states[charge.misticId!]; // a MisticPay "não conhece" o ID dela...
    api.states[`brinzy-${charge.id}`] = "COMPLETO"; // ...mas conhece o nosso
    await svc.tick();

    expect(charges.get(charge.id)!.status).toBe("paid");
    expect(onlyCalls("/transactions/check").map((c) => c.body.transactionId)).toEqual([charge.misticId!, `brinzy-${charge.id}`]);
  });

  test("verificar agora (botão do painel)", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 1 });
    api.states[charge.misticId!] = "COMPLETO";
    const checked = await svc.checkNow(charge.id);
    expect(checked.status).toBe("paid");
    await expect(svc.checkNow("nada")).rejects.toThrow("não encontrado");
  });

  test("um pagamento pendente é retomado depois de reiniciar o programa", async () => {
    const charge = await newService().createCharge({ chatJid: CHAT, amount: 9 });
    outbox.length = 0;

    // "reinicia": stores e serviço novos, lendo do disco
    store = new MisticStore(join(dir, "mistic.json"));
    charges = new ChargeStore(join(dir, "charges.json"));
    const restarted = newService();
    api.states[charge.misticId!] = "COMPLETO";
    await restarted.tick();

    expect(charges.get(charge.id)!.status).toBe("paid");
    expect(outbox.length).toBe(1);
  });
});

describe("cuidado com a API da MisticPay", () => {
  test("respeita o intervalo entre consultas", async () => {
    const svc = newService({ timing: { ...FAST, intervalFor: () => 60_000 } });
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 1 });
    await svc.tick();
    await svc.tick();
    expect(onlyCalls("/transactions/check").length).toBe(0); // acabou de criar: ainda não é hora

    charges.update(charge.id, { lastCheckAt: Date.now() - 61_000 });
    await svc.tick();
    expect(onlyCalls("/transactions/check").length).toBe(1);
  });

  test("limita quantas consultas saem por ciclo", async () => {
    const svc = newService({ timing: { ...FAST, maxChecksPerTick: 2 } });
    for (let i = 0; i < 5; i++) await svc.createCharge({ chatJid: CHAT, amount: 1 });
    await svc.tick();
    expect(onlyCalls("/transactions/check").length).toBe(2);
  });

  test("quando o limite de consultas do IP acaba, não consulta", async () => {
    const svc = newService({ limiter: new RateLimiter(0, 60_000) });
    await svc.createCharge({ chatJid: CHAT, amount: 1 });
    await svc.tick();
    expect(onlyCalls("/transactions/check").length).toBe(0);
    await expect(svc.checkNow(charges.list()[0]!.id)).rejects.toMatchObject({ code: "rate_limit" });
  });

  test("credenciais recusadas: para de consultar, avisa uma vez e retoma quando forem trocadas", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 1 });
    api.checkStatus = 401;
    await svc.tick();
    await svc.tick();
    await svc.tick();

    expect(onlyCalls("/transactions/check").length).toBe(1);
    expect(notifications.filter((n) => n.title.includes("recusou o login")).length).toBe(1);

    api.checkStatus = 200;
    api.states[charge.misticId!] = "COMPLETO";
    store.update({ clientSecret: "cs_novo" });
    await svc.tick();
    expect(charges.get(charge.id)!.status).toBe("paid");
  });

  test("429: dá um tempo em vez de insistir", async () => {
    const svc = newService();
    await svc.createCharge({ chatJid: CHAT, amount: 1 });
    api.checkStatus = 429;
    await svc.tick();
    await svc.tick();
    await svc.tick();
    expect(onlyCalls("/transactions/check").length).toBe(1);
  });

  test("sem internet: tenta de novo no próximo ciclo, sem marcar como falha", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 1 });

    const svcOffline = newService({ fetch: offline });
    await svcOffline.tick();
    expect(charges.get(charge.id)!.status).toBe("pending");
  });

  test("passou do prazo de acompanhamento: expira sem consultar", async () => {
    const svc = newService({ timing: { ...FAST, intervalFor: () => null } });
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 1 });
    await svc.tick();
    expect(charges.get(charge.id)!.status).toBe("expired");
    expect(onlyCalls("/transactions/check").length).toBe(0);
  });

  test("sem credenciais não consulta, mas continua tentando agradecimentos pendentes", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 1 });
    failSending = true;
    api.states[charge.misticId!] = "COMPLETO";
    await svc.tick();
    expect(charges.get(charge.id)!.thanksSent).toBe(false);

    failSending = false;
    store.update({ clientId: "", clientSecret: null, authHeader: null });
    await svc.tick();
    expect(charges.get(charge.id)!.thanksSent).toBe(true);
    expect(onlyCalls("/transactions/check").length).toBe(1);
  });

  test("o acompanhamento roda sozinho depois de start() e para com stop()", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 1 });
    api.states[charge.misticId!] = "COMPLETO";

    svc.start();
    await Bun.sleep(60);
    svc.stop();
    expect(charges.get(charge.id)!.status).toBe("paid");

    const before = api.calls.length;
    await Bun.sleep(30);
    expect(api.calls.length).toBe(before);
  });
});

describe("saque", () => {
  const base = { amount: 50, pixKeyType: "CPF", pixKey: "529.982.247-25", description: "Saque do mês" };

  test("pede o saque e guarda no histórico sem a chave completa", async () => {
    const record = await newService().withdraw(base);

    expect(onlyCalls("/transactions/withdraw")[0]!.body).toEqual({
      amount: 50, pixKey: VALID_CPF, pixKeyType: "CPF", description: "Saque do mês",
    });
    expect(record).toMatchObject({ kind: "withdraw", status: "pending", amountCents: 5000, misticId: "1001", pixKeyType: "CPF", pixKeyMasked: "•••••••4725" });
    expect(JSON.stringify(charges.list())).not.toContain(VALID_CPF);
  });

  test("acompanha até concluir e avisa (sem agradecer a ninguém)", async () => {
    const svc = newService();
    const record = await svc.withdraw(base);
    api.states[record.misticId!] = "COMPLETO";
    await svc.tick();

    expect(charges.get(record.id)!.status).toBe("paid");
    expect(notifications).toEqual([{ title: "Loja: saque concluído", body: "R$ 50,00 para a chave •••••••4725." }]);
    expect(outbox).toEqual([]);
  });

  test("a MisticPay recusa (ex.: saldo insuficiente): mostra o motivo e nada é salvo", async () => {
    api.withdrawStatus = 422;
    await expect(newService().withdraw(base)).rejects.toMatchObject({ code: "api", message: "Saldo insuficiente" });
    expect(charges.list()).toEqual([]);
  });

  test("valida valor, tipo e chave antes de chamar a API", async () => {
    const svc = newService();
    await expect(svc.withdraw({ ...base, amount: -1 })).rejects.toMatchObject({ code: "validation" });
    await expect(svc.withdraw({ ...base, pixKeyType: "OUTRO" })).rejects.toThrow("tipo da chave");
    await expect(svc.withdraw({ ...base, pixKey: "123" })).rejects.toThrow("chave PIX");
    await expect(svc.withdraw({ ...base, pixKeyType: "EMAIL", pixKey: "sem-arroba" })).rejects.toThrow("chave PIX");
    expect(api.calls.length).toBe(0);
  });

  test("não deixa sair o mesmo saque duas vezes seguidas (clique duplo)", async () => {
    const svc = newService();
    const [first, second] = await Promise.allSettled([svc.withdraw(base), svc.withdraw(base)]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(onlyCalls("/transactions/withdraw").length).toBe(1);

    // logo depois também é barrado; um saque diferente passa
    await expect(svc.withdraw(base)).rejects.toThrow("idêntico");
    await svc.withdraw({ ...base, amount: 51 });
    expect(onlyCalls("/transactions/withdraw").length).toBe(2);
  });

  test("com a integração desligada não saca", async () => {
    store.update({ enabled: false });
    await expect(newService().withdraw(base)).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("conta e configuração", () => {
  test("dados da conta", async () => {
    expect(await newService().accountInfo()).toMatchObject({ name: "Fulano", availableBalance: 100, blockedBalance: 5 });
  });

  test("testar credenciais novas sem salvar", async () => {
    const svc = newService();
    await svc.testConnection({ clientId: "ci_teste", clientSecret: "cs_teste" });
    expect(onlyCalls("/users/info")[0]!.auth).toBe("Basic " + Buffer.from("ci_teste:cs_teste").toString("base64"));
    expect(store.get().clientId).toBe("ci_1");
    expect(store.get().clientSecret).toBe("cs_1");
  });

  test("testar completa com o que já está salvo (só o Client ID novo, por exemplo)", async () => {
    await newService().testConnection({ clientId: "ci_outro" });
    expect(onlyCalls("/users/info")[0]!.auth).toBe("Basic " + Buffer.from("ci_outro:cs_1").toString("base64"));
  });

  test("testar sem credenciais dá erro claro", async () => {
    store.update({ clientId: "", clientSecret: null });
    await expect(newService().testConnection()).rejects.toBeInstanceOf(MisticError);
  });
});

describe("apoio", () => {
  test("telefone digitado vira número com DDI", () => {
    expect(normalizePhone("(11) 98888-0000")).toBe("5511988880000");
    expect(normalizePhone("11 3888-0000")).toBe("551138880000");
    expect(normalizePhone("+55 11 98888-0000")).toBe("5511988880000");
    expect(normalizePhone("+1 415 555 0123")).toBe("14155550123");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  test("chaves PIX por tipo", () => {
    expect(normalizePixKey("CPF", "529.982.247-25")).toBe(VALID_CPF);
    expect(normalizePixKey("CPF", "111.111.111-11")).toBeNull();
    expect(normalizePixKey("CNPJ", "11.222.333/0001-81")).toBe("11222333000181");
    expect(normalizePixKey("EMAIL", " Maria@Email.COM ")).toBe("maria@email.com");
    expect(normalizePixKey("EMAIL", "maria")).toBeNull();
    expect(normalizePixKey("TELEFONE", "(11) 98888-0000")).toBe("11988880000");
    expect(normalizePixKey("TELEFONE", "12")).toBeNull();
    expect(normalizePixKey("CHAVE_ALEATORIA", "123E4567-E89B-12D3-A456-426614174000")).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(normalizePixKey("CHAVE_ALEATORIA", "curta")).toBeNull();
  });

  test("as mensagens padrão existem", () => {
    expect(DEFAULT_CHARGE_MESSAGE).toContain("{valor}");
    expect(DEFAULT_THANKS_MESSAGE).toContain("{nome}");
  });
});

describe("copiar a cobrança (sem enviar) e cliente aleatório", () => {
  test("send:false cria a cobrança na MisticPay mas não manda nada no WhatsApp", async () => {
    const charge = await newService().createCharge({ chatJid: CHAT, amount: 30, description: "Corrida", send: false });

    expect(onlyCalls("/transactions/create").length).toBe(1);
    expect(outbox).toEqual([]);
    expect(charge).toMatchObject({ status: "pending", chatJid: CHAT, name: "Maria Silva", sendError: null, sent: { charge: false, code: false, qr: false } });
    expect(operatorActions).toEqual([CHAT]); // você está atendendo esse cliente
  });

  test("o texto para copiar tem a mensagem e o PIX copia e cola", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 30, description: "Corrida", send: false });
    const text = svc.chargeText(charge.id);

    expect(text).toContain("R$ 30,00");
    expect(text).toContain("Corrida");
    expect(text.endsWith("000201COPIACOLA1001")).toBe(true);
    expect(text.split("000201COPIACOLA1001").length).toBe(2); // o código aparece uma vez só
  });

  test("o modelo do texto é configurável e o PIX nunca fica de fora", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 12, send: false });

    store.update({ copyMessage: "Oi {nome}, são {valor}. PIX: {pix}" });
    expect(svc.chargeText(charge.id)).toBe("Oi Maria, são R$ 12,00. PIX: 000201COPIACOLA1001");

    // sem {pix} no modelo, o código vai no fim (copiar sem o PIX não serviria)
    store.update({ copyMessage: "Oi {nome}, são {valor}." });
    expect(svc.chargeText(charge.id)).toBe("Oi Maria, são R$ 12,00.\n\n000201COPIACOLA1001");
  });

  test("cliente aleatório: nome sorteado, descrição padrão, sem WhatsApp e sem envio", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ random: true, amount: 45 });

    const body = onlyCalls("/transactions/create")[0]!.body;
    expect(body.payerName).toMatch(/^\S+ \S+/); // Nome Sobrenome
    expect(body.description).toBe("Corrida");
    expect(body.payerDocument).toBe(VALID_CPF); // CPF: nunca inventado, vem do padrão salvo
    expect(charge).toMatchObject({ chatJid: null, phone: null, name: body.payerName, description: "Corrida", status: "pending", sendError: null });
    expect(outbox).toEqual([]);
    expect(operatorActions).toEqual([]); // não há conversa
    expect(svc.chargeText(charge.id)).toContain("R$ 45,00");
  });

  test("cliente aleatório respeita o nome e a descrição informados, e a descrição padrão é configurável", async () => {
    const svc = newService();
    await svc.createCharge({ random: true, amount: 5, payerName: "  Zé da Silva ", description: "Frete" });
    expect(onlyCalls("/transactions/create")[0]!.body).toMatchObject({ payerName: "Zé da Silva", description: "Frete" });

    store.update({ defaultDescription: "Entrega" });
    await svc.createCharge({ random: true, amount: 5 });
    expect(onlyCalls("/transactions/create")[1]!.body.description).toBe("Entrega");

    store.update({ defaultDescription: "" }); // sem padrão: vai como "Cobrança" e a lista fica sem descrição
    const charge = await svc.createCharge({ random: true, amount: 5 });
    expect(onlyCalls("/transactions/create")[2]!.body.description).toBe("Cobrança");
    expect(charge.description).toBe("");
  });

  test("cliente aleatório nunca envia, nem se pedirem send:true", async () => {
    await newService().createCharge({ random: true, send: true, amount: 5 });
    expect(outbox).toEqual([]);
  });

  test("cliente aleatório ainda exige o CPF (a MisticPay exige) e valor válido", async () => {
    store.update({ defaultPayerDocument: "" });
    await expect(newService().createCharge({ random: true, amount: 5 })).rejects.toThrow("exige um CPF");
    await expect(newService().createCharge({ random: true, amount: 0, payerDocument: VALID_CPF })).rejects.toMatchObject({ code: "validation" });
    expect(api.calls.length).toBe(0);
  });

  test("pagamento de cliente aleatório: avisa no computador e não tenta agradecer por WhatsApp", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ random: true, amount: 45, payerName: "Ana Souza" });
    api.states[charge.misticId!] = "COMPLETO";
    await svc.tick();
    await svc.tick();

    expect(charges.get(charge.id)).toMatchObject({ status: "paid", thanksSent: false, thanksAttempts: 0 });
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.body).toContain("Ana Souza");
    expect(outbox).toEqual([]);
  });

  test("não dá pra reenviar uma cobrança sem WhatsApp de destino", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ random: true, amount: 5 });
    await expect(svc.resend(charge.id)).rejects.toThrow("Copiar cobrança");
    expect(outbox).toEqual([]);
  });

  test("chargeText de cobrança inexistente ou de saque é recusado", async () => {
    const svc = newService();
    expect(() => svc.chargeText("nao-existe")).toThrow("não encontrada");
    const withdrawal = await svc.withdraw({ amount: 10, pixKeyType: "CPF", pixKey: VALID_CPF });
    expect(() => svc.chargeText(withdrawal.id)).toThrow("não encontrada");
  });
});

describe("pagamento confirmado avisa as métricas", () => {
  const withAliases = (paid: ChargeRecord[]) =>
    newService({
      onPaid: (record) => void paid.push({ ...record }),
      contacts: {
        find: (jid) => (jid.startsWith("5511977770000") ? { name: "Maria Silva", phone: "5511977770000" } : undefined),
        lookupPhone: async () => null,
        aliases: (jid) => (jid.startsWith("5511977770000") ? ["98765432100@lid", "5511977770000:12@s.whatsapp.net"] : []),
      },
    });

  test("chama onPaid uma vez, com todos os JIDs conhecidos do cliente", async () => {
    const paid: ChargeRecord[] = [];
    const svc = withAliases(paid);
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 32.9 });
    expect([...charge.contactJids].sort()).toEqual(["5511977770000@s.whatsapp.net", "98765432100@lid"]); // sem repetir, sem sufixo de aparelho

    expect(paid).toEqual([]); // ainda não pagou
    api.states[charge.misticId!] = "COMPLETO";
    await svc.tick();
    await svc.tick();

    expect(paid.length).toBe(1);
    expect(paid[0]).toMatchObject({ id: charge.id, status: "paid", amountCents: 3290, phone: "5511977770000" });
    expect(paid[0]!.paidAt).toBeGreaterThan(0);
  });

  test("cobrança para um número digitado também leva o telefone", async () => {
    const paid: ChargeRecord[] = [];
    const svc = newService({ onPaid: (r) => void paid.push({ ...r }) });
    const charge = await svc.createCharge({ phone: "(11) 98888-0000", amount: 10 });
    expect(charge.contactJids).toContain("5511988880000@s.whatsapp.net");
  });

  test("cliente aleatório (sem WhatsApp) também avisa, sem JIDs", async () => {
    const paid: ChargeRecord[] = [];
    const svc = withAliases(paid);
    const charge = await svc.createCharge({ random: true, amount: 45 });
    api.states[charge.misticId!] = "COMPLETO";
    await svc.tick();
    expect(paid.length).toBe(1);
    expect(paid[0]!.contactJids).toEqual([]);
  });

  test("se registrar nas métricas falhar, o pagamento continua valendo e o cliente é agradecido", async () => {
    const svc = newService({
      onPaid: () => {
        throw new Error("arquivo de métricas travado");
      },
    });
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 10 });
    outbox.length = 0;
    api.states[charge.misticId!] = "COMPLETO";
    await svc.tick();

    expect(charges.get(charge.id)).toMatchObject({ status: "paid", thanksSent: true });
    expect(outbox.length).toBe(1);
    expect(notifications.length).toBe(1);
  });
});

describe("excluir cobrança", () => {
  test("tira do histórico e do disco", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 10 });
    const other = await svc.createCharge({ chatJid: CHAT, amount: 20 });

    svc.deleteCharge(charge.id);

    expect(svc.list().map((c) => c.id)).toEqual([other.id]);
    expect(new ChargeStore(join(dir, "charges.json")).list().map((c) => c.id)).toEqual([other.id]);
  });

  test("uma cobrança excluída deixa de ser consultada na MisticPay", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 10 });
    svc.deleteCharge(charge.id);

    await svc.tick();
    expect(onlyCalls("/transactions/check").length).toBe(0);
  });

  test("dá pra excluir uma já paga e o extrato da MisticPay não é tocado", async () => {
    const svc = newService();
    const charge = await svc.createCharge({ chatJid: CHAT, amount: 10 });
    api.states[charge.misticId!] = "COMPLETO";
    await svc.tick();
    expect(charges.get(charge.id)!.status).toBe("paid");

    const callsBefore = api.calls.length;
    svc.deleteCharge(charge.id);
    expect(charges.get(charge.id)).toBeUndefined();
    expect(api.calls.length).toBe(callsBefore); // só o histórico local
  });

  test("cobrança inexistente e saque não podem ser excluídos por aqui", async () => {
    const svc = newService();
    expect(() => svc.deleteCharge("nao-existe")).toThrow("não encontrada");

    const withdrawal = await svc.withdraw({ amount: 10, pixKeyType: "CPF", pixKey: VALID_CPF });
    expect(() => svc.deleteCharge(withdrawal.id)).toThrow("não encontrada");
    expect(charges.get(withdrawal.id)).toBeDefined(); // o registro do saque continua
  });

  test("excluir no meio do envio interrompe o resto das mensagens sem erro", async () => {
    let removed = false;
    const svc = newService({
      sender: {
        sendText: async (chatJid, text) => {
          outbox.push({ kind: "text", chatJid, text });
          if (!removed) {
            removed = true;
            charges.remove(charges.list()[0]!.id); // o operador exclui logo depois da 1ª mensagem
          }
        },
        sendImage: async (chatJid, image, caption) => void outbox.push({ kind: "image", chatJid, text: caption, bytes: image.length }),
      },
    });

    await svc.createCharge({ chatJid: CHAT, amount: 10 });
    expect(outbox.map((m) => m.kind)).toEqual(["text"]); // sem o código nem o QR Code
    expect(charges.list()).toEqual([]);
  });
});
