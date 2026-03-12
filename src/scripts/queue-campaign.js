import { prisma } from "../lib/prisma.js";

const campaignId = Number(process.argv[2]);

if (!campaignId || Number.isNaN(campaignId)) {
  console.error("Usage: npm run campaign:queue -- <campaignId>");
  process.exit(1);
}

const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
if (!campaign) {
  console.error(`Campaign ${campaignId} not found`);
  process.exit(1);
}

const activeSuppressions = await prisma.suppressionGlobal.findMany({
  where: { isActive: true },
  select: { email: true }
});

const suppressedEmails = activeSuppressions.map((s) => s.email);
const subscribers = await prisma.subscriber.findMany({
  where: {
    status: "active",
    ...(suppressedEmails.length > 0 ? { email: { notIn: suppressedEmails } } : {})
  },
  select: { id: true, email: true }
});

const payload = subscribers.map((s) => ({
  campaignId,
  subscriberId: s.id,
  toEmail: s.email,
  status: "queued",
  provider: "smtp"
}));

let inserted = 0;
const chunkSize = 1000;

for (let i = 0; i < payload.length; i += chunkSize) {
  const chunk = payload.slice(i, i + chunkSize);
  const result = await prisma.message.createMany({
    data: chunk,
    skipDuplicates: true
  });
  inserted += result.count;
}

await prisma.campaign.update({
  where: { id: campaignId },
  data: { status: "queued" }
});

console.log(`Queued messages: ${inserted} for campaign ${campaignId}`);

await prisma.$disconnect();
