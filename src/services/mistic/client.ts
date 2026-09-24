/**
 * Cliente da API da MisticPay (https://docs.misticpay.com).
 *
 * Autenticação: `Authorization: Basic base64(client_id:client_secret)`. Os headers
 * antigos `ci`/`cs` só valem até 30/09/2026 e só em alguns endpoints, então não são usados.
 */

export const MISTIC_BASE_URL = "https://api.misticpay.com/api";

export interface MisticCredentials {
  clientId: string;
  clientSecret: string;
  /** Valor pronto do header Authorization. Se preenchido, vale no lugar do que seria montado. */
  authHeader?: string;
}

/**
 * validation = dado inválido antes de chamar a API · not_configured = faltam credenciais ·
 * auth = credenciais recusadas · rate_limit = muitas consultas · network = sem resposta ·
 * api = a MisticPay recusou por outro motivo.
 */
export type MisticErrorCode = "validation" | "not_configured" | "auth" | "rate_limit" | "network" | "api";

export class MisticError extends Error {
  constructor(
    message: string,
    readonly code: MisticErrorCode,
    readonly status = 0
  ) {
    super(message);
    this.name = "MisticError";
  }
}

export type MisticTransactionState = "PENDENTE" | "COMPLETO" | "FALHA" | "CANCELADO" | string;

export interface MisticUserInfo {
  name: string;
  email: string;
  document: string;
  phone: string;
  accountVerified: boolean;
  documentVerified: boolean;
  withdrawBlocked: boolean;
  availableBalance: number;
  blockedBalance: number;
}

export interface DepositInput {
  /** Em reais (ex.: 4.55). */
  amount: number;
  payerName: string;
  /** CPF só com dígitos (obrigatório na MisticPay). */
  payerDocument: string;
  /** ID do nosso lado, pra identificar a transação. */
  transactionId: string;
  description: string;
}

export interface DepositResult {
  /** ID da transação na MisticPay. */
  transactionId: string;
  state: MisticTransactionState;
  /** PIX copia e cola. */
  copyPaste: string | null;
  qrCodeBase64: string | null;
  qrCodeUrl: string | null;
}

export type PixKeyType = "CPF" | "CNPJ" | "EMAIL" | "TELEFONE" | "CHAVE_ALEATORIA";
export const PIX_KEY_TYPES: readonly PixKeyType[] = ["CPF", "CNPJ", "EMAIL", "TELEFONE", "CHAVE_ALEATORIA"];

export interface WithdrawInput {
  /** Em reais. */
  amount: number;
  pixKey: string;
  pixKeyType: PixKeyType;
  description: string;
}

export interface WithdrawResult {
  transactionId: string;
  jobId: string | null;
  status: string;
}

export interface CheckResult {
  transactionId: string;
  state: MisticTransactionState;
  /** Valor em reais. */
  value: number | null;
  fee: number | null;
}

export interface StatementItem {
  id: number | string;
  value: number;
  fee: number;
  description: string;
  clientName: string | null;
  state: MisticTransactionState;
  type: string;
  method: string;
  createdAt: string;
}

export interface Statement {
  items: StatementItem[];
  page: number;
  totalPages: number;
  total: number;
}

type Json = Record<string, any>;

