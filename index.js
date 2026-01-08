import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "10mb" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- Webhook verification ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Receive messages ---
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

      const imageUrl = message.attachments[0].payload.url;
      const editedImageUrl = await generateSuccessfulImage(imageUrl);

      await sendImage(senderId, editedImageUrl);
      await sendText(senderId, "Would you post this as a profile photo or story?");
    } else {
      await sendText(
        senderId,
        "Send a photo and I’ll show how you’d look if you were successful ✨"
      );
    }
  } catch (err) {
    console.error("Error:", err);
  }
});

// --- OpenAI Image Edit ---
async function generateSuccessfulImage(imageUrl) {
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  const prompt = `
Make a realistic, high-quality portrait of the same person,
showing a successful, confident professional look.
Clean studio lighting, natural skin texture,
well-groomed appearance.
Preserve identity. No cartoon or stylization.
`;

  const response = await client.images.generate({
    model: "gpt-image-1",
    prompt,
    size: "1024x1024"
  });

  return response.data[0].url;
}

// --- Messenger helpers ---
async function sendText(psid, text) {
  await fetch(
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
}

async function sendImage(psid, imageUrl) {
  await fetch(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        message: {
          attachment: {
            type: "image",
            payload: { url: imageUrl }
          }
        }
      })
    }
  );
}

app.get("/", (_, res) => res.send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on", PORT));
