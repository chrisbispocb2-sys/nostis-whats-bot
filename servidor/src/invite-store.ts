import { randomBytes } from "crypto";
import { JsonFileStore } from "./base-store";
import { CONFIG } from "./config";
import type { UserRole } from "./user-store";

export interface Invite {
  /** Também é o próprio token do convite (256 bits aleatórios — imprevisível, não precisa de campo separado). */
  id: string;
  role: UserRole;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
  revoked: boolean;
}

interface InvitesData {
  invites: Invite[];
}

export class InviteStore extends JsonFileStore<InvitesData> {
  constructor(file: string) {
    super(file, { invites: [] });
    this.data.invites ??= [];
  }

  list(): Invite[] {
    return this.data.invites;
  }

  create(adminId: string, role: UserRole): Invite {
    const now = Date.now();
    const invite: Invite = {
      id: randomBytes(32).toString("hex"),
      role,
      createdBy: adminId,
      createdAt: now,
      expiresAt: now + CONFIG.inviteExpiryMs,
      usedAt: null,
      usedBy: null,
      revoked: false,
    };
    this.data.invites.unshift(invite);
    this.save();
    return invite;
  }

  /** Convite pronto para uso (existe, não foi usado, não foi revogado e não expirou). */
  findValid(token: string): Invite | null {
    const invite = this.data.invites.find((i) => i.id === token);
    if (!invite || invite.usedAt || invite.revoked || invite.expiresAt <= Date.now()) return null;
    return invite;
  }

  markUsed(token: string, userId: string): void {
    const invite = this.data.invites.find((i) => i.id === token);
    if (!invite) return;
    invite.usedAt = Date.now();
    invite.usedBy = userId;
    this.save();
  }

  revoke(id: string): boolean {
    const invite = this.data.invites.find((i) => i.id === id);
    if (!invite || invite.revoked) return false;
    invite.revoked = true;
    this.save();
    return true;
  }
}
