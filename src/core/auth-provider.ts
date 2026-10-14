import { randomBytes } from "crypto";
import type { PublicUser, UserRole, FeatureKey, Features } from "./user-store";
import type { Invite } from "./invite-store";
import type { AccessKey } from "./key-store";
import type { MisticGateway, MisticUserInfo, WithdrawInput, WithdrawResult } from "../services/mistic/client";
import { CONFIG } from "../config";

export const SESSION_COOKIE_NAME = "brinzy_session";

export interface AuthResult {
  user: PublicUser;
  cookie: string;
}

type MaybePromise<T> = T | Promise<T>;

/** Um usuário como o painel de administração mostra. `devices`/`maxDevices`/`team` só existem com servidor de licenças. */
export type AdminUserView = PublicUser & {
  online: boolean;
  devices?: Array<{ id: string; name: string; firstSeenAt: number }>;
  maxDevices?: number;
  team?: string | null;
};

/** Configuração de um funcionário dentro da empresa de um líder (igual ao servidor/src/user-store.ts). */
export interface CompanyConfig {
  /** Taxa do líder sobre o líquido do funcionário, em porcentagem (0 a 100). */
  feePercent: number;
  /** Quantos WhatsApp o funcionário pode conectar. */
  maxWhatsapps: number;
  /** Líder bloqueou o saque deste funcionário? */
  withdrawBlocked: boolean;
}

/** Um funcionário como o painel do líder mostra (vem do servidor com a configuração da empresa). */
export type EmployeeView = AdminUserView & {
  leaderId: string | null;
  company: CompanyConfig;
  claimedWhatsapps: Array<{ account: string; firstSeenAt: number }>;
};

/** O que o líder vê do dinheiro da empresa: o saldo de cada funcionário, o bruto total e a parte dele (taxas). */
export interface LeaderMoneySummary {
  configured: boolean;
  employees: Array<{ id: string; username: string; balanceCents: number; feePercent: number; withdrawBlocked: boolean }>;
  leaderFeeBalanceCents: number;
  grossTotalCents: number;
  hasWithdrawPassword: boolean;
}

/** Quem está com uma "vez" (o bot ligado num WhatsApp, o acompanhamento de uma corrida). */
export interface LeaseHolder {
  username: string;
  deviceName: string;
  since: number;
}

/** As listas de conversas de um WhatsApp, guardadas no servidor pra todo mundo que atende nele ver igual. */
export interface SharedLists {
  revision: number;
  folders: Array<{ id: string; name: string; createdAt: number }>;
  memberships: Array<{ folderId: string; chatJid: string; addedAt: number }>;
}

export type SharedListOp =
  | { type: "create"; id: string; name: string }
  | { type: "delete"; id: string }
  | { type: "add"; folderId: string; chatJid: string }
  | { type: "remove"; folderId: string; chatJid: string }
  | { type: "seed"; folders: Array<{ id: string; name: string; createdAt?: number }>; memberships: Array<{ folderId: string; chatJid: string }> };

/** A prova de que este computador está conectado numa conta de WhatsApp, como o servidor confere (servidor/src/wa-proof.ts). */
export interface WaProofPayload {
  details: string;
  accountKey: string;
  accountSignature: string;
  deviceKey: string;
  timestamp: number;
  signature: string;
}

/**
 * Com qual WhatsApp esta conta do painel está conectada, pro servidor saber quem combina com quem.
 * `account` existe quando dá pra PROVAR a conexão (a credencial que o celular assinou ao ler o QR
 * Code): aí todo mundo conectado nesse WhatsApp é juntado sozinho. Sem ela, vale só o número, e o
 * servidor junta apenas quem é da mesma equipe (ou os computadores da mesma conta de licença).
 */
export interface WorkspaceIdentity {
  /** Número do WhatsApp (só dígitos). */
  phone: string;
  account?: {
    /** Identificador da conta de WhatsApp — igual em todo computador conectado nela. */
    id: string;
    /** Monta a prova pra sessão de licença informada (o servidor pede quando ainda não tem uma). */
    prove(sessionId: string): WaProofPayload;
  };
}

/**
 * O que várias instalações do programa conectadas no MESMO WhatsApp combinam entre si pelo
 * servidor de licenças (uma não enxerga a outra): de quem é a vez de ter o bot ligado ou de
 * acompanhar uma corrida, e as listas de conversas.
 *
 * Todos devolvem null quando não deu pra combinar (servidor fora do ar, ninguém logado, ou
 * servidor antigo sem esse recurso) — quem chama decide o que fazer sem a resposta.
 */
