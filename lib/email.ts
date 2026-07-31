import { Resend } from "resend";
import nodemailer from "nodemailer";

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.EMAIL_FROM ?? "Yazlık <hello@yazlik.local>";

const resend = apiKey ? new Resend(apiKey) : null;

export type Attachment = { filename: string; content: string };

/* ============================================================
   HOW MAIL LEAVES
   ============================================================ */

/**
 * Three ways out, chosen in this order, first one that is configured wins.
 *
 * 1. **SMTP**, when `SMTP_HOST` is set. This is the one to reach for while
 *    testing: point it at Mailpit, Mailhog, Ethereal or your own server and
 *    every message the product sends lands in a real inbox you can open,
 *    rendered by a real mail client rather than by a terminal. That matters
 *    more than it sounds — the confirmation carries an `.ics` attachment, and
 *    "does the calendar file actually attach and open" cannot be answered by
 *    reading HTML in a log.
 * 2. **Resend**, when `RESEND_API_KEY` is set. Production.
 * 3. **The console**, when neither is. Not a degraded mode: it is what lets the
 *    whole request → approve → notify loop be exercised on a laptop with no
 *    account anywhere, and it guarantees a development machine cannot email a
 *    real person by accident.
 *
 * SMTP is checked first on purpose. Someone testing deliverability has usually
 * left a Resend key lying in `.env.local`, and the surprising outcome would be
 * the mail going to the real service anyway.
 */
type Transport = "smtp" | "resend" | "console";

function transport(): Transport {
  if (process.env.SMTP_HOST?.trim()) return "smtp";
  // A dummy key counts as unconfigured — it is how the seeded env says "print
  // it" without leaving the variable out entirely.
  if (resend && apiKey && !apiKey.startsWith("re_dev_dummy")) return "resend";
  return "console";
}

/**
 * Built per send rather than held open.
 *
 * A long-lived pool is the right shape for a mail server and the wrong one for
 * a serverless function, which may be frozen between requests holding a socket
 * the far end has already given up on. This product sends single messages at
 * human pace; a connection per message costs nothing anyone will notice.
 */
function smtpTransport() {
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST!.trim(),
    port,
    // 465 is implicit TLS; everything else starts plain and upgrades with
    // STARTTLS. `SMTP_SECURE` overrides when a server disagrees.
    secure: process.env.SMTP_SECURE
      ? process.env.SMTP_SECURE === "true"
      : port === 465,
    // A local Mailpit or Mailhog wants no credentials at all, and passing an
    // empty user makes it refuse the connection.
    auth: user ? { user, pass } : undefined,
  });
}

/**
 * Sends mail by whichever route is configured.
 *
 * Never throws into a caller's happy path on its own account — but note this
 * function itself does not swallow errors: `lib/emails.ts` is where each of the
 * five messages is wrapped, so an approval can never fail because a mail server
 * was slow. Keep it that way.
 */
export async function send(opts: {
  to: string;
  subject: string;
  html: string;
  attachments?: Attachment[];
}) {
  switch (transport()) {
    case "smtp": {
      await smtpTransport().sendMail({
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        attachments: opts.attachments?.map((a) => ({
          filename: a.filename,
          // The one attachment this product sends is an `.ics`, which is text.
          content: a.content,
          contentType: "text/calendar; charset=utf-8",
        })),
      });
      return;
    }

    case "resend": {
      await resend!.emails.send({
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        attachments: opts.attachments?.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content).toString("base64"),
        })),
      });
      return;
    }

    case "console": {
      console.log(
        "\n[email:dev]",
        opts.subject,
        "→",
        opts.to,
        "\n" + opts.html,
        opts.attachments?.length
          ? `\n[attachments] ${opts.attachments.map((a) => a.filename).join(", ")}`
          : "",
        "\n",
      );
      return;
    }
  }
}

export async function sendMagicLinkEmail(email: string, url: string) {
  await send({
    to: email,
    subject: "Sign in to Yazlık",
    html: [
      `<p>Open the link below to sign in. It expires in an hour.</p>`,
      `<p><a href="${url}">Sign in to Yazlık</a></p>`,
      `<p>If you didn't ask for this, nothing happens — ignore it.</p>`,
    ].join(""),
  });
}
