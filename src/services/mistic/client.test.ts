import { describe, expect, test } from "bun:test";
import { MisticClient, MisticError, MISTIC_BASE_URL, type MisticCredentials } from "./client";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** fetch de mentira: responde com o que o teste mandar e anota a chamada. */
function fakeFetch(respond: (call: Call) => { status?: number; json?: unknown } | Error) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const out = respond(call);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out.json ?? {}), {
      status: out.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const CREDS: MisticCredentials = { clientId: "ci_abc", clientSecret: "cs_xyz" };

function client(respond: Parameters<typeof fakeFetch>[0], creds: MisticCredentials = CREDS) {
  const fake = fakeFetch(respond);
  return { api: new MisticClient(() => creds, fake.impl), calls: fake.calls };
}

describe("autenticação", () => {
  test("monta o Basic com Client ID e Client Secret", async () => {
    const { api, calls } = client(() => ({ json: { data: { balance: 10 } } }));
    await api.getBalance();

    const expected = "Basic " + Buffer.from("ci_abc:cs_xyz").toString("base64");
    expect(calls[0]!.headers["Authorization"]).toBe(expected);
    expect(calls[0]!.url).toBe(`${MISTIC_BASE_URL}/users/balance`);
  });

  test("o header informado à mão vale no lugar do montado", async () => {
    const { api, calls } = client(() => ({ json: { data: { balance: 1 } } }), { ...CREDS, authHeader: "Basic PRONTO123" });
    await api.getBalance();
    expect(calls[0]!.headers["Authorization"]).toBe("Basic PRONTO123");
  });

  test("só o header à mão já basta (sem Client ID/Secret)", async () => {
    const { api, calls } = client(() => ({ json: { data: { balance: 1 } } }), { clientId: "", clientSecret: "", authHeader: "Basic X" });
    await api.getBalance();
    expect(calls.length).toBe(1);
  });

  test("sem credenciais nem chama a API", async () => {
    const { api, calls } = client(() => ({}), { clientId: "", clientSecret: "  " });
    await expect(api.getBalance()).rejects.toMatchObject({ code: "not_configured" });
    expect(calls.length).toBe(0);
  });

  test("espaços em volta das credenciais não atrapalham", async () => {
    const { api, calls } = client(() => ({ json: { data: {} } }), { clientId: "  ci_abc ", clientSecret: " cs_xyz\n" });
    await api.getBalance();
    expect(calls[0]!.headers["Authorization"]).toBe("Basic " + Buffer.from("ci_abc:cs_xyz").toString("base64"));
  });
});

describe("dados da conta", () => {
  test("lê nome, verificação e saldos", async () => {
    const { api, calls } = client(() => ({
      json: {
        data: {
          name: "João Silva", email: "joao@email.com", document: "12345678909", phone: "11999999999",
          accountVerified: true, documentVerified: true, withdrawBlocked: false, availableBalance: 850, blockedBalance: 150,
        },
      },
    }));
    const info = await api.getUserInfo();
    expect(calls[0]!.url).toBe(`${MISTIC_BASE_URL}/users/info`);
    expect(info).toEqual({
      name: "João Silva", email: "joao@email.com", document: "12345678909", phone: "11999999999",
      accountVerified: true, documentVerified: true, withdrawBlocked: false, availableBalance: 850, blockedBalance: 150,
    });
  });

  test("resposta incompleta não quebra", async () => {
    const { api } = client(() => ({ json: {} }));
    expect(await api.getUserInfo()).toMatchObject({ name: "", availableBalance: 0, withdrawBlocked: false });
  });
});

describe("cobrança", () => {
  test("cria a cobrança e devolve o copia e cola e o número da transação", async () => {
    const { api, calls } = client(() => ({
      json: {
        message: "Transação criada com sucesso",
        data: {
          transactionId: "31484480", transactionState: "PENDENTE", transactionAmount: 455,
          qrCodeBase64: "data:image/png;base64,AAA", qrcodeUrl: "https://qr/x", copyPaste: "000201...",
        },
      },
    }));
    const result = await api.createDeposit({
      amount: 4.55, payerName: "Maria", payerDocument: "12345678909", transactionId: "brinzy-1", description: "Corrida",
    });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${MISTIC_BASE_URL}/transactions/create`);
    expect(calls[0]!.body).toEqual({
      amount: 4.55, payerName: "Maria", payerDocument: "12345678909", transactionId: "brinzy-1", description: "Corrida",
    });
    expect(result).toEqual({
      transactionId: "31484480", state: "PENDENTE", copyPaste: "000201...", qrCodeBase64: "data:image/png;base64,AAA", qrCodeUrl: "https://qr/x",
    });
  });

  test("resposta sem o número da transação é erro", async () => {
    const { api } = client(() => ({ json: { data: {} } }));
    await expect(
      api.createDeposit({ amount: 1, payerName: "x", payerDocument: "1", transactionId: "t", description: "d" })
    ).rejects.toMatchObject({ code: "api" });
  });

  test("consulta o estado da transação", async () => {
    const { api, calls } = client(() => ({
      json: { message: "ok", transaction: { transactionId: "301.6", value: 1.12, fee: 0.31, transactionState: "COMPLETO" } },
    }));
    const result = await api.checkTransaction("31484480");
    expect(calls[0]!.url).toBe(`${MISTIC_BASE_URL}/transactions/check`);
    expect(calls[0]!.body).toEqual({ transactionId: "31484480" });
    expect(result).toEqual({ transactionId: "301.6", state: "COMPLETO", value: 1.12, fee: 0.31 });
  });

  test("transação não encontrada", async () => {
    const { api } = client(() => ({ json: { message: "sem transação" } }));
    await expect(api.checkTransaction("1")).rejects.toMatchObject({ code: "api", status: 404 });
  });
});

describe("saque", () => {
  test("pede o saque com chave PIX", async () => {
    const { api, calls } = client(() => ({
      json: { message: "fila", data: { jobId: "withdraw-4-1", transactionId: 54345, status: "QUEUED" } },
    }));
    const result = await api.withdraw({ amount: 10.5, pixKey: "12345678909", pixKeyType: "CPF", description: "saque" });

    expect(calls[0]!.url).toBe(`${MISTIC_BASE_URL}/transactions/withdraw`);
    expect(calls[0]!.body).toEqual({ amount: 10.5, pixKey: "12345678909", pixKeyType: "CPF", description: "saque" });
    expect(result).toEqual({ transactionId: "54345", jobId: "withdraw-4-1", status: "QUEUED" });
  });
});

describe("extrato", () => {
  test("lista as transações com paginação", async () => {
    const { api, calls } = client(() => ({
      json: {
        data: [{ id: 9, value: 2, fee: 0.15, clientName: "Gustavo", description: "x", transactionState: "COMPLETO", transactionType: "DEPOSITO", transactionMethod: "PIX", createdAt: "2026-03-04T23:47:23.257Z" }],
        pagination: { page: 2, perPage: 10, total: 21, totalPages: 3 },
      },
    }));
    const statement = await api.listTransactions(2, "COMPLETO");

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${MISTIC_BASE_URL}/users/transactions/list/2?status=COMPLETO`);
    expect(statement.page).toBe(2);
    expect(statement.totalPages).toBe(3);
    expect(statement.items[0]).toMatchObject({ id: 9, value: 2, clientName: "Gustavo", state: "COMPLETO", type: "DEPOSITO" });
  });

  test("página inválida vira 1", async () => {
    const { api, calls } = client(() => ({ json: { data: [] } }));
    await api.listTransactions(0);
    expect(calls[0]!.url).toBe(`${MISTIC_BASE_URL}/users/transactions/list/1`);
  });
});

