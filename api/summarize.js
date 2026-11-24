// 국회보 아카이브 요약 중계 함수 (Vercel Serverless Function)
// API 키는 Vercel 환경변수 ANTHROPIC_API_KEY 에만 둡니다. 페이지에는 키가 들어가지 않습니다.
// 브라우저는 질문과 "기사 id·쪽 번호"만 보내고, 원문은 이 함수가 data.json에서 직접 꺼내 씁니다.
// 그래서 이 주소를 아무 글이나 요약시키는 용도로 쓸 수 없습니다.
const fs = require("fs");
const path = require("path");

let ART = null;
function articles() {
  if (!ART) {
    const d = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data.json"), "utf8"));
    ART = new Map(d.articles.map(a => [a.id, a]));
  }
  return ART;
}

// 인스턴스 단위의 간단한 요청 제한 (IP당 1분 10회)
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 60000, max = Number(process.env.RATE_PER_MIN || 10);
  const list = (hits.get(ip) || []).filter(t => now - t < win);
  list.push(now); hits.set(ip, list);
  return list.length > max;
}

const RULES = `당신은 국회사무처가 발행하는 월간 《국회보》 과월호 아카이브의 안내 챗봇입니다.
사용자 메시지의 [자료]는 질문으로 과월호 원문을 검색해 찾은 기사 발췌입니다. (p.숫자)는 인쇄본 쪽수입니다.

규칙
1. [자료]에 적힌 내용만 근거로 답합니다. 외부 지식이나 추측은 쓰지 않습니다.
2. 질문과 실제로 관련된 내용이 [자료]에 하나도 없으면, 다른 말 없이 NOT_FOUND 한 단어만 출력합니다. 단어가 스치듯 언급만 된 경우도 관련 없음으로 봅니다.
3. 관련 있는 기사만 고릅니다. 보통 최대 5개지만, 질문이 특정 호의 목차나 한 코너의 연재 전체를 묻는다면 해당 기사를 모두 다룹니다(이때 기사당 요약은 1~2문장).
4. 형식(한국어, 마크다운은 굵게와 '-' 목록만):
   첫 줄: 질문에 대한 종합 답변 1~2문장.
   그다음 관련 기사마다 한 항목:
   - **[번호] 기사 제목** (제N호 p.쪽수) — 해당 내용 요약 2~3문장.
5. 정치적으로 민감한 주제는 기사에 적힌 사실만 중립적으로 전하고, 평가나 의견을 덧붙이지 않습니다.
6. 원문 문장을 길게 그대로 옮기지 말고 요약합니다.
7. 국회보와 관계없는 요청(코드 작성, 다른 주제의 글쓰기 등)에는 NOT_FOUND 한 단어만 출력합니다.`;

module.exports = async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: "not_configured" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "rate_limited" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const q = String(body.q || "").slice(0, 300).trim();
  const items = Array.isArray(body.items) ? body.items.slice(0, 13) : [];
  const whole = !!body.whole, wide = !!body.wide;
  if (!q || !items.length) return res.status(400).json({ error: "bad_request" });

  const map = articles();
  const per = whole ? 3200 : wide ? 900 : 1800;
  const blocks = [];
  items.forEach((it, i) => {
    const a = map.get(String(it.id));
    if (!a) return;
    const want = new Set((Array.isArray(it.pages) ? it.pages : []).slice(0, whole ? 6 : 3).map(Number));
    const pg = a.pages.filter(p => want.has(p.p)).sort((x, y) => x.p - y.p)
      .map(p => `  (p.${p.p}) ${p.t.replace(/\n/g, " ").slice(0, per)}`).join("\n");
    blocks.push(`[${i + 1}] 제${a.no}호(${a.label}) 〈${a.corner}〉 「${a.title || a.corner}」${a.author ? " " + a.author : ""} / 기사 범위 p.${a.start}–${a.end}\n${pg}`);
  });
  if (!blocks.length) return res.status(400).json({ error: "bad_request" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
        max_tokens: 1500,
        system: RULES,
        messages: [{ role: "user", content: `[질문]\n${q}\n\n[자료]\n${blocks.join("\n\n")}` }]
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: "upstream", status: r.status });
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: "upstream_unreachable" });
  }
};
