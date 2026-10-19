const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 300;
// Yandex rejects responses whose session_state JSON exceeds 1 KB; keep a safety margin.
const MAX_SESSION_STATE_BYTES = 900;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4400;
const SERPER_TIMEOUT_MS = 1800;
const GEMINI_TIMEOUT_MS = 4100;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если переданы результаты поиска, отвечай по ним. Для расписания и результатов назови найденные матчи: кто играет, во сколько и с каким счётом.",
  "Не говори, что данных нет, если в тексте уже есть команды, время или счёт. Не выдумывай факты, которых в результатах нет.",
  "Если не знаешь ответа и поиск ничего не дал, честно скажи об этом."
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

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|завтра|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные|матч|расписан|результат|чемпионат/i.test(text);
}

// Turns a spoken question into a shorter web query. Schedule questions get an extra keyword.
function searchQuery(text) {
  const query = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
  if (/матч|чемпионат|лиг|расписан|результат|сч[её]т/i.test(query) && !/расписан/i.test(query)) {
    return `${query} расписание`;
  }
  return query;
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

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: searchQuery(query), gl: "ru", hl: "ru", num: 8 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    return formatSearchContext(data);
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
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
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nНазови команды, время и счёт, если они есть в тексте. Не выдумывай матчи, которых там нет.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 512
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    const detail = String(data?.error?.message || "").slice(0, 300);
    console.error("Gemini request failed with HTTP", status, detail);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
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
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
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

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search has a very short budget because Alice expects a response within 4.5 seconds.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2300)));
      console.info(searchContext ? `Search context attached, ${searchContext.length} chars` : "Search returned no usable text");
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 250))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.name === "AbortError" ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, errorForUser, fitAliceText, fitHistoryToBytes, formatSearchContext, isSearchIntent, safeHistory, searchQuery };
