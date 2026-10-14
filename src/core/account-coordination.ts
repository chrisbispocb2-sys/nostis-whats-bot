import type { ChatService } from "../services/chat.service";
import type { LeaseHolder, SharedListOp, SharedLists, WorkspaceCoordinator, WorkspaceIdentity } from "./auth-provider";
import { logger } from "../utils/logger";

/** A vez do bot vence sozinha se quem a tem ficar esse tempo sem renovar (computador desligado, sem internet). */
const BOT_LEASE_TTL_MS = 75_000;
/** Uma corrida fica com quem a pegou por esse tempo (nenhuma dura mais que isso). */
const RIDE_LEASE_TTL_MS = 4 * 60 * 60_000;
/** O painel lê as listas a cada poucos segundos: não precisa ir ao servidor toda vez. */
const LISTS_PULL_MIN_GAP_MS = 4_000;

export interface AccountCoordinationDeps {
  /** Sem isto (modo local, sem servidor de licenças), nada é combinado e tudo funciona como numa instalação só. */
  coordinator?: WorkspaceCoordinator;
  /** Com qual WhatsApp esta conta está conectada (e a prova disso), ou null enquanto não conectou. */
  identity: () => WorkspaceIdentity | null;
  botActive: () => boolean;
  /** Outra instalação está com a vez do bot neste WhatsApp: desligar o daqui e avisar. */
  onBotConflict: (holder: LeaseHolder) => void;
  /**
   * Funcionário de empresa: o líder liberou menos WhatsApp do que o conectado aqui (ou bloqueou este).
   * Desligar o bot daqui e avisar. `max` = quantos o líder liberou (0 = nenhum). Chamado só na virada
   * (não a cada verificação), pra não encher de aviso.
   */
  onWhatsappBlocked?: (max: number) => void;
  chats: Pick<ChatService, "listFolders" | "listFolderMemberships" | "replaceFolders" | "getMeta" | "setMeta">;
  label: () => string;
}

/**
 * Combina esta conta de WhatsApp com as outras instalações do programa conectadas no MESMO número
 * (outra pessoa atendendo em outro computador), pelo servidor de licenças:
 *
 * - **Vez do bot:** só uma instalação fica com o bot ligado. Quem tenta ligar com outra já ligada
 *   recebe o nome de quem está — senão as duas responderiam cada chamada em dobro.
 * - **Vez de cada corrida:** só uma acompanha (avisos e cobrança não saem em dobro).
 * - **Listas de conversas:** ficam guardadas no servidor; o que uma pessoa organiza, a outra vê.
 *
 * Quando não dá pra falar com o servidor, nada trava: o bot liga e a corrida é acompanhada
 * (preferível a parar o atendimento por causa de uma queda do servidor).
 */
export class AccountCoordination {
  /** WhatsApp para o qual esta instalação está com a vez do bot (null = não está). */
  private botHeldFor: WorkspaceIdentity | null = null;
  /** Última vez em que o bot daqui foi desligado porque outra instalação já estava com ele (o painel avisa). */
  lastBotConflict: { holder: LeaseHolder; at: number } | null = null;
  private lastListsPullAt = 0;
  /** "número:revisão" das listas já aplicadas neste computador (evita regravar o banco à toa). */
  private appliedLists: string | null = null;
  /** Último resultado do limite de WhatsApp do líder (null = ainda não checou / sem limite). Só avisa na virada. */
  private whatsappAllowed: boolean | null = null;

  constructor(private readonly deps: AccountCoordinationDeps) {}

  /* ---------- Limite de WhatsApp do líder (funcionário de empresa) ---------- */

  /**
   * Confere com o servidor se este WhatsApp cabe no limite que o líder liberou para o funcionário.
   * `allowed: false` (passou do limite) desliga o bot e avisa — uma vez só, na virada. Conta sem
   * líder, servidor fora do ar ou servidor antigo devolvem null: não mexe em nada.
   */
  async checkWhatsappAllowed(): Promise<void> {
    const wa = this.deps.identity();
    const claim = this.deps.coordinator?.claimWhatsapp;
    if (!wa || !claim) return;
    try {
      const result = await claim.call(this.deps.coordinator, wa);
      if (!result) return; // não dá pra saber agora: não bloqueia
      const changed = this.whatsappAllowed !== result.allowed;
      this.whatsappAllowed = result.allowed;
      if (!result.allowed && changed) this.deps.onWhatsappBlocked?.(result.max ?? 0);
    } catch (err) {
      logger.debug({ err, account: this.deps.label() }, "Falha ao conferir o limite de WhatsApp do líder (ignorado)");
    }
  }

  /* ---------- Vez do bot ---------- */

  /** Tenta ficar com a vez do bot. Devolve null se pode ligar, ou quem já está com o bot ligado. */
  async claimBot(): Promise<LeaseHolder | null> {
    const wa = this.deps.identity();
    if (!this.deps.coordinator || !wa) return null;
    const result = await this.deps.coordinator.acquireLease(wa, "bot", BOT_LEASE_TTL_MS);
    if (result && !result.granted) return result.holder;
    if (result) this.botHeldFor = wa;
    return null;
  }

