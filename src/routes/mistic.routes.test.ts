import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountManager } from "../core/account-manager";
import type { Account } from "../core/account";
import { MISTIC_BASE_URL } from "../services/mistic/client";
import { RateLimiter } from "../services/mistic/rate-limiter";
import type { MisticTiming } from "../services/mistic/service";
import { fakeConnections, privateText, tempDirs, type FakeConnection } from "../testing/fakes";
import { handleApiRequest } from ".";

const CLIENT = "5511977770000@s.whatsapp.net";
const VALID_CPF = "52998224725";
const SECRET = "cs_SEGREDO_super_secreto_123";
const AUTH_HEADER = "Basic SEGREDO_DO_HEADER";

const FAST: MisticTiming = { tickMs: 1000, maxChecksPerTick: 5, messageGapMs: 0, thanksRetryGapMs: 0, intervalFor: () => 0 };

let dirs: ReturnType<typeof tempDirs>;
let manager: AccountManager;
let account: Account;
let connection: FakeConnection;
let created: FakeConnection[];
let notifications: string[];

/** MisticPay de mentira, compartilhada pelas contas do teste. */
let states: Record<string, string>;
let misticCalls: Array<{ path: string; auth: string; body?: any }>;
let nextId: number;
let rejectCreate = false;

const fakeFetch = (async (url: string, init: RequestInit) => {
  const path = String(url).replace(MISTIC_BASE_URL, "");
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  misticCalls.push({ path, auth: String((init.headers as Record<string, string>)["Authorization"]), body });
  const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });

  if (path === "/users/info") {
    return reply(200, { data: { name: "Maria Gomes", email: "m@x.com", document: "52998224725", phone: "11999999999", accountVerified: true, documentVerified: true, withdrawBlocked: false, availableBalance: 850, blockedBalance: 150 } });
  }
  if (path === "/transactions/create") {
    if (rejectCreate) return reply(422, { error: "Conta bloqueada" });
    const id = String(nextId++);
    states[id] = "PENDENTE";
    return reply(200, { data: { transactionId: id, transactionState: "PENDENTE", copyPaste: `000201PIX${id}` } });
  }
  if (path === "/transactions/check") {
    return states[body.transactionId]
      ? reply(200, { transaction: { transactionId: body.transactionId, transactionState: states[body.transactionId], value: 1, fee: 0 } })
      : reply(404, {});
  }
  if (path === "/transactions/withdraw") {
    const id = String(nextId++);
    states[id] = "PENDENTE";
    return reply(200, { data: { transactionId: id, jobId: `job-${id}`, status: "QUEUED" } });
  }
  if (path.startsWith("/users/transactions/list/")) {
    return reply(200, { data: [{ id: 1, value: 5, fee: 0.1, clientName: "Zé", description: "x", transactionState: "COMPLETO", transactionType: "DEPOSITO", transactionMethod: "PIX", createdAt: "2026-01-01T00:00:00Z" }], pagination: { page: 1, totalPages: 1, total: 1 } });
  }
  return reply(404, {});
}) as unknown as typeof fetch;

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

const cfg = { enabled: true, clientId: "ci_123", clientSecret: SECRET, defaultPayerDocument: VALID_CPF };

beforeEach(() => {
  dirs = tempDirs();
  notifications = [];
  states = {};
  misticCalls = [];
  nextId = 5000;
  rejectCreate = false;
  const fake = fakeConnections();
  created = fake.created;
  manager = new AccountManager({
    appDataDir: dirs.appDataDir,
    tempDir: dirs.tempDir,
    createConnection: fake.factory,
    notify: (title, body) => void notifications.push(`${title} | ${body}`),
    mistic: { fetch: fakeFetch, timing: FAST, limiter: new RateLimiter(1000, 60_000) },
    greetingTiming: { quietWindowMs: 20, maxWaitMs: 100, typingDelayMs: () => 1 },
    guardTimeoutMs: () => 60_000,
  });
  account = manager.get("default")!;
  connection = created[0]!;
  connection.connected = true;
});

afterEach(() => {
  manager.stopAll();
  dirs.cleanup();
});

