/* 운영자 화면.
 *
 * 잠금이 두 겹이다.
 *   · 보기 — 로그인한 admin 만. 다른 사람은 403.
 *   · 바꾸기 — admin 이면서 ADMIN_TOKEN 헤더가 맞아야 한다.
 * 두 겹인 이유는 세션 하나가 새는 것과 DB 를 지울 수 있는 것이 같은 무게가 아니기
 * 때문이다. 토큰은 화면에 한 번 넣어 두면 브라우저 세션에만 남고 서버로는 헤더로만 간다.
 * ADMIN_TOKEN 이 비어 있으면 바꾸는 동작은 전부 막힌다 — 빈 값과 빈 헤더가 우연히
 * 같아지는 경로를 남기지 않는다.
 *
 * 화면에는 지우는 버튼이 있지만, 무엇을 지울 수 있는지는 화면이 아니라 db/admin.ts 가
 * 정한다. 상금이 나간 대회는 거기서 거절한다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { layout, esc, jsonForScript } from './views';
import { readJson, sendJson } from './http';
import {
  listTournaments, purgeTournament, openTestTournament, createTournament, revokePrizesAndPurge,
  cancelRunningTournament, searchUsers, grantPoints, userLedger,
} from '../db/admin';
import { listSeasons, updateSeason, closeSeason, seasonPlayers, backfillFirstSeason } from '../db/queries';
import { getConfig, defaultConfig, saveConfig, resetConfig } from '../db/settings';
import {
  getRecurrence, saveRecurrence, nextOccurrence, WEEKDAY_LABEL, MODE_LABEL,
  type RecurMode,
} from '../db/recurrence';
import {
  listNoticesAdmin, createNotice, updateNotice, toggleNotice, deleteNotice,
  parseBody, unparseBody, keepTables, NOTICE_KINDS,
} from '../db/notices';
import type { WebUser } from '../db/queries';

/** 바꾸는 동작의 두 번째 잠금. 토큰이 설정돼 있지 않으면 무조건 잠긴다. */
export function adminTokenOk(req: IncomingMessage): boolean {
  const want = process.env.ADMIN_TOKEN ?? '';
  if (want === '') return false;
  return String(req.headers['x-admin-token'] ?? '') === want;
}

export function isAdmin(user: WebUser | null): boolean {
  return !!user && user.role === 'admin';
}

const num = (n: number) => Number(n || 0).toLocaleString('ko-KR');
/** 자정으로부터의 분을 HH:MM 으로. time 입력이 그대로 읽고 쓰는 형식이다. */
const hhmm = (m: number) =>
  String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const kst = (s: number | null) => s == null ? '—'
  : new Date((s + 9 * 3600) * 1000).toISOString().replace('T', ' ').slice(5, 16);
/* datetime-local 입력이 읽고 쓰는 형식(YYYY-MM-DDTHH:MM). 브라우저는 이 값을 그 사람의
   시간대로 해석하는데, 운영자도 서버 일정도 KST 라 여기서 KST 로 찍어 준다.
   (다른 시간대에서 열면 그 시간대로 읽히므로, 화면에 KST 라고 적어 둔다.) */
const localInput = (s: number) =>
  new Date((s + 9 * 3600) * 1000).toISOString().slice(0, 16);

function tournamentState(t: { started_at: number | null; finished_at: number | null; cancelled_at: number | null }): string {
  if (t.cancelled_at != null) return '취소';
  if (t.finished_at != null) return '종료';
  if (t.started_at != null) return '진행 중';
  return '대기';
}

