import "dotenv/config";
import OpenAI from "openai";
import { Telegraf, Markup } from "telegraf";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const groqKey = process.env.GROQ_API_KEY;

if (!botToken) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
if (!groqKey) throw new Error("Missing GROQ_API_KEY in .env");

const llm = new OpenAI({
  apiKey: groqKey,
  baseURL: "https://api.groq.com/openai/v1",
});

const bot = new Telegraf(botToken);

const MODEL = "llama-3.3-70b-versatile";
const DEFAULT_SYSTEM = "Ты полезный ассистент. Отвечай по делу.";
const STOP_MARKER = "<END>";

// --------------------
// State (in-memory)
// --------------------
const dialogs = new Map(); // chatId -> messages[]
const settingsByChat = new Map(); // chatId -> settings
const settingsMsgIdByChat = new Map(); // chatId -> message_id of settings screen

function newDefaultSettings() {
  return {
    max_tokens: 128, // 64, 128, 256, 512
    format: "bullets", // "bullets" | "json"
    temperature: 0.7, // 0.2 or 0.9
    frequency_penalty: 0,
    presence_penalty: 0,
    use_stop: true,
  };
}

function ensureSession(chatId) {
  if (!dialogs.has(chatId)) {
    dialogs.set(chatId, [{ role: "system", content: DEFAULT_SYSTEM }]);
  }
  if (!settingsByChat.has(chatId)) {
    settingsByChat.set(chatId, newDefaultSettings());
  }
}

function resetSession(chatId) {
  dialogs.delete(chatId);
  settingsByChat.delete(chatId);
  settingsMsgIdByChat.delete(chatId);
  ensureSession(chatId);
}

function getMessages(chatId) {
  ensureSession(chatId);
  return dialogs.get(chatId);
}

function getSettings(chatId) {
  ensureSession(chatId);
  return settingsByChat.get(chatId);
}

function safeTelegramText(text) {
  return text.length > 3500 ? text.slice(0, 3500) + "\n\n…(обрезано)" : text;
}

function prettySettings(s) {
  const fmt = s.format === "json" ? "JSON" : "Список";
  const stop = s.use_stop ? `ON (${STOP_MARKER})` : "OFF";
  return `max_tokens: ${s.max_tokens} | format: ${fmt} | temp: ${s.temperature} | freq: ${s.frequency_penalty} | pres: ${s.presence_penalty} | stop: ${stop}`;
}

// --------------------
// Keyboards (with labels)
// --------------------
const noop = Markup.button.callback;

function labelRow(text) {
  // "псевдо-лейбл": кнопка, которая ничего не делает
  return [noop(`— ${text} —`, "noop")];
}

function controlsKeyboard(chatId) {
  const s = getSettings(chatId);

  const lenRow = [
    Markup.button.callback(s.max_tokens === 64 ? "🟩 64" : "64", "len_64"),
    Markup.button.callback(s.max_tokens === 128 ? "🟩 128" : "128", "len_128"),
    Markup.button.callback(s.max_tokens === 256 ? "🟩 256" : "256", "len_256"),
    Markup.button.callback(s.max_tokens === 512 ? "🟩 512" : "512", "len_512"),
  ];

  const formatRow = [
    Markup.button.callback(s.format === "bullets" ? "🟩 Список" : "Список", "fmt_bullets"),
    Markup.button.callback(s.format === "json" ? "🟩 JSON" : "JSON", "fmt_json"),
  ];

  const tempRow = [
    Markup.button.callback(s.temperature === 0.2 ? "🟩 0.2" : "0.2", "temp_0.2"),
    Markup.button.callback(s.temperature === 0.9 ? "🟩 0.9" : "0.9", "temp_0.9"),
  ];

  const freqRow = [
    Markup.button.callback(s.frequency_penalty === 0 ? "🟩 0" : "0", "freq_0"),
    Markup.button.callback(s.frequency_penalty === 0.6 ? "🟩 0.6" : "0.6", "freq_0.6"),
  ];

  const presRow = [
    Markup.button.callback(s.presence_penalty === 0 ? "🟩 0" : "0", "pres_0"),
    Markup.button.callback(s.presence_penalty === 0.6 ? "🟩 0.6" : "0.6", "pres_0.6"),
  ];

  const stopRow = [
    Markup.button.callback(s.use_stop ? "🟩 ON" : "ON", "stop_on"),
    Markup.button.callback(!s.use_stop ? "🟩 OFF" : "OFF", "stop_off"),
  ];

  return Markup.inlineKeyboard([
    labelRow("Количество токенов на ответ (max_tokens)"),
    lenRow,

    labelRow("Формат вывода"),
    formatRow,

    labelRow("Случайность (temperature)"),
    tempRow,

    labelRow("Штраф повторов слов (frequency_penalty)"),
    freqRow,

    labelRow("Штраф повторов тем (presence_penalty)"),
    presRow,

    labelRow("Условие завершения (stop)"),
    stopRow,

    [Markup.button.callback("⬅️ Назад", "back_to_prompt")],
  ]);
}

function afterAnswerKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🆕 Новый вопрос", "new_question"),
      Markup.button.callback("⚙️ Изменить настройки", "open_settings"),
    ],
  ]);
}

function startKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("▶️ Start", "do_start")],
  ]);
}

// --------------------
// Text builders
// --------------------
function buildConstrainedUserPrompt(userText, s) {
  const formatInstruction =
    s.format === "json"
      ? `Формат ответа: строго JSON без markdown. Поля: {"answer": string, "bullets": string[]}.`
      : `Формат ответа: список из 3–6 пунктов. Каждый пункт короткий.`;

  const lengthInstruction = `Ограничение длины: уложись примерно в ${Math.min(
    120,
    Math.round(s.max_tokens * 0.75)
  )} слов максимум.`;

  const stopInstruction = s.use_stop
    ? `Условие завершения: в конце выведи отдельной строкой ${STOP_MARKER}.`
    : `Условие завершения: закончи сразу после выполнения требований.`;

  return [
    userText.trim(),
    "",
    "Требования к ответу:",
    `- ${formatInstruction}`,
    `- ${lengthInstruction}`,
    `- ${stopInstruction}`,
  ].join("\n");
}

async function callLLM({ messages, params }) {
  const payload = {
    model: MODEL,
    messages,
    temperature: params.temperature,
    max_tokens: params.max_tokens,
    frequency_penalty: params.frequency_penalty,
    presence_penalty: params.presence_penalty,
    stop: params.stop,
  };
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  const res = await llm.chat.completions.create(payload);
  return res.choices?.[0]?.message?.content ?? "(пустой ответ)";
}

// “Без ограничений” — даём большой max_tokens, чтобы точно не резало
const UNRESTRICTED_PARAMS = {
  temperature: 0.7,
  max_tokens: 800,
  frequency_penalty: 0,
  presence_penalty: 0,
  stop: undefined,
};

// --------------------
// UX helpers
// --------------------
async function showStartScreen(ctx) {
  await ctx.reply(
    "Нажми Start, чтобы начать и увидеть настройки.",
    startKeyboard()
  );
}

// Один экран настроек: создаём или редактируем
async function showControls(ctx) {
  const chatId = ctx.chat.id;
  const s = getSettings(chatId);

  const text =
    "⚙️ Настройки\n" +
    prettySettings(s) +
    "\n\nНажимай кнопки ниже, чтобы менять параметры:";

  const keyboard = controlsKeyboard(chatId);
  const existingId = settingsMsgIdByChat.get(chatId);

  // Если мы внутри callback_query — пробуем edit текущего сообщения
  if (ctx.updateType === "callback_query") {
    try {
      await ctx.editMessageText(text, keyboard);
      const mid = ctx.callbackQuery?.message?.message_id;
      if (mid) settingsMsgIdByChat.set(chatId, mid);
      return;
    } catch {
      // продолжим ниже
    }
  }

  // Если есть сохранённый message_id — редактируем его через API
  if (existingId) {
    try {
      await bot.telegram.editMessageText(chatId, existingId, undefined, text, keyboard);
      return;
    } catch {
      settingsMsgIdByChat.delete(chatId);
    }
  }

  // Иначе создаём новый экран и запоминаем id
  const msg = await ctx.reply(text, keyboard);
  if (msg?.message_id) settingsMsgIdByChat.set(chatId, msg.message_id);
}

async function showPrompt(ctx) {
  await ctx.reply(
    "Можешь задать вопрос. Я пришлю 2 ответа: (1) с ограничениями и (2) без ограничений.",
    afterAnswerKeyboard()
  );
}

// --------------------
// Commands
// --------------------
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  resetSession(chatId);
  await ctx.reply("Привет! Это бот для экспериментов с контролем ответа.\nКоманды: /reset, /controls");
  await showControls(ctx);
  await showPrompt(ctx);
});

bot.command("controls", async (ctx) => {
  ensureSession(ctx.chat.id);
  await showControls(ctx);
});

bot.command("reset", async (ctx) => {
  resetSession(ctx.chat.id);
  await ctx.reply("Ок, контекст и настройки сброшены.");
  await showControls(ctx);
  await showPrompt(ctx);
});

// --------------------
// Button actions
// --------------------
bot.action("noop", async (ctx) => {
  await ctx.answerCbQuery(" ");
});

bot.action("do_start", async (ctx) => {
  const chatId = ctx.chat.id;
  resetSession(chatId);
  await ctx.answerCbQuery("OK");
  await ctx.reply("Начали новую сессию.");
  await showControls(ctx);
  await showPrompt(ctx);
});

bot.action("new_question", async (ctx) => {
  await ctx.answerCbQuery("OK");
  await ctx.reply("Ок! Напиши новый вопрос текстом 🙂");
});