describe("configuração da MisticPay", () => {
  test("começa desligada e sem credenciais", async () => {
    const { json } = await api("GET", "/accounts/default/mistic/config");
    expect(json).toMatchObject({ enabled: false, configured: false, hasSecret: false, hasAuthHeader: false, floatMode: "conversation", activeWindowMinutes: 30, sendQr: true, sendThanks: true });
    expect(json.defaults.chargeMessage).toContain("{valor}");
  });

  test("o Client Secret e o header de autenticação NUNCA voltam pro painel", async () => {
    const put = await api("PUT", "/accounts/default/mistic/config", { ...cfg, authHeader: AUTH_HEADER });
    expect(put.json).toMatchObject({ enabled: true, configured: true, clientId: "ci_123", hasSecret: true, hasAuthHeader: true });

    const get = await api("GET", "/accounts/default/mistic/config");
    for (const text of [put.text, get.text]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("SEGREDO_DO_HEADER");
      expect(text).not.toContain("clientSecret");
      expect(text).not.toContain("authHeader");
    }
    // e a configuração geral do bot também não vaza
    const general = await api("GET", "/accounts/default/settings");
    expect(general.text).not.toContain(SECRET);
  });

  test("segredo vazio mantém o salvo; null apaga", async () => {
    await api("PUT", "/accounts/default/mistic/config", cfg);
    await api("PUT", "/accounts/default/mistic/config", { clientSecret: "", authHeader: "" });
    expect(account.misticSettings.get().clientSecret).toBe(SECRET);

    const cleared = await api("PUT", "/accounts/default/mistic/config", { clientSecret: null });
    expect(cleared.json.hasSecret).toBe(false);
    expect(cleared.json.configured).toBe(false);
  });

  test("valida o CPF padrão e o modo do botão", async () => {
    expect((await api("PUT", "/accounts/default/mistic/config", { defaultPayerDocument: "111.111.111-11" })).status).toBe(400);
    expect((await api("PUT", "/accounts/default/mistic/config", { floatMode: "sempre" })).status).toBe(400);
    expect((await api("PUT", "/accounts/default/mistic/config", { defaultPayerDocument: "529.982.247-25", floatMode: "always", activeWindowMinutes: 45 })).json).toMatchObject({
      defaultPayerDocument: VALID_CPF, floatMode: "always", activeWindowMinutes: 45,
    });
  });

  test("a configuração é de cada conta", async () => {
    const b = await manager.create("Segunda");
    await api("PUT", "/accounts/default/mistic/config", cfg);
    expect((await api("GET", `/accounts/${b.id}/mistic/config`)).json).toMatchObject({ enabled: false, clientId: "" });
  });

  test("testar a conexão com credenciais novas não salva nada", async () => {
    const res = await api("POST", "/accounts/default/mistic/test", { clientId: "ci_novo", clientSecret: "cs_novo" });
    expect(res.status).toBe(200);
    expect(res.json.info).toMatchObject({ name: "Maria Gomes", availableBalance: 850, blockedBalance: 150 });
    expect(res.json.info.document).toBe("•••••••4725"); // documento mascarado
    expect(misticCalls[0]!.auth).toBe("Basic " + Buffer.from("ci_novo:cs_novo").toString("base64"));
    expect(account.misticSettings.get().clientId).toBe("");
  });

  test("dados da conta e extrato", async () => {
    await api("PUT", "/accounts/default/mistic/config", cfg);
    const info = await api("GET", "/accounts/default/mistic/account");
    expect(info.json.info).toMatchObject({ name: "Maria Gomes", accountVerified: true, withdrawBlocked: false, availableBalance: 850 });

    const statement = await api("GET", "/accounts/default/mistic/statement?page=1&status=COMPLETO");
    expect(statement.json.items[0]).toMatchObject({ value: 5, state: "COMPLETO", type: "DEPOSITO" });
    expect(misticCalls.at(-1)!.path).toBe("/users/transactions/list/1?status=COMPLETO");
  });

  test("sem credenciais os endpoints avisam o que fazer", async () => {
    const res = await api("GET", "/accounts/default/mistic/account");
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("Client ID");
  });
});

