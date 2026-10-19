import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 300;
// Yandex rejects responses whose session_state JSON exceeds 1 KB; keep a safety margin.
const MAX_SESSION_STATE_BYTES = 900;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3800;
const SERPER_TIMEOUT_MS = 1500;
const GEMINI_TIMEOUT_MS = 2200;
// A second identical Serper request starts if the first one is slower than this.
const SERPER_HEDGE_MS = 700;
// With Redis the reply may be finished in the background, so search and Gemini get much more time.
const SOFT_DEADLINE_MS = 3400;
const BACKGROUND_BUDGET_MS = 14000;
const BACKGROUND_SERPER_TIMEOUT_MS = 4000;
const BACKGROUND_GEMINI_TIMEOUT_MS = 8000;
const CONTINUE_WAIT_MS = 3300;
const PENDING_TTL_SEC = 600;
const SEARCH_CACHE_TTL_SEC = 600;
const SEARCH_CACHE_MAX_ITEMS = 100;
const SEARCHING_TEXT = "Ищу ответ. Скажите «дальше» через пару секунд.";
const STILL_SEARCHING_TEXT = "Ещё ищу. Скажите «дальше» ещё раз через пару секунд.";
const CONTINUE_COMMANDS = new Set([
  "дальше", "ну дальше", "продолжи", "продолжай", "что там", "ну что", "ну что там", "и что",
  "ну", "готово", "ответ", "какой ответ", "скажи ответ", "нашла", "ну как", "что нашла"
]);
const DEFAULT_TIME_ZONE = "Europe/Moscow";
const RU_MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если переданы результаты поиска, отвечай только по ним.",
  "Если вопрос про сегодня, завтра или конкретный день, называй матчи только этой даты. Если в тексте другая дата, скажи, что на запрошенный день таких матчей нет, и назови ближайшую дату из текста.",
  "Время произноси так, как оно написано в источнике. Не добавляй «утра» или «вечера» и не переводи время в другой пояс.",
  "Не выдумывай факты, которых в результатах нет. Если поиск ничего не дал, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history: fitHistoryToBytes(history) }
  };
}

