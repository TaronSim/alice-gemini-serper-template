import test from "node:test";
import assert from "node:assert/strict";
import { aliceResponse, completeSentences, errorForUser, fitAliceText, fitHistoryToBytes, generationConfigFor, isContinueCommand, safeHistory, systemPrompt, toSpeech } from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-gemini-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

function fakeRes() {
  const res = {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return value; },
    setHeader() {}
  };
  return res;
}

test("session_state stays under the Yandex 1 KB limit with long Russian history", () => {
  const longText = "Очень длинный русский ответ нейросети. ".repeat(50);
  const history = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: longText }));
  const result = aliceResponse("Привет", false, history);
  const bytes = Buffer.byteLength(JSON.stringify(result.session_state), "utf8");
  assert.ok(bytes <= 1024, `session_state is ${bytes} bytes`);
  assert.ok(result.session_state.history.length > 0);
  assert.equal(result.session_state.history.at(-1).role, "model");
  assert.deepEqual(fitHistoryToBytes(history, 10), []);
});

test("Yandex ping is answered without calling Gemini", async () => {
  const handler = (await import("../api/index.js")).default;
  const res = fakeRes();
  await handler({ method: "POST", body: { request: { command: "ping", original_utterance: "ping" } } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.response.text, "pong");
});

test("requests from another skill are rejected when ALICE_SKILL_ID is set", async () => {
  const handler = (await import("../api/index.js")).default;
  process.env.ALICE_SKILL_ID = "my-skill";
  try {
    const res = fakeRes();
    await handler({ method: "POST", body: { session: { skill_id: "other-skill" }, request: { command: "" } } }, res);
    assert.equal(res.statusCode, 403);

    const ok = fakeRes();
    await handler({ method: "POST", body: { session: { skill_id: "my-skill" }, request: { command: "" } } }, ok);
    assert.equal(ok.statusCode, 200);
    assert.match(ok.payload.response.text, /Привет/);
  } finally {
    delete process.env.ALICE_SKILL_ID;
  }
});

test("Gemini timeout produces the 'не успела' message", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = async () => {
    throw new DOMException("This operation was aborted", "AbortError");
  };
  try {
    const res = fakeRes();
    await handler({ method: "POST", body: { request: { command: "расскажи сказку" } } }, res);
    assert.equal(res.payload.response.text, errorForUser(new Error("TIME_BUDGET_EXHAUSTED")));
    assert.match(res.payload.response.text, /Не успела/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

function geminiSse(text) {
  const event = { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] };
  return new Response(`data: ${JSON.stringify(event)}\r\n\r\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

test("only whole sentences are kept and continue phrases are recognised", () => {
  assert.equal(completeSentences("Первое предложение. Второе без конца"), "Первое предложение.");
  assert.equal(completeSentences("Без точки"), "");
  assert.equal(isContinueCommand("Дальше!"), true);
  assert.equal(isContinueCommand("ну что там?"), true);
  assert.equal(isContinueCommand("дальше расскажи про Марс"), false);
});

test("slow Gemini stream returns the sentences it already finished", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /streamGenerateContent\?alt=sse/);
    const first = { candidates: [{ content: { parts: [{ text: "Жил-был кот. Однажды он" }] } }] };
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(first)}\n\n`));
        options.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      }
    });
    return new Response(body, { status: 200 });
  };
  try {
    const res = fakeRes();
    await handler({ method: "POST", body: { request: { command: "расскажи сказку" } } }, res);
    assert.equal(res.payload.response.text, "Жил-был кот.");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

test("with Redis a late answer is finished in the background and given on 'дальше'", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  const store = new Map();
  let releaseGemini;
  const geminiGate = new Promise(resolve => { releaseGemini = resolve; });
  process.env.GEMINI_API_KEY = "gemini-key";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://redis.test")) {
      const [command, key, value] = JSON.parse(options.body);
      let result = null;
      if (command === "GET") result = store.get(key) ?? null;
      if (command === "SET") { store.set(key, value); result = "OK"; }
      if (command === "DEL") result = store.delete(key) ? 1 : 0;
      return new Response(JSON.stringify({ result }));
    }
    await geminiGate;
    return geminiSse("Жил-был кот, и он любил молоко.");
  };
  const session = { session_id: "session-1" };
  try {
    const first = fakeRes();
    await handler({ method: "POST", body: { session, request: { command: "расскажи сказку" } } }, first);
    assert.match(first.payload.response.text, /Скажите «дальше»/);

    releaseGemini();
    for (let i = 0; i < 50 && !String(store.get("alice:pending:session-1")).includes('"done"'); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const next = fakeRes();
    await handler({ method: "POST", body: { session, request: { command: "дальше" } } }, next);
    assert.equal(next.payload.response.text, "Жил-был кот, и он любил молоко.");
    assert.deepEqual(next.payload.session_state.history.map(item => item.text), [
      "расскажи сказку",
      "Жил-был кот, и он любил молоко."
    ]);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(store.has("alice:pending:session-1"), false);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});

