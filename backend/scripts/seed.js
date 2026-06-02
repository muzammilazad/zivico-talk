import "dotenv/config";
import { seedDefaultAccounts } from "../src/services/defaultAccounts.js";
import { prisma } from "../src/services/prisma.js";

try {
  const { support, admin } = await seedDefaultAccounts();
  console.log(`Support account ready: ${support?.email || "not configured"}`);
  console.log(`Admin account ready: ${admin?.email || "not configured"}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
