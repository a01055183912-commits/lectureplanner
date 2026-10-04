const TYPES = [
  ["lecture", "강의"],
  ["practice", "실습"],
  ["demo", "시연"],
  ["discussion", "토의"],
  ["etc", "기타"],
];
const TYPE_KO = Object.fromEntries(TYPES);
const COLORS = { lecture: "--c-lecture", practice: "--c-practice", demo: "--c-demo", discussion: "--c-discussion", etc: "--c-etc" };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let cfg = { ai: false, edu: false, accessRequired: false };
let input = null;
let plan = null;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.accessRequired) {
    let code = sessionStorage.getItem("accessCode");
    if (!code) {
      code = prompt("접근 코드를 입력하세요") || "";
      sessionStorage.setItem("accessCode", code);
    }
    headers["x-access-code"] = code;
  }
  const r = await fetch(path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) sessionStorage.removeItem("accessCode");
  if (!r.ok) throw new Error(data.error || `요청 실패 (${r.status})`);
  return data;
}

function busy(on, text) {
  $("#busy").hidden = !on;
  if (text) $("#busyText").textContent = text;
}

// ---------- 폼: 비율 ----------
const form = $("#form");
const defaults = { lecture: 40, practice: 30, demo: 10, discussion: 15, etc: 5 };

function buildRatios() {
  $("#ratios").innerHTML = TYPES.map(
    ([k, ko]) => `<div class="ratio-row">
      <span>${ko}</span>
      <input type="range" min="0" max="100" step="5" data-r="${k}" value="${defaults[k]}">
      <input type="number" min="0" max="100" data-n="${k}" value="${defaults[k]}">
    </div>`,
  ).join("");
  $("#ratios").addEventListener("input", (e) => {
    const k = e.target.dataset.r || e.target.dataset.n;
    if (!k) return;
    const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    $(`[data-r="${k}"]`).value = v;
    $(`[data-n="${k}"]`).value = v;
    updateRatioSum();
  });
  updateRatioSum();
}
const getRatio = () => Object.fromEntries(TYPES.map(([k]) => [k, Number($(`[data-n="${k}"]`).value) || 0]));

function updateRatioSum() {
  const r = getRatio();
  const sum = Object.values(r).reduce((a, b) => a + b, 0);
  $("#ratioSum").innerHTML = `합계 <b class="${sum === 100 ? "" : "bad"}">${sum}%</b>${sum === 100 ? "" : sum > 100 ? " (초과)" : " (부족)"}`;
  $("#ratioBar").innerHTML = TYPES.map(
    ([k]) => `<i style="width:${Math.min(100, (r[k] / Math.max(sum, 100)) * 100)}%;background:var(${COLORS[k]})"></i>`,
  ).join("");
}

$("#ratioFix").onclick = () => {
  const r = getRatio();
  const sum = Object.values(r).reduce((a, b) => a + b, 0);
  if (sum === 0) return;
  let acc = 0;
  const keys = TYPES.map(([k]) => k);
  keys.forEach((k, i) => {
    const v = i === keys.length - 1 ? 100 - acc : Math.round((r[k] / sum) * 100);
    acc += v;
    $(`[data-r="${k}"]`).value = v;
    $(`[data-n="${k}"]`).value = v;
  });
  updateRatioSum();
};

// ---------- 폼: 내일배움카드 ----------
function eduModeChanged() {
  const mode = form.eduMode.value;
  $("#eduOpts").hidden = mode === "off";
  $("#eduHint").textContent = mode === "off" ? "" : cfg.edu ? "고용24 국민내일배움카드 훈련과정을 조회해 설계에 반영합니다." : "KOREA_EDU_INFO 환경변수가 없어 훈련과정 조회 없이 AI가 일반 지식으로만 제안합니다.";
}
form.addEventListener("change", (e) => { if (e.target.name === "eduMode") eduModeChanged(); });