describe("erros", () => {
  test.each([401, 403])("HTTP %p vira erro de credenciais", async (status) => {
    const { api } = client(() => ({ status, json: { error: "Credenciais inválidas", statusCode: status } }));
    const err = await api.getBalance().catch((e) => e);
    expect(err).toBeInstanceOf(MisticError);
    expect(err.code).toBe("auth");
    expect(err.message).toContain("Client ID");
    expect(err.message).toContain("Credenciais inválidas"); // o motivo da própria MisticPay
  });

  test("com header manual recusado, a mensagem aponta o campo certo", async () => {
    const { api } = client(() => ({ status: 401, json: { error: "Envie as credenciais nos cabeçalhos ci e cs" } }), { ...CREDS, authHeader: "Basic ERRADO" });
    const err = await api.getBalance().catch((e) => e);
    expect(err.code).toBe("auth");
    expect(err.message).toContain("header de autenticação preenchido à mão");
    expect(err.message).toContain("apague esse campo");
    expect(err.message).not.toContain("cabeçalhos ci"); // a mensagem confusa da API não vai pro usuário
  });

  test("429 vira erro de excesso de consultas", async () => {
    const { api } = client(() => ({ status: 429, json: { error: "rate" } }));
    await expect(api.getBalance()).rejects.toMatchObject({ code: "rate_limit", status: 429 });
  });

  test("outros erros mostram a mensagem da própria MisticPay", async () => {
    const { api } = client(() => ({ status: 422, json: { error: "Saldo insuficiente", statusCode: 422 } }));
    const err = await api.getBalance().catch((e) => e);
    expect(err).toMatchObject({ code: "api", status: 422, message: "Saldo insuficiente" });
  });

  test("400 com corpo vazio ainda dá uma mensagem", async () => {
    const { api } = client(() => ({ status: 400, json: {} }));
    const err = await api.getBalance().catch((e) => e);
    expect(err.code).toBe("api");
    expect(err.message.length).toBeGreaterThan(5);
  });

  test("sem internet", async () => {
    const { api } = client(() => new TypeError("fetch failed"));
    await expect(api.getBalance()).rejects.toMatchObject({ code: "network" });
  });

  test("a mensagem de erro nunca contém o Client Secret", async () => {
    const { api } = client(() => ({ status: 401, json: { error: "cs_xyz inválido" } }));
    // a MisticPay poderia ecoar algo, mas o que montamos por conta própria não inclui o segredo
    const { api: api2 } = client(() => new TypeError("boom"));
    const e2 = await api2.getBalance().catch((e) => e);
    expect(String(e2.message)).not.toContain("cs_xyz");
    expect(api).toBeDefined();
  });
});
