import path from "node:path";
import xlsx from "xlsx";
import { prisma } from "../lib/prisma.js";
import { isValidEmail, normalizeEmail } from "../lib/email-utils.js";

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const filePath = process.argv[2];
const sheetName = getArg("--sheet");
const source = getArg("--source") ?? "excel_import";

if (!filePath) {
  console.error("Usage: npm run import:excel -- ./contactos.xlsx [--sheet Hoja1] [--source landing]");
  process.exit(1);
}

const workbook = xlsx.readFile(path.resolve(filePath));
const targetSheet = sheetName ?? workbook.SheetNames[0];
const sheet = workbook.Sheets[targetSheet];

if (!sheet) {
  console.error(`Sheet not found: ${targetSheet}`);
  process.exit(1);
}

const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
let total = 0;
let invalid = 0;
let suppressed = 0;
let upserted = 0;

for (const row of rows) {
  total += 1;
  const rawEmail = row.email || row.Email || row.EMAIL;
  const email = normalizeEmail(rawEmail);
  const fullName = String(row.nombre || row.name || row.full_name || "").trim() || null;
  const consentRaw = row.consentimiento_fecha || row.consent_at || row.consent;
  const consentAt = consentRaw ? new Date(consentRaw) : null;

  if (!isValidEmail(email)) {
    invalid += 1;
    continue;
  }

  const suppression = await prisma.suppressionGlobal.findUnique({ where: { email } });
  if (suppression?.isActive) {
    suppressed += 1;
    continue;
  }

  await prisma.subscriber.upsert({
    where: { email },
    update: {
      fullName,
      source,
      consentAt: consentAt && !Number.isNaN(consentAt.getTime()) ? consentAt : null,
      status: "active"
    },
    create: {
      email,
      fullName,
      source,
      consentAt: consentAt && !Number.isNaN(consentAt.getTime()) ? consentAt : null,
      status: "active"
    }
  });

  upserted += 1;
}

console.log("Import finished:");
console.log(`- total rows: ${total}`);
console.log(`- upserted: ${upserted}`);
console.log(`- invalid: ${invalid}`);
console.log(`- skipped (suppressed): ${suppressed}`);

await prisma.$disconnect();