function fitHistoryToBytes(history, maxBytes = MAX_SESSION_STATE_BYTES) {
  const items = safeHistory(history);
  while (items.length && Buffer.byteLength(JSON.stringify({ history: items }), "utf8") > maxBytes) {
    items.shift();
  }
  return items;
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

// Keeps Gemini on the fastest setting. Flash-Lite rejects thinkingBudget 0, older models reject thinkingLevel.
function generationConfigFor(model) {
  const config = { temperature: 0.5, maxOutputTokens: 200 };
  if (/^gemini-2\.5/i.test(model)) config.thinkingConfig = { thinkingBudget: 0 };
  else if (/flash-lite/i.test(model)) config.thinkingConfig = { thinkingLevel: "minimal" };
  else if (/^gemini-[3-9]/i.test(model)) config.thinkingConfig = { thinkingLevel: "low" };
  return config;
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|завтра|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные|матч|расписан|результат|чемпионат/i.test(text);
}

// Accepts an IANA zone from Alice and falls back to Moscow when the value is missing or invalid.
function resolveTimeZone(value) {
  const zone = String(value || "").trim() || DEFAULT_TIME_ZONE;
  try {
    Intl.DateTimeFormat("ru-RU", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

// Reads the calendar day in the user's time zone.
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const read = type => Number(parts.find(part => part.type === type).value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

// Moves a calendar day forward without crossing a zone boundary at midnight.
function shiftZonedDate(date, timeZone, days) {
  const { year, month, day } = zonedParts(date, timeZone);
  return new Date(Date.UTC(year, month - 1, day + days, 12));
}

// Formats a zoned calendar day as "19 октября 2026".
function formatRuDate(date, timeZone) {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${day} ${RU_MONTHS[month - 1]} ${year}`;
}

function hasWord(text, word) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

function replaceWord(text, word, value) {
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "giu"), value);
}

function isScheduleQuestion(text) {
  return /матч|расписан|чемпионат|лиг|результат|сч[её]т/i.test(text);
}

// Tells the model which calendar day the user means.
function dateContext(text, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const zone = resolveTimeZone(timeZone);
  const today = formatRuDate(now, zone);
  const tomorrow = formatRuDate(shiftZonedDate(now, zone, 1), zone);
  let asked = `сегодня, ${today}`;
  if (hasWord(text, "послезавтра")) asked = `послезавтра, ${formatRuDate(shiftZonedDate(now, zone, 2), zone)}`;
  else if (hasWord(text, "завтра")) asked = `завтра, ${tomorrow}`;
  else if (!hasWord(text, "сегодня") && !hasWord(text, "сейчас")) asked = "день не указан";
  return `Сейчас ${today}, часовой пояс ${zone}. Завтра ${tomorrow}. Пользователь спрашивает про: ${asked}.`;
}

// Turns a spoken question into a web query with an absolute date instead of "сегодня" or "завтра".
function searchQuery(text, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const zone = resolveTimeZone(timeZone);
  let query = String(text ?? "").replace(/\s+/g, " ").trim();
  query = replaceWord(query, "послезавтра", formatRuDate(shiftZonedDate(now, zone, 2), zone));
  query = replaceWord(query, "завтра", formatRuDate(shiftZonedDate(now, zone, 1), zone));
  query = replaceWord(query, "сегодня", formatRuDate(now, zone));
  if (isScheduleQuestion(query) && !/расписан/i.test(query)) query = `${query} расписание`;
  return query.slice(0, 180);
}

function clipText(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Collects the parts of a Serper response that can actually contain facts, not only three short snippets.
function formatSearchContext(data) {
  const lines = [];
  const box = data?.answerBox;
  const answer = box?.answer || box?.snippet;
  if (answer) lines.push(`Краткий ответ: ${clipText(answer, 500)}`);

  if (Array.isArray(box?.list)) {
    const list = box.list
      .map(item => clipText(typeof item === "string" ? item : item?.title || item?.snippet, 140))
      .filter(Boolean)
      .slice(0, 8);
    if (list.length) lines.push(`Список: ${list.join("; ")}`);
  }

  const graph = data?.knowledgeGraph;
  if (graph?.title || graph?.description) {
    const attrs = graph.attributes && typeof graph.attributes === "object"
      ? Object.entries(graph.attributes).slice(0, 8).map(([key, value]) => `${key}: ${clipText(value, 80)}`).join("; ")
      : "";
    lines.push(`Карточка: ${clipText(graph.title, 120)}. ${clipText(graph.description, 300)}${attrs ? ` ${attrs}` : ""}`.trim());
  }

  const sports = data?.sportsResults || data?.sports_results;
  if (sports) lines.push(`Спорт: ${clipText(JSON.stringify(sports), 900)}`);

  for (const item of (Array.isArray(data?.organic) ? data.organic : []).slice(0, 6)) {
    const snippet = clipText(item?.snippet, 320);
    if (snippet) lines.push(`${clipText(item?.title, 140)}: ${snippet}`);
  }

  for (const item of (Array.isArray(data?.peopleAlsoAsk) ? data.peopleAlsoAsk : []).slice(0, 2)) {
    if (item?.snippet) lines.push(`Ещё: ${clipText(item.question, 80)} ${clipText(item.snippet, 220)}`);
  }

  return lines.join("\n").slice(0, 2200);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

// Sends the request again if the first copy is slow or fails, and keeps whichever answer arrives first.
function hedgedFetchJson(url, options, timeoutMs, hedgeAfterMs) {
  return new Promise((resolve, reject) => {
    const controllers = [];
    let running = 0;
    let settled = false;
    let hedgeTimer;
    let deadlineTimer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(deadlineTimer);
      controllers.forEach(controller => controller.abort());
      if (error) reject(error);
      else resolve(result);
    };

    const attempt = () => {
      if (settled || controllers.length >= 2) return;
      const controller = new AbortController();
      controllers.push(controller);
      running += 1;
      fetch(url, { ...options, signal: controller.signal })
        .then(async response => ({ response, data: await response.json().catch(() => ({})) }))
        .then(result => finish(null, result), error => {
          running -= 1;
          if (controllers.length < 2) attempt();
          else if (!running) finish(error);
        });
    };

    hedgeTimer = setTimeout(attempt, hedgeAfterMs);
    deadlineTimer = setTimeout(
      () => finish(new DOMException("The request took too long", "AbortError")),
      Math.max(100, timeoutMs)
    );
    attempt();
  });
}

const searchMemoryCache = new Map();

async function readSearchCache(query) {
  const cached = searchMemoryCache.get(query);
  if (cached && cached.expiresAt > Date.now()) return cached.context;
  searchMemoryCache.delete(query);
  const stored = await redisCommand(["GET", `alice:search:${query}`], 300).catch(() => null);
  return typeof stored === "string" ? stored : "";
}

function writeSearchCache(query, context) {
  searchMemoryCache.set(query, { context, expiresAt: Date.now() + SEARCH_CACHE_TTL_SEC * 1000 });
  while (searchMemoryCache.size > SEARCH_CACHE_MAX_ITEMS) {
    searchMemoryCache.delete(searchMemoryCache.keys().next().value);
  }
  if (redisConfig()) {
    runLater(redisCommand(["SET", `alice:search:${query}`, context, "EX", SEARCH_CACHE_TTL_SEC]).catch(() => {}));
  }
}

async function searchWeb(text, timeoutMs, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return { context: "", failed: false };

  const deadline = Date.now() + timeoutMs;
  const query = searchQuery(text, now, timeZone);
  const cached = await readSearchCache(query);
  if (cached) return { context: cached, failed: false };

  try {
    const { response, data } = await hedgedFetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 8 })
      },
      deadline - Date.now(),
      SERPER_HEDGE_MS
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return { context: "", failed: true };
    }

    const context = formatSearchContext(data);
    if (context) writeSearchCache(query, context);
    return { context, failed: false };
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return { context: "", failed: true };
  }
}

// Upstash Redis over its REST API. The Vercel Marketplace integration may name the variables KV_REST_API_*.
function redisConfig() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "").trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

async function redisCommand(args, timeoutMs = 1000) {
  const config = redisConfig();
  if (!config) return null;
  const { response, data } = await fetchJson(
    config.url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(args)
    },
    timeoutMs
  );
  if (!response.ok) throw new Error(`REDIS_HTTP_${response.status}`);
  return data?.result ?? null;
}

async function readPending(key) {
  try {
    const value = await redisCommand(["GET", key], 800);
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch (error) {
    console.warn("Could not read the pending answer from Redis:", error?.message || "unknown error");
    return null;
  }
}

function savePending(key, record) {
  return redisCommand(["SET", key, JSON.stringify(record), "EX", PENDING_TTL_SEC]);
}

// Keeps background work alive on Vercel after the response is sent; a no-op elsewhere.
function runLater(promise) {
  try {
    waitUntil(promise);
  } catch {
    // Not running on Vercel; the promise still runs in this process.
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

// Keeps only whole sentences, so an answer cut by the deadline still sounds finished.
function completeSentences(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^[\s\S]*[.!?…](?=\s|$)/);
  return match ? match[0].trim() : "";
}

// Reads Gemini's server-sent events one JSON chunk at a time.
async function* readSseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = block => {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n");
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const event = parse(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (event) yield event;
    }
  }
  const last = parse(buffer + decoder.decode());
  if (last) yield last;
}

async function askGemini(text, history, searchContext, timeoutMs, dateLine = "", allowPartial = false) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${dateLine}\n\nВопрос: ${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nЕсли дата в результатах не совпадает с запрошенным днём, так и скажи. Время называй как в тексте, без перевода.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  // Streaming lets us keep the sentences Gemini has already written when time runs out.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  let collected = "";
  let finishReason = "";
  let blockReason = "";

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: generationConfigFor(model)
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const status = Number(response.status);
      const detail = String(data?.error?.message || "").slice(0, 300);
      console.error("Gemini request failed with HTTP", status, detail);
      if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
      if (status === 429) throw new Error("GEMINI_QUOTA");
      throw new Error("GEMINI_REQUEST_FAILED");
    }

    for await (const event of readSseEvents(response.body)) {
      const candidate = event?.candidates?.[0];
      collected += (candidate?.content?.parts || [])
        .map(part => part?.thought || typeof part?.text !== "string" ? "" : part.text)
        .join("");
      finishReason = candidate?.finishReason || finishReason;
      blockReason = event?.promptFeedback?.blockReason || blockReason;
    }
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
    const partial = allowPartial ? completeSentences(collected) : "";
    if (!partial) throw new Error("TIME_BUDGET_EXHAUSTED");
    console.warn("Gemini ran out of time; returning the sentences it finished.");
    return partial;
  } finally {
    clearTimeout(timer);
  }

  const answer = collected.trim();
  if (!answer) {
    if (blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
    return completeSentences(answer) || answer;
  }
  return answer;
}

// Searches when needed and asks Gemini; the limits decide how long each step may take.
async function answerQuestion(text, history, { now, timeZone, deadlineAt, serperMs, geminiMs, allowPartial }) {
  const left = () => deadlineAt - Date.now();
  let searchContext = "";
  if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
    // Leave Gemini at least two seconds after the search.
    const found = await searchWeb(text, Math.min(serperMs, Math.max(0, left() - 2000)), now, timeZone);
    searchContext = found.context;
    console.info(searchContext ? `Search context attached, ${searchContext.length} chars` : "Search returned no usable text");
    if (found.failed && isScheduleQuestion(text)) throw new Error("SEARCH_FAILED");
  }

  return askGemini(
    text,
    history,
    searchContext,
    Math.max(0, Math.min(geminiMs, left() - 250)),
    searchContext ? dateContext(text, now, timeZone) : "",
    allowPartial
  );
}

function isContinueCommand(text) {
  const normalized = String(text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return CONTINUE_COMMANDS.has(normalized);
}

function withTurn(history, question, answer) {
  return [
    ...history,
    { role: "user", text: String(question).slice(0, MAX_HISTORY_MESSAGE_CHARS) },
    { role: "model", text: String(answer).slice(0, MAX_HISTORY_MESSAGE_CHARS) }
  ].slice(-MAX_HISTORY_MESSAGES);
}

function normalizeError(error) {
  return error?.name === "AbortError" ? new Error("TIME_BUDGET_EXHAUSTED") : error;
}

// Answers "дальше" with the reply finished in the background, waiting a little if it is almost ready.
async function deliverPending(key, history, startedAt) {
  let record = await readPending(key);
  if (!record) return null;

  while (record?.status === "pending" && Date.now() - startedAt + 300 < CONTINUE_WAIT_MS) {
    await delay(300);
    record = await readPending(key);
  }

  if (record?.status === "done") {
    runLater(redisCommand(["DEL", key]).catch(() => {}));
    return aliceResponse(record.answer, false, withTurn(history, record.question, record.answer));
  }
  if (record?.status === "error") {
    runLater(redisCommand(["DEL", key]).catch(() => {}));
    return aliceResponse(errorForUser(new Error(record.error)), false, history);
  }
  return aliceResponse(STILL_SEARCHING_TEXT, false, history);
}

// Stores the late answer; skips it when the user has already moved on to another question.
async function finishInBackground(key, id, question, job) {
  try {
    await savePending(key, { id, status: "pending", question });
  } catch (error) {
    console.warn("Could not save the pending question to Redis:", error?.message || "unknown error");
  }

  let record;
  try {
    const answer = await job;
    record = { id, status: "done", question, answer };
  } catch (error) {
    record = { id, status: "error", question, error: normalizeError(error)?.message || "unknown error" };
  }

  try {
    const current = await readPending(key);
    if (current?.id !== id) return;
    await savePending(key, record);
    console.info(`Background answer saved with status ${record.status}`);
  } catch (error) {
    console.warn("Could not save the background answer to Redis:", error?.message || "unknown error");
  }
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "SEARCH_FAILED":
      return "Не успела проверить расписание. Спросите ещё раз чуть позже.";
    case "TIME_BUDGET_EXHAUSTED":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const body = req.body && typeof req.body === "object" ? req.body : {};

  // Optional protection: only accept requests from your own skill, so strangers cannot spend your API quota.
  const expectedSkillId = String(process.env.ALICE_SKILL_ID || "").trim();
  if (expectedSkillId && body?.session?.skill_id !== expectedSkillId) {
    console.warn("Rejected request from an unknown skill_id.");
    return res.status(403).json({ error: "Forbidden" });
  }

  // Yandex Dialogs health checks send "ping"; answer without calling paid APIs.
  if (String(body?.request?.original_utterance || "").trim().toLowerCase() === "ping") {
    return res.status(200).json(aliceResponse("pong", false, body?.state?.session?.history));
  }

  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  const now = new Date();
  const timeZone = resolveTimeZone(body?.meta?.timezone);
  const sessionId = String(body?.session?.session_id || "").trim();
  // With Redis, a slow answer is finished in the background and read back when the user says "дальше".
  const pendingKey = redisConfig() && sessionId ? `alice:pending:${sessionId}` : "";

  if (pendingKey && isContinueCommand(text)) {
    const reply = await deliverPending(pendingKey, oldHistory, startedAt);
    if (reply) return res.status(200).json(reply);
  }

  try {
    if (!pendingKey) {
      // Without Redis everything must fit into Alice's 4.5 seconds, so a cut answer beats no answer.
      const answer = await answerQuestion(text, oldHistory, {
        now,
        timeZone,
        deadlineAt: startedAt + TOTAL_RESPONSE_BUDGET_MS,
        serperMs: SERPER_TIMEOUT_MS,
        geminiMs: GEMINI_TIMEOUT_MS,
        allowPartial: true
      });
      return res.status(200).json(aliceResponse(answer, false, withTurn(oldHistory, text, answer)));
    }

    const job = answerQuestion(text, oldHistory, {
      now,
      timeZone,
      deadlineAt: startedAt + BACKGROUND_BUDGET_MS,
      serperMs: BACKGROUND_SERPER_TIMEOUT_MS,
      geminiMs: BACKGROUND_GEMINI_TIMEOUT_MS,
      allowPartial: false
    });
    const answer = await Promise.race([job, delay(SOFT_DEADLINE_MS - (Date.now() - startedAt)).then(() => null)]);

    if (answer !== null) {
      // A fresh answer replaces any older question that was still waiting.
      runLater(redisCommand(["DEL", pendingKey]).catch(() => {}));
      return res.status(200).json(aliceResponse(answer, false, withTurn(oldHistory, text, answer)));
    }

    runLater(finishInBackground(pendingKey, randomUUID(), text, job));
    console.info("Answer is not ready yet; finishing it in the background.");
    return res.status(200).json(aliceResponse(SEARCHING_TEXT, false, oldHistory));
  } catch (error) {
    const safeError = normalizeError(error);
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, completeSentences, dateContext, errorForUser, fitAliceText, fitHistoryToBytes, formatSearchContext, generationConfigFor, isContinueCommand, isSearchIntent, safeHistory, searchQuery };