function courseHtml(c) {
  const t = c.link ? `<a class="course-link" href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title);
  return `<div>${t}<small>${esc(c.org)} · ${esc(c.start)}~${esc(c.end)} · 수강비 ${esc(c.fee || "-")}원${c.employRate3 ? ` · 취업률 ${esc(c.employRate3)}%` : ""}${c.satisfaction ? ` · 만족도 ${esc(c.satisfaction)}` : ""}</small></div>`;
}

$("#eduPreview").onclick = async () => {
  const box = $("#eduList");
  if (!cfg.edu) { box.textContent = "KOREA_EDU_INFO 환경변수가 설정되지 않았습니다."; return; }
  box.textContent = "검색 중…";
  try {
    const q = new URLSearchParams({ keyword: form.eduKeyword.value || form.topic.value, area: form.eduArea.value });
    const d = await api(`/api/edu/search?${q}`);
    box.innerHTML = d.courses.length ? `<div class="hint">총 ${d.total}건 중 ${d.courses.length}건</div>` + d.courses.map(courseHtml).join("") : "검색 결과가 없습니다.";
  } catch (e) { box.textContent = e.message; }
};

// ---------- 생성 ----------
function readInput() {
  const total = (Number(form.hours.value) || 0) * 60 + (Number(form.mins.value) || 0);
  return {
    topic: form.topic.value.trim(),
    audience: form.audience.value.trim(),
    totalMinutes: total,
    start: form.start.value || "09:00",
    mode: form.mode.value,
    headcount: form.headcount.value.trim(),
    notes: form.notes.value.trim(),
    ratio: getRatio(),
    eduMode: form.eduMode.value,
    eduKeyword: form.eduKeyword.value.trim(),
    eduArea: form.eduArea.value,
  };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#error").textContent = "";
  const inp = readInput();
  if (Object.values(inp.ratio).reduce((a, b) => a + b, 0) !== 100) { $("#error").textContent = "유형 비율의 합을 100%로 맞춰 주세요."; return; }
  if (inp.totalMinutes < 10) { $("#error").textContent = "소요 시간을 입력해 주세요."; return; }
  $("#genBtn").disabled = true;
  busy(true, "AI가 강의 계획서를 작성 중입니다… (30초~2분)");
  try {
    const d = await api("/api/generate", { method: "POST", body: JSON.stringify({ input: inp }) });
    input = inp;
    plan = d.plan;
    if (d.eduWarning) $("#error").textContent = "훈련과정 조회 실패: " + d.eduWarning + " (조회 없이 생성됨)";
    persist();
    render();
    if (matchMedia("(max-width:900px)").matches) $("#doc").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    $("#error").textContent = err.message;
  } finally {
    busy(false);
    $("#genBtn").disabled = false;
  }
});

// ---------- 경로 기반 편집 ----------
function getAt(path) { return path.split(".").reduce((o, k) => o?.[k], plan); }
function setAt(path, v) {
  const ks = path.split(".");
  const last = ks.pop();
  ks.reduce((o, k) => o[k], plan)[last] = v;
}
function persist() { store.set("lp-draft", JSON.stringify({ input, plan })); }

const ed = (path, text, cls = "") => `<span class="ed ${cls}" contenteditable="true" spellcheck="false" data-path="${path}">${esc(text)}</span>`;
const list = (path, items, ph = "새 항목") =>
  `<ul>${items.map((t, i) => `<li>${ed(`${path}.${i}`, t)} <button class="del" data-del="${path}.${i}" title="삭제">×</button></li>`).join("")}</ul><button class="add no-print" data-add="${path}" data-ph="${ph}">+ 추가</button>`;
const secHead = (title, key) => `<h2>${title}<button class="regen no-print" data-regen="${key}" title="AI로 이 부분 다시 작성">✦ 재생성</button></h2>`;

// ---------- 시간 계산 ----------
const pad = (n) => String(n).padStart(2, "0");
function clock(startStr, offset) {
  const [h, m] = (startStr || "09:00").split(":").map(Number);
  const t = h * 60 + m + offset;
  return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
}
function schedule() {
  let off = 0;
  return plan.sessions.map((s) => {
    const r = { from: clock(input.start, off), to: clock(input.start, off + s.minutes) };
    off += s.minutes;
    return r;
  });
}
function ratioStats() {
  const total = plan.sessions.reduce((a, s) => a + (Number(s.minutes) || 0), 0);
  const per = Object.fromEntries(TYPES.map(([k]) => [k, 0]));
  plan.sessions.forEach((s) => { per[s.type] = (per[s.type] || 0) + (Number(s.minutes) || 0); });
  return { total, per };
}
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}` : `${m}분`);