export function adminPage(user: WebUser): string {
  const ts = listTournaments(30);
  const tokenSet = (process.env.ADMIN_TOKEN ?? '') !== '';

  /* 진행 중인 판은 어느 쪽으로도 손대지 않는다 — 사람이 앉아 카드를 보고 있다. */
  const live2 = (t: { started_at: number | null; finished_at: number | null; cancelled_at: number | null }) =>
    t.started_at != null && t.finished_at == null && t.cancelled_at == null;
  const rows = ts.map(t => {
    return `<tr>
      <td>${t.id}</td>
      <td>${esc(t.date_str)}</td>
      <td>${esc(t.title)}</td>
      <td>${tournamentState(t)}</td>
      <td class="r">${num(t.entries)}</td>
      <td class="r">${num(t.prize_multiplier)}</td>
      <td class="r ${t.paid > 0 ? 'paid' : ''}">${num(t.paid)}P</td>
      <td>${live2(t)
        ? `<span class="ad-no">진행 중</span>`
        : t.paid > 0
          ? `<button type="button" class="ad-revoke danger" data-id="${t.id}"
               data-label="${esc(t.date_str)} · ${esc(t.title)}" data-paid="${t.paid}">상금 회수 후 삭제</button>`
          : `<button type="button" class="ad-del" data-id="${t.id}" data-label="${esc(t.date_str)} · ${esc(t.title)}">지우기</button>`}</td>
    </tr>`;
  }).join('');

  const cfg = getConfig();
  const d = defaultConfig();
  /* 잠그는 것은 "돌고 있는 판"이 있을 때뿐이다. 대기 중인 정규 판까지 막았더니 그 판이
     늘 앉아 있어서 임시 판을 영영 만들 수 없었다 — 지우면 1초 안에 되살아났다. */
  const live = ts.find(live2) ?? null;
  /* 다음 대회가 언제 시작하는지가 새 판을 열 수 있는지를 정한다 — 그 시각을 그대로 적는다.
     "만들 수 없습니다"만 나오면 무엇을 기다려야 하는지 알 수 없다. */
  const nowSec = Math.floor(Date.now() / 1000);
  const pending = ts.filter(t => t.started_at == null && t.finished_at == null && t.cancelled_at == null);
  const nextStart = pending.length
    ? Math.min(...pending.map(t => t.scheduled_start_at)) : null;
  const canMake = !live && (nextStart == null || nextStart - nowSec >= 2 * 3600);
  /* 폼의 기본값은 설정에 적힌 시각의 "다음 차례"다 — 21:00/22:00 이 지났으면 내일 것을 준다.
     매번 손으로 날짜를 고르게 하면 늘 하던 일정을 여는 데도 다섯 번을 눌러야 한다. */
  const nextAt = (minOfDay: number) => {
    const kstNow = nowSec + 9 * 3600;
    const dayStart = Math.floor(kstNow / 86400) * 86400;          // KST 자정
    const at = dayStart + minOfDay * 60 - 9 * 3600;               // 다시 UTC 기준 unix초
    return at > nowSec ? at : at + 86400;
  };
  const defaultStartAt = nextAt(cfg.startMin);
  // 등록은 시작보다 앞서야 한다 — 설정의 간격을 그대로 유지해 하루를 넘겨도 어긋나지 않는다
  const defaultRegAt = defaultStartAt - (cfg.startMin - cfg.regOpenMin) * 60;
  /* 반복 개최 — 규칙과 그 규칙이 가리키는 다음 차례. 켜져 있을 때만 계산한다. */
  const rec = getRecurrence();
  const nextRecur = rec.enabled ? nextOccurrence(rec, nowSec) : null;
  const recText = rec.mode === 'weekly' ? `매주 ${WEEKDAY_LABEL[rec.weekday]}요일`
    : rec.mode === 'monthly' ? `매월 ${rec.day}일`
      : MODE_LABEL[rec.mode];
  const notices = listNoticesAdmin();
  const noticeRows = notices.map(n => `<tr>
      <td class="n">${esc(n.date)}</td>
      <td>${esc(n.kind)}</td>
      <td>${esc(n.title)}</td>
      <td class="ad-id">${esc(n.id)}</td>
      <td>${n.active ? '보임' : '<span class="ad-no">숨김</span>'}</td>
      <td>
        <button type="button" class="nt-edit" data-id="${esc(n.id)}">수정</button>
        <button type="button" class="nt-toggle" data-id="${esc(n.id)}">${n.active ? '숨기기' : '보이기'}</button>
        <button type="button" class="nt-del danger" data-id="${esc(n.id)}" data-title="${esc(n.title)}">지우기</button>
      </td>
    </tr>`).join('');
  /* 수정 화면이 원문처럼 보이도록 본문을 줄 규칙으로 되돌려 함께 내려보낸다.
     화면에서 다시 서버에 물으면 왕복이 한 번 더 생기는데, 글 몇 개라 통째로 보내는 편이 낫다. */
  const noticeBodies: Record<string, unknown> = {};
  for (const n of notices) {
    noticeBodies[n.id] = {
      date: n.date, kind: n.kind, title: n.title, summary: n.summary,
      active: n.active, body: unparseBody(n.sections),
    };
  }
  const seasons = listSeasons();
  const cur = seasons.find(s => s.closed_at == null);
  const seasonRows = seasons.map(s => `<tr>
      <td>시즌 ${s.number}${s.closed_at == null ? ' <span class="ad-live">진행 중</span>' : ''}</td>
      <td>${esc(s.name || '—')}</td>
      <td>${kst(s.started_at)}</td>
      <td>${s.closed_at != null ? kst(s.closed_at) : s.ends_at != null ? kst(s.ends_at) + ' 예정' : '미정'}</td>
      <td class="r">${num(seasonPlayers(s.id))}</td>
      <td>${esc(s.reward || '—')}</td>
    </tr>`).join('');

  /* 왼쪽 메뉴와 화면을 짝지어 둔다. 카드 일곱 개가 세로로 이어져 있어서 아래쪽 것은
     스크롤을 한참 내려야 나왔다 — 하는 일이 다른 카드들이 한 줄에 꿰여 있던 셈이다.

     화면을 갈아끼우되 카드는 전부 그린 채로 두고 보이기만 바꾼다. 이 화면의 동작은
     전부 로드 시점에 getElementById 로 묶이기 때문에, 안 보이는 화면을 아예 안 그리면
     그 묶기가 통째로 끊긴다 — 지금 잘 도는 것을 건드리지 않는 길이 이쪽이다. */
  const MENU: { key: string; label: string; sub: string }[] = [
    { key: 'tour', label: '대회 관리', sub: '개설 · 개최 방식 · 기록' },
    { key: 'season', label: '시즌 / 랭킹', sub: '시즌 설정 · 마감' },
    { key: 'user', label: '유저 / 재화', sub: '조회 · 지급 · 원장' },
    { key: 'sys', label: '공지 / 시스템', sub: '공지 · 운영 토큰' },
  ];
  const nav = MENU.map(m => `
    <button type="button" class="ad-nav-item" data-pane="${m.key}">
      <span class="ad-nav-l">${esc(m.label)}</span>
      <span class="ad-nav-s">${esc(m.sub)}</span>
    </button>`).join('');

  const body = `
  <div class="ad-wrap">
    <div class="ad-top">
      <div>
        <h1 class="ad-h">운영자 화면</h1>
        <p class="ad-sub">${esc(user.username)} 님으로 접속했습니다. 데이터를 바꾸는 동작에는 운영 토큰이 필요합니다.</p>
      </div>
      <!-- 토큰 상태는 어느 화면에 있든 보여야 한다. 없으면 바꾸는 동작이 전부 막히는데,
           그 사실을 [공지/시스템] 화면에 들어가야만 알 수 있으면 늦다. -->
      <div class="ad-tokchip" id="adTokChip"></div>
    </div>

    <div class="ad-shell">
      <nav class="ad-nav" id="adNav">${nav}</nav>
      <div class="ad-panes">

    <section class="ad-card" data-pane="sys">
      <h2>운영 토큰</h2>
      ${tokenSet
        ? `<p class="ad-note">서버에 ADMIN_TOKEN 이 설정돼 있습니다. 아래에 같은 값을 넣어야 바꾸는 동작이 열립니다.</p>`
        : `<p class="ad-warn">서버에 ADMIN_TOKEN 이 설정돼 있지 않습니다. 바꾸는 동작이 전부 막혀 있습니다.
             <code>flyctl secrets set ADMIN_TOKEN=...</code> 로 설정한 뒤 다시 여세요.</p>`}
      <div class="ad-row">
        <input type="password" id="adTok" placeholder="ADMIN_TOKEN" autocomplete="off">
        <button type="button" id="adTokSave">기억</button>
        <span id="adTokState" class="ad-note"></span>
      </div>
    </section>

    <section class="ad-card" data-pane="tour">
      <h2>대회 기록</h2>
      <p class="ad-note">상금이 나간 대회는 <b>[상금 회수 후 삭제]</b>로만 지울 수 있습니다 — 그냥 지우면
        원장에 근거 없는 포인트가 남습니다. 회수는 역방향 원장으로 기록되고,
        <b>이미 다 쓴 사람은 잔액이 음수가 됩니다</b>(지원금으로 갚아 나갈 수 있습니다).
        되돌릴 수 없으니 테스트는 상금 배수 0으로 여세요.</p>
      <p class="ad-note">${rec.enabled
        ? `<b>반복 개최가 켜져 있습니다</b> — ${recText}. 그 밖의 판은 아래에서 직접 여세요.`
        : `<b>대회는 저절로 열리지 않습니다.</b> 아래에서 직접 여셔야 합니다 —
           열지 않으면 그날은 대회가 없습니다. 정기적으로 열려면 [개최 방식]에서 반복을 켜세요.`}</p>
      <div class="ad-sub2">새 대회 <span>${live
        ? '지금 돌고 있는 대회가 있어 만들 수 없습니다 — 끝난 뒤에 열립니다'
        : nextStart == null
          ? '예정된 대회가 없습니다 — 지금 열 수 있습니다'
          : nextStart - nowSec >= 2 * 3600
            ? `다음 대회 ${kst(nextStart)} 시작 — 두 시간 넘게 남아 하나 더 열 수 있습니다`
            : `다음 대회가 ${kst(nextStart)}에 시작해 만들 수 없습니다 —
               한 판이 두 시간까지 갈 수 있어서, 시작까지 두 시간 이상 남았을 때만 열립니다`}</span></div>
      <div class="ad-grid">
        <label>제목<input type="text" id="ncTitle" placeholder="홀덤 프리롤" ${canMake ? '' : 'disabled'}><i>비우면 "홀덤 프리롤"</i></label>
        <label>등록 시작<input type="datetime-local" id="ncRegAt" value="${localInput(defaultRegAt)}" ${canMake ? '' : 'disabled'}><i>KST · 이때부터 신청을 받습니다</i></label>
        <label>대회 시작<input type="datetime-local" id="ncStartAt" value="${localInput(defaultStartAt)}" ${canMake ? '' : 'disabled'}><i>KST · 3명 이상이면 이때 시작</i></label>
        <label>상금 배수<span class="ad-inx"><input type="number" id="ncMult" min="0" step="100" value="${cfg.weekdayMultiplier}" ${canMake ? '' : 'disabled'}><b>×명</b></span><i>0이면 상금 없음(테스트용)</i></label>
      </div>
      <div class="ad-row">
        <button type="button" id="ncMake" class="primary" ${canMake ? '' : 'disabled'}>대회 열기</button>
        <button type="button" id="adTest" ${canMake ? '' : 'disabled'}>테스트 대회 (지금 · 상금 없음)</button>
        ${live
          ? `<button type="button" id="adAbort" class="danger">진행 중 대회 중단</button>`
          : ''}
        <span class="ad-note">칩·블라인드·대기·레이트 레지는 아래 [대회 설정]의 값을 씁니다.</span>
      </div>
      <div class="ad-scroll">
        <table class="ad-tbl">
          <thead><tr><th>id</th><th>날짜</th><th>제목</th><th>상태</th><th class="r">참가</th>
            <th class="r">배수</th><th class="r">지급</th><th></th></tr></thead>
          <tbody id="adTBody">${rows}</tbody>
        </table>
      </div>
    </section>

    <section class="ad-card" data-pane="tour">
      <h2>개최 방식</h2>
      <p class="ad-note">반복을 켜면 시작 <b>12시간 전</b>에 다음 판이 자동으로 만들어집니다.
        시각·칩·상금은 아래 [대회 설정]의 값을 그대로 씁니다 — 여기서는 <b>어느 날 여는지</b>만 정합니다.
        이미 돌고 있는 판이 있으면 만들지 않고 끝난 뒤에 따라잡습니다.
        <b>지운 판은 되살아나지 않습니다</b> — 만든 차례를 따로 적어 두기 때문입니다.</p>
      <div class="ad-grid">
        <label>자동 개최<select id="rcEnabled">
          <option value="0" ${rec.enabled ? '' : 'selected'}>끔 (수동으로만)</option>
          <option value="1" ${rec.enabled ? 'selected' : ''}>켬</option>
        </select><i>마스터 스위치 — 끄면 아래 설정과 무관하게 아무것도 안 만듭니다</i></label>
        <label>반복 주기<select id="rcMode">
          <option value="manual" ${rec.mode === 'manual' ? 'selected' : ''}>수동 개최</option>
          <option value="daily" ${rec.mode === 'daily' ? 'selected' : ''}>매일</option>
          <option value="weekly" ${rec.mode === 'weekly' ? 'selected' : ''}>매주</option>
          <option value="monthly" ${rec.mode === 'monthly' ? 'selected' : ''}>매월</option>
        </select><i>매주·매월이면 아래 칸이 쓰입니다</i></label>
        <label>요일 (매주)<select id="rcWeekday">
          ${WEEKDAY_LABEL.map((w, i) =>
            `<option value="${i}" ${rec.weekday === i ? 'selected' : ''}>${w}요일</option>`).join('')}
        </select><i>매주일 때만</i></label>
        <label>날짜 (매월)<span class="ad-inx"><input type="number" id="rcDay" min="1" max="31" value="${rec.day}"><b>일</b></span><i>그 달에 없는 날이면 건너뜁니다</i></label>
      </div>
      <div class="ad-row">
        <button type="button" id="rcSave" class="primary">개최 방식 저장</button>
        <span class="ad-note">${rec.enabled && nextRecur
          ? `다음 자동 개최 — ${kst(nextRecur.startAt)} 시작 (등록 ${kst(nextRecur.regOpenAt)})`
          : '지금은 자동으로 열리지 않습니다'}</span>
      </div>
    </section>

    <section class="ad-card" data-pane="tour">
      <h2>대회 설정</h2>
      <p class="ad-note">바꾼 값은 <b>다음에 만들어질 대회부터</b> 적용됩니다. 진행 중인 대회는 만들어질 때의
        값을 자기 행에 갖고 있어서 흔들리지 않습니다 — 블라인드가 갑자기 뛰거나 늦게 온 사람만
        다른 스택을 받는 일이 없습니다. 순위별 분배(ITM 비율)는 검증된 산식이라 고정입니다.</p>
      <div class="ad-sub2">일정</div>
      <div class="ad-grid">
        <label>등록 시작<input type="time" id="cfRegAt" value="${hhmm(cfg.regOpenMin)}"><i>KST</i></label>
        <label>대회 시작<input type="time" id="cfStartAt" value="${hhmm(cfg.startMin)}"><i>KST</i></label>
        <label>최소 인원 대기<span class="ad-inx"><input type="number" id="cfGrace" min="1" value="${cfg.graceMin}"><b>분</b></span><i>시작 시각 이후 · 지금 마감 ${hhmm(cfg.startMin + cfg.graceMin)}</i></label>
        <label>레이트 레지<span class="ad-inx"><input type="number" id="cfLateReg" min="1" value="${cfg.lateRegMin}"><b>분</b></span><i>실제 시작 이후</i></label>
      </div>
      <div class="ad-sub2">칩과 블라인드</div>
      <div class="ad-grid">
        <label>시작 칩<span class="ad-inx"><input type="number" id="cfStack" min="1" step="500" value="${cfg.startingStack}"><b>칩</b></span><i></i></label>
        <label>블라인드 주기<span class="ad-inx"><input type="number" id="cfLevel" min="1" value="${cfg.levelMin}"><b>분</b></span><i>레벨 11까지 ${cfg.levelMin * 10}분</i></label>
      </div>
      <div class="ad-sub2">상금 풀 <span>순위별 분배(ITM 비율)는 고정입니다 — 여기서는 풀의 크기만 정합니다</span></div>
      <div class="ad-grid">
        <label>평일 배수<span class="ad-inx"><input type="number" id="cfWd" min="0" step="100" value="${cfg.weekdayMultiplier}"><b>×명</b></span><i>5명이면 ${num(cfg.weekdayMultiplier * 5)}P</i></label>
        <label>주말 배수<span class="ad-inx"><input type="number" id="cfWe" min="0" step="100" value="${cfg.weekendMultiplier}"><b>×명</b></span><i>5명이면 ${num(cfg.weekendMultiplier * 5)}P</i></label>
        <label>고정 상금 풀<span class="ad-inx"><input type="number" id="cfFixed" min="0" step="1000" value="${cfg.prizeFixed}"><b>P</b></span><i>0이면 인원 × 배수를 씁니다</i></label>
      </div>
      <div class="ad-row">
        <button type="button" id="cfSave" class="primary">설정 저장</button>
        <button type="button" id="cfReset">기본값으로</button>
        <span class="ad-note">기본값 — 등록 ${hhmm(d.regOpenMin)} · 시작 ${hhmm(d.startMin)} · 대기 ${d.graceMin}분 ·
          레이트 ${d.lateRegMin}분 · 칩 ${num(d.startingStack)} · 블라인드 ${d.levelMin}분</span>
      </div>
    </section>

    <section class="ad-card" data-pane="season">
      <h2>시즌</h2>
      <p class="ad-note">시즌을 닫으면 <b>그 순간의 잔액이 성적표로 찍히고</b>, 전원 잔액이 0으로
        초기화되며 다음 시즌이 열립니다. 게임별 전적은 지우지 않습니다 — 시즌이 열쇠에 들어 있어
        새 시즌은 저절로 비어 있고 지난 시즌 기록은 그대로 남습니다.
        지원금 쿨다운도 함께 풀립니다(0에서 시작하므로 바로 받을 수 있어야 합니다).</p>
      <div class="ad-scroll"><table class="ad-tbl">
        <thead><tr><th>시즌</th><th>이름</th><th>시작</th><th>종료</th><th class="r">참여</th><th>보상</th></tr></thead>
        <tbody>${seasonRows}</tbody>
      </table></div>
      <div class="ad-row" style="margin-top:12px">
        <input type="text" id="adSName" placeholder="현재 시즌 이름 (예: 오픈베타)" autocomplete="off">
        <input type="text" id="adSReward" placeholder="보상 안내" autocomplete="off">
        <input type="date" id="adSEnd">
        <button type="button" id="adSSave">안내 저장</button>
      </div>
      <div class="ad-row">
        <button type="button" id="adSFill">지난 기록을 첫 시즌으로 가져오기</button>
        <span class="ad-note">시즌 표를 만들기 전의 판은 시즌 장부에 없습니다. 첫 시즌의 범위가
          "지금까지 전부"이므로 통산 기록을 그대로 옮깁니다. 더하는 것이 아니라 맞추는 것이라
          여러 번 눌러도 결과가 같습니다.</span>
      </div>
      <div class="ad-row">
        <button type="button" id="adSClose" class="danger">시즌 종료 · 다음 시즌 열기</button>
        <span class="ad-note">되돌릴 수 없습니다.</span>
      </div>
    </section>

    <section class="ad-card" data-pane="sys">
      <h2>공지사항</h2>
      <p class="ad-note">아이디는 주소에 그대로 쓰입니다 — 한 번 정하면 바꾸지 마세요. 링크를 공유한
        사람의 주소가 깨집니다. 그래서 <b>지우기와 별개로 숨김</b>을 뒀습니다. 숨기면 목록에도 상세에도
        안 나오지만 글은 남아 있어 언제든 되돌릴 수 있습니다.</p>
      <div class="ad-scroll"><table class="ad-tbl">
        <thead><tr><th>날짜</th><th>분류</th><th>제목</th><th>아이디</th><th>상태</th><th></th></tr></thead>
        <tbody id="ntBody">${noticeRows}</tbody>
      </table></div>
      <div class="ad-row" style="margin-top:12px">
        <button type="button" id="ntNew">새 글 쓰기</button>
        <span class="ad-note">본문 규칙 — <code>## 제목</code>은 절, <code>- 항목</code>은 목록, 나머지 줄은 문단입니다.</span>
      </div>
      <div id="ntForm" hidden>
        <div class="ad-grid">
          <label>아이디 (주소)<input type="text" id="ntId" placeholder="holdem-update-1"><i>영소문자·숫자·하이픈</i></label>
          <label>날짜<input type="date" id="ntDate"><i>KST</i></label>
          <label>분류<select id="ntKind">${NOTICE_KINDS.map(k => `<option>${esc(k)}</option>`).join('')}</select><i></i></label>
          <label>보이기<select id="ntActive"><option value="1">보임</option><option value="0">숨김</option></select><i></i></label>
        </div>
        <div class="ad-row"><input type="text" id="ntTitle" placeholder="제목" style="flex:1;min-width:260px"></div>
        <div class="ad-row"><input type="text" id="ntSummary" placeholder="목록에 한 줄로 보이는 요약" style="flex:1;min-width:260px"></div>
        <textarea id="ntBodyText" class="ad-ta" rows="12" placeholder="## 바뀐 점&#10;- 블라인드 주기를 8분으로 되돌렸습니다&#10;자세한 내용은 아래를 보세요."></textarea>
        <div class="ad-row">
          <button type="button" id="ntSave">저장</button>
          <button type="button" id="ntCancel">취소</button>
          <span class="ad-note" id="ntMode"></span>
        </div>
      </div>
    </section>

    <section class="ad-card" data-pane="user">
      <h2>포인트</h2>
      <p class="ad-note">지급·차감은 원장에 남습니다. 잔액을 음수로 만드는 차감은 거절됩니다.</p>
      <div class="ad-row">
        <input type="search" id="adQ" placeholder="닉네임 또는 아이디" autocomplete="off">
        <button type="button" id="adFind">찾기</button>
      </div>
      <div class="ad-scroll"><table class="ad-tbl">
        <thead><tr><th>닉네임</th><th>아이디</th><th class="r">잔액</th><th>권한</th><th></th></tr></thead>
        <tbody id="adUBody"><tr><td colspan="5" class="ad-note">검색해 주세요.</td></tr></tbody>
      </table></div>
    </section>

    <section class="ad-card" data-pane="user">
      <h2>원장 <span class="ad-sub2-in" id="adLName"></span></h2>
      <p class="ad-note">잔액은 이 표의 누적합과 같습니다 — 그것이 이 서비스의 경제 규칙이고,
        감사가 매번 확인합니다. 어긋나 보이면 그건 표시가 아니라 사고입니다.
        위 목록에서 <b>[원장]</b>을 누르면 그 사람의 최근 50건이 나옵니다.</p>
      <div class="ad-scroll"><table class="ad-tbl">
        <thead><tr><th>시각</th><th class="r">증감</th><th>사유</th><th class="r">이후 잔액</th></tr></thead>
        <tbody id="adLBody"><tr><td colspan="4" class="ad-note">유저를 고르면 나옵니다.</td></tr></tbody>
      </table></div>
    </section>

      </div>
    </div>
  </div>

  <dialog id="adConfirm" class="ad-dlg">
    <h3 id="adCTitle">확인</h3>
    <p id="adCBody"></p>
    <div class="ad-row">
      <button type="button" id="adCNo">취소</button>
      <button type="button" id="adCYes" class="danger">실행</button>
    </div>
  </dialog>

  <script>
  (function(){
    /* ── 왼쪽 메뉴 ────────────────────────────────────────────────
       카드는 전부 그려져 있고 여기서 보이기만 바꾼다. 고른 화면은 주소(#)에 남긴다 —
       새로고침하거나 저장 뒤 location.reload() 가 걸려도 보던 자리로 돌아온다.
       이 화면은 저장할 때마다 새로고침하므로, 이게 없으면 매번 첫 화면으로 튕긴다. */
    var PANES = ['tour', 'season', 'user', 'sys'];
    var navEl = document.getElementById('adNav');
    function showPane(key){
      if (PANES.indexOf(key) < 0) key = PANES[0];
      var cards = document.querySelectorAll('.ad-card[data-pane]');
      for (var i = 0; i < cards.length; i++) {
        cards[i].hidden = cards[i].getAttribute('data-pane') !== key;
      }
      var items = navEl.querySelectorAll('.ad-nav-item');
      for (var j = 0; j < items.length; j++) {
        var on = items[j].getAttribute('data-pane') === key;
        items[j].classList.toggle('on', on);
        items[j].setAttribute('aria-current', on ? 'page' : 'false');
      }
    }
    navEl.addEventListener('click', function(ev){
      var b = ev.target.closest ? ev.target.closest('.ad-nav-item') : null;
      if (!b) return;
      var key = b.getAttribute('data-pane');
      /* 주소만 바꾸고 hashchange 가 실제 전환을 맡는다 — 뒤로 가기로도 같은 길을 지난다 */
      if (location.hash.slice(1) === key) showPane(key); else location.hash = key;
    });
    window.addEventListener('hashchange', function(){ showPane(location.hash.slice(1)); });
    showPane(location.hash.slice(1));

    var tokKey = 'od_admin_token';
    var tokEl = document.getElementById('adTok');
    var tokState = document.getElementById('adTokState');
    var tokChip = document.getElementById('adTokChip');
    function tok(){ try { return sessionStorage.getItem(tokKey) || ''; } catch (e) { return ''; } }
    function paintTok(){
      var has = !!tok();
      tokState.textContent = has ? '기억됨 (이 탭에만)' : '없음 — 바꾸는 동작이 막힙니다';
      /* 어느 화면에 있든 보이는 자리. 없으면 눌러서 곧장 그 카드로 갈 수 있게 한다 */
      tokChip.className = 'ad-tokchip' + (has ? ' on' : '');
      tokChip.innerHTML = has
        ? '<span class="dot"><\\/span>운영 토큰 기억됨'
        : '<a href="#sys"><span class="dot"><\\/span>운영 토큰 없음 — 넣기<\\/a>';
    }
    document.getElementById('adTokSave').addEventListener('click', function(){
      try { sessionStorage.setItem(tokKey, tokEl.value); } catch (e) { /* 저장 못 하면 이번만 */ }
      tokEl.value = '';
      paintTok();
    });
    paintTok();

    /* 되돌릴 수 없는 동작은 반드시 이 문을 지나간다. 버튼 하나로 바로 실행되는 자리를
       만들지 않는다 — 운영자가 목록을 훑다가 잘못 누르는 것이 실제로 일어나는 사고다. */
    var dlg = document.getElementById('adConfirm');
    var pending = null;
    function confirmThen(title, body, run){
      document.getElementById('adCTitle').textContent = title;
      document.getElementById('adCBody').textContent = body;
      pending = run;
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    }
    document.getElementById('adCNo').addEventListener('click', function(){
      pending = null; if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
    });
    document.getElementById('adCYes').addEventListener('click', function(){
      var run = pending; pending = null;
      if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
      if (run) run();
    });

    function post(url, body){
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': tok() },
        body: JSON.stringify(body || {}),
      }).then(function(r){ return r.json().then(function(d){ return { status: r.status, d: d }; }); });
    }
    function shout(r){
      if (r.status === 200 && r.d && r.d.ok) return true;
      var msg = (r.d && (r.d.error || r.d.message)) || ('실패 (' + r.status + ')');
      if (r.status === 403) msg = '운영 토큰이 맞지 않습니다.';
      alert(msg);
      return false;
    }

    var ncMake = document.getElementById('ncMake');
    if (ncMake) ncMake.addEventListener('click', function(){
      /* datetime-local 은 'YYYY-MM-DDTHH:MM' 을 준다. 브라우저의 시간대로 해석되므로
         Date 에 그대로 넘긴다 — 운영자도 KST 라 화면에 적힌 시각 그대로 들어간다. */
      function at(id){
        var v = String(document.getElementById(id).value || '');
        var ms = v ? new Date(v).getTime() : NaN;
        return isFinite(ms) ? Math.floor(ms / 1000) : NaN;
      }
      var body = {
        title: document.getElementById('ncTitle').value,
        regOpenAt: at('ncRegAt'),
        startAt: at('ncStartAt'),
        prizeMultiplier: Math.floor(Number(document.getElementById('ncMult').value)),
      };
      if (!isFinite(body.regOpenAt) || !isFinite(body.startAt)) { alert('시각을 넣어 주세요.'); return; }
      if (body.regOpenAt > body.startAt) {
        alert('등록 시작이 대회 시작보다 늦습니다 — 아무도 신청할 수 없는 대회가 됩니다.'); return;
      }
      if (!isFinite(body.prizeMultiplier) || body.prizeMultiplier < 0) { alert('상금 배수를 확인해 주세요.'); return; }
      var fmt = function(sec){
        var d = new Date(sec * 1000);
        return (d.getMonth() + 1) + '/' + d.getDate() + ' '
          + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      };
      confirmThen('대회를 열까요?',
        (body.title || '홀덤 프리롤') + ' — 등록 ' + fmt(body.regOpenAt)
        + ' · 시작 ' + fmt(body.startAt) + '.'
        + (body.prizeMultiplier === 0 ? ' 상금 배수 0이라 포인트는 나가지 않습니다.' : ''),
        function(){ post('/api/admin/tournament/create', body)
          .then(function(r){ if (shout(r)) location.reload(); }); });
    });

    document.getElementById('adTest').addEventListener('click', function(){
      confirmThen('테스트 대회를 열까요?',
        '지금 등록을 열고 바로 시작하는 상금 없는 대회를 만듭니다. 끝나면 이 표에서 지울 수 있습니다.',
        function(){ post('/api/admin/tournament/test', {}).then(function(r){ if (shout(r)) location.reload(); }); });
    });
    /* 막힌 판을 푸는 유일한 길이다 — 날짜로 밀려나던 것도, 부팅 취소도 이제 없다.
       버튼은 실제로 돌고 있을 때만 그려지므로 없을 수 있다. */
    var abort = document.getElementById('adAbort');
    if (abort) abort.addEventListener('click', function(){
      confirmThen('진행 중인 대회를 중단할까요?',
        '앉아 있는 사람들의 판이 그 자리에서 끝나고 상금은 나가지 않습니다. 기록은 남습니다. 되돌릴 수 없습니다.',
        function(){ post('/api/admin/tournament/abort', {}).then(function(r){ if (shout(r)) location.reload(); }); });
    });

    document.getElementById('adTBody').addEventListener('click', function(ev){
      var b = ev.target.closest ? ev.target.closest('.ad-del') : null;
      if (b) {
        confirmThen('대회 기록을 지울까요?',
          b.getAttribute('data-label') + ' — 이 대회의 판·좌석·참가 기록이 모두 사라집니다. 되돌릴 수 없습니다.',
          function(){
            post('/api/admin/tournament/purge', { id: Number(b.getAttribute('data-id')) })
              .then(function(r){ if (shout(r)) location.reload(); });
          });
        return;
      }
      /* 상금 회수는 남의 포인트를 도로 가져오는 일이라 확인을 한 겹 더 둔다.
         숫자를 직접 받아 적게 하는 이유: 목록을 훑다가 잘못 누르는 것과, 얼마를 회수하는지
         읽지 않고 확인을 누르는 것은 다른 사고인데 확인 모달 하나로는 둘 다 못 막는다. */
      var rv = ev.target.closest ? ev.target.closest('.ad-revoke') : null;
      if (!rv) return;
      var paid = rv.getAttribute('data-paid');
      var typed = prompt(rv.getAttribute('data-label') + '\\n\\n'
        + '이 대회가 지급한 ' + num(Number(paid)) + 'P 를 참가자에게서 도로 가져옵니다.\\n'
        + '이미 다 쓴 사람은 잔액이 음수가 됩니다(지원금으로 갚아 나갈 수 있습니다).\\n\\n'
        + '되돌릴 수 없습니다. 계속하려면 회수 금액 ' + paid + ' 을 그대로 적어 주세요.', '');
      if (typed == null) return;
      if (String(typed).trim() !== String(paid)) { alert('금액이 달라 취소했습니다.'); return; }
      post('/api/admin/tournament/revoke', { id: Number(rv.getAttribute('data-id')) })
        .then(function(r){
          if (shout(r)) { alert(num(r.d.revoked) + 'P 를 ' + r.d.users + '명에게서 회수했습니다.'); location.reload(); }
        });
    });

    document.getElementById('adSSave').addEventListener('click', function(){
      var d = document.getElementById('adSEnd').value;
      post('/api/admin/season/update', {
        name: document.getElementById('adSName').value,
        reward: document.getElementById('adSReward').value,
        // 날짜만 받고 그날 끝으로 본다 — 시각까지 고르게 하면 KST 환산 실수가 늘어난다
        endsAt: d ? Math.floor(new Date(d + 'T23:59:59+09:00').getTime() / 1000) : null,
      }).then(function(r){ if (shout(r)) location.reload(); });
    });

    /* ── 공지 ────────────────────────────────────────────────────
       수정은 새 글 쓰기와 같은 폼을 쓴다. 다른 점은 아이디를 잠근다는 것 하나다 —
       아이디가 곧 주소라, 고치면 공유된 링크가 깨진다. */
    var ntBodies = ${jsonForScript(noticeBodies)};
    var ntEditing = null;
    var ntForm = document.getElementById('ntForm');
    function ntShow(id){
      ntEditing = id;
      ntForm.hidden = false;
      var v = id ? ntBodies[id] : null;
      document.getElementById('ntId').value = id || '';
      document.getElementById('ntId').disabled = !!id;
      document.getElementById('ntDate').value = v ? v.date : new Date().toISOString().slice(0, 10);
      document.getElementById('ntKind').value = v ? v.kind : '업데이트';
      document.getElementById('ntActive').value = v ? (v.active ? '1' : '0') : '1';
      document.getElementById('ntTitle').value = v ? v.title : '';
      document.getElementById('ntSummary').value = v ? v.summary : '';
      document.getElementById('ntBodyText').value = v ? v.body : '';
      document.getElementById('ntMode').textContent = id ? ('수정 중 — ' + id) : '새 글';
      ntForm.scrollIntoView({ block: 'nearest' });
    }
    document.getElementById('ntNew').addEventListener('click', function(){ ntShow(null); });
    document.getElementById('ntCancel').addEventListener('click', function(){
      ntForm.hidden = true; ntEditing = null;
    });
    document.getElementById('ntSave').addEventListener('click', function(){
      var body = {
        id: document.getElementById('ntId').value.trim(),
        date: document.getElementById('ntDate').value,
        kind: document.getElementById('ntKind').value,
        title: document.getElementById('ntTitle').value,
        summary: document.getElementById('ntSummary').value,
        body: document.getElementById('ntBodyText').value,
        active: document.getElementById('ntActive').value === '1',
      };
      if (!body.id) { alert('아이디를 넣어 주세요.'); return; }
      if (!body.title.trim()) { alert('제목을 넣어 주세요.'); return; }
      if (!body.body.trim()) { alert('본문을 넣어 주세요.'); return; }
      var url = ntEditing ? '/api/admin/notice/update' : '/api/admin/notice/create';
      post(url, body).then(function(r){ if (shout(r)) location.reload(); });
    });
    document.getElementById('ntBody').addEventListener('click', function(ev){
      var t = ev.target.closest ? ev.target : null;
      if (!t) return;
      var id = t.getAttribute('data-id');
      if (!id) return;
      if (t.classList.contains('nt-edit')) { ntShow(id); return; }
      if (t.classList.contains('nt-toggle')) {
        post('/api/admin/notice/toggle', { id: id })
          .then(function(r){ if (shout(r)) location.reload(); });
        return;
      }
      if (t.classList.contains('nt-del')) {
        confirmThen('공지를 지울까요?',
          t.getAttribute('data-title') + ' — 되돌릴 수 없습니다. 잠시 내리는 것이라면 [숨기기]를 쓰세요.',
          function(){ post('/api/admin/notice/delete', { id: id })
            .then(function(r){ if (shout(r)) location.reload(); }); });
      }
    });

    /* 저장 전에 화면에서도 한 번 본다. 서버가 마지막 문이지만, 눌러 보고 나서야
       "시간 순서가 틀렸다"는 말을 듣는 것보다 미리 막는 편이 낫다. */
    function cfNum(id){ return Math.floor(Number(document.getElementById(id).value)); }
    /* time 입력은 'HH:MM' 문자열이다. 자정으로부터의 분으로 바꿔 보낸다 —
       서버도 DB도 분으로 다루므로 여기서 한 번만 변환한다. */
    /* time 입력의 value 는 표시가 "오후 04:00"이어도 항상 24시간 "HH:MM"이다.
       정규식으로 읽지 않는다 — 이 코드는 템플릿 문자열 안에 있어서 \\d 같은 이스케이프가
       한 겹 더 먹힌다. 실제로 \\d 가 d 로 바뀌어 리터럴 'd'를 찾다가 항상 NaN 이 났다.
       콜론으로 자르고 숫자로 바꾸면 그런 함정이 없다. */
    function cfClock(id){
      var parts = String(document.getElementById(id).value || '').split(':');
      if (parts.length !== 2) return NaN;
      var h = Number(parts[0]), m = Number(parts[1]);
      if (!isFinite(h) || !isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return NaN;
      return h * 60 + m;
    }
    function cfRead(){
      return {
        regOpenMin: cfClock('cfRegAt'), startMin: cfClock('cfStartAt'),
        graceMin: cfNum('cfGrace'), lateRegMin: cfNum('cfLateReg'),
        startingStack: cfNum('cfStack'), levelMin: cfNum('cfLevel'),
        weekdayMultiplier: cfNum('cfWd'), weekendMultiplier: cfNum('cfWe'),
        prizeFixed: cfNum('cfFixed'),
      };
    }
    function cfCheck(c){
      var bad = [];
      // 어느 칸이 잘못됐는지 적는다 — 같은 문장이 여러 줄 뜨면 무엇을 고쳐야 할지 알 수 없다
      var LABEL = { regOpenMin: '등록 시작', startMin: '대회 시작', graceMin: '최소 인원 대기',
        lateRegMin: '레이트 레지', startingStack: '시작 칩', levelMin: '블라인드 주기',
        weekdayMultiplier: '평일 배수', weekendMultiplier: '주말 배수', prizeFixed: '고정 상금 풀' };
      for (var k in c) if (!isFinite(c[k])) bad.push((LABEL[k] || k) + ' 값을 확인해 주세요');
      /* 분 단위로 바뀐 뒤에도 시(regOpenHour/startHour)를 보고 있었다 — 없는 값이라
         비교가 전부 false 가 되어 화면 검증이 조용히 아무것도 안 했다. 서버가 막아 주긴
         하지만, 저장을 눌러 봐야 알게 되는 것이 이 검사를 둔 이유를 지운다. */
      if (isFinite(c.regOpenMin) && isFinite(c.startMin) && c.regOpenMin >= c.startMin) {
        bad.push('등록 시작은 대회 시작보다 앞서야 합니다');
      }
      if (isFinite(c.startMin) && c.startMin + c.graceMin > 24 * 60) {
        bad.push('대기 마감이 자정을 넘습니다');
      }
      if (c.graceMin <= 0 || c.lateRegMin <= 0 || c.startingStack <= 0 || c.levelMin <= 0) {
        bad.push('대기·레이트 레지·칩·블라인드 주기는 1 이상이어야 합니다');
      }
      if (c.weekdayMultiplier < 0 || c.weekendMultiplier < 0 || c.prizeFixed < 0) {
        bad.push('배수와 고정 상금은 0 이상이어야 합니다');
      }
      return bad;
    }
    document.getElementById('cfSave').addEventListener('click', function(){
      var c = cfRead();
      var bad = cfCheck(c);
      if (bad.length) { alert(bad.join('\\n')); return; }
      confirmThen('대회 설정을 저장할까요?',
        '다음에 만들어질 대회부터 적용됩니다. 진행 중인 대회는 바뀌지 않습니다.',
        function(){ post('/api/admin/config', c).then(function(r){ if (shout(r)) location.reload(); }); });
    });
    /* 개최 방식. 켰는데 주기가 '수동'이면 아무 일도 안 일어난다 — 서버도 막지만
       그 조합을 저장해 두고 기다리게 두면 운영자는 켰다고 믿는다. 여기서 먼저 말한다. */
    document.getElementById('rcSave').addEventListener('click', function(){
      var rcSel = document.getElementById('rcWeekday');
      var body = {
        enabled: document.getElementById('rcEnabled').value === '1',
        mode: document.getElementById('rcMode').value,
        weekday: Number(document.getElementById('rcWeekday').value),
        day: Math.floor(Number(document.getElementById('rcDay').value)),
      };
      if (body.enabled && body.mode === 'manual') {
        alert('자동 개최를 켜려면 반복 주기를 매일·매주·매월 중에서 골라 주세요.');
        return;
      }
      var what = !body.enabled ? '자동 개최를 끕니다 — 앞으로는 직접 여셔야 합니다.'
        : body.mode === 'weekly' ? '매주 ' + rcSel.options[rcSel.selectedIndex].text + '에 자동으로 열립니다.'
        : body.mode === 'monthly' ? '매월 ' + body.day + '일에 자동으로 열립니다.'
        : '매일 자동으로 열립니다.';
      confirmThen('개최 방식을 저장할까요?',
        what + ' 시각과 칩·상금은 [대회 설정]의 값을 씁니다. 이미 만들어진 대회는 바뀌지 않습니다.',
        function(){ post('/api/admin/recurrence', body).then(function(r){ if (shout(r)) location.reload(); }); });
    });
    document.getElementById('cfReset').addEventListener('click', function(){
      confirmThen('기본값으로 되돌릴까요?',
        '저장된 설정을 지워 코드의 기본값을 쓰게 합니다. 다음 대회부터 적용됩니다.',
        function(){ post('/api/admin/config/reset', {}).then(function(r){ if (shout(r)) location.reload(); }); });
    });

    document.getElementById('adSFill').addEventListener('click', function(){
      confirmThen('지난 기록을 첫 시즌으로 가져올까요?',
        '통산 기록(game_stats)을 첫 시즌의 시즌 장부에 맞춰 넣습니다. 더하는 것이 아니라 맞추는 것이라 여러 번 눌러도 같습니다.',
        function(){
          post('/api/admin/season/backfill', {})
            .then(function(r){ if (shout(r)) { alert(r.d.rows + '행을 시즌 장부에 넣었습니다.'); location.reload(); } });
        });
    });

    document.getElementById('adSClose').addEventListener('click', function(){
      confirmThen('시즌을 끝낼까요?',
        '지금 잔액이 성적표로 찍히고, 전원 잔액이 0으로 초기화되며 다음 시즌이 열립니다. '
        + '게임별 전적은 시즌별로 남습니다. 되돌릴 수 없습니다.',
        function(){
          post('/api/admin/season/close', {})
            .then(function(r){ if (shout(r)) { alert('시즌 ' + r.d.closed + ' 종료 · '
              + r.d.ranked + '명 기록 · 시즌 ' + r.d.nextNumber + ' 시작'); location.reload(); } });
        });
    });

    var uBody = document.getElementById('adUBody');
    function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function num(n){ return Number(n || 0).toLocaleString('ko-KR'); }
    function find(){
      var q = document.getElementById('adQ').value;
      fetch('/api/admin/users?q=' + encodeURIComponent(q))
        .then(function(r){ return r.json(); })
        .then(function(d){
          var rows = (d && d.users) || [];
          if (!rows.length) { uBody.innerHTML = '<tr><td colspan="5" class="ad-note">없습니다.<\\/td><\\/tr>'; return; }
          uBody.innerHTML = rows.map(function(u){
            return '<tr><td>' + esc(u.username) + '<\\/td>'
              + '<td class="ad-id">' + esc(u.id) + '<\\/td>'
              + '<td class="r">' + num(u.balance) + 'P<\\/td>'
              + '<td>' + esc(u.role || 'member') + '<\\/td>'
              + '<td><button type="button" class="ad-give" data-id="' + esc(u.id) + '" data-name="'
              + esc(u.username) + '">포인트<\\/button>'
              + '<button type="button" class="ad-led" data-id="' + esc(u.id) + '" data-name="'
              + esc(u.username) + '">원장<\\/button><\\/td><\\/tr>';
          }).join('');
        });
    }
    document.getElementById('adFind').addEventListener('click', find);
    document.getElementById('adQ').addEventListener('keydown', function(e){ if (e.key === 'Enter') find(); });

    /* 원장 보기 — 읽기만 한다. 방금 한 조치가 제대로 남았는지 확인하는 자리다. */
    var lBody = document.getElementById('adLBody');
    var lName = document.getElementById('adLName');
    function when(sec){
      return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sec * 1000));
    }
    function loadLedger(id, name){
      lName.textContent = '— ' + name;
      lBody.innerHTML = '<tr><td colspan="4" class="ad-note">불러오는 중…<\\/td><\\/tr>';
      fetch('/api/admin/ledger?id=' + encodeURIComponent(id))
        .then(function(r){ return r.json(); })
        .then(function(d){
          var rows = (d && d.rows) || [];
          if (!rows.length) { lBody.innerHTML = '<tr><td colspan="4" class="ad-note">기록이 없습니다.<\\/td><\\/tr>'; return; }
          lBody.innerHTML = rows.map(function(x){
            var sign = x.delta > 0 ? 'pos' : 'neg';
            return '<tr><td class="n">' + esc(when(x.created_at)) + '<\\/td>'
              + '<td class="r ' + sign + '">' + (x.delta > 0 ? '+' : '') + num(x.delta) + 'P<\\/td>'
              + '<td class="ad-rsn">' + esc(x.reason) + '<\\/td>'
              + '<td class="r">' + num(x.balance_after) + 'P<\\/td><\\/tr>';
          }).join('');
        })
        .catch(function(){ lBody.innerHTML = '<tr><td colspan="4" class="ad-note">불러오지 못했습니다.<\\/td><\\/tr>'; });
    }

    uBody.addEventListener('click', function(ev){
      var led = ev.target.closest ? ev.target.closest('.ad-led') : null;
      if (led) { loadLedger(led.getAttribute('data-id'), led.getAttribute('data-name')); return; }
      var b = ev.target.closest ? ev.target.closest('.ad-give') : null;
      if (!b) return;
      var name = b.getAttribute('data-name'), id = b.getAttribute('data-id');
      var raw = prompt(name + ' 님에게 줄 포인트 (빼려면 음수)', '');
      if (raw == null || raw === '') return;
      var amount = Math.floor(Number(raw));
      if (!isFinite(amount) || amount === 0) { alert('숫자를 넣어 주세요.'); return; }
      var memo = prompt('사유 (원장에 남습니다)', '운영 지급') || '';
      confirmThen(amount > 0 ? '포인트를 지급할까요?' : '포인트를 차감할까요?',
        name + ' 님에게 ' + num(amount) + 'P. 사유: ' + memo,
        function(){
          post('/api/admin/points', { userId: id, delta: amount, memo: memo })
            .then(function(r){
              if (!shout(r)) return;
              alert('잔액 ' + num(r.d.balance) + 'P');
              find();
              // 방금 준 것이 원장에 남았는지 그 자리에서 보인다
              loadLedger(id, name);
            });
        });
    });

    void ${jsonForScript(user.id)};
  })();
  </script>`;
  return layout('운영자 화면', 'lobby', body);
}

