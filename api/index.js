import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";

const DEFAULT_MODEL = "gemini-3.8-flash";
// Used when the main model is out of quota (HTTP 429), e.g. when it has no free-tier limit.
const DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_THINKING_LEVEL = "low";
const SERPER_TIMEOUT_MS = 5000;
const MAX_TOOL_ROUNDS = 3;
const SPORTS_LOOKAHEAD_DAYS = 7;
// When the main model is slow, it is cut off early enough for the fallback model to answer.
const FALLBACK_RESERVE_MS = 9000;
// Errors after which the next model is tried: out of quota, overloaded, or too slow.
const RETRYABLE_ERRORS = new Set(["GEMINI_QUOTA", "GEMINI_UNAVAILABLE", "TIME_BUDGET_EXHAUSTED"]);
// An overloaded or out-of-quota model answers with an error only after ~2 seconds, which Alice cannot spare.
// Such a model is skipped for a while; the cooldown lives in this instance's memory.
const COOLDOWN_ERRORS = new Set(["GEMINI_QUOTA", "GEMINI_UNAVAILABLE"]);
const MODEL_COOLDOWN_MS = 60000;
const cooldownUntil = new Map();
// Leagues with full fixture lists in ESPN's free public scoreboard.
const FOOTBALL_LEAGUES = {
  "uefa.champions": "Лига чемпионов",
  "uefa.europa": "Лига Европы",
  "uefa.europa.conf": "Лига конференций",
  "eng.1": "Английская Премьер-лига",
  "esp.1": "Ла Лига",
  "ita.1": "Серия А",
  "ger.1": "Бундеслига",
  "fra.1": "Лига 1",
  "rus.1": "РПЛ"
};
// Functions Gemini may call; it decides itself when to use them, like the Gemini app decides when to search.
const SEARCH_DECLARATION = {
  name: "search_web",
  description: "Поиск Google. Используй для вопросов о свежих событиях, новостях, погоде, ценах, курсах и для фактов, в которых не уверен. Пиши в запросе конкретную дату вместо слов «сегодня» или «завтра». Если результаты неполные, поищи ещё раз точнее, например на английском.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Поисковый запрос" } },
    required: ["query"]
  }
};
const FOOTBALL_DECLARATION = {
  name: "football_matches",
  description: "Полный и точный список футбольных матчей турнира на дату: время начала в часовом поясе пользователя, счёт идущих и завершённых игр. Если в этот день матчей нет, возвращает ближайший игровой день. Для матчей этих турниров используй эту функцию, а не поиск.",
  parameters: {
    type: "object",
    properties: {
      league: {
        type: "string",
        enum: Object.keys(FOOTBALL_LEAGUES),
        description: Object.entries(FOOTBALL_LEAGUES).map(([slug, name]) => `${slug} — ${name}`).join(", ")
      },
      date: { type: "string", description: "Дата в формате ГГГГ-ММ-ДД по часовому поясу пользователя" }
    },
    required: ["league", "date"]
  }
};
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 300;
// Yandex rejects responses whose session_state JSON exceeds 1 KB; keep a safety margin.
const MAX_SESSION_STATE_BYTES = 900;
const MAX_ALICE_TEXT = 1024;
// Without Redis everything must fit into Alice's ~4.5 seconds.
const TOTAL_RESPONSE_BUDGET_MS = 3800;
// With Redis a slow answer is finished in the background, so Gemini gets as much time as in its own app.
const SOFT_DEADLINE_MS = 3800;
const BACKGROUND_GEMINI_TIMEOUT_MS = 25000;
const CONTINUE_WAIT_MS = 3300;
const PENDING_TTL_SEC = 600;
const SEARCHING_TEXT = "Ищу ответ. Скажите «дальше» через пару секунд.";
const STILL_SEARCHING_TEXT = "Ещё думаю. Скажите «дальше» ещё раз через пару секунд.";
const CONTINUE_COMMANDS = new Set([
  "дальше", "ну дальше", "продолжи", "продолжай", "что там", "ну что", "ну что там", "и что",
  "ну", "готово", "ответ", "какой ответ", "скажи ответ", "нашла", "ну как", "что нашла"
]);
// On screens the user can tap instead of saying "дальше".
const CONTINUE_BUTTONS = [{ title: "Дальше", hide: true }];
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
    "Для вопросов о свежих событиях, спорте, расписаниях, новостях, погоде, ценах и курсах обязательно используй поиск или спортивную базу, если они доступны.",
    "Не утверждай, что матча, события или факта нет, если инструменты прямо этого не подтвердили. Если точных данных не нашлось, так и скажи.",
    `Сейчас ${date}, часовой пояс пользователя ${zone}. Время называй в этом поясе.`,
    "Отвечай на языке пользователя."
  ].join(" ");
}

