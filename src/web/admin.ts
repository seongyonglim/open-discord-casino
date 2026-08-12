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
import * as T from '../services/tournament';
import { BUG_REPORT_BOUNTY } from '../services/rewards';
import { readJson, sendJson } from './http';
import {
  listTournaments, purgeTournament, openTestTournament, createTournament, revokePrizesAndPurge,
  cancelRunningTournament, searchUsers, grantPoints, userLedger,
} from '../db/admin';
import { prizePoolOf, isPko, isMystery } from '../db/holdem';
import { listSeasons, updateSeason, closeSeason, seasonPlayers, backfillFirstSeason } from '../db/queries';
import { getConfig, defaultConfig, saveConfig, resetConfig, multiplierBehindSeason } from '../db/settings';
import {
  getRecurrence, saveRecurrence, nextOccurrence, WEEKDAY_LABEL, MODE_LABEL,
  type RecurMode,
} from '../db/recurrence';
import { getSeasonSchedule, saveSeasonSchedule, clearSeasonSchedule } from '../db/season-schedule';
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
    /* 상금 풀은 지금 기준으로 다시 잰다 — 아직 안 끝난 판은 지급액이 0이라
       "이 판이 얼마짜리인가"를 지급액만 봐서는 알 수 없다. */
    const pool = prizePoolOf(t, t.entries, t.prize_fixed);
    const st = tournamentState(t);
    return `<tr>
      <td>${t.id}</td>
      <td>${esc(t.date_str)}</td>
      <td>${esc(t.title)}</td>
      <td>${t.buy_in > 0
        ? `<span class="ad-tag buy">바이인 ${num(t.buy_in)}P</span>`
        : `<span class="ad-tag free">프리롤</span>`}${
        /* 바운티 판은 목록에서 바로 구분돼야 한다. 상금 팟이 참가비의 절반으로만 잡히므로,
           모르고 보면 "상금이 왜 반이지"가 된다 — 그 답을 같은 줄에 둔다. */
        isMystery(t) ? ` <span class="ad-tag mystery">미스터리</span>`
        : isPko(t) ? ` <span class="ad-tag pko">PKO ${t.bounty_pct}%</span>` : ''}</td>
      <td><span class="ad-st s-${st === '진행 중' ? 'run' : st === '종료' ? 'done' : st === '취소' ? 'cancel' : 'wait'}">${st}</span></td>
      <td class="r">${num(t.entries)}</td>
      <td class="r">${num(pool)}P</td>
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
  /* 시즌이 올라 기본 상금이 커졌는데 저장된 값만 옛날에 머물러 있는 경우.
     저장된 값을 코드가 덮지는 않지만(운영자가 명시한 값이다), 공지한 금액과 실제가
     어긋난 채로 조용히 굴러가면 안 되므로 화면에서 말한다. */
  const behind = multiplierBehindSeason();
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
  const sched = getSeasonSchedule();
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
    </tr>`).join('');

  /* 왼쪽 메뉴와 화면을 짝지어 둔다. 카드 일곱 개가 세로로 이어져 있어서 아래쪽 것은
     스크롤을 한참 내려야 나왔다 — 하는 일이 다른 카드들이 한 줄에 꿰여 있던 셈이다.

     화면을 갈아끼우되 카드는 전부 그린 채로 두고 보이기만 바꾼다. 이 화면의 동작은
     전부 로드 시점에 getElementById 로 묶이기 때문에, 안 보이는 화면을 아예 안 그리면
     그 묶기가 통째로 끊긴다 — 지금 잘 도는 것을 건드리지 않는 길이 이쪽이다. */
  const MENU: { key: string; label: string; sub: string }[] = [
    { key: 'tour', label: '대회 관리', sub: '개설 · 자동 개최 · 기록' },
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
      <h2>새 대회 열기</h2>
      <p class="ad-note">${rec.enabled
        ? `<b>반복 개최가 켜져 있습니다</b> — ${recText}. 그 밖의 판을 여기서 직접 엽니다.`
        : `<b>대회는 저절로 열리지 않습니다.</b> 여기서 직접 여셔야 합니다 —
           열지 않으면 그날은 대회가 없습니다. 정기적으로 열려면 아래 [자동 개최 설정]에서 반복을 켜세요.`}
        여기서 여는 판은 <b>아래 적힌 값 그대로</b> 열립니다 — 나중에 템플릿을 고쳐도 흔들리지 않습니다.</p>
      ${canMake
        ? `<div class="ad-sub2">지금 열 수 있는가 <span>${nextStart == null
            ? '예정된 대회가 없습니다 — 지금 열 수 있습니다'
            : `다음 대회 ${kst(nextStart)} 시작 — 두 시간 넘게 남아 하나 더 열 수 있습니다`}</span></div>`
        /* 잠겼으면 크게 말한다. 예전에는 작은 회색 한 줄이라 폼은 멀쩡해 보이는데 아무것도
           안 눌려서 "드롭다운이 고장 났다"로 읽혔다 — 실제로 그런 제보가 왔다.
           무엇을 기다려야 하는지도 함께 적는다. */
        : `<p class="ad-warn"><b>지금은 새 대회를 열 수 없어 아래 입력이 잠겨 있습니다.</b>
             ${live
               ? '지금 돌고 있는 대회가 있습니다 — 그 판이 끝나면 열립니다.'
               : `다음 대회가 ${kst(nextStart!)}에 시작합니다. 한 판이 두 시간까지 갈 수 있어서,
                  시작까지 두 시간 이상 남았을 때만 새로 열 수 있습니다.`}
             ${live ? '' : '먼저 열고 싶으면 아래 [대회 기록]에서 그 대회를 지우세요.'}</p>`}
      <div class="ad-grid">
        <label>제목<input type="text" id="ncTitle" placeholder="${cfg.buyIn > 0 ? '홀덤 토너먼트' : '홀덤 프리롤'}" ${canMake ? '' : 'disabled'}><i>비우면 방식에 맞는 이름이 붙습니다</i></label>
        <label>참가 방식<select id="ncKind" ${canMake ? '' : 'disabled'}>
          <option value="free" ${cfg.buyIn > 0 ? '' : 'selected'}>프리롤 (참가비 없음)</option>
          <option value="buyin" ${cfg.buyIn > 0 ? 'selected' : ''}>바이인 (참가비 있음)</option>
        </select><i>템플릿의 방식이 기본으로 잡힙니다</i></label>
        <!-- 대회 종류. 바운티는 참가비를 반으로 갈라 한쪽을 머리 값으로 쓰므로
             참가비가 있어야 뜻이 있다 — 프리롤을 고르면 아래 스크립트가 잠근다. -->
        <label>대회 종류<select id="ncMode" ${canMake ? '' : 'disabled'}>
          <option value="CLASSIC" selected>일반 (상금만)</option>
          <option value="PKO_BOUNTY">PKO 바운티 (순위 상금 + 바운티)</option>
          <option value="MYSTERY_BOUNTY">미스터리 바운티 (전액 바운티 · 금액 비공개)</option>
        </select><i id="ncModeHint">바운티는 1인당 금액(참가비 또는 배수)에서 갈라 냅니다</i></label>
        <!-- 바운티 몫. PKO 에서만 고른다 — 미스터리는 전액이라 고를 것이 없다. -->
        <label id="ncPctWrap" hidden>바운티 몫<span class="ad-inx">
          <input type="number" id="ncPct" min="10" max="100" step="5" value="50"><b>%</b>
        </span><i id="ncPctHint">나머지가 순위 상금입니다</i></label>
        <label>등록 시작<input type="datetime-local" id="ncRegAt" value="${localInput(defaultRegAt)}" ${canMake ? '' : 'disabled'}><i>KST · 이때부터 신청을 받습니다</i></label>
        <label>대회 시작<input type="datetime-local" id="ncStartAt" value="${localInput(defaultStartAt)}" ${canMake ? '' : 'disabled'}><i>KST · 3명 이상이면 이때 시작</i></label>
      </div>
      <!-- 방식에 따라 이 두 줄 중 하나만 보인다. 지금 쓰이지 않는 칸을 늘어놓으면
           무엇이 상금을 정하는지가 흐려진다 — 실제로 배수와 참가비가 나란히 있었다. -->
      <div class="ad-grid" id="ncFreeRow">
        <label>상금 배수<span class="ad-inx"><input type="number" id="ncMult" min="0" step="100" value="${cfg.weekdayMultiplier}" ${canMake ? '' : 'disabled'}><b>×명</b></span><i>인원 × 배수가 상금 풀 · 0이면 상금 없음</i></label>
      </div>
      <div class="ad-grid" id="ncBuyRow">
        <label>참가비<span class="ad-inx"><input type="number" id="ncBuyIn" min="0" step="100" value="${cfg.buyIn}" ${canMake ? '' : 'disabled'}><b>P</b></span><i>걷은 돈이 그대로 상금 · 취소되면 전액 환불</i></label>
        <label>보장 상금 (GTD)<span class="ad-inx"><input type="number" id="ncGtd" min="0" step="1000" value="${cfg.prizeFixed}" ${canMake ? '' : 'disabled'}><b>P</b></span><i>걷은 돈이 이보다 적으면 모자란 만큼 채웁니다</i></label>
      </div>
      <!-- 판의 모양. 예전에는 이 네 값이 템플릿에만 있어서, 오늘 한 판만 짧게 돌리려 해도
           템플릿을 고쳤다가 되돌려야 했다 — 그 사이에 자동 개최가 걸리면 엉뚱한 판이 열린다. -->
      <div class="ad-sub2">이 대회의 룰 <span>템플릿과 무관하게 이 판에만 적용됩니다</span></div>
      <div class="ad-grid">
        <label>시작 칩<span class="ad-inx"><input type="number" id="ncStack" min="1" step="500" value="${cfg.startingStack}" ${canMake ? '' : 'disabled'}><b>칩</b></span><i></i></label>
        <label>블라인드 주기<span class="ad-inx"><input type="number" id="ncLevel" min="1" value="${cfg.levelMin}" ${canMake ? '' : 'disabled'}><b>분</b></span><i>마지막 레벨(16)까지 <span id="ncLevelTotal">${cfg.levelMin * 15}</span>분</i></label>
        <label>레이트 레지<span class="ad-inx"><input type="number" id="ncLateReg" min="1" value="${cfg.lateRegMin}" ${canMake ? '' : 'disabled'}><b>분</b></span><i>실제 시작 이후</i></label>
        <label>최소 인원 대기<span class="ad-inx"><input type="number" id="ncGrace" min="1" value="${cfg.graceMin}" ${canMake ? '' : 'disabled'}><b>분</b></span><i>시작 시각 이후 · 3명 미달이면 취소</i></label>
      </div>
      <div class="ad-row">
        <button type="button" id="ncLoadTpl" ${canMake ? '' : 'disabled'}>자동 개최 템플릿 값 불러오기</button>
        <span class="ad-note">칩 ${num(cfg.startingStack)} · 블라인드 ${cfg.levelMin}분 ·
          레이트 ${cfg.lateRegMin}분 · 대기 ${cfg.graceMin}분 ·
          ${cfg.buyIn > 0 ? `참가비 ${num(cfg.buyIn)}P` : `배수 ${num(cfg.weekdayMultiplier)}×명`}</span>
      </div>
      <div class="ad-row">
        <button type="button" id="ncMake" class="primary" ${canMake ? '' : 'disabled'}>대회 열기</button>
        <button type="button" id="adTest" ${canMake ? '' : 'disabled'}>테스트 대회 (지금 · 상금 없음)</button>
        ${live
          ? `<button type="button" id="adAbort" class="danger">진행 중 대회 중단</button>`
          : ''}
      </div>
    </section>

    <section class="ad-card" data-pane="tour">
      <h2>대회 기록</h2>
      <p class="ad-note">상금이 나간 대회는 <b>[상금 회수 후 삭제]</b>로만 지울 수 있습니다 — 그냥 지우면
        원장에 근거 없는 포인트가 남습니다. 회수는 역방향 원장으로 기록되고,
        <b>이미 다 쓴 사람은 잔액이 음수가 됩니다</b>(지원금으로 갚아 나갈 수 있습니다).
        참가비를 걷은 판도 같습니다 — 지우려면 걷은 돈을 먼저 돌려줘야 합니다.</p>
      <div class="ad-scroll">
        <table class="ad-tbl ad-tour">
          <thead><tr><th>id</th><th>날짜</th><th>제목</th><th>방식</th><th>상태</th>
            <th class="r">참가</th><th class="r">상금 풀</th><th class="r">지급</th><th></th></tr></thead>
          <tbody id="adTBody">${rows}</tbody>
        </table>
      </div>
    </section>

    <section class="ad-card" data-pane="tour">
      <h2>자동 개최 설정</h2>
      <p class="ad-note">자동 개최 스케줄과, 그 주기마다 적용될 전용 룰을 설정합니다 —
        <b>여기서는 어느 날 여는지</b>만 정하고, 시각·칩·상금은 아래 [자동 개최 전용 템플릿]이 정합니다.
        켜 두면 시작 <b>12시간 전</b>에 다음 판이 자동으로 만들어집니다.
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
        <button type="button" id="rcSave" class="primary">자동 개최 설정 저장</button>
        <span class="ad-note">${rec.enabled && nextRecur
          ? `다음 자동 개최 — ${kst(nextRecur.startAt)} 시작 (등록 ${kst(nextRecur.regOpenAt)})`
          : '지금은 자동으로 열리지 않습니다'}</span>
      </div>
    </section>

    <section class="ad-card" data-pane="tour">
      <h2>자동 개최 전용 템플릿</h2>
      <p class="ad-note"><b>[자동 개최 설정]이 여는 판에만</b> 적용됩니다. 손으로 여는 판은
        [새 대회 열기]에 적은 값 그대로 열리므로 여기를 고쳐도 흔들리지 않습니다 —
        그쪽에서 <b>[자동 개최 템플릿 값 불러오기]</b>를 누르면 이 값이 폼에 채워집니다.
        바꾼 값은 <b>다음에 만들어질 대회부터</b> 적용됩니다 — 진행 중인 대회는 만들어질 때의 값을
        자기 행에 갖고 있어서 흔들리지 않습니다(블라인드가 갑자기 뛰거나 늦게 온 사람만 다른
        스택을 받는 일이 없습니다). 순위별 분배(ITM 비율)는 검증된 산식이라 고정입니다.</p>
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
        <label>블라인드 주기<span class="ad-inx"><input type="number" id="cfLevel" min="1" value="${cfg.levelMin}"><b>분</b></span><i>마지막 레벨(16)까지 ${cfg.levelMin * 15}분</i></label>
      </div>
      ${behind
        ? `<p class="ad-warn"><b>시즌이 바뀌어 기본 상금이 올랐습니다.</b>
             지금 저장된 평일 배수는 ${num(behind.now)}P인데, 이 시즌의 기본값은 ${num(behind.expected)}P입니다.
             저장된 값이 우선하므로 <b>대회는 아직 ${num(behind.now)}P로 열립니다.</b>
             공지한 금액과 맞추려면 아래에서 값을 고치거나 [기본값으로]를 누르세요.</p>`
        : ''}
      <div class="ad-sub2">참가 방식과 상금 풀 <span>순위별 분배(ITM 비율)는 고정입니다 — 여기서는 풀의 크기만 정합니다</span></div>
      <div class="ad-grid">
        <label>참가 방식<select id="cfKind">
          <option value="free" ${cfg.buyIn > 0 ? '' : 'selected'}>프리롤 (참가비 없음)</option>
          <option value="buyin" ${cfg.buyIn > 0 ? 'selected' : ''}>바이인 (참가비 있음)</option>
        </select><i>고른 쪽의 설정만 아래에 나옵니다</i></label>
      </div>
      <!-- 방식에 따라 한 쪽만 보인다. 배수와 참가비는 상금 풀을 정하는 서로 다른 방법이라
           나란히 두면 어느 것이 지금 쓰이는지 알 수 없다. -->
      <div class="ad-grid" id="cfFreeRow">
        <label>평일 배수<span class="ad-inx"><input type="number" id="cfWd" min="0" step="100" value="${cfg.weekdayMultiplier}"><b>×명</b></span><i>5명이면 ${num(cfg.weekdayMultiplier * 5)}P</i></label>
        <label>주말 배수<span class="ad-inx"><input type="number" id="cfWe" min="0" step="100" value="${cfg.weekendMultiplier}"><b>×명</b></span><i>5명이면 ${num(cfg.weekendMultiplier * 5)}P</i></label>
        <label>고정 상금 풀<span class="ad-inx"><input type="number" id="cfFixed" min="0" step="1000" value="${cfg.prizeFixed}"><b>P</b></span><i>0이면 인원 × 배수를 씁니다</i></label>
      </div>
      <div class="ad-grid" id="cfBuyRow">
        <label>참가비<span class="ad-inx"><input type="number" id="cfBuyIn" min="0" step="100" value="${cfg.buyIn}"><b>P</b></span><i>5명이면 상금 ${num(Math.max(cfg.buyIn, 0) * 5)}P · 취소되면 전액 환불</i></label>
        <label>보장 상금 (GTD)<span class="ad-inx"><input type="number" id="cfGtd" min="0" step="1000" value="${cfg.prizeFixed}"><b>P</b></span><i>걷은 돈이 이보다 적으면 모자란 만큼 채웁니다</i></label>
      </div>
      <div class="ad-row">
        <button type="button" id="cfSave" class="primary">템플릿 저장</button>
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
        <thead><tr><th>시즌</th><th>이름</th><th>시작</th><th>종료</th><th class="r">참여</th></tr></thead>
        <tbody>${seasonRows}</tbody>
      </table></div>
      <div class="ad-row" style="margin-top:12px">
        <input type="text" id="adSName" placeholder="현재 시즌 이름 (예: 오픈베타)" autocomplete="off">
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

      <!-- 예약. 사람이 자정에 깨어 있지 않아도 넘어가게 하려고 둔다.
           반드시 화면에 보여야 한다 — 예약해 둔 파괴적인 동작이 어디에도 안 보이면
           그것을 걸어 둔 사실 자체를 잊는다. -->
      <div class="ad-sub2">종료 예약 <span>서버 타이머가 없어 접속이 있을 때 넘어갑니다 — 자정에 아무도 없으면 첫 접속에서 처리됩니다</span></div>
      ${sched.closeAt != null
        ? `<p class="ad-warn"><b>${kst(sched.closeAt)}에 시즌이 종료되도록 예약돼 있습니다.</b>
             그 시각이 지나면 전원 잔액이 ${num(sched.seed)}P로 초기화되고
             ${sched.nextName ? `<b>${esc(sched.nextName)}</b>` : '다음 시즌'}이 열립니다.</p>`
        : `<p class="ad-note">예약이 없습니다. 시각을 넣고 저장하면 그때 자동으로 넘어갑니다.</p>`}
      <div class="ad-grid">
        <label>종료 시각<input type="datetime-local" id="adSchAt" value="${sched.closeAt != null ? localInput(sched.closeAt) : ''}"><i>KST</i></label>
        <label>다음 시즌 이름<input type="text" id="adSchName" value="${esc(sched.nextName)}" placeholder="시즌 1"><i>비우면 이름 없이 열립니다</i></label>
        <label>시작 잔액<span class="ad-inx"><input type="number" id="adSchSeed" min="0" step="1000" value="${sched.seed}"><b>P</b></span><i>전원이 이 값에서 시작합니다</i></label>
      </div>
      <div class="ad-row">
        <button type="button" id="adSchSave" class="primary">종료 예약 저장</button>
        <button type="button" id="adSchClear">예약 취소</button>
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

    /* 새 대회 폼도 참가 방식에 따라 한 줄만 보여준다 — 템플릿 카드와 같은 규칙이다.
       버튼이 잠긴 상태(canMake=false)에서도 폼은 그려지므로 요소는 항상 있다. */
    var ncKind = document.getElementById('ncKind');
    var ncMode = document.getElementById('ncMode');
    function ncSyncRows(){
      var buyin = ncKind.value === 'buyin';
      document.getElementById('ncFreeRow').hidden = buyin;
      document.getElementById('ncBuyRow').hidden = !buyin;
      /* 바운티는 "1인당 금액의 절반"이라, 그 1인당 금액만 있으면 프리롤도 걸 수 있다 —
         참가비 대회는 참가비, 프리롤은 상금 배수가 그 값이다. 예전에는 참가비만 보고
         프리롤을 통째로 잠갔는데, 배수 10,000 인 프리롤이면 5,000 은 상금 5,000 은
         머리 값으로 두면 되므로 막을 이유가 없었다.
         배수도 참가비도 0 인 판(보장 상금만 있는 프리롤)에는 걸 수 없으니 그때만 잠근다 —
         "바운티 대회"라고 적어 놓고 아무 바운티도 없는 판이 열리는 것이 문제다. */
      var unit = buyin
        ? Math.floor(Number(document.getElementById('ncBuyIn').value) || 0)
        : Math.floor(Number(document.getElementById('ncMult').value) || 0);
      ncMode.disabled = unit <= 0;
      if (unit <= 0) ncMode.value = 'CLASSIC';
      /* 바운티 몫은 PKO 에서만 고른다 — 미스터리는 전액이라 고를 것이 없다. */
      var mystery = ncMode.value === 'MYSTERY_BOUNTY';
      var pctEl = document.getElementById('ncPct');
      var pctWrap = document.getElementById('ncPctWrap');
      /* 두 바운티 모드가 함께 쓴다 — 미스터리도 순위 상금을 남길 수 있다.
         일반 대회에서만 감춘다(바운티가 없으니 고를 것이 없다). */
      if (pctWrap) pctWrap.hidden = ncMode.value === 'CLASSIC';
      var pct = Math.min(100, Math.max(10, Math.floor(Number(pctEl && pctEl.value) || 50)));
      var bty = Math.floor(unit * pct / 100);
      var hint = document.getElementById('ncModeHint');
      if (hint) {
        hint.textContent = unit <= 0
          ? (buyin ? '참가비를 입력하면 바운티를 걸 수 있습니다'
                   : '상금 배수가 있어야 바운티를 걸 수 있습니다')
          : ncMode.value === 'CLASSIC'
            ? '바운티 없이 순위 상금만 나눕니다'
            : (buyin ? '참가비' : '배수') + ' ' + unit.toLocaleString('ko-KR') + 'P 중 '
              + bty.toLocaleString('ko-KR') + 'P 가 바운티'
              + (unit - bty > 0
                ? ' · 나머지 ' + (unit - bty).toLocaleString('ko-KR') + 'P 가 순위 상금'
                : ' (순위 상금 없음)')
              + (mystery ? ' · 바운티 금액은 비공개' : '');
      }
      var pctHint = document.getElementById('ncPctHint');
      if (pctHint) {
        pctHint.textContent = unit > 0
          ? '바운티 ' + bty.toLocaleString('ko-KR') + 'P · 순위 상금 '
            + (unit - bty).toLocaleString('ko-KR') + 'P'
          : '나머지가 순위 상금입니다';
      }
    }
    ncKind.addEventListener('change', ncSyncRows);
    /* 금액을 고치면 안내와 잠금이 따라와야 한다 — 안 그러면 배수를 0 에서 올려도
       종류 선택이 잠긴 채로 남는다. */
    ['ncBuyIn', 'ncMult', 'ncPct'].forEach(function(idv){
      var el = document.getElementById(idv);
      if (el) el.addEventListener('input', ncSyncRows);
    });
    ncMode.addEventListener('change', ncSyncRows);
    ncSyncRows();

    /* 자동 개최 전용 템플릿의 지금 값. 서버가 그린 페이지에 박아 둔다 —
       [불러오기]를 누를 때마다 요청을 보내면, 템플릿을 저장한 뒤 이 페이지를
       새로고침하지 않은 상태에서 눌렀을 때 화면과 다른 값이 들어온다. */
    var NC_TPL = ${JSON.stringify({
      startingStack: cfg.startingStack, levelMin: cfg.levelMin,
      lateRegMin: cfg.lateRegMin, graceMin: cfg.graceMin,
      kind: cfg.buyIn > 0 ? 'buyin' : 'free',
      mult: cfg.weekdayMultiplier, buyIn: cfg.buyIn, gtd: cfg.prizeFixed,
    })};
    function ncLevelHint(){
      var v = Math.floor(Number(document.getElementById('ncLevel').value));
      var el = document.getElementById('ncLevelTotal');
      if (el) el.textContent = isFinite(v) && v > 0 ? String(v * 15) : '—';
    }
    document.getElementById('ncLevel').addEventListener('input', ncLevelHint);
    var ncLoadTpl = document.getElementById('ncLoadTpl');
    if (ncLoadTpl) ncLoadTpl.addEventListener('click', function(){
      var set = function(id, v){ document.getElementById(id).value = String(v); };
      set('ncStack', NC_TPL.startingStack);
      set('ncLevel', NC_TPL.levelMin);
      set('ncLateReg', NC_TPL.lateRegMin);
      set('ncGrace', NC_TPL.graceMin);
      /* 상금 쪽도 같이 채운다. 룰만 채우고 참가 방식은 그대로 두면 "템플릿을 불러왔다"고
         읽은 운영자가 프리롤 템플릿으로 바이인 판을 여는 일이 생긴다. */
      ncKind.value = NC_TPL.kind;
      set('ncMult', NC_TPL.mult);
      set('ncBuyIn', NC_TPL.buyIn);
      set('ncGtd', NC_TPL.gtd);
      ncSyncRows();
      ncLevelHint();
    });

    var ncMake = document.getElementById('ncMake');
    if (ncMake) ncMake.addEventListener('click', function(){
      /* datetime-local 은 'YYYY-MM-DDTHH:MM' 을 준다. 브라우저의 시간대로 해석되므로
         Date 에 그대로 넘긴다 — 운영자도 KST 라 화면에 적힌 시각 그대로 들어간다. */
      function at(id){
        var v = String(document.getElementById(id).value || '');
        var ms = v ? new Date(v).getTime() : NaN;
        return isFinite(ms) ? Math.floor(ms / 1000) : NaN;
      }
      var buyin = ncKind.value === 'buyin';
      var body = {
        title: document.getElementById('ncTitle').value,
        regOpenAt: at('ncRegAt'),
        startAt: at('ncStartAt'),
        /* 참가 방식이 정한 쪽만 보낸다. 두 값을 다 보내면 서버가 어느 쪽을 믿어야 할지
           모호해지고, 화면에서 프리롤을 골라 놓고 참가비가 붙는 일이 생긴다. */
        buyIn: buyin ? Math.floor(Number(document.getElementById('ncBuyIn').value)) : 0,
        /* 1인당 금액이 0 이면 위에서 select 를 잠그며 CLASSIC 으로 되돌려 두었다 */
        mode: ncMode.value,
        /* 바운티 몫(%). 미스터리는 서버가 100 으로 못 박으므로 이 값은 PKO 에서만 쓰인다 */
        bountyPct: Math.min(100, Math.max(10, Math.floor(
          Number((document.getElementById('ncPct') || {}).value) || 50))),
        prizeMultiplier: buyin ? 0 : Math.floor(Number(document.getElementById('ncMult').value)),
        prizeFixed: buyin ? Math.floor(Number(document.getElementById('ncGtd').value)) : 0,
        /* 판의 모양은 늘 보낸다. 안 보내면 서버가 템플릿 값을 쓰는데, 그러면 화면에
           적힌 것과 실제로 열리는 판이 달라진다. */
        startingStack: Math.floor(Number(document.getElementById('ncStack').value)),
        levelMin: Math.floor(Number(document.getElementById('ncLevel').value)),
        lateRegMin: Math.floor(Number(document.getElementById('ncLateReg').value)),
        graceMin: Math.floor(Number(document.getElementById('ncGrace').value)),
      };
      if (!isFinite(body.regOpenAt) || !isFinite(body.startAt)) { alert('시각을 넣어 주세요.'); return; }
      if (body.regOpenAt > body.startAt) {
        alert('등록 시작이 대회 시작보다 늦습니다 — 아무도 신청할 수 없는 대회가 됩니다.'); return;
      }
      if (!isFinite(body.prizeMultiplier) || body.prizeMultiplier < 0) { alert('상금 배수를 확인해 주세요.'); return; }
      if (!isFinite(body.buyIn) || body.buyIn < 0) { alert('참가비를 확인해 주세요.'); return; }
      if (!isFinite(body.prizeFixed) || body.prizeFixed < 0) { alert('보장 상금을 확인해 주세요.'); return; }
      if (buyin && body.buyIn === 0) {
        alert('바이인을 골랐으면 참가비를 1P 이상 넣어 주세요. 참가비가 없으면 프리롤입니다.'); return;
      }
      var rules = [['startingStack', '시작 칩'], ['levelMin', '블라인드 주기'],
        ['lateRegMin', '레이트 레지 시간'], ['graceMin', '최소 인원 대기 시간']];
      for (var ri = 0; ri < rules.length; ri++) {
        var rv = body[rules[ri][0]];
        if (!isFinite(rv) || rv < 1) { alert(rules[ri][1] + '을(를) 1 이상으로 넣어 주세요.'); return; }
      }
      var fmt = function(sec){
        var d = new Date(sec * 1000);
        return (d.getMonth() + 1) + '/' + d.getDate() + ' '
          + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      };
      var money = buyin
        ? ' 참가비 ' + body.buyIn.toLocaleString('ko-KR') + 'P — 걷은 돈이 그대로 상금이 됩니다'
          + (body.prizeFixed > 0 ? ' (보장 ' + body.prizeFixed.toLocaleString('ko-KR') + 'P).' : '.')
          + ' 인원 미달로 취소되면 전액 환불됩니다.'
        : body.prizeMultiplier === 0 ? ' 상금 배수 0이라 포인트는 나가지 않습니다.' : '';
      confirmThen('대회를 열까요?',
        (body.title || (buyin ? '홀덤 토너먼트' : '홀덤 프리롤')) + ' — 등록 ' + fmt(body.regOpenAt)
        + ' · 시작 ' + fmt(body.startAt) + '.' + money
        /* 룰을 함께 읽힌다. 이제 이 판에만 적용되는 값이라, 확인 창이 마지막으로
           눈에 들어오는 자리다 — 템플릿과 다르게 열어 놓고 모르는 일이 없어야 한다. */
        + ' 칩 ' + num(body.startingStack) + ' · 블라인드 ' + body.levelMin + '분'
        + ' · 레이트 ' + body.lateRegMin + '분 · 대기 ' + body.graceMin + '분.',
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

    /* 시즌 종료 예약. 전원의 잔액이 초기화되는 동작이라 시각과 결과를 그대로 읽어 준다 —
       확인 창이 마지막으로 눈에 들어오는 자리다. */
    document.getElementById('adSchSave').addEventListener('click', function(){
      var raw = document.getElementById('adSchAt').value;
      if (!raw) { alert('종료 시각을 넣어 주세요. 예약을 없애려면 [예약 취소]를 누르세요.'); return; }
      var at = Math.floor(new Date(raw).getTime() / 1000);
      if (!isFinite(at)) { alert('시각을 확인해 주세요.'); return; }
      var seed = Math.floor(Number(document.getElementById('adSchSeed').value));
      if (!isFinite(seed) || seed < 0) { alert('시작 잔액을 확인해 주세요.'); return; }
      var name = document.getElementById('adSchName').value;
      var when = new Date(at * 1000);
      confirmThen('시즌 종료를 예약할까요?',
        (when.getMonth() + 1) + '월 ' + when.getDate() + '일 '
        + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0')
        + ' 이후 첫 접속에서 시즌이 넘어갑니다. 그 순간의 잔액이 성적표로 찍히고 '
        + '전원 잔액이 ' + num(seed) + 'P로 초기화되며 '
        + (name || '다음 시즌') + '이 열립니다. 되돌릴 수 없습니다.',
        function(){
          post('/api/admin/season/schedule', {
            closeAt: at, nextName: name,
            seed: seed,
          }).then(function(r){ if (shout(r)) location.reload(); });
        });
    });
    document.getElementById('adSchClear').addEventListener('click', function(){
      post('/api/admin/season/schedule', {}).then(function(r){ if (shout(r)) location.reload(); });
    });

    document.getElementById('adSSave').addEventListener('click', function(){
      var d = document.getElementById('adSEnd').value;
      post('/api/admin/season/update', {
        name: document.getElementById('adSName').value,
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
    /* 참가 방식에 따라 한 쪽 줄만 보인다. 안 보이는 칸의 값은 읽지 않는다 —
       화면에 없는 숫자가 저장되면 무엇이 반영됐는지 알 수 없다.

       고정 상금 칸이 둘(cfFixed·cfGtd)인데 저장되는 값은 하나다. 보이는 쪽을 읽고,
       방식을 바꿀 때 값을 옮겨 둘이 벌어지지 않게 한다. */
    var cfKind = document.getElementById('cfKind');
    function cfBuyin(){ return cfKind.value === 'buyin'; }
    function cfSyncRows(){
      var buyin = cfBuyin();
      document.getElementById('cfFreeRow').hidden = buyin;
      document.getElementById('cfBuyRow').hidden = !buyin;
      // 방금 감춰진 쪽의 고정 상금을 보이는 쪽으로 옮긴다
      if (buyin) document.getElementById('cfGtd').value = document.getElementById('cfFixed').value;
      else document.getElementById('cfFixed').value = document.getElementById('cfGtd').value;
    }
    cfKind.addEventListener('change', cfSyncRows);
    cfSyncRows();

    function cfRead(){
      var buyin = cfBuyin();
      return {
        regOpenMin: cfClock('cfRegAt'), startMin: cfClock('cfStartAt'),
        graceMin: cfNum('cfGrace'), lateRegMin: cfNum('cfLateReg'),
        startingStack: cfNum('cfStack'), levelMin: cfNum('cfLevel'),
        /* 프리롤이면 참가비 0, 바이인이면 배수 0. 저장되는 값 하나로 방식이 정해지므로
           둘이 어긋난 상태(바이인인데 0원)가 아예 생기지 않는다. */
        buyIn: buyin ? cfNum('cfBuyIn') : 0,
        weekdayMultiplier: buyin ? 0 : cfNum('cfWd'),
        weekendMultiplier: buyin ? 0 : cfNum('cfWe'),
        prizeFixed: buyin ? cfNum('cfGtd') : cfNum('cfFixed'),
      };
    }
    function cfCheck(c){
      var bad = [];
      // 어느 칸이 잘못됐는지 적는다 — 같은 문장이 여러 줄 뜨면 무엇을 고쳐야 할지 알 수 없다
      var LABEL = { regOpenMin: '등록 시작', startMin: '대회 시작', graceMin: '최소 인원 대기',
        lateRegMin: '레이트 레지', startingStack: '시작 칩', levelMin: '블라인드 주기',
        weekdayMultiplier: '평일 배수', weekendMultiplier: '주말 배수',
        prizeFixed: '고정 상금 풀', buyIn: '참가비' };
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
      if (c.weekdayMultiplier < 0 || c.weekendMultiplier < 0 || c.prizeFixed < 0 || c.buyIn < 0) {
        bad.push('배수 · 고정 상금 · 참가비는 0 이상이어야 합니다');
      }
      /* 바이인을 골라 놓고 0원이면 그냥 프리롤이다. 저장은 되지만 운영자가 기대한 것과
         다르므로 여기서 말한다 — 조용히 프리롤이 되면 왜 참가비가 안 걷히는지 모른다. */
      if (cfBuyin() && c.buyIn === 0) {
        bad.push('바이인을 골랐으면 참가비를 1P 이상 넣어 주세요 (0원이면 프리롤입니다)');
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
    /* 자동 개최 설정. 켰는데 주기가 '수동'이면 아무 일도 안 일어난다 — 서버도 막지만
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
      confirmThen('자동 개최 설정을 저장할까요?',
        what + ' 시각과 칩·상금은 [자동 개최 전용 템플릿]의 값을 씁니다. 이미 만들어진 대회는 바뀌지 않습니다.',
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

    var BOUNTY = ${jsonForScript(BUG_REPORT_BOUNTY)};

    uBody.addEventListener('click', function(ev){
      var led = ev.target.closest ? ev.target.closest('.ad-led') : null;
      if (led) { loadLedger(led.getAttribute('data-id'), led.getAttribute('data-name')); return; }
      var b = ev.target.closest ? ev.target.closest('.ad-give') : null;
      if (!b) return;
      var name = b.getAttribute('data-name'), id = b.getAttribute('data-id');
      /* 가장 자주 하는 지급이 제보 보상이라 그 금액을 기본값으로 채워 둔다.
         값은 코드에서 온다(services/rewards 의 BUG_REPORT_BOUNTY) — 여기 숫자를 적어 두면
         금액을 올리는 날 공지와 어드민 화면이 갈라진다. */
      var raw = prompt(name + ' 님에게 줄 포인트 (빼려면 음수)', String(BOUNTY));
      if (raw == null || raw === '') return;
      var amount = Math.floor(Number(raw));
      if (!isFinite(amount) || amount === 0) { alert('숫자를 넣어 주세요.'); return; }
      var memo = prompt('사유 (원장에 남습니다)',
        amount === BOUNTY ? '버그 제보 보상' : '운영 지급') || '';
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
  const b = await readJson(req) as { name?: unknown; endsAt?: unknown } | null;
  const cur = listSeasons().find(s => s.closed_at == null);
  if (!cur) return sendJson(res, 400, { error: '진행 중인 시즌이 없습니다' });
  const endsAt = b?.endsAt == null ? null : Math.floor(Number(b.endsAt));
  const ok = updateSeason(cur.id, {
    name: String(b?.name ?? '').slice(0, 40),
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
    buyIn: n('buyIn'),
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

/** 돈으로 쓰일 값은 정수 0 이상만 받는다. NaN·음수·소수가 원장까지 흘러가면 안 된다. */
function clampMoney(v: unknown): number {
  const n = Math.floor(Number(v ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 판의 모양(칩·블라인드·레이트 레지·대기)을 요청에서 골라낸다.
 *
 * 안 보낸 값은 키 자체를 빼서 넘긴다 — undefined 를 넣어 보내면 createTournament 의
 * `?? 템플릿값` 이 그대로 먹지만, "안 보냈다"와 "0을 보냈다"를 여기서 갈라 두지 않으면
 * 0 이 조용히 템플릿 값으로 바뀐다. 0 은 잘못된 입력이고 거절돼야 하는 값이다.
 */
function ruleFields(b: Record<string, unknown> | null):
  { startingStack?: number; levelMin?: number; lateRegMin?: number; graceMin?: number } {
  const out: Record<string, number> = {};
  for (const k of ['startingStack', 'levelMin', 'lateRegMin', 'graceMin'] as const) {
    if (b?.[k] != null) out[k] = Math.floor(Number(b[k]));
  }
  return out;
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
    /* 참가비는 사람의 잔액에서 실제로 빠져나가는 돈이다. 음수·소수·NaN 이 들어오면
       그대로 원장에 남으므로 여기서 정수 0 이상으로 못 박는다. */
    buyIn: clampMoney(b?.buyIn),
    prizeFixed: clampMoney(b?.prizeFixed),
    /* 대회 종류. 정확히 'PKO_BOUNTY' 일 때만 바운티 판이고 나머지는 전부 일반 판이다 —
       모르는 값이 바운티로 읽히면 걷은 돈이 갈 곳을 잃는다(db 쪽도 같은 판단을 한다). */
    mode: b?.mode === 'PKO_BOUNTY' ? 'PKO_BOUNTY'
      : b?.mode === 'MYSTERY_BOUNTY' ? 'MYSTERY_BOUNTY' : 'CLASSIC',
    /* 바운티 몫(%). 범위 밖 값은 db 쪽이 다시 다듬는다 — 화면을 거치지 않는 경로가 있다 */
    bountyPct: b?.bountyPct != null ? Math.floor(Number(b.bountyPct)) : undefined,
    /* 판의 모양은 안 보내면 템플릿을 쓴다(반복 개최가 그 길이다). 화면은 늘 채워 보내므로
       손으로 여는 판은 화면에 적힌 그대로 열린다 — 템플릿을 나중에 고쳐도 안 흔들린다. */
    ...ruleFields(b),
  });
  if (!r.ok) return sendJson(res, 400, { error: createErrorText(r) });
  return sendJson(res, 200, { ok: true, id: r.id });
}

/* 왜 안 되는지를 그대로 적는다. "만들 수 없습니다"만 나오면 운영자는 무엇을 기다려야
   하는지 알 수 없다 — 곧 시작할 판 때문이라면 그 시각을 알려 주는 것이 답이다. */
function createErrorText(
  r: { error: 'live_exists' } | { error: 'too_close'; startsAt: number } | { error: 'bad_time' }
    | { error: 'bad_rules'; detail: string }
): string {
  if (r.error === 'live_exists') return '지금 돌고 있는 대회가 있습니다 — 끝난 뒤에 만들 수 있습니다';
  if (r.error === 'bad_time') return '등록 시작이 대회 시작보다 늦습니다 — 아무도 신청할 수 없는 대회가 됩니다';
  if (r.error === 'bad_rules') return r.detail;
  const at = new Date((r.startsAt + 9 * 3600) * 1000).toISOString().slice(11, 16);
  return `곧 시작할 대회가 있습니다 (${at} 시작) — 한 판이 두 시간까지 갈 수 있어서,`
    + ' 다음 대회 시작까지 두 시간 이상 남았을 때만 새로 만들 수 있습니다';
}

/**
 * 시즌 종료 예약.
 *
 * 예약해 두면 그 시각이 지난 뒤 첫 요청에서 시즌이 넘어간다 — 전원의 잔액이 초기화되는
 * 동작이라, 저장은 운영 토큰을 지난 요청만 받는다(라우터가 이미 막는다).
 */
export async function handleAdminSeasonSchedule(
  req: IncomingMessage, res: ServerResponse
): Promise<void> {
  const b = await readJson(req) as Record<string, unknown> | null;
  /* 시각을 안 주면 예약 취소로 본다 — 빈 칸을 저장했는데 옛 예약이 남아 있으면
     지웠다고 생각한 사람이 그대로 넘어가는 것을 보게 된다. */
  if (b?.closeAt == null || b.closeAt === '') {
    clearSeasonSchedule();
    return sendJson(res, 200, { ok: true, cleared: true });
  }
  const r = saveSeasonSchedule({
    closeAt: Math.floor(Number(b.closeAt)),
    nextName: String(b.nextName ?? ''),    seed: Math.floor(Number(b.seed ?? 0)),
  });
  if (!r.ok) return sendJson(res, 400, { error: r.error });
  return sendJson(res, 200, { ok: true });
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