/* ── API ─────────────────────────────────────────────────────────── */

export async function handleAdminUsers(
  _req: IncomingMessage, res: ServerResponse, q: string
): Promise<void> {
  return sendJson(res, 200, { ok: true, users: searchUsers(q) });
}

export async function handleAdminLedger(
  _req: IncomingMessage, res: ServerResponse, id: string
): Promise<void> {
  if (id.trim() === '') return sendJson(res, 400, { error: '아이디가 필요합니다' });
  return sendJson(res, 200, { ok: true, rows: userLedger(id) });
}

export async function handleAdminPoints(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as { userId?: unknown; delta?: unknown; memo?: unknown } | null;
  const userId = String(b?.userId ?? '');
  const r = grantPoints(userId, Number(b?.delta ?? 0), String(b?.memo ?? ''));
  if (!r.ok) {
    const msg = r.error === 'no_user' ? '없는 사용자입니다'
      : r.error === 'bad_amount' ? '금액이 올바르지 않습니다'
      : '잔액이 음수가 됩니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, balance: r.balance });
}

export async function handleAdminPurge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as { id?: unknown } | null;
  const r = purgeTournament(Number(b?.id ?? 0));
  if (!r.ok) {
    const msg = r.error === 'not_found' ? '없는 대회입니다'
      : r.error === 'paid' ? '상금이 지급된 대회는 지울 수 없습니다'
      : '진행 중인 대회는 지울 수 없습니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, removed: r.removed });
}

export async function handleAdminTestTournament(
  _req: IncomingMessage, res: ServerResponse
): Promise<void> {
  const r = openTestTournament();
  if (!r.ok) return sendJson(res, 400, { error: '진행 중인 대회가 있습니다' });
  return sendJson(res, 200, { ok: true, id: r.id });
}

export async function handleAdminSeasonUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as { name?: unknown; reward?: unknown; endsAt?: unknown } | null;
  const cur = listSeasons().find(s => s.closed_at == null);
  if (!cur) return sendJson(res, 400, { error: '진행 중인 시즌이 없습니다' });
  const endsAt = b?.endsAt == null ? null : Math.floor(Number(b.endsAt));
  const ok = updateSeason(cur.id, {
    name: String(b?.name ?? '').slice(0, 40),
    reward: String(b?.reward ?? '').slice(0, 200),
    endsAt: endsAt != null && Number.isFinite(endsAt) ? endsAt : null,
  });
  return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 400, { error: '고칠 수 없습니다' });
}

