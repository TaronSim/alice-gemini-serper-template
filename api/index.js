import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";

const DEFAULT_MODEL = "gemini-3.8-flash";
// Used when the main model is out of quota (HTTP 429), e.g. when it has no free-tier limit.
const DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash-lite";
const SERPER_TIMEOUT_MS = 5000;
const MAX_SEARCH_ROUNDS = 2;
// When the main model is slow, it is cut off early enough for the fallback model to answer.
const FALLBACK_RESERVE_MS = 9000;
// Errors after which the next model is tried: out of quota, overloaded, or too slow.
const RETRYABLE_ERRORS = new Set(["GEMINI_QUOTA", "GEMINI_UNAVAILABLE", "TIME_BUDGET_EXHAUSTED"]);
// Gemini decides itself when to search, like with the built-in Google Search, but the search runs through Serper.
const SEARCH_TOOL = {
  functionDeclarations: [{
    name: "search_web",
    description: "Поиск Google. Используй для вопросов о свежих событиях, спорте, расписаниях, новостях, погоде, ценах, курсах и для фактов, в которых не уверен. Пиши в запросе конкретную дату вместо слов «сегодня» или «завтра».",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Поисковый запрос" } },
      required: ["query"]
    }
  }]
};
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 300;
// Yandex rejects responses whose session_state JSON exceeds 1 KB; keep a safety margin.
const MAX_SESSION_STATE_BYTES = 900;
const MAX_ALICE_TEXT = 1024;
// Without Redis everything must fit into Alice's ~4.5 seconds.
const TOTAL_RESPONSE_BUDGET_MS = 3800;
// With Redis a slow answer is finished in the background, so Gemini gets as much time as in its own app.
const SOFT_DEADLINE_MS = 3400;
const BACKGROUND_GEMINI_TIMEOUT_MS = 25000;
const CONTINUE_WAIT_MS = 3300;
const PENDING_TTL_SEC = 600;
const SEARCHING_TEXT = "Ищу ответ. Скажите «дальше» через пару секунд.";
const STILL_SEARCHING_TEXT = "Ещё думаю. Скажите «дальше» ещё раз через пару секунд.";
const CONTINUE_COMMANDS = new Set([
  "дальше", "ну дальше", "продолжи", "продолжай", "что там", "ну что", "ну что там", "и что",
  "ну", "готово", "ответ", "какой ответ", "скажи ответ", "нашла", "ну как", "что нашла"
]);
const DEFAULT_TIME_ZONE = "Europe/Moscow";