test("Gemini picks its own thinking depth unless GEMINI_THINKING_LEVEL is set", () => {
  assert.deepEqual(generationConfigFor("gemini-3.8-flash", ""), { maxOutputTokens: 8192 });
  assert.deepEqual(generationConfigFor("gemini-3.8-flash", "Low").thinkingConfig, { thinkingLevel: "low" });
  assert.equal(generationConfigFor("gemini-2.5-flash", "low").thinkingConfig, undefined);
});

test("Markdown from Gemini becomes plain speech", () => {
  assert.equal(
    toSpeech("## Матчи\n- **Ливерпуль** — Вильярреал\n- [ПСЖ](https://x.y) — Барселона\nПодробнее: https://example.com"),
    "Матчи. Ливерпуль — Вильярреал. ПСЖ — Барселона. Подробнее:"
  );
});

test("Gemini gets Google Search, the current date and the user's time zone", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "gemini-key";
  let request;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /gemini-3\.8-flash:streamGenerateContent\?alt=sse/);
    request = JSON.parse(options.body);
    return geminiSse("Сегодня в АПЛ играют Тоттенхэм и Ковентри.");
  };
  try {
    const res = fakeRes();
    await handler({
      method: "POST",
      body: { meta: { timezone: "Asia/Yerevan" }, request: { command: "какие матчи чемпионата англии сегодня" } }
    }, res);
    assert.deepEqual(request.tools, [{ google_search: {} }]);
    const instruction = request.systemInstruction.parts[0].text;
    assert.match(instruction, /Asia\/Yerevan/);
    assert.match(instruction, /20\d\d/);
    assert.equal(request.contents.at(-1).parts[0].text, "какие матчи чемпионата англии сегодня");
    assert.equal(res.payload.response.text, "Сегодня в АПЛ играют Тоттенхэм и Ковентри.");

    process.env.GEMINI_GOOGLE_SEARCH = "off";
    await handler({ method: "POST", body: { request: { command: "сочини стих" } } }, fakeRes());
    assert.equal(request.tools, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_GOOGLE_SEARCH;
  }
});

test("the system prompt keeps only voice-format limits", () => {
  const prompt = systemPrompt(new Date("2026-10-19T12:00:00Z"), "Europe/Moscow");
  assert.match(prompt, /19 октября 2026/);
  assert.match(prompt, /поиск Google/);
  assert.doesNotMatch(prompt, /1–3 коротких/);
});

test("an out-of-quota model falls back to the lighter model", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "gemini-key";
  const models = [];
  globalThis.fetch = async url => {
    const model = String(url).match(/models\/([^:]+):/)[1];
    models.push(model);
    if (model === "gemini-3.8-flash") {
      return new Response(JSON.stringify({ error: { message: "You exceeded your current quota" } }), { status: 429 });
    }
    return geminiSse("Короткий стих готов.");
  };
  try {
    const res = fakeRes();
    await handler({ method: "POST", body: { request: { command: "сочини короткий стих" } } }, res);
    assert.deepEqual(models, ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    assert.equal(res.payload.response.text, "Короткий стих готов.");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});