// ---------- 렌더 ----------
function render() {
  $("#toolbar").hidden = !plan;
  if (!plan) return;
  const sch = schedule();
  const { total, per } = ratioStats();
  const warnTotal = total !== input.totalMinutes ? `<p class="warn no-print">세션 합계(${total}분)가 입력한 총 시간(${input.totalMinutes}분)과 다릅니다. 분 단위를 조정하거나 세션을 재생성하세요.</p>` : "";

  const a = plan.eduAnalysis;
  const eduSec = a
    ? `<section>${secHead(`10. 내일배움카드 훈련과정 분석 <span class="kv">(${a.mode === "gap" ? "미개설 내용 제안" : "유사 교육 참고"})</span>`, "eduAnalysis")}
        <p>${ed("eduAnalysis.summary", a.summary)}</p>
        ${a.similarCourses.length ? `<h4>유사 과정</h4>${a.similarCourses.map((c, i) => `<div class="card"><b>${ed(`eduAnalysis.similarCourses.${i}.title`, c.title)} <span class="kv">${ed(`eduAnalysis.similarCourses.${i}.org`, c.org)}</span></b>${ed(`eduAnalysis.similarCourses.${i}.note`, c.note)}</div>`).join("")}` : ""}
        ${a.gaps.length ? `<h4>기존 과정에 없는(부족한) 내용 제안</h4>${a.gaps.map((g, i) => `<div class="card"><b>${ed(`eduAnalysis.gaps.${i}.topic`, g.topic)}</b><div class="kv">근거: ${ed(`eduAnalysis.gaps.${i}.reason`, g.reason)}</div><div>반영: ${ed(`eduAnalysis.gaps.${i}.howReflected`, g.howReflected)}</div></div>`).join("")}` : ""}
        ${a.differentiation ? `<p><b>차별 포인트</b> · ${ed("eduAnalysis.differentiation", a.differentiation)}</p>` : ""}
        ${plan.eduCourses.length ? `<details class="no-print"><summary class="kv">조회된 훈련과정 ${plan.eduCourses.length}건</summary><div class="edu-list">${plan.eduCourses.map(courseHtml).join("")}</div></details>` : ""}
      </section>`
    : "";

  $("#doc").innerHTML = `
    <h1>${ed("title", plan.title)}</h1>
    <div class="sub">${ed("subtitle", plan.subtitle)}</div>
    <p class="overview">${ed("overview", plan.overview)}</p>
    <button class="regen no-print" data-regen="header">✦ 제목·개요 재생성</button>
    <p class="kv">대상: ${esc(input.audience)} · 총 ${fmtMin(input.totalMinutes)} · ${esc(input.mode)}${input.headcount ? ` · ${esc(input.headcount)}` : ""}</p>

    <section>${secHead("1. 강의 목표", "goals")}${list("goals", plan.goals)}</section>

    <section>${secHead("2. 강의 특장점", "highlights")}
      ${plan.highlights.map((h, i) => `<div class="card"><b>${ed(`highlights.${i}.title`, h.title)} <button class="del" data-del="highlights.${i}">×</button></b>${ed(`highlights.${i}.desc`, h.desc)}</div>`).join("")}
      <button class="add no-print" data-add="highlights">+ 추가</button>
    </section>

    <section>${secHead("3. 기대 효과", "effects")}${list("effects", plan.effects)}</section>
    <section>${secHead("4. 수강 요건", "prerequisites")}${list("prerequisites", plan.prerequisites)}</section>

    <section>${secHead("5. 강의에 필요한 사항", "requirements")}
      ${plan.requirements.map((r, i) => `<div class="card"><b>${ed(`requirements.${i}.category`, r.category)} <button class="del" data-del="requirements.${i}">×</button></b>${list(`requirements.${i}.items`, r.items)}</div>`).join("")}
      <button class="add no-print" data-add="requirements">+ 분류 추가</button>
    </section>

    <section>
      <h2>6. 유형별 시간 배분</h2>
      <table class="ratio-table"><thead><tr><th>유형</th><th>목표</th><th>실제 배분</th></tr></thead><tbody>
      ${TYPES.filter(([k]) => input.ratio[k] > 0 || per[k] > 0).map(([k, ko]) => {
        const pct = total ? Math.round((per[k] / total) * 100) : 0;
        return `<tr><td><span class="tag t-${k}">${ko}</span></td><td>${input.ratio[k]}%</td><td>${fmtMin(per[k])} (${pct}%)</td></tr>`;
      }).join("")}</tbody></table>
      ${warnTotal}
    </section>

    <section>${secHead("7. 세부 타임라인", "sessions")}
      <table><thead><tr><th>시간</th><th>유형</th><th>세션</th><th>분</th><th class="no-print"></th></tr></thead><tbody>
      ${plan.sessions.map((s, i) => `<tr><td class="num">${sch[i].from} – ${sch[i].to}</td>
        <td><select data-type="${i}">${TYPES.map(([k, ko]) => `<option value="${k}" ${k === s.type ? "selected" : ""}>${ko}</option>`).join("")}</select></td>
        <td>${ed(`sessions.${i}.title`, s.title)}</td>
        <td><input type="number" min="0" step="5" value="${s.minutes}" data-min="${i}"></td>
        <td class="no-print"><button class="del" data-del="sessions.${i}" title="세션 삭제">×</button></td></tr>`).join("")}
      </tbody></table>
      <button class="add no-print" data-add="sessions">+ 세션 추가</button>
    </section>

    <section><h2>8. 상세 커리큘럼</h2>
      ${plan.sessions.map((s, i) => `<div class="session t-${s.type}">
        <h3>${i + 1}. ${ed(`sessions.${i}.title`, s.title)} <span class="tag t-${s.type}">${TYPE_KO[s.type]}</span><span class="meta">${sch[i].from}–${sch[i].to} · ${s.minutes}분</span>
          <button class="regen no-print" data-regen="session" data-index="${i}">✦</button></h3>
        ${list(`sessions.${i}.content`, s.content)}
        <div class="meta"><p>진행: ${ed(`sessions.${i}.method`, s.method)}</p><p>자료/도구: ${ed(`sessions.${i}.materials`, s.materials)}</p></div>
      </div>`).join("")}
    </section>

    <section>${secHead("9. 성과 확인", "assessment")}${list("assessment", plan.assessment)}</section>
    ${eduSec}
  `;
}