bot.action("open_settings", async (ctx) => {
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

bot.action("back_to_prompt", async (ctx) => {
  await ctx.answerCbQuery("OK");
  await showPrompt(ctx);
});

// Settings handlers
bot.action(/len_(\d+)/, async (ctx) => {
  const chatId = ctx.chat.id;
  ensureSession(chatId);
  const s = getSettings(chatId);
  s.max_tokens = Number(ctx.match[1]);
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

bot.action("fmt_bullets", async (ctx) => {
  const chatId = ctx.chat.id;
  ensureSession(chatId);
  const s = getSettings(chatId);
  s.format = "bullets";
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

bot.action("fmt_json", async (ctx) => {
  const chatId = ctx.chat.id;
  ensureSession(chatId);
  const s = getSettings(chatId);
  s.format = "json";
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

bot.action("temp_0.2", async (ctx) => {
  const chatId = ctx.chat.id;
  ensureSession(chatId);
  const s = getSettings(chatId);
  s.temperature = 0.2;
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

bot.action("temp_0.9", async (ctx) => {
  const chatId = ctx.chat.id;
  ensureSession(chatId);
  const s = getSettings(chatId);
  s.temperature = 0.9;
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

bot.action("freq_0", async (ctx) => {
  const chatId = ctx.chat.id;
  ensureSession(chatId);
  const s = getSettings(chatId);
  s.frequency_penalty = 0;
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

bot.action("freq_0.6", async (ctx) => {
  const chatId = ctx.chat.id;
  ensureSession(chatId);
  const s = getSettings(chatId);
  s.frequency_penalty = 0.6;
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

bot.action("pres_0", async (ctx) => {
  const chatId = ctx.chat.id;
  ensureSession(chatId);
  const s = getSettings(chatId);
  s.presence_penalty = 0;
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

bot.action("pres_0.6", async (ctx) => {
  const chatId = ctx.chat.id;
  ensureSession(chatId);
  const s = getSettings(chatId);
  s.presence_penalty = 0.6;
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

bot.action("stop_on", async (ctx) => {
  const chatId = ctx.chat.id;
  ensureSession(chatId);
  const s = getSettings(chatId);
  s.use_stop = true;
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

bot.action("stop_off", async (ctx) => {
  const chatId = ctx.chat.id;
  ensureSession(chatId);
  const s = getSettings(chatId);
  s.use_stop = false;
  await ctx.answerCbQuery("OK");
  await showControls(ctx);
});

// --------------------
// Main text handler
// --------------------
bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const userText = ctx.message.text?.trim();
  if (!userText) return;

  if (userText.startsWith("/")) return;

  // после рестарта: показываем Start-кнопку и не тратим запросы
  const hasDialog = dialogs.has(chatId);
  const hasSettings = settingsByChat.has(chatId);
  if (!hasDialog || !hasSettings) {
    await showStartScreen(ctx);
    return;
  }

  const s = getSettings(chatId);
  const history = getMessages(chatId);

  const baseMessages = [...history, { role: "user", content: userText }];

  await ctx.sendChatAction("typing");

  try {
    // 1) С ограничениями
    const constrainedUser = buildConstrainedUserPrompt(userText, s);
    const constrainedMessages = [...history, { role: "user", content: constrainedUser }];

    const constrainedParams = {
      temperature: s.temperature,
      max_tokens: s.max_tokens,
      frequency_penalty: s.frequency_penalty,
      presence_penalty: s.presence_penalty,
      stop: s.use_stop ? [STOP_MARKER] : undefined,
    };

    const constrainedAnswerRaw = await callLLM({
      messages: constrainedMessages,
      params: constrainedParams,
    });

    await ctx.reply(
      "✅ С ограничениями\n" +
        prettySettings(s) +
        "\n\n" +
        safeTelegramText(constrainedAnswerRaw)
    );

    // 2) Без ограничений
    await ctx.sendChatAction("typing");

    const unrestrictedAnswerRaw = await callLLM({
      messages: baseMessages,
      params: UNRESTRICTED_PARAMS,
    });

    await ctx.reply(
      "🟦 Без ограничений\n" +
        `temp: ${UNRESTRICTED_PARAMS.temperature}, max_tokens: ${UNRESTRICTED_PARAMS.max_tokens}\n\n` +
        safeTelegramText(unrestrictedAnswerRaw)
    );

    // сохраняем диалог только по unrestricted
    history.push({ role: "user", content: userText });
    history.push({ role: "assistant", content: unrestrictedAnswerRaw });

    await showPrompt(ctx);
  } catch (e) {
    console.error(e);
    await ctx.reply("Упс, ошибка при запросе к модели. Смотри лог в консоли.");
    await showPrompt(ctx);
  }
});

// --------------------
bot.launch();
console.log("Bot is running (polling). Press Ctrl+C to stop.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
