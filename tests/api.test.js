import test from "node:test";
import assert from "node:assert/strict";
import { aliceResponse, errorForUser, fitAliceText, fitHistoryToBytes, formatSearchContext, isSearchIntent, safeHistory, searchQuery } from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("матчи лиги чемпионов завтра"), true);
  assert.equal(isSearchIntent("какие матчи чемпионата англии сегодня"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
  assert.equal(isSearchIntent("сочини короткий стих"), false);
});

test("schedule questions become a search query and Serper facts are kept", () => {
  assert.equal(searchQuery("какие матчи чемпионата англии сегодня"), "какие матчи чемпионата англии сегодня расписание");
  assert.equal(searchQuery("сочини короткий стих"), "сочини короткий стих");

  const context = formatSearchContext({
    answerBox: { snippet: "Арсенал — Челси, 17:30" },
    organic: [{ title: "АПЛ сегодня", snippet: "Ливерпуль — Манчестер Сити, 20:00" }]
  });
  assert.match(context, /Арсенал — Челси, 17:30/);
  assert.match(context, /Ливерпуль — Манчестер Сити, 20:00/);
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