export interface WorkspaceCoordinator {
  /** Pega/renova a vez `name`. `{ granted: false, holder }` = outra instalação está com ela. */
  acquireLease(wa: WorkspaceIdentity, name: string, ttlMs: number): Promise<{ granted: true } | { granted: false; holder: LeaseHolder } | null>;
  releaseLease(wa: WorkspaceIdentity, name: string): Promise<void>;
  getLists(wa: WorkspaceIdentity): Promise<SharedLists | null>;
  applyListOp(wa: WorkspaceIdentity, op: SharedListOp): Promise<SharedLists | null>;
  /**
   * Funcionário de empresa: este WhatsApp cabe no limite que o líder liberou? `allowed: false` = passou
   * do limite (o app desliga o bot e avisa). null = não dá pra saber agora (servidor fora do ar, sem
   * líder, ou servidor antigo) — não bloqueia. Só existe com servidor de licenças.
   */
  claimWhatsapp?(wa: WorkspaceIdentity): Promise<{ allowed: boolean; max?: number } | null>;
}

/**
 * O "banco" que executa o dinheiro de um funcionário de empresa: ele não tem MisticPay própria, então
 * cobrar/conferir/sacar passa pelo servidor de licenças, que guarda as credenciais do líder e faz o
 * split. `isEmployee()` diz se a conta logada AGORA é funcionário de empresa (senão, o app usa a
 * MisticPay local, como sempre). Só o `RemoteAuthService` implementa isto.
 */
export interface MoneyBackend extends MisticGateway {
  isEmployee(): boolean;
  /** Saque do funcionário: a senha vai pro servidor (ele confere senha, bloqueio do líder e saldo). */
  withdrawAsEmployee(input: WithdrawInput, withdrawPassword: string): Promise<WithdrawResult>;
  /** Cria/troca/remove (`null`) a senha de saque do funcionário, guardada no servidor. */
  setEmployeeWithdrawPassword(password: string | null, currentPassword?: string): Promise<void>;
  /** Situação do dinheiro do funcionário pro painel (saldo, bloqueio, se já criou senha de saque). */
  employeeMoneyStatus(): Promise<{ availableBalance: number; withdrawBlocked: boolean; hasWithdrawPassword: boolean }>;
}

/** A versão do app que o admin publicou pra baixar (botão "Baixar atualização"). */
export interface AppRelease {
  version: string;
  url: string;
  notes: string;
  publishedAt?: number;
}

/** Como anda a licença deste computador (só com servidor de licenças). */
export interface LicenseStatus {
  /** ok = em dia · offline = sem falar com o servidor, ainda dentro da tolerância · blocked = tolerância esgotada. */
  state: "ok" | "offline" | "blocked";
  /** Até quando o programa segue funcionando sem conseguir falar com o servidor. */
  validUntil: number;
}

/**
 * Quem responde pelo login e pelo controle de acesso do painel. Duas implementações:
 * `AuthService` (modo local: contas guardadas neste computador, só pra desenvolver e testar) e
 * `RemoteAuthService` (o que vai no exe: tudo vem do servidor de licenças).
 */
export interface AuthProvider {
  isBootstrapNeeded(): boolean;
  bootstrap(username: string, password: string): MaybePromise<AuthResult>;
  login(username: string, password: string): MaybePromise<AuthResult>;
  registerViaInvite(token: string, username: string, password: string): MaybePromise<AuthResult>;
  logoutCookieHeader(req: Request): MaybePromise<string>;
  currentUser(req: Request): PublicUser | null;
  hasActiveSession(): boolean;
  issuePayToken(accountId: string): string;
  isAuthorizedForAccount(req: Request, url: URL): boolean;
  canUse(req: Request, feature: FeatureKey): boolean;
  requireAdmin(req: Request): PublicUser;
  listUsers(): MaybePromise<AdminUserView[]>;
  setUserDisabled(id: string, disabled: boolean): MaybePromise<PublicUser>;
  setUserAccess(
    req: Request,
    id: string,
    input: { expiresAt?: number | null; features?: Partial<Features>; maxDevices?: number; team?: string | null }
  ): MaybePromise<PublicUser>;
  listInvites(): MaybePromise<Invite[]>;
  createInvite(adminId: string, role: UserRole): MaybePromise<Invite>;
  revokeInvite(id: string): MaybePromise<boolean>;
  createKey(req: Request, durationDays: number): MaybePromise<AccessKey>;
  listKeys(req: Request): MaybePromise<(AccessKey & { createdByUsername: string | null })[]>;
  revokeKey(req: Request, id: string): MaybePromise<boolean>;
  redeemKey(req: Request, code: string): MaybePromise<PublicUser>;
  /** Só com servidor de licenças: libera os computadores em que a conta já entrou. */
  resetUserDevices?(req: Request, id: string): Promise<PublicUser>;
  /** Muda o papel de uma conta já existente (promover a líder, rebaixar...). A pessoa precisa entrar de novo. */
  setUserRole?(req: Request, id: string, role: UserRole): Promise<PublicUser>;
  /** Só com servidor de licenças (null = ninguém logado neste computador). */
  licenseStatus?(): LicenseStatus | null;
  /** Atualização disponível pra este computador (versão publicada diferente da que roda aqui), ou null. */
  availableUpdate?(): AppRelease | null;
  /** Admin: a versão do app publicada agora (null = nenhuma). */
  getRelease?(req: Request): Promise<AppRelease | null>;
  /** Admin: publica a versão disponível (link + rótulo) que vira o botão de baixar pros usuários. */
  setRelease?(req: Request, input: { version: string; url: string; notes?: string }): Promise<AppRelease>;
  /** Admin: tira a versão publicada (ninguém vê mais o botão). */
  clearRelease?(req: Request): Promise<void>;

