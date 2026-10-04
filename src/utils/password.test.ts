import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "./password";

describe("hash de senha", () => {
  test("a senha certa confere", () => {
    const stored = hashPassword("minhasenha");
    expect(verifyPassword("minhasenha", stored)).toBe(true);
  });

  test("a senha errada não confere", () => {
    const stored = hashPassword("minhasenha");
    expect(verifyPassword("outrasenha", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  test("é sensível a maiúsculas/minúsculas", () => {
    const stored = hashPassword("Senha123");
    expect(verifyPassword("senha123", stored)).toBe(false);
  });

  test("nunca guarda a senha em texto puro no resultado", () => {
    const stored = hashPassword("minhasenha");
    expect(JSON.stringify(stored)).not.toContain("minhasenha");
  });

  test("o mesmo texto gera hashes diferentes (sal aleatório) mas os dois conferem", () => {
    const a = hashPassword("minhasenha");
    const b = hashPassword("minhasenha");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(verifyPassword("minhasenha", a)).toBe(true);
    expect(verifyPassword("minhasenha", b)).toBe(true);
  });

  test("um hash salvo com outro sal não confere, mesmo com a senha certa", () => {
    const a = hashPassword("minhasenha");
    const b = hashPassword("minhasenha");
    expect(verifyPassword("minhasenha", { salt: a.salt, hash: b.hash })).toBe(false);
  });
});
