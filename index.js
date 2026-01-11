import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";
import { Storage } from "@google-cloud/storage";
import crypto from "crypto";
import FormData from "form-data";

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
app.get("/", (_, res) => res.status(200).send("ok"));

// ===== META VERIFY =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
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

    const att = message?.attachments?.[0];

    if (att?.type === "image") {
      await sendText(psid, "Processing your successful version ⏳");

      const imageUrl = att.payload?.url;
      if (!imageUrl) {
        await sendText(psid, "I couldn't read the photo URL. Please try again.");
        return;
      }

      // 1) download the original image from Messenger
      const inputBuffer = await downloadImageBuffer(imageUrl);

      // 2) photo → photo using OpenAI, then upload to GCS and get public URL
      const publicUrl = await editAndUploadImage(inputBuffer);

      // 3) send back to Messenger
      await sendImage(psid, publicUrl);
      await sendText(psid, "Would you post this as a profile photo or story?");
      return;
    }

    await sendText(psid, "Send a photo and I’ll show how you’d look if you were successful.");
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

// ===== DOWNLOAD IMAGE FROM URL =====
async function downloadImageBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to download image: ${resp.status} ${await resp.text()}`);
  }
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ===== PHOTO→PHOTO: OPENAI EDIT + GCS UPLOAD =====
// Uses raw REST call with multipart/form-data for maximum compatibility.
async function editAndUploadImage(inputBuffer) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!BUCKET_NAME) throw new Error("Missing BUCKET_NAME");

  const prompt = `
Transform the same person in the input photo into a "successful version" profile photo.
Preserve identity and facial features (same person). Keep pose similar.
Improve lighting, sharpness, grooming, and overall professional look.
Natural skin texture, realistic photo. No cartoon/anime. No extra people.
Background: clean and minimal (studio/office blur).`;

  // Create multipart form: image + model + prompt
  const form = new FormData();
  // Provide a filename and content-type; PNG works fine as container even if original was JPEG
  form.append("image", inputBuffer, { filename: "input.jpg", contentType: "image/jpeg" });
  form.append("model", "gpt-image-1");
  form.append("prompt", prompt);
  form.append("size", "1024x1024");

  // Call OpenAI images edits endpoint directly
  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...form.getHeaders()
    },
    body: form
  });

  const json = await resp.json();
  if (!resp.ok) {
    console.error("OpenAI error payload:", json);
    throw new Error(`OpenAI images/edits failed: ${resp.status} ${JSON.stringify(json)}`);
  }

  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI did not return b64_json from edits");

  const outBuffer = Buffer.from(b64, "base64");

  const objectName = `out/${crypto.randomUUID()}.png`;
  const file = storage.bucket(BUCKET_NAME).file(objectName);

  await file.save(outBuffer, {
    contentType: "image/png",
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000" }
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
      body: JSON.stringify({ recipient: { id: psid }, message: { text } })
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
          attachment: { type: "image", payload: { url: imageUrl, is_reusable: false } }
        }
      })
    }
  );

  if (!resp.ok) {
    console.error("SendImage error:", resp.status, await resp.text(), "url:", imageUrl);
  }
}

// ===== START SERVER =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on", PORT));
