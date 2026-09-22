const nodemailer = require("nodemailer");

const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || "daashaf003@gmail.com";

function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function buildEmail(type, payload) {
  const b = payload.booking || {};
  const link = payload.link || "";

  if (type === "organizer_submitted") {
    return {
      to: b.organizerEmail,
      subject: `We've received your request: ${b.title}`,
      text: [
        `Hi ${b.organizer || "there"},`,
        ``,
        `Your booking request "${b.title}" has been submitted and is now pending admin review.`,
        ``,
        `Venue: ${b.location || "—"}`,
        `Window: ${formatDateTime(b.start)} → ${formatDateTime(b.due)}`,
        ``,
        `We'll email you again once it's reviewed.`,
        link ? `\nTrack it here: ${link}` : "",
      ].join("\n"),
    };
  }

  if (type === "admin_new_request") {
    return {
      to: ADMIN_NOTIFY_EMAIL,
      subject: `New booking request: ${b.title}`,
      text: [
        `A new booking request needs review.`,
        ``,
        `Title: ${b.title}`,
        `Organizer: ${b.organizer || b.organizerType || "—"} (${b.organizerEmail || "—"})`,
        `Department: ${b.department || "—"}`,
        `Venue: ${b.location || "—"}`,
        `Window: ${formatDateTime(b.start)} → ${formatDateTime(b.due)}`,
        ``,
        link ? `Review it here: ${link}` : "",
      ].join("\n"),
    };
  }

  if (type === "organizer_published") {
    return {
      to: b.organizerEmail,
      subject: `Your event is live: ${b.title}`,
      text: [
        `Hi ${b.organizer || "there"},`,
        ``,
        `"${b.title}" has been published and is now visible on the public calendar.`,
        ``,
        `Venue: ${b.location || "—"}`,
        `Window: ${formatDateTime(b.start)} → ${formatDateTime(b.due)}`,
        ``,
        link ? `View it here: ${link}` : "",
      ].join("\n"),
    };
  }

  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  if (process.env.APP_SHARED_SECRET && req.headers["x-app-secret"] !== process.env.APP_SHARED_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowedOrigins.length > 0) {
    const origin = req.headers.origin || "";
    if (!allowedOrigins.includes(origin)) {
      res.status(403).json({ error: "forbidden origin" });
      return;
    }
  }

  const { type, booking, link } = req.body || {};
  if (!type || !booking) {
    res.status(400).json({ error: "missing type or booking" });
    return;
  }

  const email = buildEmail(type, { booking, link });
  if (!email) {
    res.status(400).json({ error: "unknown email type" });
    return;
  }
  if (!email.to) {
    res.status(400).json({ error: "no recipient for this email" });
    return;
  }

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("SMTP_USER / SMTP_PASS not configured — skipping send.");
    res.status(200).json({ ok: false, skipped: true, reason: "SMTP not configured" });
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email.to,
      subject: email.subject,
      text: email.text,
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-email failed:", err);
    res.status(502).json({ error: "couldn't send email", message: err.message });
  }
};
