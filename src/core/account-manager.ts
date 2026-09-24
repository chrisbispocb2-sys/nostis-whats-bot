import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  APPDATA_DIR,
  DEFAULT_ACCOUNT_ID,
  TEMP_DIR,
  accountPaths,
} from "../config/paths";
import { Account, type AccountMeta, type AccountOptions } from "./account";
import { logger } from "../utils/logger";

interface AccountsIndex {
  accounts: AccountMeta[];
}

export interface AccountManagerOptions extends Omit<AccountOptions, "appDataDir" | "tempDir"> {
  appDataDir?: string;
  tempDir?: string;
}

/** Conta que existe desde antes do suporte a várias: se chamava só "o bot". */
const DEFAULT_ACCOUNT_NAME = "WhatsApp 1";

function validateName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Informe um nome para a conta.");
  if (trimmed.length > 40) throw new Error("O nome da conta pode ter no máximo 40 caracteres.");
  return trimmed;
}

/** Guarda quais contas de WhatsApp existem e mantém cada uma viva. */
export class AccountManager {
  private accounts = new Map<string, Account>();
  private readonly appDataDir: string;
  private readonly indexFile: string;

  constructor(private readonly options: AccountManagerOptions = {}) {
    this.appDataDir = options.appDataDir ?? APPDATA_DIR;
    this.indexFile = join(this.appDataDir, "accounts.json");
    this.load();
  }

  private accountOptions(): AccountOptions {
    return {
      ...this.options,
      appDataDir: this.appDataDir,
      tempDir: this.options.tempDir ?? TEMP_DIR,
    };
  }

  private load(): void {
    let metas: AccountMeta[] = [];

    if (existsSync(this.indexFile)) {
      try {
        const data = JSON.parse(readFileSync(this.indexFile, "utf-8")) as AccountsIndex;
        if (Array.isArray(data.accounts)) metas = data.accounts;
      } catch (err) {
        logger.error({ err }, "Falha ao carregar accounts.json");
      }
    }

    // Primeira execução (ou índice ilegível): a conta original continua onde sempre esteve
    if (metas.length === 0) {
      metas = [{ id: DEFAULT_ACCOUNT_ID, name: DEFAULT_ACCOUNT_NAME, createdAt: Date.now() }];
    }

    for (const meta of metas) {
      this.accounts.set(meta.id, new Account(meta, this.accountOptions()));
    }
    this.save();
  }

  private save(): void {
    const data: AccountsIndex = {
      accounts: this.list().map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt })),
    };
    mkdirSync(this.appDataDir, { recursive: true });
    writeFileSync(this.indexFile, JSON.stringify(data, null, 2), "utf-8");
  }

  list(): Account[] {
    return [...this.accounts.values()];
  }

  get(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  /** Conecta todas as contas. Uma que falhar não derruba as outras. */
  async startAll(): Promise<void> {
    await Promise.all(
      this.list().map((account) =>
        account.start().catch((err) => {
          logger.error({ err, account: account.name }, "Falha ao iniciar a conta");
        })
      )
    );
  }

  stopAll(): void {
    for (const account of this.list()) account.stop();
  }

  private assertUniqueName(name: string, exceptId?: string): void {
    const clash = this.list().some(
      (a) => a.id !== exceptId && a.name.toLowerCase() === name.toLowerCase()
    );
    if (clash) throw new Error(`Já existe uma conta chamada "${name}".`);
  }

  /** Cria uma conta nova e já começa a conectar (o painel mostra o QR Code). */
  async create(name: string | undefined): Promise<Account> {
    const validName = validateName(name);
    this.assertUniqueName(validName);

    const meta: AccountMeta = {
      id: randomUUID().slice(0, 8),
      name: validName,
      createdAt: Date.now(),
    };
    const account = new Account(meta, this.accountOptions());
    this.accounts.set(meta.id, account);
    this.save();

    account.start().catch((err) => {
      logger.error({ err, account: account.name }, "Falha ao iniciar a conta");
    });
    this.options.onMisticChange?.();
    return account;
  }

  rename(id: string, name: string | undefined): Account | undefined {
    const account = this.accounts.get(id);
    if (!account) return undefined;

    const validName = validateName(name);
    this.assertUniqueName(validName, id);
    account.name = validName;
    this.save();
    return account;
  }

  /**
   * Remove a conta e apaga os dados dela. A conta original não pode ser
   * removida (ela usa a pasta de dados principal); dá pra trocar o número
   * dela desconectando.
   */
  async remove(id: string): Promise<boolean> {
    const account = this.accounts.get(id);
    if (!account) return false;
    if (id === DEFAULT_ACCOUNT_ID) {
      throw new Error("A primeira conta não pode ser removida. Use “Desconectar” para trocar o número dela.");
    }
    if (this.accounts.size <= 1) {
      throw new Error("Não é possível remover a única conta.");
    }

    // Desvincula o aparelho no WhatsApp antes de apagar a sessão
    try {
      await account.connection.logout({ reconnect: false });
    } catch (err) {
      logger.warn({ err, account: account.name }, "Não foi possível desvincular o aparelho ao remover a conta");
    }
    account.stop();

    this.accounts.delete(id);
    this.save();
    this.options.onMisticChange?.();
    rmSync(accountPaths(id, this.appDataDir, this.options.tempDir ?? TEMP_DIR).root, {
      recursive: true,
      force: true,
    });
    return true;
  }
}
