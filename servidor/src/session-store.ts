import { randomUUID } from "crypto";
import { JsonFileStore } from "./base-store";
import { CONFIG } from "./config";

/** Uma conta logada num computador. É o que mantém a licença daquele computador renovável. */
export interface Session {
  id: string;
  userId: string;
  deviceId: string;
  createdAt: number;
  /** Última vez que o programa daquele computador renovou a licença. */
  lastSeenAt: number;
}

interface SessionsData {
  sessions: Session[];
}

export class SessionStore extends JsonFileStore<SessionsData> {
  constructor(file: string) {
    super(file, { sessions: [] });
    this.data.sessions ??= [];
  }

  /** Abre a sessão da conta naquele computador (entrar de novo no mesmo computador troca a anterior). */
  create(userId: string, deviceId: string): Session {
    this.data.sessions = this.data.sessions.filter((s) => !(s.userId === userId && s.deviceId === deviceId));
    const now = Date.now();
    const session: Session = { id: randomUUID(), userId, deviceId, createdAt: now, lastSeenAt: now };
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  find(id: string): Session | null {
    return this.data.sessions.find((s) => s.id === id) ?? null;
  }

  touch(id: string): void {
    const session = this.find(id);
    if (!session) return;
    session.lastSeenAt = Date.now();
    this.save();
  }

  delete(id: string): void {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    if (this.data.sessions.length !== before) this.save();
  }

  /** Desconecta a conta de todos os computadores (usado ao desativar o usuário ou liberar os computadores). */
  deleteAllForUser(userId: string): void {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== userId);
    if (this.data.sessions.length !== before) this.save();
  }

  /** Quem renovou a licença há pouco — "quem está online" no painel de administração. */
  onlineUserIds(): Set<string> {
    const now = Date.now();
    return new Set(this.data.sessions.filter((s) => now - s.lastSeenAt <= CONFIG.onlineThresholdMs).map((s) => s.userId));
  }
}