// ---------- 문서 이벤트 ----------
const docEl = $("#doc");
docEl.addEventListener("input", (e) => {
  const p = e.target.dataset?.path;
  if (p && e.target.isContentEditable) { setAt(p, e.target.textContent); persist(); }
});
docEl.addEventListener("paste", (e) => {
  if (!e.target.isContentEditable) return;
  e.preventDefault();
  document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\n+/g, " "));
});
docEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.isContentEditable) { e.preventDefault(); e.target.blur(); }
});
docEl.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.min !== undefined) { plan.sessions[+t.dataset.min].minutes = Math.max(0, Number(t.value) || 0); }
  else if (t.dataset.type !== undefined) { plan.sessions[+t.dataset.type].type = t.value; }
  else return;
  persist(); render();
});
docEl.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.del) {
    const ks = b.dataset.del.split(".");
    const idx = +ks.pop();
    getAt(ks.join(".")).splice(idx, 1);
    persist(); render();
  } else if (b.dataset.add) {
    const p = b.dataset.add;
    const t = getAt(p);
    if (p === "highlights") t.push({ title: "새 특장점", desc: "설명" });
    else if (p === "requirements") t.push({ category: "새 분류", items: ["항목"] });
    else if (p === "sessions") t.push({ type: "etc", title: "새 세션", minutes: 10, content: ["내용"], method: "", materials: "" });
    else t.push(b.dataset.ph || "새 항목");
    persist(); render();
  } else if (b.dataset.regen) {
    openRegen(b.dataset.regen, b.dataset.index !== undefined ? +b.dataset.index : undefined);
  }
});

// ---------- 부분 AI 재생성 ----------
const dlg = $("#regenDlg");
let regenTarget = null;
const SECTION_NAMES = { header: "제목·개요", goals: "강의 목표", highlights: "특장점", effects: "기대 효과", prerequisites: "수강 요건", requirements: "필요 사항", sessions: "타임라인·커리큘럼 전체", session: "이 세션", assessment: "성과 확인", eduAnalysis: "내일배움카드 분석" };

function openRegen(section, index) {
  regenTarget = { section, index };
  $("#regenTitle").textContent = `“${SECTION_NAMES[section]}” AI 재생성`;
  $("#regenInstr").value = "";
  dlg.showModal();
}
$("#regenCancel").onclick = () => dlg.close();
$("#regenForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { section, index } = regenTarget;
  const instruction = $("#regenInstr").value.trim();
  dlg.close();
  busy(true, `“${SECTION_NAMES[section]}” 다시 작성 중…`);
  try {
    const d = await api("/api/regenerate", { method: "POST", body: JSON.stringify({ input, plan, section, index, instruction }) });
    if (section === "header") Object.assign(plan, d.value);
    else if (section === "session") plan.sessions[index] = d.value;
    else plan[section] = d.value;
    persist(); render();
  } catch (err) {
    alert(err.message);
  } finally {
    busy(false);
  }
});

