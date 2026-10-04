import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const EDU_KEY = process.env.KOREA_EDU_INFO || "";
const client = process.env.CLAUDE_API_KEY
  ? new Anthropic({ apiKey: process.env.CLAUDE_API_KEY })
  : null;

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "public")));

// ---------- 보호: 접근 코드 + 간단한 IP 기반 호출 제한 ----------
const hits = new Map();
function guard(req, res, next) {
  if (ACCESS_CODE && req.get("x-access-code") !== ACCESS_CODE) {
    return res.status(401).json({ error: "접근 코드가 올바르지 않습니다." });
  }
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 30) {
    return res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
  }
  list.push(now);
  hits.set(req.ip, list);
  next();
}

app.get("/api/config", (_req, res) => {
  res.json({ ai: !!client, edu: !!EDU_KEY, accessRequired: !!ACCESS_CODE, model: MODEL });
});

// ---------- 고용24 국민내일배움카드 훈련과정 ----------
const WORK24_URL = "https://www.work24.go.kr/cm/openApi/call/hr/callOpenApiSvcInfo310L01.do";

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const pick = (o, key) => {
  const k = Object.keys(o).find((x) => x.toLowerCase() === key.toLowerCase());
  return k ? o[k] : "";
};
function findList(node) {
  if (Array.isArray(node)) return node;
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) {
      const r = findList(v);
      if (r) return r;
    }
  }
  return null;
}
function safeLink(u) {
  return typeof u === "string" && /^https?:\/\//.test(u) ? u : "";
}