  /** Solta a vez do bot (chamado quando o bot daqui desliga, por qualquer motivo). */
  async releaseBot(): Promise<void> {
    const wa = this.botHeldFor;
    this.botHeldFor = null;
    if (wa) await this.deps.coordinator?.releaseLease(wa, "bot").catch(() => {});
  }

  /**
   * Rodado de tempos em tempos: com o bot ligado, renova a vez (e descobre se outra instalação já
   * estava com ela — é o caso de dois computadores abrindo com o bot ligado); desligado, solta.
   */
  async tick(): Promise<void> {
    try {
      // Funcionário de empresa: se o líder não liberou este WhatsApp, desliga o bot antes de disputar a vez.
      await this.checkWhatsappAllowed();
      if (!this.deps.botActive()) {
        if (this.botHeldFor) await this.releaseBot();
        return;
      }
      const holder = await this.claimBot();
      if (holder && this.deps.botActive()) {
        this.lastBotConflict = { holder, at: Date.now() };
        this.deps.onBotConflict(holder);
      }
    } catch (err) {
      logger.debug({ err, account: this.deps.label() }, "Falha ao combinar a vez do bot com as outras instalações (ignorado)");
    }
  }

  /* ---------- Vez de uma corrida ---------- */

  /** Esta instalação pode acompanhar essa corrida? false = outra já pegou. */
  async claimRide(shareToken: string): Promise<boolean> {
    const wa = this.deps.identity();
    if (!this.deps.coordinator || !wa) return true;
    try {
      const result = await this.deps.coordinator.acquireLease(wa, `ride:${shareToken}`, RIDE_LEASE_TTL_MS);
      return !result || result.granted;
    } catch {
      return true;
    }
  }

  /* ---------- Listas de conversas ---------- */

  /** Nome do "espaço" no servidor, pra anotações locais: a conta de WhatsApp provada, ou só o número. */
  private scope(wa: WorkspaceIdentity): string {
    return wa.account ? `wa:${wa.account.id}` : wa.phone;
  }

  private seededKey(wa: WorkspaceIdentity): string {
    return `shared_lists_seeded:${this.scope(wa)}`;
  }

  private apply(wa: WorkspaceIdentity, state: SharedLists): void {
    const key = `${this.scope(wa)}:${state.revision}`;
    if (key === this.appliedLists) return;
    this.deps.chats.replaceFolders(state.folders, state.memberships);
    this.appliedLists = key;
  }

  /**
   * Traz as listas do servidor pra este computador. Na primeira vez (ou se o servidor nunca recebeu
   * lista nenhuma), as listas que já existiam aqui sobem e são juntadas às de lá pelo nome, em vez
   * de serem apagadas.
   */
  async syncLists({ force = false } = {}): Promise<void> {
    const wa = this.deps.identity();
    const coordinator = this.deps.coordinator;
    if (!coordinator || !wa) return;
    if (!force && Date.now() - this.lastListsPullAt < LISTS_PULL_MIN_GAP_MS) return;
    this.lastListsPullAt = Date.now();

    try {
      let state = await coordinator.getLists(wa);
      if (!state) return;

      const seeded = this.deps.chats.getMeta(this.seededKey(wa)) !== null;
      const local = this.deps.chats.listFolders();
      if (local.length > 0 && (!seeded || state.revision === 0)) {
        state = await coordinator.applyListOp(wa, {
          type: "seed",
          folders: local.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt })),
          memberships: this.deps.chats.listFolderMemberships(),
        });
        if (!state) return;
      }
      if (!seeded) this.deps.chats.setMeta(this.seededKey(wa), "1");
      this.apply(wa, state);
    } catch (err) {
      logger.warn({ err, account: this.deps.label() }, "Falha ao sincronizar as listas de conversas com o servidor (ignorado)");
    }
  }

  /**
   * Aplica uma mudança nas listas compartilhadas. Devolve false quando as listas desta conta não são
   * compartilhadas (modo local, ou este computador nunca chegou a sincronizar com o servidor) — aí
   * quem chama grava só aqui, como sempre foi. Lança se são compartilhadas mas o servidor não
   * respondeu: gravar só aqui faria a mudança sumir na sincronização seguinte.
   */
  async listOp(op: SharedListOp): Promise<boolean> {
    const wa = this.deps.identity();
    const coordinator = this.deps.coordinator;
    if (!coordinator || !wa) return false;

    await this.syncLists({ force: true }); // garante que as listas daqui já subiram antes de mexer nas de lá
    if (this.deps.chats.getMeta(this.seededKey(wa)) === null) return false;

    const state = await coordinator.applyListOp(wa, op);
    if (!state) {
      throw new Error("As listas deste WhatsApp são compartilhadas e o servidor de licenças não respondeu, então a mudança não foi salva. Tente de novo em instantes.");
    }
    this.apply(wa, state);
    return true;
  }
}