const DEFAULT_TIMEOUT_MS = 20_000;

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export class MisticClient {
  constructor(
    private readonly getCredentials: () => MisticCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = MISTIC_BASE_URL,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {}

  /** Valor do header Authorization (o informado à mão ou o Basic montado com ID e Secret). */
  authorization(): string {
    const { clientId, clientSecret, authHeader } = this.getCredentials();
    if (authHeader?.trim()) return authHeader.trim();
    if (!clientId.trim() || !clientSecret.trim()) {
      throw new MisticError("Preencha o Client ID e o Client Secret da MisticPay nas configurações.", "not_configured");
    }
    return `Basic ${Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString("base64")}`;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<Json> {
    const authorization = this.authorization();

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new MisticError(
        timeout ? "A MisticPay demorou demais para responder. Tente de novo." : "Não foi possível falar com a MisticPay. Verifique a internet.",
        "network"
      );
    }

    const data = (await res.json().catch(() => ({}))) as Json;
    if (res.ok) return data;

    const detail = str(data["error"] ?? data["message"]);
    if (res.status === 401 || res.status === 403) {
      // O header informado à mão vale no lugar do montado: se ele estiver errado, é ele o culpado
      const manual = this.getCredentials().authHeader?.trim();
      throw new MisticError(
        manual
          ? "A MisticPay recusou o header de autenticação preenchido à mão. Confira-o ou apague esse campo: aí o sistema monta sozinho o header com o Client ID e o Client Secret."
          : `A MisticPay recusou as credenciais${detail ? ` (${detail})` : ""}. Confira o Client ID e o Client Secret.`,
        "auth",
        res.status
      );
    }
    if (res.status === 429) {
      throw new MisticError("Muitas consultas seguidas à MisticPay. Aguarde um minuto.", "rate_limit", 429);
    }
    if (res.status === 400) {
      // A MisticPay usa 400 também quando faltam as credenciais
      throw new MisticError(detail || "A MisticPay recusou o pedido.", "api", 400);
    }
    throw new MisticError(detail || `A MisticPay respondeu com erro ${res.status}.`, "api", res.status);
  }

  /** Dados da conta (nome, verificação, saldo disponível e bloqueado). Também serve pra testar as credenciais. */
  async getUserInfo(): Promise<MisticUserInfo> {
    const d = ((await this.request("GET", "/users/info"))["data"] ?? {}) as Json;
    return {
      name: str(d["name"]),
      email: str(d["email"]),
      document: str(d["document"]),
      phone: str(d["phone"]),
      accountVerified: !!d["accountVerified"],
      documentVerified: !!d["documentVerified"],
      withdrawBlocked: !!d["withdrawBlocked"],
      availableBalance: Number(d["availableBalance"] ?? 0),
      blockedBalance: Number(d["blockedBalance"] ?? 0),
    };
  }

  async getBalance(): Promise<number> {
    const d = ((await this.request("GET", "/users/balance"))["data"] ?? {}) as Json;
    return Number(d["balance"] ?? 0);
  }

  /** Cria uma cobrança PIX. */
  async createDeposit(input: DepositInput): Promise<DepositResult> {
    const d = ((await this.request("POST", "/transactions/create", input))["data"] ?? {}) as Json;
    const transactionId = str(d["transactionId"]);
    if (!transactionId) throw new MisticError("A MisticPay não devolveu o número da transação.", "api");
    return {
      transactionId,
      state: str(d["transactionState"]) || "PENDENTE",
      copyPaste: str(d["copyPaste"]) || null,
      qrCodeBase64: str(d["qrCodeBase64"]) || null,
      qrCodeUrl: str(d["qrcodeUrl"]) || null,
    };
  }

  /** Consulta o estado de uma transação (cobrança ou saque). */
  async checkTransaction(transactionId: string): Promise<CheckResult> {
    const t = ((await this.request("POST", "/transactions/check", { transactionId }))["transaction"] ?? {}) as Json;
    if (!t["transactionState"]) throw new MisticError("A MisticPay não encontrou essa transação.", "api", 404);
    return {
      transactionId: str(t["transactionId"]) || transactionId,
      state: str(t["transactionState"]),
      value: t["value"] === undefined ? null : Number(t["value"]),
      fee: t["fee"] === undefined ? null : Number(t["fee"]),
    };
  }

  /** Saque via chave PIX. O dinheiro sai do saldo disponível; o processamento é assíncrono (fila). */
  async withdraw(input: WithdrawInput): Promise<WithdrawResult> {
    const d = ((await this.request("POST", "/transactions/withdraw", input))["data"] ?? {}) as Json;
    const transactionId = str(d["transactionId"]);
    if (!transactionId) throw new MisticError("A MisticPay não devolveu o número do saque.", "api");
    return { transactionId, jobId: str(d["jobId"]) || null, status: str(d["status"]) || "QUEUED" };
  }

  /** Extrato: transações da conta, mais recentes primeiro. */
  async listTransactions(page = 1, status?: string): Promise<Statement> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const res = await this.request("GET", `/users/transactions/list/${Math.max(1, Math.floor(page))}${query}`);
    const rows = Array.isArray(res["data"]) ? (res["data"] as Json[]) : [];
    const pagination = (res["pagination"] ?? {}) as Json;
    return {
      items: rows.map((r) => ({
        id: r["id"] ?? "",
        value: Number(r["value"] ?? 0),
        fee: Number(r["fee"] ?? 0),
        description: str(r["description"]),
        clientName: r["clientName"] ? str(r["clientName"]) : null,
        state: str(r["transactionState"]),
        type: str(r["transactionType"]),
        method: str(r["transactionMethod"]),
        createdAt: str(r["createdAt"]),
      })),
      page: Number(pagination["page"] ?? page),
      totalPages: Number(pagination["totalPages"] ?? 1),
      total: Number(pagination["total"] ?? rows.length),
    };
  }
}