async function searchEdu({ keyword = "", area = "", days = 180, size = 20 } = {}) {
  if (!EDU_KEY) throw new Error("KOREA_EDU_INFO 환경변수가 설정되지 않았습니다.");
  const from = new Date();
  const to = new Date(Date.now() + Number(days) * 86400000);
  const params = new URLSearchParams({
    authKey: EDU_KEY,
    returnType: "JSON",
    outType: "1",
    pageNum: "1",
    pageSize: String(Math.min(Number(size) || 20, 100)),
    srchTraStDt: ymd(from),
    srchTraEndDt: ymd(to),
    sort: "DESC",
    sortCol: "5",
  });
  if (keyword) params.set("srchTraProcessNm", keyword);
  if (area) params.set("srchTraArea1", area);

  const r = await fetch(`${WORK24_URL}?${params}`, { signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("고용24 응답을 해석할 수 없습니다: " + text.slice(0, 120).replace(/\s+/g, " "));
  }
  const rows = findList(json) || [];
  const total = Number(pick(json?.HRDNet || json, "scn_cnt")) || rows.length;
  const courses = rows
    .filter((o) => o && typeof o === "object")
    .map((o) => ({
      title: pick(o, "title"),
      org: pick(o, "subTitle"),
      start: pick(o, "traStartDate"),
      end: pick(o, "traEndDate"),
      fee: pick(o, "realMan") || pick(o, "courseMan"),
      target: pick(o, "trainTarget"),
      capacity: pick(o, "yardMan"),
      employRate3: pick(o, "eiEmplRate3"),
      satisfaction: pick(o, "stdgScor"),
      ncs: pick(o, "ncsCd"),
      address: pick(o, "address"),
      link: safeLink(pick(o, "titleLink")),
    }))
    .filter((c) => c.title);
  return { total, courses };
}

// 전체 문구로 결과가 없으면 가장 긴 단어로 재검색
async function searchEduSmart(opts) {
  let res = await searchEdu(opts);
  if (!res.courses.length && opts.keyword && /\s/.test(opts.keyword.trim())) {
    const longest = opts.keyword.trim().split(/\s+/).sort((a, b) => b.length - a.length)[0];
    res = await searchEdu({ ...opts, keyword: longest });
  }
  return res;
}

app.get("/api/edu/search", guard, async (req, res) => {
  try {
    res.json(await searchEduSmart({ keyword: req.query.keyword || "", area: req.query.area || "" }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- Claude ----------
const TYPES = { lecture: "강의", practice: "실습", demo: "시연", discussion: "토의", etc: "기타" };

const SCHEMA_DOC = `반드시 아래 구조의 JSON 객체 하나만 출력한다. (설명문, 코드펜스 금지)
{
  "title": "강의명",
  "subtitle": "한 줄 부제",
  "overview": "강의 개요 2~3문장",
  "goals": ["강의 목표(측정 가능한 행동 동사로 시작) 3~5개"],
  "highlights": [{"title": "특장점 제목", "desc": "차별점·우수성 설명 1~2문장"}],   // 3~5개
  "effects": ["기대 효과 3~5개"],
  "prerequisites": ["수강 요건(사전 지식·경력·권장 대상 등) 2~5개"],
  "requirements": [{"category": "장비/소프트웨어/교재·자료/장소·환경/강사·운영 등", "items": ["필요 사항"]}],
  "sessions": [{
    "type": "lecture|practice|demo|discussion|etc",
    "title": "세션 제목",
    "minutes": 정수(분),
    "content": ["세부 내용 불릿 2~5개"],
    "method": "진행 방식·활동 안내 1~2문장",
    "materials": "사용 자료/도구(없으면 빈 문자열)"
  }],
  "assessment": ["성과 확인/평가 방법 1~3개"],
  "eduAnalysis": null 또는 {
    "summary": "내일배움카드 훈련과정 분석 요약 2~3문장",
    "similarCourses": [{"title": "참고한 과정명(제공된 목록에서만)", "org": "기관", "note": "본 강의와의 관계·차이"}],
    "gaps": [{"topic": "기존 과정에 없는(또는 부족한) 내용", "reason": "근거", "howReflected": "본 강의에 반영한 방식"}],
    "differentiation": "기존 과정 대비 본 강의의 차별 포인트"
  }
}`;

const SYSTEM = `당신은 기업 교육·대학·세미나를 설계하는 15년 경력의 교수설계(ID) 전문가이다.
입력 조건에 꼭 맞는 실행 가능한 강의 계획서를 한국어로 작성한다.
원칙:
- 강의 유형은 강의(lecture)·실습(practice)·시연(demo)·토의(discussion)·기타(etc: 도입, 휴식, 평가, 정리 등)로만 분류한다.
- sessions의 minutes 합계는 총 소요 시간과 정확히 같아야 한다. 유형별 minutes 합계는 요청한 비율에 근접(5분 단위 반올림 오차 허용)해야 한다. 비율 0%인 유형은 사용하지 않는다.
- 오프닝(아이스브레이킹/목표 공유)과 마무리(정리/Q&A/평가)를 포함하고, 2시간 이상이면 휴식 시간을 etc로 배치한다.
- 구체적이고 대상 수준에 맞게 쓰고, 막연한 일반론·과장 표현을 피한다.
- 사실로 확인되지 않은 통계·수치·기관명을 지어내지 않는다.`;

function inputBlock(i) {
  const r = i.ratio || {};
  const ratioText = Object.entries(TYPES)
    .map(([k, ko]) => `${ko} ${Number(r[k]) || 0}%`)
    .join(", ");
  return `[입력 조건]
- 강의 주제: ${i.topic}
- 강의 대상: ${i.audience}
- 총 소요 시간: ${i.totalMinutes}분
- 유형 비율: ${ratioText}
- 진행 방식: ${i.mode || "미지정"}
- 예상 인원: ${i.headcount || "미지정"}
- 기타 참고 특징: ${i.notes || "없음"}`;
}

function eduBlock(i, edu) {
  if (!edu || i.eduMode === "off") return "";
  const lines = edu.courses
    .slice(0, 15)
    .map(
      (c, n) =>
        `${n + 1}. ${c.title} | ${c.org} | ${c.start}~${c.end} | 수강비 ${c.fee || "-"}원 | 대상 ${c.target || "-"} | 3개월 취업률 ${c.employRate3 || "-"} | 만족도 ${c.satisfaction || "-"}`,
    )
    .join("\n");
  const list = lines || "(검색 결과 없음)";
  const task =
    i.eduMode === "gap"
      ? "위 과정들에 없거나 부족한 내용(공백)을 찾아 본 강의에 차별화 요소로 반영하고, eduAnalysis.gaps에 근거와 반영 방식을 쓴다. 검색 결과가 없으면 '유사 과정이 확인되지 않음'을 전제로 하되 과장하지 않는다."
      : "위 과정들 중 유사한 것을 eduAnalysis.similarCourses에 정리하고, 그 구성(주제·시간 배분)을 참고하되 본 강의만의 차별점을 eduAnalysis.differentiation에 쓴다. 필요하면 gaps도 채운다.";
  return `\n[국민내일배움카드 훈련과정 검색 결과 - 총 ${edu.total}건 중 상위 ${Math.min(15, edu.courses.length)}건]\n${list}\n지시: ${task} eduAnalysis는 반드시 채운다. 제공 목록에 없는 과정명은 쓰지 않는다.`;
}

async function callClaude(userText, maxTokens = 24000) {
  if (!client) throw new Error("CLAUDE_API_KEY 환경변수가 설정되지 않았습니다.");
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system: SYSTEM,
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: userText }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("모델이 요청을 처리하지 못했습니다. 입력 내용을 조정해 주세요.");
  if (msg.stop_reason === "max_tokens") throw new Error("응답이 길이 제한에 도달했습니다. 시간을 줄이거나 다시 시도해 주세요.");
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return parseJson(text);
}

function parseJson(text) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("AI 응답에서 JSON을 찾지 못했습니다.");
  return JSON.parse(text.slice(s, e + 1));
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

function normSession(s) {
  return {
    type: Object.hasOwn(TYPES, s?.type) ? s.type : "etc",
    title: str(s?.title),
    minutes: Math.max(0, Math.round(Number(s?.minutes) || 0)),
    content: arr(s?.content).map(str),
    method: str(s?.method),
    materials: str(s?.materials),
  };
}

function normPlan(p, edu, mode) {
  const a = p.eduAnalysis;
  return {
    title: str(p.title),
    subtitle: str(p.subtitle),
    overview: str(p.overview),
    goals: arr(p.goals).map(str),
    highlights: arr(p.highlights).map((h) => ({ title: str(h?.title), desc: str(h?.desc) })),
    effects: arr(p.effects).map(str),
    prerequisites: arr(p.prerequisites).map(str),
    requirements: arr(p.requirements).map((r) => ({ category: str(r?.category), items: arr(r?.items).map(str) })),
    sessions: arr(p.sessions).map(normSession),
    assessment: arr(p.assessment).map(str),
    eduAnalysis:
      a && mode !== "off"
        ? {
            mode,
            summary: str(a.summary),
            similarCourses: arr(a.similarCourses).map((c) => ({ title: str(c?.title), org: str(c?.org), note: str(c?.note) })),
            gaps: arr(a.gaps).map((g) => ({ topic: str(g?.topic), reason: str(g?.reason), howReflected: str(g?.howReflected) })),
            differentiation: str(a.differentiation),
          }
        : null,
    eduCourses: edu ? edu.courses.slice(0, 15) : [],
  };
}

function validateInput(i) {
  if (!i || !str(i.topic).trim() || !str(i.audience).trim()) return "강의 주제와 대상을 입력해 주세요.";
  const t = Number(i.totalMinutes);
  if (!(t >= 10 && t <= 2400)) return "소요 시간은 10분~40시간 사이로 입력해 주세요.";
  const sum = Object.keys(TYPES).reduce((n, k) => n + (Number(i.ratio?.[k]) || 0), 0);
  if (Math.round(sum) !== 100) return "유형 비율의 합이 100%여야 합니다.";
  return null;
}

app.post("/api/generate", guard, async (req, res) => {
  const input = req.body?.input;
  const bad = validateInput(input);
  if (bad) return res.status(400).json({ error: bad });
  try {
    let edu = null;
    let eduWarning = "";
    if (input.eduMode && input.eduMode !== "off") {
      try {
        edu = await searchEduSmart({
          keyword: input.eduKeyword || input.topic,
          area: input.eduArea || "",
        });
      } catch (e) {
        eduWarning = e.message;
      }
    }
    const prompt = `${inputBlock(input)}${eduBlock(input, edu)}\n\n${SCHEMA_DOC}${
      edu ? "" : "\n(내일배움카드 정보가 없으므로 eduAnalysis는 null)"
    }`;
    const plan = normPlan(await callClaude(prompt), edu, edu ? input.eduMode : "off");
    res.json({ plan, eduWarning });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "생성 중 오류가 발생했습니다." });
  }
});

const SECTION_HINT = {
  header: `{"title": "...", "subtitle": "...", "overview": "..."}`,
  goals: `["강의 목표", ...]`,
  highlights: `[{"title": "...", "desc": "..."}, ...]`,
  effects: `["기대 효과", ...]`,
  prerequisites: `["수강 요건", ...]`,
  requirements: `[{"category": "...", "items": ["..."]}, ...]`,
  assessment: `["평가 방법", ...]`,
  eduAnalysis: `{"summary": "...", "similarCourses": [...], "gaps": [...], "differentiation": "..."} (스키마는 원래 계획서와 동일)`,
  sessions: `전체 sessions 배열 (스키마 동일, minutes 합계는 총 시간과 같아야 함)`,
  session: `세션 객체 1개 (스키마 동일)`,
};

app.post("/api/regenerate", guard, async (req, res) => {
  const { input, plan, section, index, instruction } = req.body || {};
  const bad = validateInput(input);
  if (bad) return res.status(400).json({ error: bad });
  if (!plan || !Object.hasOwn(SECTION_HINT, section)) return res.status(400).json({ error: "잘못된 요청입니다." });
  try {
    const { eduCourses, ...planForPrompt } = plan;
    let constraint = "";
    let target = "";
    if (section === "session") {
      const s = plan.sessions?.[index];
      if (!s) return res.status(400).json({ error: "세션을 찾을 수 없습니다." });
      constraint = `이 세션의 type은 "${s.type}", minutes는 ${s.minutes}분으로 반드시 유지한다.`;
      target = `세션 #${index + 1} "${s.title}"`;
    } else if (section === "sessions") {
      constraint = `총 ${input.totalMinutes}분, 유형 비율을 지키며 전체 세션을 다시 구성한다.`;
      target = "전체 세션(타임라인·커리큘럼)";
    } else {
      target = section;
    }
    if (section === "eduAnalysis" && (!input.eduMode || input.eduMode === "off")) {
      return res.status(400).json({ error: "내일배움카드 분석 모드가 꺼져 있습니다." });
    }
    const prompt = `${inputBlock(input)}${section === "eduAnalysis" ? eduBlock(input, { total: plan.eduCourses?.length || 0, courses: plan.eduCourses || [] }) : ""}

[현재 강의 계획서]
${JSON.stringify(planForPrompt)}

[작업] 위 계획서의 "${target}" 부분만 다시 작성한다. 나머지와 일관성을 유지하고 중복을 피한다.
${constraint}
${instruction ? `사용자 요청: ${str(instruction).slice(0, 500)}` : "더 구체적이고 개선된 안으로 다시 작성한다."}

출력: {"value": ${SECTION_HINT[section]}} 형태의 JSON 객체 하나만 출력한다.`;
    const out = await callClaude(prompt, 16000);
    let v = out.value;
    if (v === undefined) return res.status(500).json({ error: "AI 응답 형식이 올바르지 않습니다." });
    if (section === "session") {
      v = normSession(v);
      v.type = plan.sessions[index].type;
      v.minutes = plan.sessions[index].minutes;
    } else if (section === "sessions") {
      v = arr(v).map(normSession);
    } else if (section === "header") {
      v = { title: str(v.title), subtitle: str(v.subtitle), overview: str(v.overview) };
    } else if (section === "eduAnalysis") {
      v = normPlan({ eduAnalysis: v }, null, input.eduMode).eduAnalysis;
    } else {
      v = normPlan({ [section]: v }, null, "off")[section];
    }
    res.json({ value: v });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "재생성 중 오류가 발생했습니다." });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`lectureplanner listening on :${PORT}`));