describe("conversas (de quem é o botão flutuante)", () => {
  test("cliente escreve no privado: vira conversa ativa, com nome e número", async () => {
    await connection.deliver(privateText(CLIENT, "Oi, tem carro?", { pushName: "Maria Silva" }));

    const { json } = await api("GET", "/accounts/default/conversations");
    expect(json.activeWindowMinutes).toBe(30);
    expect(json.conversations).toEqual([
      expect.objectContaining({ chatJid: CLIENT, phone: "5511977770000", name: "Maria Silva", lastFrom: "client", active: true }),
    ]);
  });

  test("você responde: continua a mesma conversa, agora com a sua mensagem por último", async () => {
    await connection.deliver(privateText(CLIENT, "Oi", { pushName: "Maria" }));
    await connection.deliver(privateText(CLIENT, "Já vou!", { fromMe: true }));

    const { json } = await api("GET", "/accounts/default/conversations");
    expect(json.conversations.length).toBe(1);
    expect(json.conversations[0]).toMatchObject({ lastFrom: "operator", name: "Maria" });
  });

  test("mensagens do próprio bot não contam como conversa sua", async () => {
    account.sent.mark("BOT1");
    await connection.deliver(privateText(CLIENT, "Olá! (saudação)", { fromMe: true, id: "BOT1" }));
    expect((await api("GET", "/accounts/default/conversations")).json.conversations).toEqual([]);
  });

  test("conversa antiga deixa de estar ativa (mas continua na lista)", async () => {
    const oldSeconds = Math.floor(Date.now() / 1000) - 3 * 3600;
    // o backlog anterior à ativação do bot é ignorado, então simulamos com o rastreador direto
    account.conversations.touch({ chatJid: CLIENT, jids: [], phone: "5511977770000", name: "Maria", from: "client", at: oldSeconds * 1000 });

    const { json } = await api("GET", "/accounts/default/conversations");
    expect(json.conversations[0].active).toBe(false);

    await api("PUT", "/accounts/default/mistic/config", { activeWindowMinutes: 300 });
    expect((await api("GET", "/accounts/default/conversations")).json.conversations[0].active).toBe(true);
  });

  test("grupos, status e banidos não entram", async () => {
    await connection.deliver({ key: { remoteJid: "1203@g.us", participant: CLIENT, fromMe: false, id: "G1" }, message: { conversation: "oi grupo" } } as never);
    await connection.deliver(privateText("status@broadcast", "meu status"));
    account.bans.ban(CLIENT, "Fulano");
    await connection.deliver(privateText(CLIENT, "Oi, sou banido"));
    expect((await api("GET", "/accounts/default/conversations")).json.conversations).toEqual([]);
  });
});