export async function handleAdminSeasonClose(
  _req: IncomingMessage, res: ServerResponse
): Promise<void> {
  /* 시작 잔액은 0 이다. 시즌은 0 에서 시작하고, 거기서부터는 지원금과 출석으로 올린다 —
     closeSeason 이 지원금 쿨다운도 함께 풀어 모두가 같은 출발선에 선다. */
  const r = closeSeason({ seed: 0 });
  if (!r.ok) return sendJson(res, 400, { error: '진행 중인 시즌이 없습니다' });
  return sendJson(res, 200, { ok: true, closed: r.closed, ranked: r.ranked, nextNumber: r.nextNumber });
}

export async function handleAdminSeasonBackfill(
  _req: IncomingMessage, res: ServerResponse
): Promise<void> {
  const r = backfillFirstSeason();
  if (!r.ok) {
    return sendJson(res, 400, {
      error: r.error === 'not_first_season'
        ? '시즌이 이미 한 번 닫혔습니다 — 통산 기록이 여러 시즌에 걸쳐 있어 옮길 수 없습니다'
        : '진행 중인 시즌이 없습니다',
    });
  }
  return sendJson(res, 200, { ok: true, rows: r.rows });
}

export async function handleAdminConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as Record<string, unknown> | null;
  const n = (k: string) => Math.floor(Number(b?.[k]));
  /* 검증은 saveConfig 안에서 한다 — 여기서 한 번 더 쓰면 두 벌이 되고, 언젠가 갈라진다.
     화면에도 같은 검사가 있지만 그건 편의고 마지막 문은 질의 계층이다. */
  const r = saveConfig({
    regOpenMin: n('regOpenMin'), startMin: n('startMin'),
    graceMin: n('graceMin'), lateRegMin: n('lateRegMin'),
    startingStack: n('startingStack'), levelMin: n('levelMin'),
    weekdayMultiplier: n('weekdayMultiplier'), weekendMultiplier: n('weekendMultiplier'),
    prizeFixed: n('prizeFixed'),
  });
  if (!r.ok) return sendJson(res, 400, { error: r.errors.join(' · ') });
  return sendJson(res, 200, { ok: true });
}

