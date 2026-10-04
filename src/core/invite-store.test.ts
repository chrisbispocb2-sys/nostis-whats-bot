import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InviteStore } from "./invite-store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-invites-"));
  file = join(dir, "invites.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("cria um convite válido para o papel pedido", () => {
  const store = new InviteStore(file);
  const invite = store.create("admin-1", "operator");
  expect(invite.role).toBe("operator");
  expect(invite.usedAt).toBeNull();
  expect(invite.revoked).toBe(false);
  expect(store.findValid(invite.id)?.id).toBe(invite.id);
});

test("convite inexistente não é válido", () => {
  const store = new InviteStore(file);
  expect(store.findValid("token-que-nao-existe")).toBeNull();
});

test("convite usado não vale mais", () => {
  const store = new InviteStore(file);
  const invite = store.create("admin-1", "operator");
  store.markUsed(invite.id, "user-1");

  expect(store.findValid(invite.id)).toBeNull();
  const stored = store.list().find((i) => i.id === invite.id);
  expect(stored?.usedBy).toBe("user-1");
  expect(stored?.usedAt).not.toBeNull();
});

test("convite revogado não vale mais", () => {
  const store = new InviteStore(file);
  const invite = store.create("admin-1", "admin");
  expect(store.revoke(invite.id)).toBe(true);
  expect(store.findValid(invite.id)).toBeNull();
  // revogar de novo não faz nada (já estava revogado)
  expect(store.revoke(invite.id)).toBe(false);
});

test("convite expirado não vale mais", () => {
  const store = new InviteStore(file);
  const invite = store.create("admin-1", "operator");
  // força a expiração direto no arquivo, sem esperar os 7 dias de verdade
  const stored = store.list().find((i) => i.id === invite.id)!;
  stored.expiresAt = Date.now() - 1000;
  expect(store.findValid(invite.id)).toBeNull();
});