describe("cobrança de ponta a ponta", () => {
  beforeEach(async () => {
    await api("PUT", "/accounts/default/mistic/config", cfg);
    await connection.deliver(privateText(CLIENT, "Oi, quanto fica até o aeroporto?", { pushName: "Maria Silva" }));
  });

  test("cobra da conversa: o cliente recebe mensagem, copia e cola e QR Code", async () => {
    const res = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 32.9, description: "Corrida até o aeroporto" });
    expect(res.status).toBe(200);
    expect(res.json.charge).toMatchObject({ status: "pending", amountCents: 3290, name: "Maria Silva", phone: "5511977770000", sendError: null, sent: { charge: true, code: true, qr: true } });

    const sent = connection.sock.sent.filter((m) => m.jid === CLIENT);
    expect(sent.length).toBe(3);
    expect(String(sent[0]!.content.text)).toContain("R$ 32,90");
    expect(String(sent[0]!.content.text)).toContain("Corrida até o aeroporto");
    expect(sent[1]!.content.text).toBe("000201PIX5000");
    expect(Buffer.isBuffer(sent[2]!.content["image"])).toBe(true);

    // o CPF padrão foi como pagador e o valor foi em reais
    const create = misticCalls.find((c) => c.path === "/transactions/create")!;
    expect(create.body).toMatchObject({ amount: 32.9, payerName: "Maria Silva", payerDocument: VALID_CPF, description: "Corrida até o aeroporto" });
    expect(create.auth).toBe("Basic " + Buffer.from(`ci_123:${SECRET}`).toString("base64"));
  });

  test("as mensagens da cobrança são do bot: o eco delas não cancela a segurança", async () => {
    account.settings.update({ autoShutdownEnabled: true });
    await connection.deliver(privateText(CLIENT, "Oi de novo")); // começa a contagem
    expect(account.guard.pendingCount).toBe(1);

    await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 10 });
    // criar a cobrança é você atendendo → a contagem é satisfeita
    expect(account.guard.pendingCount).toBe(0);

    // o cliente escreve de novo e o WhatsApp devolve as mensagens do bot como fromMe: não valem como resposta
    await connection.deliver(privateText(CLIENT, "ok, vou pagar"));
    expect(account.guard.pendingCount).toBe(1);
    for (const m of connection.sock.sent.filter((s) => s.jid === CLIENT)) {
      await connection.deliver(privateText(CLIENT, String(m.content.text ?? "(qr)"), { fromMe: true, id: m.options!.messageId }));
    }
    expect(account.guard.pendingCount).toBe(1);
  });

  test("criar a cobrança cancela a saudação automática que estava pra sair", async () => {
    account.bot.setGroups([{ jid: "1203@g.us", name: "G", hasPicture: false }]);
    account.bot.setGroupEnabled("1203@g.us", true);
    for (const rule of [...account.keywords.list()]) account.keywords.delete(rule.id);
    account.keywords.create({ keywords: ["uber on"], responses: ["pv"], greetingEnabled: true });

    await connection.deliver({ key: { remoteJid: "1203@g.us", participant: CLIENT, fromMe: false, id: "G9" }, message: { conversation: "uber on" }, pushName: "Maria" } as never);
    await connection.deliver(privateText(CLIENT, "Oi"));
    await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 10 });

    await Bun.sleep(150);
    // só as 3 mensagens da cobrança: a saudação de endereços não foi enviada por cima
    expect(connection.sock.sent.filter((m) => m.jid === CLIENT).length).toBe(3);
  });

  test("pagou → o sistema identifica e o cliente recebe o agradecimento", async () => {
    const { json } = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 32.9 });
    const charge = json.charge;
    connection.sock.sent.length = 0;

    await account.mistic.tick(); // ainda não pagou
    expect(connection.sock.sent).toEqual([]);

    states[charge.misticId] = "COMPLETO";
    await account.mistic.tick();

    expect(connection.sock.textsTo(CLIENT)).toEqual(["✅ Pagamento de R$ 32,90 recebido! Muito obrigado, Maria! 🙏"]);
    expect(notifications).toEqual(["WhatsApp 1: pagamento recebido | R$ 32,90 de Maria Silva."]);

    const list = (await api("GET", "/accounts/default/mistic/charges")).json.charges;
    expect(list[0]).toMatchObject({ id: charge.id, status: "paid", thanksSent: true });
  });

  test("mensagens configuráveis pelo painel valem na hora", async () => {
    await api("PUT", "/accounts/default/mistic/config", {
      chargeMessage: "Oi {nome}, são {valor}.",
      qrCaption: "QR de {valor}",
      thanksMessage: "Pago! Valeu, {nome} 🚗",
    });
    const { json } = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 10 });
    const sent = connection.sock.sent.filter((m) => m.jid === CLIENT);
    expect(sent[0]!.content.text).toBe("Oi Maria, são R$ 10,00.");
    expect(sent[2]!.content["caption"]).toBe("QR de R$ 10,00");

    connection.sock.sent.length = 0;
    states[json.charge.misticId] = "COMPLETO";
    await account.mistic.tick();
    expect(connection.sock.textsTo(CLIENT)).toEqual(["Pago! Valeu, Maria 🚗"]);
  });

  test("cliente que ainda não está nas conversas: cobra pelo número (confere no WhatsApp)", async () => {
    connection.sock.registered["5511988880000"] = "5511988880000@s.whatsapp.net";
    const ok = await api("POST", "/accounts/default/mistic/charges", { phone: "(11) 98888-0000", amount: 5, payerName: "Carlos" });
    expect(ok.status).toBe(200);
    // cobrança + copia e cola + QR Code (o QR não é texto, então textsTo conta 3 entradas: a legenda vazia dele)
    expect(connection.sock.sent.filter((m) => m.jid === "5511988880000@s.whatsapp.net").length).toBe(3);

    const notFound = await api("POST", "/accounts/default/mistic/charges", { phone: "11 90000-0000", amount: 5 });
    expect(notFound.status).toBe(400);
    expect(notFound.json.error).toContain("WhatsApp");
  });

  test("erros voltam com a explicação certa e não criam nada", async () => {
    const noAmount = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 0 });
    expect(noAmount.status).toBe(400);

    const badCpf = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 5, payerDocument: "111.111.111-11" });
    expect(badCpf.status).toBe(400);
    expect(badCpf.json.error).toContain("CPF");

    rejectCreate = true;
    const refused = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 5 });
    expect(refused.status).toBe(502);
    expect(refused.json.error).toBe("Conta bloqueada");

    account.misticSettings.update({ enabled: false });
    expect((await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 5 })).status).toBe(409);

    expect(account.charges.list()).toEqual([]);
  });

  test("sem CPF nenhum a cobrança é recusada com a explicação (a MisticPay exige o CPF) e nada é criado", async () => {
    account.misticSettings.update({ defaultPayerDocument: "" });
    const res = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 5 });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("exige um CPF");
    expect(misticCalls.some((c) => c.path === "/transactions/create")).toBe(false);
    expect(account.charges.list()).toEqual([]);

    // Com o CPF digitado no formulário passa, e ele vai só com dígitos
    const ok = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 5, payerDocument: "529.982.247-25" });
    expect(ok.status).toBe(200);
    expect(misticCalls.find((c) => c.path === "/transactions/create")!.body.payerDocument).toBe(VALID_CPF);
  });

  test("WhatsApp desconectado: a cobrança é criada, o erro aparece e dá pra reenviar", async () => {
    connection.connected = false;
    const res = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 5 });
    expect(res.status).toBe(200);
    expect(res.json.charge.sendError).toContain("desconectado");
    expect(res.json.charge.sent).toEqual({ charge: false, code: false, qr: false });

    connection.connected = true;
    const resent = await api("POST", `/accounts/default/mistic/charges/${res.json.charge.id}/resend`);
    expect(resent.json.charge).toMatchObject({ sendError: null, sent: { charge: true, code: true, qr: true } });
  });

  test("verificar agora pelo painel", async () => {
    const { json } = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 5 });
    states[json.charge.misticId] = "COMPLETO";
    const checked = await api("POST", `/accounts/default/mistic/charges/${json.charge.id}/check`);
    expect(checked.json.charge.status).toBe("paid");
    expect((await api("POST", "/accounts/default/mistic/charges/nao-existe/check")).status).toBe(400);
  });

  test("as cobranças são de cada conta", async () => {
    const b = await manager.create("Segunda");
    await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 5 });
    expect((await api("GET", `/accounts/${b.id}/mistic/charges`)).json.charges).toEqual([]);
  });
});