// Only the voice format is restricted; the content should be what Gemini would answer in its own chat.
function systemPrompt(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const zone = resolveTimeZone(timeZone);
  const date = new Intl.DateTimeFormat("ru-RU", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(now);
  return [
    "Ты — Gemini, ассистент Google. Пользователь говорит с тобой голосом через Яндекс Алису, и твой ответ будет зачитан вслух.",
    "Отвечай так же точно и по существу, как ответил бы в обычном чате Gemini, но в виде устной речи: без Markdown, заголовков, таблиц, ссылок, эмодзи и списков с символами. Перечисления делай обычными предложениями.",
    "Укладывайся примерно в 900 символов. Если тема большая, расскажи главное и предложи продолжить.",
    "Для вопросов о свежих событиях, спорте, расписаниях, новостях, погоде, ценах и курсах обязательно используй поиск Google.",
    `Сейчас ${date}, часовой пояс пользователя ${zone}. Время называй в этом поясе.`,
    "Отвечай на языке пользователя."
  ].join(" ");
}

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

// Turns any Markdown that slips through into plain sentences Alice can read aloud.
function toSpeech(value) {
  return String(value ?? "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`~]+/g, "")
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(#{1,6}\s+|[-•]\s+|\d+[.)]\s+)/, "").trim())
    .filter(Boolean)
    .map(line => /[.!?…:;,]$/.test(line) ? line : `${line}.`)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Gemini 3 picks its own thinking depth, like in the Gemini app; GEMINI_THINKING_LEVEL can override it.
function generationConfigFor(model, thinkingLevel = process.env.GEMINI_THINKING_LEVEL) {
  // Thinking tokens count toward this limit, so it is generous; the prompt keeps the spoken part short.
  const config = { maxOutputTokens: 8192 };
  const level = String(thinkingLevel || "").trim().toLowerCase();
  if (level && /^gemini-[3-9]/i.test(model)) config.thinkingConfig = { thinkingLevel: level };
  return config;
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

function modelName(value, fallback) {
  const model = String(value || fallback).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");
  return model;
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

// Runs a web search that Gemini asked for through the search_web function.
async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  const q = clipText(query, 200);
  if (!key || !q) return "Поиск недоступен.";
  if (timeoutMs < 300) return "Поиск не успел выполниться.";
  console.info(`Gemini searched the web: ${q}`);

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q, gl: "ru", hl: "ru", num: 8 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );
    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "Поиск не удался.";
    }
    return formatSearchContext(data) || "Ничего не найдено.";
  } catch {
    console.warn("Serper request did not finish in time.");
    return "Поиск не успел выполниться.";
  }
}

function searchLabel(search) {
  if (search === "google") return "with Google Search";
  if (search === "serper") return "with Serper search";
  return "without search";
}

// Built-in Google Search needs a paid Gemini tier, so it is opt-in; otherwise Gemini searches through Serper.
// On HTTP 429 the next attempt runs: the main model without Google Search, then the fallback model.
async function askGemini(text, history, { now, timeZone, timeoutMs, allowPartial }) {
  const deadline = Date.now() + timeoutMs;
  const model = modelName(process.env.GEMINI_MODEL, DEFAULT_MODEL);
  const fallback = modelName(process.env.GEMINI_FALLBACK_MODEL, DEFAULT_FALLBACK_MODEL);
  const setting = String(process.env.GEMINI_GOOGLE_SEARCH || "").trim().toLowerCase();
  const webSearch = setting !== "off" && process.env.SERPER_API_KEY ? "serper" : "none";
  const attempts = setting === "on"
    ? [{ model, search: "google" }, { model, search: webSearch }, { model: fallback, search: webSearch }]
    : [{ model, search: webSearch }, { model: fallback, search: webSearch }];
  const unique = attempts.filter((item, index) =>
    attempts.findIndex(other => other.model === item.model && other.search === item.search) === index);

  for (const [index, attempt] of unique.entries()) {
    const next = unique[index + 1];
    const left = deadline - Date.now();
    const reserve = next && left >= 2 * FALLBACK_RESERVE_MS ? FALLBACK_RESERVE_MS : 0;
    try {
      return await askGeminiModel(attempt.model, text, history, {
        now,
        timeZone,
        timeoutMs: left - reserve,
        allowPartial: allowPartial && !reserve,
        search: attempt.search
      });
    } catch (error) {
      const canRetry = next && RETRYABLE_ERRORS.has(error?.message) && deadline - Date.now() >= 2000;
      if (!canRetry) throw error;
      console.warn(`Gemini ${attempt.model} ${searchLabel(attempt.search)} failed with ${error.message}; retrying with ${next.model} ${searchLabel(next.search)}.`);
    }
  }
  throw new Error("GEMINI_REQUEST_FAILED");
}

// One streamed Gemini call. Returns the text, the raw parts and any function calls; marks a timeout instead of throwing.
async function streamGemini(model, request, timeoutMs, search) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  const step = { text: "", parts: [], calls: [], finishReason: "", blockReason: "", searches: new Set(), timedOut: false };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify(request),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const status = Number(response.status);
      const detail = String(data?.error?.message || "").slice(0, 300);
      // For 429 Google may name the exact limit that ran out, e.g. requests per day on the free tier.
      const quotas = (data?.error?.details || [])
        .flatMap(item => item?.violations || [])
        .map(item => item?.quotaId || item?.quotaMetric)
        .filter(Boolean)
        .join(", ");
      console.error("Gemini request failed with HTTP", status, model, searchLabel(search), detail, quotas ? `Quota: ${quotas}` : "");
      if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
      if (status === 429) throw new Error("GEMINI_QUOTA");
      if (status >= 500) throw new Error("GEMINI_UNAVAILABLE");
      throw new Error("GEMINI_REQUEST_FAILED");
    }

    for await (const event of readSseEvents(response.body)) {
      const candidate = event?.candidates?.[0];
      for (const part of candidate?.content?.parts || []) {
        if (!part || part.thought) continue;
        // Gemini 3 needs its parts (with thought signatures) sent back unchanged after a function call.
        step.parts.push(part);
        if (typeof part.text === "string") step.text += part.text;
        if (part.functionCall) step.calls.push(part.functionCall);
      }
      step.finishReason = candidate?.finishReason || step.finishReason;
      step.blockReason = event?.promptFeedback?.blockReason || step.blockReason;
      for (const query of candidate?.groundingMetadata?.webSearchQueries || []) step.searches.add(query);
    }
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
    step.timedOut = true;
  } finally {
    clearTimeout(timer);
  }
  return step;
}