// ---------- 내보내기 ----------
function toMarkdown() {
  const sch = schedule();
  const li = (a) => a.map((x) => `- ${x}`).join("\n");
  const { total, per } = ratioStats();
  const a = plan.eduAnalysis;
  return [
    `# ${plan.title}`,
    plan.subtitle && `> ${plan.subtitle}`,
    plan.overview,
    `- 대상: ${input.audience}\n- 총 시간: ${fmtMin(input.totalMinutes)}\n- 진행 방식: ${input.mode}${input.headcount ? `\n- 예상 인원: ${input.headcount}` : ""}`,
    `## 1. 강의 목표\n${li(plan.goals)}`,
    `## 2. 강의 특장점\n${plan.highlights.map((h) => `- **${h.title}**: ${h.desc}`).join("\n")}`,
    `## 3. 기대 효과\n${li(plan.effects)}`,
    `## 4. 수강 요건\n${li(plan.prerequisites)}`,
    `## 5. 강의에 필요한 사항\n${plan.requirements.map((r) => `**${r.category}**\n${li(r.items)}`).join("\n\n")}`,
    `## 6. 유형별 시간 배분\n| 유형 | 목표 | 실제 |\n|---|---|---|\n${TYPES.filter(([k]) => input.ratio[k] > 0 || per[k] > 0).map(([k, ko]) => `| ${ko} | ${input.ratio[k]}% | ${per[k]}분 (${total ? Math.round((per[k] / total) * 100) : 0}%) |`).join("\n")}`,
    `## 7. 세부 타임라인\n| 시간 | 유형 | 세션 | 분 |\n|---|---|---|---|\n${plan.sessions.map((s, i) => `| ${sch[i].from}–${sch[i].to} | ${TYPE_KO[s.type]} | ${s.title} | ${s.minutes} |`).join("\n")}`,
    `## 8. 상세 커리큘럼\n${plan.sessions.map((s, i) => `### ${i + 1}. ${s.title} (${TYPE_KO[s.type]}, ${sch[i].from}–${sch[i].to}, ${s.minutes}분)\n${li(s.content)}${s.method ? `\n\n- 진행: ${s.method}` : ""}${s.materials ? `\n- 자료/도구: ${s.materials}` : ""}`).join("\n\n")}`,
    `## 9. 성과 확인\n${li(plan.assessment)}`,
    a && `## 10. 내일배움카드 훈련과정 분석 (${a.mode === "gap" ? "미개설 내용 제안" : "유사 교육 참고"})\n${a.summary}${a.similarCourses.length ? `\n\n**유사 과정**\n${a.similarCourses.map((c) => `- ${c.title} (${c.org}): ${c.note}`).join("\n")}` : ""}${a.gaps.length ? `\n\n**기존 과정에 없는(부족한) 내용**\n${a.gaps.map((g) => `- **${g.topic}** — 근거: ${g.reason} / 반영: ${g.howReflected}`).join("\n")}` : ""}${a.differentiation ? `\n\n**차별 포인트**: ${a.differentiation}` : ""}`,
  ].filter(Boolean).join("\n\n") + "\n";
}

$("#btnPrint").onclick = () => { document.title = plan.title || "강의 계획서"; print(); };
$("#btnMd").onclick = () => {
  const blob = new Blob([toMarkdown()], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(plan.title || "lecture-plan").replace(/[\\/:*?"<>|\s]+/g, "_")}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$("#btnCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(toMarkdown()); $("#btnCopy").textContent = "복사됨 ✓"; }
  catch { $("#btnCopy").textContent = "복사 실패"; }
  setTimeout(() => ($("#btnCopy").textContent = "MD 복사"), 1500);
};

// ---------- 초기화 ----------
(async function init() {
  buildRatios();
  try {
    cfg = await api("/api/config");
  } catch {}
  $("#status").textContent = `AI ${cfg.ai ? "연결됨" : "키 없음"} · 내일배움카드 ${cfg.edu ? "연결됨" : "키 없음"}`;
  if (!cfg.ai) $("#error").textContent = "CLAUDE_API_KEY 환경변수가 설정되지 않아 생성 기능을 쓸 수 없습니다.";
  const raw = store.get("lp-draft");
  if (raw) {
    try { ({ input, plan } = JSON.parse(raw)); if (plan && input) render(); else plan = null; } catch { plan = null; }
  }
})();