describe("saque", () => {
  beforeEach(async () => {
    await api("PUT", "/accounts/default/mistic/config", cfg);
  });

  test("pede o saque e ele aparece no histórico sem a chave completa", async () => {
    const res = await api("POST", "/accounts/default/mistic/withdraw", { amount: 100, pixKeyType: "CPF", pixKey: "529.982.247-25", description: "Retirada" });
    expect(res.status).toBe(200);
    expect(res.json.withdrawal).toMatchObject({ kind: "withdraw", status: "pending", amountCents: 10000, pixKeyType: "CPF", pixKeyMasked: "•••••••4725" });
    expect(res.text).not.toContain(VALID_CPF);
    expect(misticCalls.find((c) => c.path === "/transactions/withdraw")!.body).toEqual({ amount: 100, pixKey: VALID_CPF, pixKeyType: "CPF", description: "Retirada" });

    const list = await api("GET", "/accounts/default/mistic/charges");
    expect(list.text).not.toContain(VALID_CPF);
  });

  test("valida e barra repetição", async () => {
    expect((await api("POST", "/accounts/default/mistic/withdraw", { amount: 10, pixKeyType: "CPF", pixKey: "123" })).status).toBe(400);
    expect((await api("POST", "/accounts/default/mistic/withdraw", { amount: 10, pixKeyType: "EMAIL", pixKey: "a@b.co" })).status).toBe(200);
    const again = await api("POST", "/accounts/default/mistic/withdraw", { amount: 10, pixKeyType: "EMAIL", pixKey: "a@b.co" });
    expect(again.status).toBe(400);
    expect(again.json.error).toContain("idêntico");
  });

  test("com a integração desligada não saca", async () => {
    await api("PUT", "/accounts/default/mistic/config", { enabled: false });
    expect((await api("POST", "/accounts/default/mistic/withdraw", { amount: 10, pixKeyType: "EMAIL", pixKey: "a@b.co" })).status).toBe(409);
  });
});

