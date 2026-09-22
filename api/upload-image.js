const { put } = require("@vercel/blob");

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-secret");

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

  const { filename, contentType, dataBase64 } = req.body || {};
  if (!filename || !contentType || !dataBase64) {
    res.status(400).json({ error: "missing filename, contentType, or dataBase64" });
    return;
  }

  if (!ALLOWED_TYPES.includes(contentType)) {
    res.status(400).json({ error: "unsupported image type" });
    return;
  }

  const buffer = Buffer.from(dataBase64, "base64");
  if (buffer.length > MAX_BYTES) {
    res.status(400).json({ error: "image too large (5MB max)" });
    return;
  }

  try {
    const blob = await put(`event-images/${Date.now()}-${filename}`, buffer, {
      access: "public",
      contentType,
      addRandomSuffix: true,
    });
    res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error("upload-image failed:", err);
    res.status(502).json({ error: "couldn't upload image", message: err.message });
  }
};
