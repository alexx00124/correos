import nodemailer from "nodemailer";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass
  }
});

function utcDayRange(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 1);
  return { start, end };
}

export async function getRemainingDailyQuota() {
  const { start, end } = utcDayRange();
  const sentToday = await prisma.message.count({
    where: {
      status: "sent",
      sentAt: {
        gte: start,
        lt: end
      }
    }
  });
  return {
    sentToday,
    remaining: Math.max(0, config.freeDailyLimit - sentToday)
  };
}

export async function processBatch() {
  const quota = await getRemainingDailyQuota();
  if (quota.remaining <= 0) {
    return { processed: 0, sent: 0, failed: 0, suppressed: 0, reason: "quota_reached" };
  }

  const limit = Math.min(config.batchSize, quota.remaining);
  const messages = await prisma.message.findMany({
    where: { status: "queued" },
    orderBy: { id: "asc" },
    take: limit,
    include: { campaign: true }
  });

  if (messages.length === 0) {
    return { processed: 0, sent: 0, failed: 0, suppressed: 0, reason: "queue_empty" };
  }

  let sent = 0;
  let failed = 0;
  let suppressed = 0;

  for (const msg of messages) {
    const suppression = await prisma.suppressionGlobal.findUnique({ where: { email: msg.toEmail } });

    if (suppression?.isActive) {
      await prisma.message.update({
        where: { id: msg.id },
        data: { status: "suppressed", attempts: { increment: 1 } }
      });
      await prisma.messageEvent.create({
        data: {
          messageId: msg.id,
          eventType: "suppressed",
          provider: "internal",
          recipientEmail: msg.toEmail,
          metaJson: { reason: suppression.reason }
        }
      });
      suppressed += 1;
      continue;
    }

    const unsubscribeUrl = `${config.unsubscribeBaseUrl}/unsubscribe?email=${encodeURIComponent(msg.toEmail)}`;
    const html = `${msg.campaign.htmlBody}<p style="font-size:12px;color:#777">Si no quieres recibir mas correos, <a href="${unsubscribeUrl}">cancelar suscripcion</a>.</p>`;
    const text = `${msg.campaign.textBody}\n\nCancelar suscripcion: ${unsubscribeUrl}`;

    try {
      const info = await transporter.sendMail({
        from: `${msg.campaign.fromName} <${msg.campaign.fromEmail}>`,
        to: msg.toEmail,
        replyTo: config.from.replyTo,
        subject: msg.campaign.subject,
        text,
        html,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
        }
      });

      await prisma.message.update({
        where: { id: msg.id },
        data: {
          status: "sent",
          sentAt: new Date(),
          providerMessageId: info.messageId,
          attempts: { increment: 1 },
          errorCode: null,
          errorMessage: null
        }
      });

      await prisma.messageEvent.create({
        data: {
          messageId: msg.id,
          eventType: "sent",
          provider: "smtp",
          providerMessageId: info.messageId,
          recipientEmail: msg.toEmail
        }
      });

      sent += 1;
    } catch (error) {
      await prisma.message.update({
        where: { id: msg.id },
        data: {
          status: "failed",
          attempts: { increment: 1 },
          errorCode: error.code ?? "smtp_error",
          errorMessage: String(error.message ?? "Unknown error")
        }
      });

      await prisma.messageEvent.create({
        data: {
          messageId: msg.id,
          eventType: "failed",
          provider: "smtp",
          recipientEmail: msg.toEmail,
          metaJson: {
            code: error.code ?? "smtp_error",
            message: String(error.message ?? "Unknown error")
          }
        }
      });

      failed += 1;
    }
  }

  return { processed: messages.length, sent, failed, suppressed, reason: "ok" };
}
