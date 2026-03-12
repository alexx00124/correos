import fs from "node:fs";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const name = getArg("--name") ?? "Campana sin nombre";
const subject = getArg("--subject") ?? "Actualizacion";
const htmlFile = getArg("--html-file");
const textFile = getArg("--text-file");

const htmlBody = htmlFile
  ? fs.readFileSync(path.resolve(htmlFile), "utf8")
  : "<html><body><h1>Hola</h1><p>Esta es una campana de prueba.</p></body></html>";

const textBody = textFile
  ? fs.readFileSync(path.resolve(textFile), "utf8")
  : "Hola\n\nEsta es una campana de prueba.";

const campaign = await prisma.campaign.create({
  data: {
    name,
    subject,
    fromName: config.from.name,
    fromEmail: config.from.email,
    htmlBody,
    textBody,
    status: "draft"
  }
});

console.log(`Campaign created: id=${campaign.id} name=${campaign.name}`);

await prisma.$disconnect();
