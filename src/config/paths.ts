import { homedir, tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

export const APP_NAME = "BotBrinzy";

function resolveAppDataDir(): string {
  const appData = process.env["APPDATA"];
  if (appData) {
    return join(appData, APP_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_NAME);
  }
  const xdgConfig = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(xdgConfig, APP_NAME);
}

function resolveTempDir(): string {
  return join(tmpdir(), APP_NAME);
}

export const APPDATA_DIR = resolveAppDataDir();
export const TEMP_DIR = resolveTempDir();

/** Caminhos do programa como um todo (valem para todas as contas de WhatsApp). */
export const PATHS = {
  appData: APPDATA_DIR,
  temp: TEMP_DIR,
  accountsIndex: join(APPDATA_DIR, "accounts.json"),
  accounts: join(APPDATA_DIR, "accounts"),
  lockFile: join(TEMP_DIR, "bot.lock"),
} as const;

/**
 * A primeira conta continua usando a pasta de dados de antes de existir
 * suporte a várias contas, então quem já usa o bot não precisa migrar nada
 * (nem perde a sessão logada). As demais ficam em `accounts/<id>/`.
 */
export const DEFAULT_ACCOUNT_ID = "default";

/** Arquivos e pastas de uma conta de WhatsApp. */
export interface AccountPaths {
  root: string;
  auth: string;
  profiles: string;
  profilesIndex: string;
  state: string;
  settings: string;
  bans: string;
  callers: string;
  groupDelays: string;
  callLeads: string;
  stickerLibrary: string;
  stickerMedia: string;
  mistic: string;
  misticCharges: string;
  qrCode: string;
}

export function accountPaths(
  id: string,
  appDataDir: string = APPDATA_DIR,
  tempDir: string = TEMP_DIR
): AccountPaths {
  const isDefault = id === DEFAULT_ACCOUNT_ID;
  const root = isDefault ? appDataDir : join(appDataDir, "accounts", id);
  return {
    root,
    auth: join(root, "auth"),
    profiles: join(root, "profiles"),
    profilesIndex: join(root, "profiles.json"),
    state: join(root, "state.json"),
    settings: join(root, "settings.json"),
    bans: join(root, "bans.json"),
    callers: join(root, "callers.json"),
    groupDelays: join(root, "group-delays.json"),
    callLeads: join(root, "call-leads.json"),
    stickerLibrary: join(root, "sticker-library.json"),
    stickerMedia: join(root, "sticker-library-media"),
    mistic: join(root, "mistic.json"),
    misticCharges: join(root, "mistic-charges.json"),
    qrCode: join(tempDir, isDefault ? "qr.png" : `qr-${id}.png`),
  };
}

export function ensureDirectories(): void {
  mkdirSync(PATHS.appData, { recursive: true });
  mkdirSync(PATHS.temp, { recursive: true });
  mkdirSync(PATHS.accounts, { recursive: true });
}

export function ensureAccountDirectories(paths: AccountPaths): void {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.auth, { recursive: true });
  mkdirSync(paths.profiles, { recursive: true });
  mkdirSync(paths.stickerMedia, { recursive: true });
}
