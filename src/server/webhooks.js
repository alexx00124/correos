import express from "express";
import fs from "node:fs";
import path from "node:path";
import xlsx from "xlsx";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { isValidEmail, normalizeEmail } from "../lib/email-utils.js";
import { getRemainingDailyQuota, processBatch } from "../services/send-service.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

let workerTimer = null;

function getArgRowValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return row[key];
    }
  }
  return "";
}

async function importExcel(filePath, sheetName = null, source = "excel_import") {
  const workbook = xlsx.readFile(path.resolve(filePath));
  const targetSheet = sheetName ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[targetSheet];
  if (!sheet) {
    throw new Error(`Sheet not found: ${targetSheet}`);
  }

  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
  let total = 0;
  let invalid = 0;
  let suppressed = 0;
  let upserted = 0;

  for (const row of rows) {
    total += 1;
    const rawEmail = getArgRowValue(row, ["email", "Email", "EMAIL"]);
    const email = normalizeEmail(rawEmail);
    const fullName = String(getArgRowValue(row, ["nombre", "name", "full_name"])) || null;
    const consentRaw = getArgRowValue(row, ["consentimiento_fecha", "consent_at", "consent"]);
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

  return { total, invalid, suppressed, upserted };
}

async function queueCampaign(campaignId) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) {
    throw new Error(`Campaign ${campaignId} not found`);
  }

  const suppressions = await prisma.suppressionGlobal.findMany({
    where: { isActive: true },
    select: { email: true }
  });

  const suppressedEmails = suppressions.map((x) => x.email);
  const subscribers = await prisma.subscriber.findMany({
    where: {
      status: "active",
      ...(suppressedEmails.length ? { email: { notIn: suppressedEmails } } : {})
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
  for (let i = 0; i < payload.length; i += 1000) {
    const chunk = payload.slice(i, i + 1000);
    const result = await prisma.message.createMany({ data: chunk, skipDuplicates: true });
    inserted += result.count;
  }

  await prisma.campaign.update({ where: { id: campaignId }, data: { status: "queued" } });
  return inserted;
}

function pageTemplate(stats, campaigns, note = "") {
  const rows = campaigns
    .map(
      (c) => `<tr><td>${c.id}</td><td>${c.name}</td><td>${c.status}</td><td>${c._count.messages}</td><td>${new Date(c.createdAt).toLocaleString()}</td></tr>`
    )
    .join("");

  const alert = note ? `<div style="padding:10px;border:1px solid #86efac;background:#f0fdf4;margin-bottom:16px">${note}</div>` : "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Panel de Correos</title>
  <style>
    body{font-family:Arial,sans-serif;max-width:1000px;margin:24px auto;padding:0 12px;background:#f7fafc}
    h1{margin-bottom:8px}
    .card{background:white;border:1px solid #e2e8f0;padding:14px;margin:12px 0;border-radius:8px}
    .row{display:flex;gap:8px;flex-wrap:wrap}
    input,textarea,button{padding:8px;border:1px solid #cbd5e1;border-radius:6px}
    input,textarea{width:100%}
    .col{flex:1 1 260px}
    table{width:100%;border-collapse:collapse}
    th,td{border-bottom:1px solid #e2e8f0;padding:8px;text-align:left}
    .kpi{display:flex;gap:12px;flex-wrap:wrap}
    .kpi div{background:#0f172a;color:#e2e8f0;padding:8px 12px;border-radius:8px}
  </style>
</head>
<body>
  <h1>Panel Local de Email</h1>
  <p>Importa Excel, crea campanas, encola y envia sin usar terminal para cada paso.</p>
  ${alert}
  <div class="kpi">
    <div>Subscribers: ${stats.subscribers}</div>
    <div>Queued: ${stats.queued}</div>
    <div>Sent: ${stats.sent}</div>
    <div>Failed: ${stats.failed}</div>
    <div>Suppressed: ${stats.suppressed}</div>
    <div>Quota hoy: ${stats.sentToday}/${config.freeDailyLimit}</div>
    <div>Worker: ${stats.workerRunning ? "activo" : "detenido"}</div>
  </div>

  <div class="card">
    <h3>1) Importar Excel</h3>
    <form method="post" action="/ui/import-excel">
      <div class="row">
        <div class="col"><input name="filePath" placeholder="Ruta del archivo .xlsx, ejemplo: C:\\datos\\contactos.xlsx" required /></div>
        <div class="col"><input name="sheetName" placeholder="Sheet (opcional)" /></div>
        <div class="col"><input name="source" placeholder="Source (opcional)" value="excel_import" /></div>
      </div>
      <button type="submit">Importar</button>
    </form>
  </div>

  <div class="card">
    <h3>2) Crear campana</h3>
    <form method="post" action="/ui/create-campaign">
      <div class="row">
        <div class="col"><input name="name" placeholder="Nombre de campana" required /></div>
        <div class="col"><input name="subject" placeholder="Asunto" required /></div>
      </div>
      <textarea name="htmlBody" rows="4" placeholder="HTML del correo" required></textarea>
      <textarea name="textBody" rows="3" placeholder="Texto plano del correo" required></textarea>
      <button type="submit">Crear campana</button>
    </form>
  </div>

  <div class="card">
    <h3>3) Encolar campana</h3>
    <form method="post" action="/ui/queue-campaign" class="row">
      <div class="col"><input name="campaignId" placeholder="ID campana" required /></div>
      <button type="submit">Encolar</button>
    </form>
  </div>

  <div class="card">
    <h3>4) Envio</h3>
    <form method="post" action="/ui/process-once" style="display:inline-block;margin-right:8px">
      <button type="submit">Procesar 1 lote</button>
    </form>
    <form method="post" action="/ui/worker/start" style="display:inline-block;margin-right:8px">
      <button type="submit">Iniciar worker automatico</button>
    </form>
    <form method="post" action="/ui/worker/stop" style="display:inline-block">
      <button type="submit">Detener worker</button>
    </form>
  </div>

  <div class="card">
    <h3>Campanas recientes</h3>
    <table>
      <thead><tr><th>ID</th><th>Nombre</th><th>Status</th><th>Mensajes</th><th>Creada</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='5'>Sin campanas</td></tr>"}</tbody>
    </table>
  </div>
</body>
</html>`;
}

function mapEventToSuppressionReason(eventType) {
  if (eventType === "bounce_hard") return "hard_bounce";
  if (eventType === "complaint") return "complaint";
  if (eventType === "unsubscribe") return "unsubscribe";
  return null;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, workerRunning: Boolean(workerTimer) });
});

app.get("/", async (req, res) => {
  const [subscribers, queued, sent, failed, suppressed, quota, campaigns] = await Promise.all([
    prisma.subscriber.count(),
    prisma.message.count({ where: { status: "queued" } }),
    prisma.message.count({ where: { status: "sent" } }),
    prisma.message.count({ where: { status: "failed" } }),
    prisma.message.count({ where: { status: "suppressed" } }),
    getRemainingDailyQuota(),
    prisma.campaign.findMany({
      take: 10,
      orderBy: { id: "desc" },
      include: { _count: { select: { messages: true } } }
    })
  ]);

  const note = String(req.query.note ?? "").trim();
  res.send(
    pageTemplate(
      {
        subscribers,
        queued,
        sent,
        failed,
        suppressed,
        sentToday: quota.sentToday,
        workerRunning: Boolean(workerTimer)
      },
      campaigns,
      note
    )
  );
});

app.post("/ui/import-excel", async (req, res) => {
  try {
    const filePath = String(req.body.filePath ?? "").trim();
    const sheetName = String(req.body.sheetName ?? "").trim() || null;
    const source = String(req.body.source ?? "excel_import").trim();

    if (!filePath || !fs.existsSync(path.resolve(filePath))) {
      res.status(400).send("Archivo no encontrado. Verifica la ruta local.");
      return;
    }

    const result = await importExcel(filePath, sheetName, source);
    res.redirect(`/?note=${encodeURIComponent(`Importado: total=${result.total}, upserted=${result.upserted}, invalid=${result.invalid}, suppressed=${result.suppressed}`)}`);
  } catch (error) {
    res.status(500).send(`Error importando Excel: ${error.message}`);
  }
});

app.post("/ui/create-campaign", async (req, res) => {
  try {
    const name = String(req.body.name ?? "").trim();
    const subject = String(req.body.subject ?? "").trim();
    const htmlBody = String(req.body.htmlBody ?? "").trim();
    const textBody = String(req.body.textBody ?? "").trim();

    if (!name || !subject || !htmlBody || !textBody) {
      res.status(400).send("name, subject, htmlBody y textBody son obligatorios");
      return;
    }

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

    res.redirect(`/?note=${encodeURIComponent(`Campana creada con id=${campaign.id}`)}`);
  } catch (error) {
    res.status(500).send(`Error creando campana: ${error.message}`);
  }
});

app.post("/ui/queue-campaign", async (req, res) => {
  try {
    const campaignId = Number(req.body.campaignId);
    if (!campaignId || Number.isNaN(campaignId)) {
      res.status(400).send("campaignId invalido");
      return;
    }

    const inserted = await queueCampaign(campaignId);
    res.redirect(`/?note=${encodeURIComponent(`Campana ${campaignId} encolada. Mensajes nuevos=${inserted}`)}`);
  } catch (error) {
    res.status(500).send(`Error encolando campana: ${error.message}`);
  }
});

app.post("/ui/process-once", async (_req, res) => {
  const result = await processBatch();
  res.redirect(
    `/?note=${encodeURIComponent(
      `Lote procesado: processed=${result.processed}, sent=${result.sent}, failed=${result.failed}, suppressed=${result.suppressed}, reason=${result.reason}`
    )}`
  );
});

app.post("/ui/worker/start", (_req, res) => {
  if (!workerTimer) {
    workerTimer = setInterval(async () => {
      try {
        const result = await processBatch();
        if (result.processed > 0) {
          console.log(`Worker tick processed=${result.processed} sent=${result.sent} failed=${result.failed} suppressed=${result.suppressed}`);
        }
      } catch (error) {
        console.error("Worker tick error:", error.message);
      }
    }, config.loopIntervalSeconds * 1000);
  }
  res.redirect("/?note=Worker automatico iniciado");
});

app.post("/ui/worker/stop", (_req, res) => {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  res.redirect("/?note=Worker automatico detenido");
});

app.get("/unsubscribe", async (req, res) => {
  const email = normalizeEmail(req.query.email);
  if (!email) {
    res.status(400).send("Missing email");
    return;
  }

  await prisma.suppressionGlobal.upsert({
    where: { email },
    update: { isActive: true, reason: "unsubscribe", source: "unsubscribe_link" },
    create: { email, isActive: true, reason: "unsubscribe", source: "unsubscribe_link" }
  });

  await prisma.subscriber.updateMany({
    where: { email },
    data: { status: "unsubscribed" }
  });

  res.status(200).send("Te desuscribiste correctamente.");
});

app.post("/webhooks/events", async (req, res) => {
  const {
    provider = "smtp",
    eventType,
    providerEventId,
    providerMessageId,
    recipientEmail,
    meta
  } = req.body ?? {};

  if (!eventType) {
    res.status(400).json({ error: "eventType is required" });
    return;
  }

  const normalizedEmail = normalizeEmail(recipientEmail);
  const message = providerMessageId
    ? await prisma.message.findFirst({
        where: { providerMessageId }
      })
    : null;

  try {
    await prisma.messageEvent.create({
      data: {
        messageId: message?.id,
        eventType,
        provider,
        providerEventId: providerEventId ?? null,
        providerMessageId: providerMessageId ?? null,
        recipientEmail: normalizedEmail || null,
        metaJson: meta ?? null
      }
    });
  } catch (error) {
    if (error.code !== "P2002") {
      throw error;
    }
  }

  const suppressionReason = mapEventToSuppressionReason(eventType);
  if (suppressionReason && normalizedEmail) {
    await prisma.suppressionGlobal.upsert({
      where: { email: normalizedEmail },
      update: { isActive: true, reason: suppressionReason, source: provider },
      create: {
        email: normalizedEmail,
        reason: suppressionReason,
        source: provider,
        isActive: true
      }
    });

    const status = suppressionReason === "unsubscribe" ? "unsubscribed" : suppressionReason === "complaint" ? "complained" : "bounced";
    await prisma.subscriber.updateMany({
      where: { email: normalizedEmail },
      data: { status }
    });
  }

  res.status(200).json({ ok: true });
});

app.listen(config.webhookPort, () => {
  console.log(`Panel y webhooks corriendo en http://localhost:${config.webhookPort}`);
});