export async function handleAdminRecurrence(
  req: IncomingMessage, res: ServerResponse
): Promise<void> {
  const b = await readJson(req) as Record<string, unknown> | null;
  /* 검증은 saveRecurrence 안에서 한다 — 화면에도 같은 검사가 있지만 그건 편의고
     마지막 문은 질의 계층이다. */
  const r = saveRecurrence({
    enabled: b?.enabled === true,
    mode: String(b?.mode ?? 'manual') as RecurMode,
    weekday: Math.floor(Number(b?.weekday)),
    day: Math.floor(Number(b?.day)),
  });
  if (!r.ok) return sendJson(res, 400, { error: r.errors.join(' · ') });
  return sendJson(res, 200, { ok: true });
}

export async function handleAdminConfigReset(
  _req: IncomingMessage, res: ServerResponse
): Promise<void> {
  resetConfig();
  return sendJson(res, 200, { ok: true });
}

/* ── 공지 API ───────────────────────────────────────────────────── */

const NOTICE_MSG: Record<string, string> = {
  bad_id: '아이디는 영소문자·숫자·하이픈으로 2~49자여야 합니다',
  bad_date: '날짜 형식이 올바르지 않습니다',
  bad_kind: '분류가 올바르지 않습니다',
  no_title: '제목을 넣어 주세요',
  no_body: '본문을 넣어 주세요',
  duplicate: '같은 아이디의 글이 이미 있습니다',
  not_found: '없는 글입니다',
};

