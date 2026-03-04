const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cron = require("node-cron");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

// 🔗 Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Gym WhatsApp Bot Running 🚀");
});

// 🛑 LOCK
let isRunning = false;

// 🔁 RETRY
async function sendWithRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      console.log(`⚠️ Retry ${i + 1}`, err.response?.data || err.message);
      await new Promise(res => setTimeout(res, 3000));
    }
  }
  throw new Error("Failed after retries");
}

// 🔥 TEMPLATE MAP (IMPORTANT)
const TEMPLATE_MAP = {
  before_expiry: "before_expiry",
  today_expiry: "today_expiry",
  after_expiry: "after_expiry"
};

// 🔥 MESSAGE FORMAT (for UI)
function formatMessage(type, name, date) {
  if (type === "before_expiry") {
    return `Hi ${name}! You've built the habit, now don't let it slip. ⚡Your membership set to renew on ${date}. Let’s keep that momentum going—renew now to keep your progress! 📈`;
  }
  if (type === "today_expiry") {
    return `Hi ${name}! Your membership ends today (${date}). Remember—Consistency is what separates the best from the rest.🔥 You are so Close to your Goal — don't let it slip now! Renew today to maintain your 'Active' status and keep the Grind going 🏋️‍♂️`;
  }
  if (type === "after_expiry") {
    return `Hi ${name}, Don't let all that hard work go to waste 📉. Your membership wrapped up on ${date}, But your Goals are still waiting for You. The best time to Restart is right Now. Ready to get back on Track? 👊`;
  }
  return "";
}

// 📤 SEND TEMPLATE
async function sendTemplate(phone, name, expiry_date, type) {
  const templateName = TEMPLATE_MAP[type];

  if (!templateName) {
    throw new Error("Invalid template type");
  }

  return sendWithRetry(async () => {
    const res = await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: name },
                { type: "text", text: expiry_date }
              ]
            }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ WhatsApp Sent:");
  });
}

// 🔁 CRON JOB
cron.schedule("* * * * *", async () => {
  if (isRunning) return;
  isRunning = true;

  console.log("⏰ Running expiry check...");

  try {
    const { data: members } = await supabase.from("members").select("*");

    for (let member of members || []) {
      try {
        const today = new Date();
        const expiry = new Date(member.expiry_date);
        const diffDays = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

        let type = null;
        if (diffDays === 3) type = "before_expiry";
        else if (diffDays === 0) type = "today_expiry";
        else if (diffDays < 0) type = "after_expiry";

        if (!type) continue;

        // 🚫 DUPLICATE PREVENTION (12 HOURS)
        const now = new Date();
        const last = member.last_reminder_sent_at
          ? new Date(member.last_reminder_sent_at)
          : null;

        if (last) {
          const diffHours = (now - last) / (1000 * 60 * 60);
          if (diffHours < 12) {
            console.log("⛔ Skipping duplicate:", member.name);
            continue;
          }
        }

        console.log("🚀 Sending:", member.name, type);

        // 📤 SEND
        await sendTemplate(member.phone, member.name, member.expiry_date, type);

        // 💬 FORMAT
        const msg = formatMessage(type, member.name, member.expiry_date);

        // 💾 SAVE MESSAGE
        await supabase.from("messages").insert([
          {
            phone: member.phone,
            message: msg,
            sender: "business",
            type: "text",
            gym_id: member.gym_id,
          }
        ]);

        // ✅ UPDATE STATUS
        await supabase.from("members").update({
          status: `${type.replace("_expiry", "")}_sent`,
          last_reminder_sent_at: new Date().toISOString()
        }).eq("id", member.id);

        console.log("✅ Done:", member.name);

      } catch (err) {
        console.log("❌ Member failed:", member.name, err.message);
      }

      await new Promise(res => setTimeout(res, 1000));
    }

  } catch (err) {
    console.log("❌ CRON ERROR:", err);
  }

  isRunning = false;
});

// 📤 SEND MESSAGE (CHAT → WHATSAPP)
app.post("/send-message", async (req, res) => {
  try {
    const { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: "phone and message required" });
    }

    console.log("📤 Sending from chat:", phone, message);

    // 📡 SEND TO WHATSAPP
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ WhatsApp Sent:");

    // 💾 SAVE TO DB
    const { data: member } = await supabase
      .from("members")
      .select("gym_id")
      .eq("phone", phone)
      .maybeSingle();

    await supabase.from("messages").insert([
      {
        phone,
        message,
        sender: "business",
        type: "text",
        gym_id: member?.gym_id || null,
      },
    ]);

    res.json({ success: true });

  } catch (err) {
    console.log("❌ SEND ERROR:", err.response?.data || err.message);

    res.status(500).json({
      error: "Failed to send",
      details: err.response?.data || err.message,
    });
  }
});

// 📩 WEBHOOK (SAVE USER MSG)
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const phone = msg.from;
    const text = msg.text?.body || "";

    const { data: member } = await supabase
      .from("members")
      .select("gym_id")
      .eq("phone", phone)
      .maybeSingle();

    await supabase.from("messages").insert([
      {
        phone,
        message: text,
        sender: "user",
        type: "text",
        gym_id: member?.gym_id || null,
      }
    ]);

    res.sendStatus(200);
  } catch {
    res.sendStatus(500);
  }
});

// 📤 MANUAL REMINDER (FRONTEND BUTTON)
app.post("/send-reminder", async (req, res) => {
  try {
    const { member_id } = req.body;

    const { data: member } = await supabase
      .from("members")
      .select("*")
      .eq("id", member_id)
      .single();

    if (!member) return res.status(404).json({ error: "Not found" });

    const today = new Date();
    const expiry = new Date(member.expiry_date);
    const diffDays = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

    let type = null;
    if (diffDays === 3) type = "before_expiry";
    else if (diffDays === 0) type = "today_expiry";
    else if (diffDays < 0) type = "after_expiry";

    if (!type) return res.json({ message: "No reminder needed" });

    // 🚫 DUPLICATE CHECK
    const now = new Date();
    const last = member.last_reminder_sent_at
      ? new Date(member.last_reminder_sent_at)
      : null;

    if (last) {
      const diffHours = (now - last) / (1000 * 60 * 60);
      if (diffHours < 12) {
        return res.json({ message: "Already sent recently" });
      }
    }

    // 📤 SEND
    await sendTemplate(member.phone, member.name, member.expiry_date, type);

    const msg = formatMessage(type, member.name, member.expiry_date);

    await supabase.from("messages").insert([
      {
        phone: member.phone,
        message: msg,
        sender: "business",
        type: "text",
        gym_id: member.gym_id,
      }
    ]);

    await supabase.from("members").update({
      status: `${type.replace("_expiry", "")}_sent`,
      last_reminder_sent_at: new Date().toISOString()
    }).eq("id", member.id);

    res.json({ success: true });

  } catch (err) {
    console.log("❌ Manual Error:", err.message);
    res.status(500).json({ error: "Failed" });
  }
});

//webhook
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "gymbot265";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 🚀 START
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});