import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";
import { Storage } from "@google-cloud/storage";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "15mb" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BUCKET_NAME = process.env.BUCKET_NAME;

const storage = new Storage();

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const event = entry?.messaging?.[0];
    if (!event) return;

    const senderId = event.sender.id;
    const message = event.message;

    if (message?.attachments?.[0]?.type === "image") {
      await sendText(senderId, "Processing your successful version ⏳");

      // Пока генерим изображение (следом сделаем photo→photo edit)
      const publicImageUrl = await generateAndUploadImage();

      await sendImage(senderId, publicImageUrl);
      await sendText(senderId, "Would you post this as a profile photo or story?");
      return;
    }

    await sendText(senderId, "Send a photo and I’ll show how you’d look if you were successful.");
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

async function generateAndUploadImage() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!BUCKET_NAME) throw new Error("Missing BUCKET_NAME");

  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  const prompt = `
Make a realistic, high-quality portrait of a confident, successful professional.
Clean studio lighting, natural skin texture, well-groomed appearance.
No cartoon or stylization.
`;

  const response = await client.images.generate({
    model: "gpt-image-1",
    prompt,
    size: "1024x1024",
    response_format: "b64_json"
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI did not return b64_json");

  const buffer = Buffer.from(b64, "base64");

  const objectName = `out/${crypto.randomUUID()}.png`;
  const file = storage.bucket(BUCKET_NAME).file(objectName);

  await file.save(buffer, {
    contentType: "image/png",
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000" }
  });

  return `https://storage.googleapis.com/${BUCKET_NAME}/${objectName}`;
}

async function sendText(psid, text) {
  const resp = await fetch(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: psid }, message: { text } })
    }
  );
  if (!resp.ok) console.error("SendText error:", resp.status, await resp.text());
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
          attachment: { type: "image", payload: { url: imageUrl, is_reusable: false } }
        }
      })
    }
  );
  if (!resp.ok) console.error("SendImage error:", resp.status, await resp.text(), "url:", imageUrl);
}

app.get("/", (_, res) => res.send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on", PORT));