function aliceResponse(text, endSession = false, history = [], buttons = []) {
  const response = {
    text: fitAliceText(text),
    end_session: endSession
  };
  if (buttons.length) response.buttons = buttons;
  return {
    version: "1.0",
    response,
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

// Gemini 3 defaults to high thinking, which takes seconds even for "привет" and misses Alice's deadline.
// Voice needs low by default; GEMINI_THINKING_LEVEL can override it.
function generationConfigFor(model, thinkingLevel = process.env.GEMINI_THINKING_LEVEL) {
  // Thinking tokens count toward this limit, so it is generous; the prompt keeps the spoken part short.
  const config = { maxOutputTokens: 8192 };
  const level = String(thinkingLevel || DEFAULT_THINKING_LEVEL).trim().toLowerCase();
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

async function fetchFootballDay(slug, day, timeoutMs) {
  const stamp = day.toISOString().slice(0, 10).replace(/-/g, "");
  const { response, data } = await fetchJson(
    `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${stamp}`,
    { headers: { Accept: "application/json" } },
    timeoutMs
  );
  if (!response.ok) throw new Error(`ESPN_HTTP_${response.status}`);
  return Array.isArray(data?.events) ? data.events : [];
}

function formatMatch(event, timeZone) {
  const competitors = event?.competitions?.[0]?.competitors || [];
  const home = competitors.find(item => item?.homeAway === "home") || competitors[0];
  const away = competitors.find(item => item?.homeAway === "away") || competitors[1];
  const teams = `${home?.team?.displayName || "?"} — ${away?.team?.displayName || "?"}`;
  const status = event?.status?.type || {};
  const score = `${home?.score ?? 0}:${away?.score ?? 0}`;
  if (/POSTPONED|CANCELED/i.test(status.name || "")) return `${teams} (перенесён)`;
  if (status.state === "post") return `${teams} ${score} (завершён)`;
  if (status.state === "in") return `${teams} ${score} (идёт, ${clipText(status.shortDetail, 20)})`;
  const time = new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(event.date));
  return `${time} ${teams}`;
}

function formatDay(day) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(day);
}

// Runs the football_matches function: the whole matchday, or the nearest one within a week.
async function footballMatches(league, date, timeZone, timeoutMs) {
  const name = FOOTBALL_LEAGUES[league];
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return "Неизвестный турнир или дата.";
  if (timeoutMs < 300) return "Спортивная база не успела ответить.";
  console.info(`Gemini asked for football matches: ${league} ${date}`);

  const zone = resolveTimeZone(timeZone);
  const deadline = Date.now() + timeoutMs;
  const day = new Date(`${date}T12:00:00Z`);
  try {
    let events = await fetchFootballDay(league, day, timeoutMs);
    let shownDay = day;
    if (!events.length) {
      const days = Array.from({ length: SPORTS_LOOKAHEAD_DAYS }, (_, i) => new Date(day.getTime() + (i + 1) * 86400000));
      const lists = await Promise.all(days.map(item => fetchFootballDay(league, item, deadline - Date.now()).catch(() => [])));
      const index = lists.findIndex(list => list.length);
      if (index >= 0) {
        events = lists[index];
        shownDay = days[index];
      }
    }

    const header = `Спортивная база ESPN, полный список. Турнир: ${name}. Время указано для пояса ${zone}.`;
    if (!events.length) return `${header} На ${formatDay(day)} и следующие ${SPORTS_LOOKAHEAD_DAYS} дней матчей нет.`;
    const intro = shownDay === day
      ? `Матчи ${formatDay(day)} (${events.length}):`
      : `На ${formatDay(day)} матчей нет. Ближайшие матчи ${formatDay(shownDay)} (${events.length}):`;
    return `${header} ${intro} ${events.map(event => formatMatch(event, zone)).join("; ")}.`;
  } catch (error) {
    console.warn("ESPN request failed:", error?.message || "unknown error");
    return "Спортивная база недоступна. Попробуй поиск.";
  }
}

function runTool(call, timeZone, timeoutMs) {
  if (call?.name === "search_web") return searchWeb(call?.args?.query, timeoutMs);
  if (call?.name === "football_matches") return footballMatches(call?.args?.league, call?.args?.date, timeZone, timeoutMs);
  return Promise.resolve("Неизвестная функция.");
}

function attemptKey(attempt) {
  return `${attempt.model}|${attempt.search}`;
}

function resetModelCooldowns() {
  cooldownUntil.clear();
}

function searchLabel(search) {
  if (search === "google") return "with Google Search";
  if (search === "tools") return "with search tools";
  return "without search";
}

// Built-in Google Search needs a paid Gemini tier, so it is opt-in; otherwise Gemini searches through Serper.
// On HTTP 429 the next attempt runs: the main model without Google Search, then the fallback model.
async function askGemini(text, history, { now, timeZone, timeoutMs, allowPartial }) {
  const deadline = Date.now() + timeoutMs;
  const model = modelName(process.env.GEMINI_MODEL, DEFAULT_MODEL);
  const fallback = modelName(process.env.GEMINI_FALLBACK_MODEL, DEFAULT_FALLBACK_MODEL);
  const setting = String(process.env.GEMINI_GOOGLE_SEARCH || "").trim().toLowerCase();
  const webSearch = setting === "off" ? "none" : "tools";
  const attempts = setting === "on"
    ? [{ model, search: "google" }, { model, search: webSearch }, { model: fallback, search: webSearch }]
    : [{ model, search: webSearch }, { model: fallback, search: webSearch }];
  const unique = attempts.filter((item, index) =>
    attempts.findIndex(other => other.model === item.model && other.search === item.search) === index);
  const ready = unique.filter(item => !(cooldownUntil.get(attemptKey(item)) > Date.now()));
  // When every attempt is cooling down, the last one is still tried rather than giving up.
  const queue = ready.length ? ready : unique.slice(-1);
  if (queue.length < unique.length) console.info(`Skipping models that failed recently; starting with ${queue[0].model} ${searchLabel(queue[0].search)}.`);

  for (const [index, attempt] of queue.entries()) {
    const next = queue[index + 1];
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
      if (next && COOLDOWN_ERRORS.has(error?.message)) cooldownUntil.set(attemptKey(attempt), Date.now() + MODEL_COOLDOWN_MS);
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
  // Logged so slow answers can be traced to thinking, tools or the network in the Vercel logs.
  const startedAt = Date.now();
  let firstChunkMs = -1;

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
      if (firstChunkMs < 0) firstChunkMs = Date.now() - startedAt;
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
  const outcome = step.timedOut ? "timed out" : step.calls.length ? `called ${step.calls.map(call => call?.name).join(", ")}` : "answered";
  console.info(`Gemini ${model} ${searchLabel(search)} ${outcome}: first chunk ${firstChunkMs < 0 ? "none" : `${firstChunkMs} ms`}, total ${Date.now() - startedAt} ms`);
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
    if (search === "tools") {
      const declarations = process.env.SERPER_API_KEY ? [SEARCH_DECLARATION, FOOTBALL_DECLARATION] : [FOOTBALL_DECLARATION];
      request.tools = [{ functionDeclarations: declarations }];
      // After enough lookups Gemini must answer with what it found.
      if (round >= MAX_TOOL_ROUNDS) request.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    }

    const step = await streamGemini(model, request, deadline - Date.now(), search);

    if (step.timedOut) {
      const partial = allowPartial && !step.calls.length ? toSpeech(completeSentences(step.text)) : "";
      if (!partial) throw new Error("TIME_BUDGET_EXHAUSTED");
      console.warn("Gemini ran out of time; returning the sentences it finished.");
      return partial;
    }

    if (search === "tools" && step.calls.length && round < MAX_TOOL_ROUNDS) {
      const results = await Promise.all(step.calls.map(call => runTool(call, timeZone, deadline - Date.now() - 1500)));
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
  return aliceResponse(STILL_SEARCHING_TEXT, false, history, CONTINUE_BUTTONS);
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
    return res.status(200).json(aliceResponse(SEARCHING_TEXT, false, oldHistory, CONTINUE_BUTTONS));
  } catch (error) {
    const safeError = normalizeError(error);
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, completeSentences, errorForUser, fitAliceText, footballMatches, fitHistoryToBytes, generationConfigFor, isContinueCommand, resetModelCooldowns, safeHistory, systemPrompt, toSpeech };