function readNoticeBody(b: Record<string, unknown> | null) {
  return {
    date: String(b?.date ?? ''),
    kind: String(b?.kind ?? ''),
    title: String(b?.title ?? ''),
    summary: String(b?.summary ?? ''),
    sections: parseBody(String(b?.body ?? '')),
    active: b?.active !== false,
  };
}

export async function handleAdminNoticeCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as Record<string, unknown> | null;
  const r = createNotice({ id: String(b?.id ?? '').trim(), ...readNoticeBody(b) });
  if (!r.ok) return sendJson(res, 400, { error: NOTICE_MSG[r.error] ?? r.error });
  return sendJson(res, 200, { ok: true });
}

export async function handleAdminNoticeUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as Record<string, unknown> | null;
  const id = String(b?.id ?? '').trim();
  const next = readNoticeBody(b);
  /* 예전 글에 표가 있었으면 되살린다. 표는 줄 규칙으로 쓰지 않으므로, 되살리지 않으면
     본문을 한 글자만 고쳐도 표가 통째로 사라진다. */
  const old = listNoticesAdmin().find(x => x.id === id);
  const r = updateNotice(id, {
    ...next, sections: old ? keepTables(next.sections, old.sections) : next.sections,
  });
  if (!r.ok) return sendJson(res, 400, { error: NOTICE_MSG[r.error] ?? r.error });
  return sendJson(res, 200, { ok: true });
}

