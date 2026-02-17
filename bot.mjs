import "dotenv/config";
import OpenAI from "openai";
import { Telegraf } from "telegraf";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const groqKey = process.env.GROQ_API_KEY;

if (!botToken) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
if (!groqKey) throw new Error("Missing GROQ_API_KEY in .env");

const llm = new OpenAI({
  apiKey: groqKey,
  baseURL: "https://api.groq.com/openai/v1",
});

const bot = new Telegraf(botToken);

// Память диалога: отдельный контекст на каждый chat.id
const dialogs = new Map(); // chatId -> messages[]

function getMessages(chatId) {
  if (!dialogs.has(chatId)) {
    dialogs.set(chatId, [
      { role: "system", content: "Ты полезный ассистент. Отвечай кратко и по делу." },
    ]);
  }
  return dialogs.get(chatId);
}

bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  dialogs.delete(chatId);
  await ctx.reply("Привет! Пиши сообщение — я отвечу. Команды: /reset");
});

bot.command("reset", async (ctx) => {
  dialogs.delete(ctx.chat.id);
  await ctx.reply("Ок, контекст сброшен. Начнём заново.");
});

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text?.trim();
  if (!text) return;

  const messages = getMessages(chatId);
  messages.push({ role: "user", content: text });

  // (опционально) "печатает..." в чате
  await ctx.sendChatAction("typing");

  try {
    const res = await llm.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature: 0.7,
    });

    const answer = res.choices?.[0]?.message?.content ?? "(пустой ответ)";
    messages.push({ role: "assistant", content: answer });

    // Telegram ограничивает длину сообщений, подрежем на всякий случай
    const safe = answer.length > 3500 ? answer.slice(0, 3500) + "\n\n…(обрезано)" : answer;
    await ctx.reply(safe);
  } catch (e) {
    console.error(e);
    await ctx.reply("Упс, ошибка при запросе к модели. Смотри лог в консоли.");
  }
});

bot.launch();
console.log("Bot is running (polling). Press Ctrl+C to stop.");

// корректное завершение
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
