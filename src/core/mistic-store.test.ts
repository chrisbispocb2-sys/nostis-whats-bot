import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MisticConfigError, MisticStore } from "./mistic-store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-mistic-store-"));
  file = join(dir, "mistic.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("senha de saque", () => {
  test("uma conta nova não tem senha: o saque fica bloqueado", () => {
    const store = new MisticStore(file);
    expect(store.hasWithdrawPassword()).toBe(false);
    expect(() => store.assertWithdrawPassword("qualquer")).toThrow("Crie uma senha de saque");
    expect(() => store.assertWithdrawPassword(undefined)).toThrow("Crie uma senha de saque");
  });

  test("cria a primeira senha sem precisar de nenhuma atual", () => {
    const store = new MisticStore(file);
    store.update({ withdrawPassword: "minhasenha" });
    expect(store.hasWithdrawPassword()).toBe(true);
    expect(() => store.assertWithdrawPassword("minhasenha")).not.toThrow();
  });

  test("senha errada é recusada", () => {
    const store = new MisticStore(file);
    store.update({ withdrawPassword: "minhasenha" });
    expect(() => store.assertWithdrawPassword("outra")).toThrow("Senha de saque incorreta.");
    expect(() => store.assertWithdrawPassword("")).toThrow("Senha de saque incorreta.");
  });

  test("recusa senha curta demais ou longa demais", () => {
    const store = new MisticStore(file);
    expect(() => store.update({ withdrawPassword: "abc" })).toThrow("pelo menos 4 caracteres");
    expect(() => store.update({ withdrawPassword: "a".repeat(65) })).toThrow("no máximo 64 caracteres");
    expect(store.hasWithdrawPassword()).toBe(false);
  });

  test("uma senha longa (dentro do limite) confere de novo com o texto INTEIRO, sem cortar", () => {
    const store = new MisticStore(file);
    const long = "x".repeat(64);
    store.update({ withdrawPassword: long });
    expect(() => store.assertWithdrawPassword(long)).not.toThrow();
    expect(() => store.assertWithdrawPassword(long.slice(0, 63))).toThrow("incorreta");
  });

  test("espaços nas pontas não contam pra senha", () => {
    const store = new MisticStore(file);
    store.update({ withdrawPassword: "  minhasenha  " });
    expect(() => store.assertWithdrawPassword("minhasenha")).not.toThrow();
  });

  test("trocar uma senha já existente exige a atual; sem ela (ou errada) recusa e não muda nada", () => {
    const store = new MisticStore(file);
    store.update({ withdrawPassword: "primeira" });

    // sem informar a senha atual (undefined), é tratado como uma senha atual errada
    expect(() => store.update({ withdrawPassword: "segunda" })).toThrow("incorreta");
    expect(() => store.assertWithdrawPassword("primeira")).not.toThrow(); // continua sendo a primeira

    expect(() => store.update({ withdrawPassword: "segunda", currentWithdrawPassword: "chuta" })).toThrow("incorreta");
    expect(() => store.assertWithdrawPassword("primeira")).not.toThrow();

    store.update({ withdrawPassword: "segunda", currentWithdrawPassword: "primeira" });
    expect(() => store.assertWithdrawPassword("segunda")).not.toThrow();
    expect(() => store.assertWithdrawPassword("primeira")).toThrow("incorreta");
  });

  test("remover uma senha existente também exige a atual", () => {
    const store = new MisticStore(file);
    store.update({ withdrawPassword: "primeira" });

    expect(() => store.update({ withdrawPassword: null })).toThrow();
    expect(store.hasWithdrawPassword()).toBe(true);

    store.update({ withdrawPassword: null, currentWithdrawPassword: "primeira" });
    expect(store.hasWithdrawPassword()).toBe(false);
    expect(() => store.assertWithdrawPassword("primeira")).toThrow("Crie uma senha de saque");
  });

  test("depois de muitas senhas erradas, trava por um tempo — mesmo pra senha certa", () => {
    const store = new MisticStore(file);
    store.update({ withdrawPassword: "certa" });

    for (let i = 0; i < 5; i++) {
      expect(() => store.assertWithdrawPassword("errada")).toThrow("incorreta");
    }
    const err = (() => {
      try {
        store.assertWithdrawPassword("certa");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(MisticConfigError);
    expect(err!.message).toContain("Muitas tentativas");
  });

  test("acertar antes do limite não conta pra travar (o contador zera)", () => {
    const store = new MisticStore(file);
    store.update({ withdrawPassword: "certa" });

    for (let i = 0; i < 4; i++) {
      expect(() => store.assertWithdrawPassword("errada")).toThrow("incorreta");
    }
    expect(() => store.assertWithdrawPassword("certa")).not.toThrow();

    // o contador zerou: precisa de mais 5 erradas pra travar de novo
    for (let i = 0; i < 4; i++) {
      expect(() => store.assertWithdrawPassword("errada")).toThrow("incorreta");
    }
    expect(() => store.assertWithdrawPassword("certa")).not.toThrow();
  });

  test("nunca aparece no publicView (nem o hash, nem a senha)", () => {
    const store = new MisticStore(file);
    store.update({ withdrawPassword: "supersecreta" });
    const view = store.publicView();
    expect(view.hasWithdrawPassword).toBe(true);
    expect(JSON.stringify(view)).not.toContain("supersecreta");
    expect(JSON.stringify(view)).not.toContain("withdrawPasswordHash");
  });

  test("fica salva no disco, como hash — nunca em texto puro", () => {
    const store = new MisticStore(file);
    store.update({ withdrawPassword: "supersecreta" });

    const raw = readFileSync(file, "utf-8");
    expect(raw).not.toContain("supersecreta");
    expect(raw).toContain("withdrawPasswordHash");

    const reloaded = new MisticStore(file);
    expect(reloaded.hasWithdrawPassword()).toBe(true);
    expect(() => reloaded.assertWithdrawPassword("supersecreta")).not.toThrow();
  });

  test("arquivo salvo antes de existir essa senha (sem o campo) não quebra", () => {
    writeFileSync(file, JSON.stringify({ enabled: true, clientId: "ci", clientSecret: "cs" }), "utf-8");
    const store = new MisticStore(file);
    expect(store.hasWithdrawPassword()).toBe(false);
    expect(() => store.assertWithdrawPassword("qualquer")).toThrow("Crie uma senha de saque");
  });
});