export async function handleAdminNoticeToggle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as { id?: unknown } | null;
  const r = toggleNotice(String(b?.id ?? ''));
  if (!r.ok) return sendJson(res, 400, { error: NOTICE_MSG[r.error] });
  return sendJson(res, 200, { ok: true, active: r.active });
}

export async function handleAdminNoticeDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJson(req) as { id?: unknown } | null;
  const r = deleteNotice(String(b?.id ?? ''));
  if (!r.ok) return sendJson(res, 400, { error: NOTICE_MSG[r.error] });
  return sendJson(res, 200, { ok: true });
}

export async function handleAdminTournamentCreate(
  req: IncomingMessage, res: ServerResponse
): Promise<void> {
  const b = await readJson(req) as Record<string, unknown> | null;
  const r = createTournament({
    title: String(b?.title ?? ''),
    regOpenAt: b?.regOpenAt != null ? Math.floor(Number(b.regOpenAt)) : undefined,
    startAt: b?.startAt != null ? Math.floor(Number(b.startAt)) : undefined,
    prizeMultiplier: Math.floor(Number(b?.prizeMultiplier ?? 0)),
  });
  if (!r.ok) return sendJson(res, 400, { error: createErrorText(r) });
  return sendJson(res, 200, { ok: true, id: r.id });
}

