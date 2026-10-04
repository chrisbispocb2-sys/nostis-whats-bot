import { randomBytes, randomUUID, createHash } from "crypto";
import { JsonFileStore } from "./base-store";
import { CONFIG } from "../config";

export interface Session {
  id: string;
  /** sha256 do token bruto — o valor bruto só existe uma vez, no momento da criação, e vira o cookie. */
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  /** Última requisição vista desta sessão — usado só para "quem está online agora" (não precisa ser exato, nunca é persistido por si só). */
  lastSeenAt: number;
}

interface SessionsData {
  sessions: Session[];
}

/** Sem nenhuma requisição por mais que isso, a pessoa deixa de contar como "online". */
const ONLINE_THRESHOLD_MS = 90_000;

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export class SessionStore extends JsonFileStore<SessionsData> {
  constructor(file: string) {
    super(file, { sessions: [] });
    this.data.sessions ??= [];
    for (const session of this.data.sessions) session.lastSeenAt ??= session.createdAt;
  }

  /** Cria a sessão e devolve o token bruto (única vez que ele existe fora do cookie do navegador). */
  create(userId: string): { session: Session; rawToken: string } {
    this.purgeExpired();
    const rawToken = randomBytes(32).toString("hex");
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      tokenHash: hashToken(rawToken),
      userId,
      createdAt: now,
      expiresAt: now + CONFIG.sessionMaxAgeMs,
      lastSeenAt: now,
    };
    this.data.sessions.push(session);
    this.save();
    return { session, rawToken };
  }

  /**
   * Marca a sessão como vista agora (chamado a cada requisição autenticada). Só em memória — não
   * vale a pena gravar em disco a cada requisição só por causa disto, e não tem problema perder o
   * valor exato se o programa reiniciar.
   */
  touch(rawToken: string): void {
    const session = this.data.sessions.find((s) => s.tokenHash === hashToken(rawToken));
    if (session) session.lastSeenAt = Date.now();
  }

  /** IDs de usuário com pelo menos uma sessão ativa vista recentemente — "quem está online" no painel de administração. */
  onlineUserIds(): Set<string> {
    const now = Date.now();
    const ids = new Set<string>();
    for (const s of this.data.sessions) {
      if (s.expiresAt > now && now - s.lastSeenAt <= ONLINE_THRESHOLD_MS) ids.add(s.userId);
    }
    return ids;
  }

  findByToken(rawToken: string): Session | null {
    const hash = hashToken(rawToken);
    const session = this.data.sessions.find((s) => s.tokenHash === hash);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) return null;
    return session;
  }

  deleteByToken(rawToken: string): void {
    const hash = hashToken(rawToken);
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.tokenHash !== hash);
    if (this.data.sessions.length !== before) this.save();
  }

  /** Desconecta a pessoa de todo lugar (usado ao desativar o usuário). */
  deleteAllForUser(userId: string): void {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== userId);
    if (this.data.sessions.length !== before) this.save();
  }

  /** Existe alguém logado agora em algum lugar? (o botão flutuante confere isso antes de abrir a janela de pagamento). */
  hasActive(): boolean {
    const now = Date.now();
    return this.data.sessions.some((s) => s.expiresAt > now);
  }

  purgeExpired(): void {
    const now = Date.now();
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.expiresAt > now);
    if (this.data.sessions.length !== before) this.save();
  }
}
