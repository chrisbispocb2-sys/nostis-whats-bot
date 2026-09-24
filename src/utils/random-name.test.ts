import { describe, expect, test } from "bun:test";
import { randomPersonName } from "./random-name";

const NOME_SOBRENOME = /^[^\s]+ [^\s]+$/;

describe("nome aleatório", () => {
  test("é sempre 'Nome Sobrenome', sem espaços sobrando", () => {
    for (let i = 0; i < 200; i++) expect(randomPersonName()).toMatch(NOME_SOBRENOME);
  });

  test("é determinístico com o sorteio injetado e nunca estoura o fim da lista", () => {
    expect(randomPersonName(() => 0)).toBe("Ana Almeida");
    expect(randomPersonName(() => 0.9999999)).toBe("Wesley Vieira");
    expect(randomPersonName(() => 1)).toBe("Wesley Vieira"); // 1 não sai do Math.random, mas não pode quebrar
  });

  test("varia de verdade", () => {
    const names = new Set(Array.from({ length: 60 }, () => randomPersonName()));
    expect(names.size).toBeGreaterThan(20);
  });
});
