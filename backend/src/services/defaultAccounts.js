import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function supportConfig() {
  return {
    name: process.env.SUPPORT_NAME || "NovaFXM Support",
    email: normalizeEmail(process.env.SUPPORT_EMAIL || "support@novafxm.com"),
    phone: String(process.env.SUPPORT_PHONE || "0700000000").trim(),
    password: process.env.SUPPORT_PASSWORD || "change-this-password"
  };
}

function isClientRole(role) {
  return !role || role === "client" || role === "user";
}

async function upsertContactPair(userId, contactUserId) {
  if (!userId || !contactUserId || String(userId) === String(contactUserId)) return;

  await prisma.contact.upsert({
    where: { userId_contactUserId: { userId: String(userId), contactUserId: String(contactUserId) } },
    update: { status: "accepted" },
    create: { userId: String(userId), contactUserId: String(contactUserId), status: "accepted" }
  });
}

export async function ensureDefaultSupportAccount() {
  const config = supportConfig();
  if (!config.email) return null;

  const phoneOwner = config.phone ? await prisma.user.findUnique({ where: { phone: config.phone } }) : null;
  const phoneIsAvailable = config.phone && (!phoneOwner || phoneOwner.email === config.email);
  const existing = await prisma.user.findUnique({ where: { email: config.email } });
  const passwordHash = await bcrypt.hash(config.password, 10);

  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        name: config.name,
        role: "support",
        isSystem: true,
        isBlocked: false,
        passwordHash,
        ...(phoneIsAvailable ? { phone: config.phone } : {})
      }
    });
  }

  return prisma.user.create({
    data: {
      name: config.name,
      email: config.email,
      phone: phoneIsAvailable ? config.phone : null,
      role: "support",
      isSystem: true,
      isBlocked: false,
      passwordHash
    }
  });
}

export async function ensureAdminAccount() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  if (!email) return null;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role === "admin") return existing;
    return prisma.user.update({ where: { id: existing.id }, data: { role: "admin" } });
  }

  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;

  return prisma.user.create({
    data: {
      name: process.env.ADMIN_NAME || "Zivico Admin",
      email,
      role: "admin",
      passwordHash: await bcrypt.hash(password, 10)
    }
  });
}

export async function ensureSupportContactForUser(userOrId) {
  const user =
    typeof userOrId === "object" && userOrId
      ? userOrId
      : await prisma.user.findUnique({ where: { id: String(userOrId) } });
  if (!user || !isClientRole(user.role)) return null;

  const support = await ensureDefaultSupportAccount();
  if (!support || String(support.id) === String(user.id)) return support;

  await upsertContactPair(user.id, support.id);
  await upsertContactPair(support.id, user.id);
  return support;
}

export async function ensureSupportContactsForAllClients() {
  const support = await ensureDefaultSupportAccount();
  if (!support) return null;

  const users = await prisma.user.findMany({
    where: {
      id: { not: support.id }
    }
  });

  for (const user of users) {
    await upsertContactPair(user.id, support.id);
    await upsertContactPair(support.id, user.id);
  }

  return support;
}

export async function seedDefaultAccounts() {
  const [support, admin] = await Promise.all([ensureDefaultSupportAccount(), ensureAdminAccount()]);
  await ensureSupportContactsForAllClients();
  return { support, admin };
}
