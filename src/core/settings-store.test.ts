import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SettingsStore, DEFAULT_RIDE_CHARGE_KEYWORD } from "./settings-store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-settings-"));
  file = join(dir, "settings.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SettingsStore — palavra-chave do valor da corrida", () => {
  test("padrão é 'chama' quando nunca foi configurada", () => {
    const store = new SettingsStore(file);
    expect(store.get().rideChargeKeyword).toBe(DEFAULT_RIDE_CHARGE_KEYWORD);
  });

  test("update guarda a palavra escolhida (com trim)", () => {
    const store = new SettingsStore(file);
    store.update({ rideChargeKeyword: "  valor  " });
    expect(store.get().rideChargeKeyword).toBe("valor");
  });

  test("update com vazio/espaços cai no padrão", () => {
    const store = new SettingsStore(file);
    store.update({ rideChargeKeyword: "   " });
    expect(store.get().rideChargeKeyword).toBe(DEFAULT_RIDE_CHARGE_KEYWORD);
  });

  test("limita o tamanho da palavra-chave", () => {
    const store = new SettingsStore(file);
    store.update({ rideChargeKeyword: "x".repeat(200) });
    expect(store.get().rideChargeKeyword.length).toBe(40);
  });

  test("migração: arquivo antigo sem o campo recebe o padrão", () => {
    writeFileSync(file, JSON.stringify({ rideAssistantEnabled: true }), "utf-8");
    const store = new SettingsStore(file);
    expect(store.get().rideChargeKeyword).toBe(DEFAULT_RIDE_CHARGE_KEYWORD);
  });
});

describe("SettingsStore — som dos grupos", () => {
  test("padrão: grupos tocam som (true)", () => {
    const store = new SettingsStore(file);
    expect(store.get().groupSoundEnabled).toBe(true);
  });

  test("update desliga o som dos grupos", () => {
    const store = new SettingsStore(file);
    store.update({ groupSoundEnabled: false });
    expect(store.get().groupSoundEnabled).toBe(false);
  });

  test("migração: arquivo antigo sem o campo mantém o som ligado", () => {
    writeFileSync(file, JSON.stringify({ notificationSoundEnabled: true }), "utf-8");
    const store = new SettingsStore(file);
    expect(store.get().groupSoundEnabled).toBe(true);
  });
});
