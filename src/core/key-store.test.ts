import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { KeyStore } from "./key-store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-keys-"));
  file = join(dir, "keys.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("cria uma chave válida com a duração pedida", () => {
  const store = new KeyStore(file);
  const key = store.create("admin-1", 30);
  expect(key.durationDays).toBe(30);
  expect(key.usedAt).toBeNull();
  expect(key.revoked).toBe(false);
  expect(store.findValid(key.id)?.id).toBe(key.id);
});

test("o código tem formato fácil de digitar (grupos de 4, maiúsculo)", () => {
  const store = new KeyStore(file);
  const key = store.create("admin-1", 30);
  expect(key.id).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);
});

test("chave inexistente não é válida", () => {
  const store = new KeyStore(file);
  expect(store.findValid("0000-0000-0000-0000-0000")).toBeNull();
});

test("chave usada não vale mais", () => {
  const store = new KeyStore(file);
  const key = store.create("admin-1", 30);
  store.markUsed(key.id, "user-1");

  expect(store.findValid(key.id)).toBeNull();
  const stored = store.list().find((k) => k.id === key.id);
  expect(stored?.usedBy).toBe("user-1");
  expect(stored?.usedAt).not.toBeNull();
});

test("chave revogada não vale mais", () => {
  const store = new KeyStore(file);
  const key = store.create("admin-1", 30);
  expect(store.revoke(key.id)).toBe(true);
  expect(store.findValid(key.id)).toBeNull();
  expect(store.revoke(key.id)).toBe(false); // já estava revogada
});

test("chave expirada (sem nunca ter sido usada) não vale mais", () => {
  const store = new KeyStore(file);
  const key = store.create("admin-1", 30);
  const stored = store.list().find((k) => k.id === key.id)!;
  stored.expiresAt = Date.now() - 1000;
  expect(store.findValid(key.id)).toBeNull();
});
