import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";
import { Storage } from "@google-cloud/storage";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "15mb" }));

// ===== ENV =====
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BUCKET_NAME = process.env.BUCKET_NAME;

// ===== CLIENTS =====
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const storage = new Storage();

// ===== HEALTH =====
app.get("/", (_, res) => {
  res.status(200).send("ok");
});

// ===== META VERIFY =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== META EVENTS =====
app.post("/webhook", async (req, res) => {
  // Meta требует быстрый 200
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const event = entry?.messaging?.[0];
    if (!event) return;

    const psid = event.sender?.id;
    const message = event.message;

    if (!psid) return;

    // === IMAGE MESSAGE ===
    if (message?.attachments?.[0]?.type === "image") {
      await sendText(psid, "Processing your successful version ⏳");

      const imageUrl = await generateAndUploadImage();

      await sendImage(psid, imageUrl);
      await sendText(psid, "Would you post this as a profile photo or story?");
      return;
    }

    // === DEFAULT TEXT ===
    await sendText(
      psid,
      "Send a photo and I’ll show how you’d look if you were successful."
    );
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

// ===== OPENAI → GCS =====
async function generateAndUploadImage() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!BUCKET_NAME) throw new Error("Missing BUCKET_NAME");

  const prompt = `
Make a realistic, high-quality portrait of a confident, successful professional.
Clean studio lighting, natural skin texture, well-groomed appearance.
No cartoon or stylization.
`;

  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: "1024x1024"
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI did not return image");

  const buffer = Buffer.from(b64, "base64");

  const objectName = `out/${crypto.randomUUID()}.png`;
  const file = storage.bucket(BUCKET_NAME).file(objectName);

  await file.save(buffer, {
    contentType: "image/png",
    resumable: false,
    metadata: {
      cacheControl: "public, max-age=31536000"
    }
  });

  return `https://storage.googleapis.com/${BUCKET_NAME}/${objectName}`;
}

// ===== MESSENGER SENDERS =====
async function sendText(psid, text) {
  const resp = await fetch(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        message: { text }
      })
    }
  );

  if (!resp.ok) {
    console.error("SendText error:", resp.status, await resp.text());
  }
}

async function sendImage(psid, imageUrl) {
  const resp = await fetch(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        message: {
          attachment: {
            type: "image",
            payload: {
              url: imageUrl,
              is_reusable: false
            }
          }
        }
      })
    }
  );

  if (!resp.ok) {
    console.error("SendImage error:", resp.status, await resp.text(), imageUrl);
  }
}

// ===== START SERVER =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});