  /* ---------- Empresa: o líder gerencia os próprios funcionários (só com servidor de licenças) ---------- */

  /** Garante que quem está logado é um líder (lança senão). */
  requireLeader?(req: Request): PublicUser;
  /** Os funcionários da empresa deste líder. */
  listEmployees?(req: Request): Promise<EmployeeView[]>;
  /** Muda a configuração de empresa de um funcionário (taxa, limite de WhatsApp, bloqueio de saque). */
  setEmployeeConfig?(req: Request, id: string, input: Partial<CompanyConfig>): Promise<EmployeeView>;
  /** Liga/desliga o acesso de um funcionário. */
  setEmployeeDisabled?(req: Request, id: string, disabled: boolean): Promise<EmployeeView>;
  /** Libera as vagas de WhatsApp do funcionário (ele vai poder conectar outros números). */
  resetEmployeeWhatsapps?(req: Request, id: string): Promise<EmployeeView>;
  /** Os convites que este líder criou para os funcionários dele. */
  listEmployeeInvites?(req: Request): Promise<Invite[]>;
  /** Cria um convite de funcionário desta empresa. */
  createEmployeeInvite?(req: Request): Promise<Invite>;
  /** Revoga um convite de funcionário desta empresa. */
  revokeEmployeeInvite?(req: Request, id: string): Promise<boolean>;

  /** A MisticPay da empresa já está configurada no servidor? */
  misticStatus?(req: Request): Promise<{ configured: boolean }>;
  /** Guarda (validando antes) as credenciais da MisticPay do líder, só no servidor. */
  setMisticCredentials?(
    req: Request,
    input: { clientId: string; clientSecret: string; authHeader?: string }
  ): Promise<{ configured: boolean; account?: { name: string; availableBalance: number } }>;
  /** Apaga as credenciais da MisticPay da empresa. */
  clearMisticCredentials?(req: Request): Promise<void>;
  /** Dados da conta real da MisticPay da empresa (saldo de verdade), só pro líder. */
  leaderMisticAccount?(req: Request): Promise<{ info: MisticUserInfo }>;
  /** Resumo do dinheiro da empresa: saldo de cada funcionário, bruto total e a parte do líder. */
  leaderMoneySummary?(req: Request): Promise<LeaderMoneySummary>;
  /** Cria/troca/remove (`null`) a senha de saque do líder. */
  setLeaderWithdrawPassword?(req: Request, password: string | null, currentPassword?: string): Promise<{ hasWithdrawPassword: boolean }>;
  /** Saque da parte (taxas) do líder, pela MisticPay da empresa. */
  leaderWithdraw?(req: Request, input: { amount: number; pixKey: string; pixKeyType: string; description?: string; withdrawPassword: string }): Promise<unknown>;
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  return new Bun.CookieMap(header).get(SESSION_COOKIE_NAME);
}

export function sessionCookieHeader(rawToken: string, maxAgeSeconds: number): string {
  return new Bun.Cookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // O painel é servido em http://127.0.0.1 (texto puro): "Secure" faria o navegador nunca mandar
    // o cookie de volta, derrubando o login inteiro.
    secure: false,
    maxAge: maxAgeSeconds,
  }).serialize();
}

interface PayToken {
  accountId: string;
  expiresAt: number;
}

/**
 * Tokens de vida curta da janela de pagamento (ela tem perfil de navegador isolado e não carrega o
 * cookie do painel): cada um autoriza só as rotas de uma conta de WhatsApp, por alguns minutos.
 */
export class PayTokenRegistry {
  private readonly tokens = new Map<string, PayToken>();

  issue(accountId: string): string {
    const now = Date.now();
    for (const [key, entry] of this.tokens) if (entry.expiresAt <= now) this.tokens.delete(key);

    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, { accountId, expiresAt: now + CONFIG.payTokenTtlMs });
    return token;
  }

  authorizes(req: Request, url: URL): boolean {
    const match = url.pathname.match(/^\/accounts\/([^/]+)\//);
    if (!match) return false;
    const accountId = decodeURIComponent(match[1]!);

    const token = req.headers.get("x-pay-token") || url.searchParams.get("token");
    if (!token) return false;

    const entry = this.tokens.get(token);
    return !!entry && entry.expiresAt > Date.now() && entry.accountId === accountId;
  }
}