async function askGeminiModel(model, text, history, { now, timeZone, timeoutMs, allowPartial, search }) {
  const deadline = Date.now() + timeoutMs;
  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));
  contents.push({ role: "user", parts: [{ text }] });

  for (let round = 0; ; round += 1) {
    const request = {
      systemInstruction: { parts: [{ text: systemPrompt(now, timeZone) }] },
      contents,
      generationConfig: generationConfigFor(model)
    };
    if (search === "google") request.tools = [{ google_search: {} }];
    if (search === "serper") {
      request.tools = [SEARCH_TOOL];
      // After enough searches Gemini must answer with what it found.
      if (round >= MAX_SEARCH_ROUNDS) request.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    }

    const step = await streamGemini(model, request, deadline - Date.now(), search);

    if (step.timedOut) {
      const partial = allowPartial && !step.calls.length ? toSpeech(completeSentences(step.text)) : "";
      if (!partial) throw new Error("TIME_BUDGET_EXHAUSTED");
      console.warn("Gemini ran out of time; returning the sentences it finished.");
      return partial;
    }

    if (search === "serper" && step.calls.length && round < MAX_SEARCH_ROUNDS) {
      const results = await Promise.all(step.calls.map(call =>
        call?.name === "search_web" ? searchWeb(call?.args?.query, deadline - Date.now() - 1500) : "Неизвестная функция."));
      contents.push({ role: "model", parts: step.parts });
      contents.push({
        role: "user",
        parts: step.calls.map((call, index) => ({
          functionResponse: { ...(call?.id ? { id: call.id } : {}), name: call?.name, response: { result: results[index] } }
        }))
      });
      continue;
    }

    if (step.searches.size) console.info(`Gemini searched Google: ${[...step.searches].join(" | ").slice(0, 300)}`);
    const answer = toSpeech(step.text);
    if (!answer) {
      if (step.blockReason) throw new Error("GEMINI_BLOCKED");
      throw new Error("GEMINI_EMPTY_RESPONSE");
    }
    if (step.finishReason === "MAX_TOKENS") {
      console.warn("Gemini reached the output token limit.");
      return completeSentences(answer) || answer;
    }
    return answer;
  }
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
    if (record.status === "error") console.warn(`Background answer saved with status error: ${record.error}`);
    else console.info("Background answer saved with status done");
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
    case "GEMINI_UNAVAILABLE":
      return "Gemini сейчас перегружен. Попробуйте ещё раз через минуту.";
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
      "Привет! Я Gemini. Спросите меня о чём угодно.",
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
      const answer = await askGemini(text, oldHistory, {
        now,
        timeZone,
        timeoutMs: TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt),
        allowPartial: true
      });
      return res.status(200).json(aliceResponse(answer, false, withTurn(oldHistory, text, answer)));
    }

    const job = askGemini(text, oldHistory, {
      now,
      timeZone,
      timeoutMs: BACKGROUND_GEMINI_TIMEOUT_MS,
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

export { aliceResponse, completeSentences, errorForUser, fitAliceText, fitHistoryToBytes, generationConfigFor, isContinueCommand, safeHistory, systemPrompt, toSpeech };
