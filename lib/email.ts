import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.EMAIL_FROM ?? "Yazlık <hello@yazlik.local>";

const resend = apiKey ? new Resend(apiKey) : null;

export type Attachment = { filename: string; content: string };

/**
 * Sends mail, or prints it when no Resend key is configured.
 *
 * The dev fallback is deliberate: the entire request → approve → notify loop
 * stays testable without a real key, and nothing is accidentally sent to a
 * real person from a development machine.
 */
export async function send(opts: {
  to: string;
  subject: string;
  html: string;
  attachments?: Attachment[];
}) {
  if (!resend || !apiKey || apiKey.startsWith("re_dev_dummy")) {
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
  await resend.emails.send({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    attachments: opts.attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content).toString("base64"),
    })),
  });
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