describe("métricas preenchidas pelo pagamento", () => {
  beforeEach(() => {
    account.misticSettings.update(cfg);
  });

  const trigger = () => account.leads.recordTrigger({ ruleId: "r1", groupJid: "g@g.us", groupName: "Grupo Centro", callerJid: CLIENT, callerName: "Maria Silva" });

  test("pagou → a corrida da pessoa vira 'Fechou' com o valor recebido, e o /leads já mostra", async () => {
    const lead = trigger();
    account.leads.markPrivateContact(CLIENT);

    const before = await api("GET", "/accounts/default/leads");
    expect(before.json.leads[0]).toMatchObject({ id: lead.id, status: "pending", value: null });
    expect(before.json.payments).toEqual({ todayCents: 0, todayCount: 0, monthCents: 0, monthCount: 0 });

    const created = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 32.9 });
    await account.mistic.tick(); // ainda não pagou
    expect((await api("GET", "/accounts/default/leads")).json.leads[0].status).toBe("pending");

    states[created.json.charge.misticId] = "COMPLETO";
    await account.mistic.tick();

    const after = await api("GET", "/accounts/default/leads");
    expect(after.json.leads[0]).toMatchObject({ id: lead.id, status: "closed", value: 32.9, paidAmount: 32.9, chargeId: created.json.charge.id });
    expect(after.json.payments).toEqual({ todayCents: 3290, todayCount: 1, monthCents: 3290, monthCount: 1 });
  });

  test("pagamento de quem não tem corrida nas métricas entra no recebido, sem mexer nas corridas", async () => {
    const other = account.leads.recordTrigger({ ruleId: "r1", groupJid: "g@g.us", groupName: "Grupo", callerJid: "5511900001111@s.whatsapp.net", callerName: "Outro" });

    const created = await api("POST", "/accounts/default/mistic/charges", { random: true, amount: 45 });
    states[created.json.charge.misticId] = "COMPLETO";
    await account.mistic.tick();

    const res = await api("GET", "/accounts/default/leads");
    expect(res.json.leads.find((l: any) => l.id === other.id)).toMatchObject({ status: "pending", value: null });
    expect(res.json.payments).toMatchObject({ todayCents: 4500, todayCount: 1 });
  });

  test("saque concluído não entra no recebido", async () => {
    const withdrawal = await api("POST", "/accounts/default/mistic/withdraw", { amount: 100, pixKeyType: "CPF", pixKey: VALID_CPF });
    states[withdrawal.json.withdrawal.misticId] = "COMPLETO";
    await account.mistic.tick();
    expect((await api("GET", "/accounts/default/leads")).json.payments.todayCents).toBe(0);
  });
});