/* 왜 안 되는지를 그대로 적는다. "만들 수 없습니다"만 나오면 운영자는 무엇을 기다려야
   하는지 알 수 없다 — 곧 시작할 판 때문이라면 그 시각을 알려 주는 것이 답이다. */
function createErrorText(
  r: { error: 'live_exists' } | { error: 'too_close'; startsAt: number } | { error: 'bad_time' }
): string {
  if (r.error === 'live_exists') return '지금 돌고 있는 대회가 있습니다 — 끝난 뒤에 만들 수 있습니다';
  if (r.error === 'bad_time') return '등록 시작이 대회 시작보다 늦습니다 — 아무도 신청할 수 없는 대회가 됩니다';
  const at = new Date((r.startsAt + 9 * 3600) * 1000).toISOString().slice(11, 16);
  return `곧 시작할 대회가 있습니다 (${at} 시작) — 한 판이 두 시간까지 갈 수 있어서,`
    + ' 다음 대회 시작까지 두 시간 이상 남았을 때만 새로 만들 수 있습니다';
}

export async function handleAdminTournamentAbort(
  _req: IncomingMessage, res: ServerResponse
): Promise<void> {
  const r = cancelRunningTournament();
  if (!r.ok) return sendJson(res, 400, { error: '진행 중인 대회가 없습니다' });
  return sendJson(res, 200, { ok: true, id: r.id });
}

export async function handleAdminTournamentRevoke(
  req: IncomingMessage, res: ServerResponse
): Promise<void> {
  const b = await readJson(req) as { id?: unknown } | null;
  const r = revokePrizesAndPurge(Number(b?.id ?? 0));
  if (!r.ok) {
    return sendJson(res, 400, {
      error: r.error === 'not_found' ? '없는 대회입니다' : '진행 중인 대회는 손댈 수 없습니다',
    });
  }
  return sendJson(res, 200, { ok: true, revoked: r.revoked, users: r.users, removed: r.removed });
}