describe("copiar cobrança, cliente aleatório e excluir", () => {
  beforeEach(() => {
    account.misticSettings.update(cfg);
  });

  test("configuração: descrição padrão 'Corrida' e modelo do texto para copiar", async () => {
    const before = await api("GET", "/accounts/default/mistic/config");
    expect(before.json.defaultDescription).toBe("Corrida");
    expect(before.json.defaults.copyMessage).toContain("{pix}");
    expect(before.json.defaults.defaultDescription).toBe("Corrida");

    const put = await api("PUT", "/accounts/default/mistic/config", { defaultDescription: "  Frete ", copyMessage: "Pague {valor}: {pix}" });
    expect(put.json).toMatchObject({ defaultDescription: "Frete", copyMessage: "Pague {valor}: {pix}" });
  });

  test("sorteia um nome", async () => {
    const res = await api("GET", "/accounts/default/mistic/random-name");
    expect(res.status).toBe(200);
    expect(res.json.name).toMatch(/^[^\s]+ [^\s]+/);
  });

  test("cliente aleatório: cria, não manda nada no WhatsApp e devolve o texto pronto para colar", async () => {
    const before = connection.sock.sent.length;
    const res = await api("POST", "/accounts/default/mistic/charges", { random: true, amount: 25, payerName: "Ana Souza" });

    expect(res.status).toBe(200);
    expect(res.json.charge).toMatchObject({ chatJid: null, phone: null, name: "Ana Souza", description: "Corrida", status: "pending" });
    expect(res.json.text).toContain("R$ 25,00");
    expect(res.json.text).toContain("Corrida");
    expect(res.json.text.endsWith("000201PIX5000")).toBe(true);
    expect(connection.sock.sent.length).toBe(before);
    expect(misticCalls.find((c) => c.path === "/transactions/create")!.body).toMatchObject({ payerName: "Ana Souza", description: "Corrida", payerDocument: VALID_CPF });
  });

  test("send:false com uma conversa: cria e devolve o texto, sem enviar", async () => {
    const before = connection.sock.sent.length;
    const res = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 8, send: false });
    expect(res.status).toBe(200);
    expect(res.json.charge).toMatchObject({ chatJid: CLIENT, sent: { charge: false, code: false, qr: false } });
    expect(res.json.text).toContain("000201PIX5000");
    expect(connection.sock.sent.length).toBe(before);
  });

  test("o envio normal continua como antes (sem 'text' na resposta)", async () => {
    const res = await api("POST", "/accounts/default/mistic/charges", { chatJid: CLIENT, amount: 8 });
    expect(res.status).toBe(200);
    expect(res.json.text).toBeUndefined();
    expect(res.json.charge.sent).toEqual({ charge: true, code: true, qr: true });
  });

  test("texto de uma cobrança já criada (botão 'Copiar cobrança' do histórico)", async () => {
    const created = await api("POST", "/accounts/default/mistic/charges", { random: true, amount: 12 });
    const res = await api("GET", `/accounts/default/mistic/charges/${created.json.charge.id}/text`);
    expect(res.status).toBe(200);
    expect(res.json.text).toBe(created.json.text);

    expect((await api("GET", "/accounts/default/mistic/charges/nao-existe/text")).status).toBe(400);
  });

  test("excluir: some da lista; inexistente dá erro; saque não pode", async () => {
    const a = await api("POST", "/accounts/default/mistic/charges", { random: true, amount: 12 });
    const b = await api("POST", "/accounts/default/mistic/charges", { random: true, amount: 13 });

    const del = await api("DELETE", `/accounts/default/mistic/charges/${a.json.charge.id}`);
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true });

    const list = await api("GET", "/accounts/default/mistic/charges");
    expect(list.json.charges.map((c: any) => c.id)).toEqual([b.json.charge.id]);

    expect((await api("DELETE", `/accounts/default/mistic/charges/${a.json.charge.id}`)).status).toBe(400);

    const withdrawal = await api("POST", "/accounts/default/mistic/withdraw", { amount: 10, pixKeyType: "CPF", pixKey: VALID_CPF });
    expect((await api("DELETE", `/accounts/default/mistic/charges/${withdrawal.json.withdrawal.id}`)).status).toBe(400);
  });

  test("reenviar uma cobrança sem WhatsApp explica o que fazer", async () => {
    const created = await api("POST", "/accounts/default/mistic/charges", { random: true, amount: 12 });
    const res = await api("POST", `/accounts/default/mistic/charges/${created.json.charge.id}/resend`);
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("Copiar cobrança");
  });
});
