// 그래프게임(크래시): 배율이 시간에 따라 지수적으로 상승하다 정해진 지점에서 터진다.
// 유저는 터지기 전에 캐시아웃하면 그 시점 배율로 정산, 못 하면 베팅액을 잃는다.
// 사다리처럼 여러 유저가 같은 라운드에 함께 참여하고 서로의 캐시아웃이 실시간으로 보인다.
//
// [업계 표준 설정]
//  - 크래시 지점: P(배율 ≥ m) = (1 - 하우스엣지) / m  를 만족하도록 뽑는다.
//    → 어느 배율에서 캐시아웃해도 기대값 = m × (0.99/m) = 0.99 로 하우스엣지가 정확히 1%가 된다.
//  - 상승 곡선: 배율 = e^(0.00006 × 경과ms)  (5초 1.35배 / 10초 1.82배 / 30초 6.05배)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import {
  advanceCrashRound, placeCrashBet, cancelCrashBet, cashoutCrashBet,
  getCrashBets, getMyCrashBet, getRecentCrashResults, getWebUser, seasonGameProfit,
  CRASH_REVEAL_SEC,
  type CrashRoundRow, type WebUser,
  chatTick,
} from '../../db/queries';
import { readJson, sendJson } from '../http';
import { award, withUnlocked, withCommon, commonAwards } from '../achieve-hook';
import { layout, jsonForScript, ROSTER_JS, sidePanel, rankPane, rankJs, helpDialog } from '../views';
import { gameSwitcher } from '../pages';

const HOUSE_EDGE = 0.01;
export const MAX_CRASH = 10_000; // 최대 배율 (이론상 무한대라 상한을 둔다)

// 상승 곡선은 구간별로 가속한다. 기본 구간은 업계 표준 속도(e^0.00006t)를 쓰고,
// 100배·1000배를 넘어가면 속도를 올려서 고배율까지 가는 시간이 지나치게 늘어지지 않게 한다.
//   1~100배   : k1 (표준)          → 100배 도달 약 76.7초
//   100~1000배: k1×3               → 1000배까지 +12.8초
//   1000배 이상: k1×6              → 10000배까지 +6.4초
// 배율 자체는 경계에서 연속이고(값이 튀지 않음) 기울기만 커진다.
export const GROWTH_K1 = 0.00006;
export const GROWTH_K2 = GROWTH_K1 * 3;
export const GROWTH_K3 = GROWTH_K1 * 6;
export const ACCEL_M1 = 100;
export const ACCEL_M2 = 1000;
export const ACCEL_T1 = Math.log(ACCEL_M1) / GROWTH_K1;                       // 100배 도달 시각(ms)
export const ACCEL_T2 = ACCEL_T1 + Math.log(ACCEL_M2 / ACCEL_M1) / GROWTH_K2; // 1000배 도달 시각(ms)

// 암호학적으로 안전한 난수로 균등분포 U∈[0,1) 생성 (Math.random 금지).
// randomInt는 (max - min) ≤ 2^48-1 만 허용하므로 2^47을 상한으로 쓴다.
// U는 0이 되면 안 되므로(0으로 나눔) 1..RAND_DENOM 범위로 만들어 (0,1] 을 보장한다.
const RAND_DENOM = 2 ** 47;
function randomUnit(): number {
  return (randomInt(0, RAND_DENOM) + 1) / RAND_DENOM;
}

// 크래시 지점 = (1 - 하우스엣지) / U,  U ~ Uniform(0,1]
//  → P(배율 ≥ m) = P(U ≤ 0.99/m) = 0.99/m  (m > 1)
//  → raw < 1 이 되는 확률이 정확히 하우스엣지(1%)다.
//
// 다만 화면에 1.00x 로 보이는 판은 그보다 잦다 — 실측 약 1.98%. 마지막 줄에서 배율을
// 소수 둘째 자리로 내리기 때문에, raw 가 [1, 1.01) 인 판도 1.00x 가 된다.
//   P(raw < 1.01) = P(u > 0.99/1.01) = 1.98%
// 버그가 아니라 내림의 결과다(내림은 언제나 하우스 쪽이라 엣지가 조금 커질 뿐 작아지지
// 않는다). 여기 적어 두는 이유는 "1% 인데 왜 이렇게 자주 터지나" 라는 물음이 실제로
// 나왔고, 코드만 보면 1% 라고 읽히기 때문이다.
// 주의: 분모는 반드시 U여야 한다. (1-U)를 쓰면서 U 상단을 즉시 크래시로 잘라내면
// 고배율이 나오는 구간을 통째로 날려버려 최대 배율이 막히고 하우스엣지도 어긋난다.
export function makeCrashPoint(): number {
  const u = randomUnit();
  const raw = (1 - HOUSE_EDGE) / u;
  if (!Number.isFinite(raw) || raw < 1) return 1.0;
  return Math.min(MAX_CRASH, Math.floor(raw * 100) / 100);
}

// 경과 시간 → 배율 (양자화 없는 실수). 구간별 가속이 적용된다.
export function rawMultiplierAt(elapsedMs: number): number {
  if (elapsedMs <= 0) return 1.0;
  if (elapsedMs <= ACCEL_T1) return Math.exp(GROWTH_K1 * elapsedMs);
  if (elapsedMs <= ACCEL_T2) return ACCEL_M1 * Math.exp(GROWTH_K2 * (elapsedMs - ACCEL_T1));
  return ACCEL_M2 * Math.exp(GROWTH_K3 * (elapsedMs - ACCEL_T2));
}

// 정산 기준 배율 — 소수점 2자리 내림(반올림하지 않음). 예: 1.859 → 1.85
export function multiplierAt(elapsedMs: number): number {
  return Math.floor(rawMultiplierAt(elapsedMs) * 100) / 100;
}

// 배율 → 그 배율에 도달하는 시각(ms). rawMultiplierAt의 역함수여야 한다.
function crashDurationMs(crashPoint: number): number {
  if (crashPoint <= 1) return 0;
  if (crashPoint <= ACCEL_M1) return Math.log(crashPoint) / GROWTH_K1;
  if (crashPoint <= ACCEL_M2) return ACCEL_T1 + Math.log(crashPoint / ACCEL_M1) / GROWTH_K2;
  return ACCEL_T2 + Math.log(crashPoint / ACCEL_M2) / GROWTH_K3;
}

/* 서버 전진 타이머(src/tick.ts)도 이 함수를 부른다. 헬퍼를 밖으로 열지 않고
   이 한 함수만 내보내는 이유가 그것이다 — 어떤 규칙으로 전진하는지는 이 모듈이
   쥐고 있어야 하고, 부르는 쪽은 "그래프을 전진시켜라"만 알면 된다. */
export function advance(): CrashRoundRow {
  return advanceCrashRound({ makeCrashPoint, crashDurationMs, multiplierAt });
}

function statePayload(round: CrashRoundRow, userId: string) {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const myBet = getMyCrashBet(round.id, userId);

  // 진행 중에는 crash_point를 절대 내려보내지 않는다 (미리 알면 게임이 성립하지 않음)
  const done = round.phase === 'done';
  return {
    ok: true,
    round: {
      id: round.id,
      phase: round.phase,
      // 베팅 구간: 마감까지 남은 초 / 공개 구간: 다음 라운드까지 남은 초
      secondsLeft: round.phase === 'betting'
        ? Math.max(0, round.betting_ends_at - nowSec)
        : done ? Math.max(0, (round.resolved_at ?? nowSec) + CRASH_REVEAL_SEC - nowSec) : 0,
      startedAtMs: round.started_at_ms,
      serverNowMs: nowMs,
      multiplier: round.phase === 'running' ? multiplierAt(nowMs - (round.started_at_ms ?? nowMs)) : null,
      crashPoint: done ? round.crash_point : null,
    },
    bets: getCrashBets(round.id),
    myBet: myBet ?? null,
    history: getRecentCrashResults(15),
    balance: getWebUser(userId)?.balance ?? 0,
    /* 채팅은 폴링을 새로 만들지 않는다 — 이 숫자 하나(마지막 메시지 id)만 얹고,
       화면은 값이 늘었을 때만 /api/chat 을 부른다. 조용하면 요청이 안 는다. */
    ...chatTick(),
  };
}

export async function handleState(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const payload = statePayload(advance(), userId);
  return sendJson(res, 200, { ...payload, ...crashAwards(userId, payload.myBet) });
}

/* ── 도전과제 ──────────────────────────────────────────────────────────
   캐시아웃 자리가 아니라 상태 응답에서 본다. 자동 캐시아웃은 라운드를 전진시키는 쪽에서
   정산되므로(누구의 요청인지도 정해져 있지 않다) 캐시아웃 핸들러에만 붙이면 그 경로가
   통째로 빠진다. 상태는 1초마다 오므로 어느 쪽으로 나갔든 곧바로 잡힌다.

   매 폴링마다 도는 자리라 값싸야 한다. 그래서 이미 응답에 들어 있는 값(내 베팅)으로
   먼저 거르고, 그 문을 지난 경우에만 db 를 본다 — 100배는 1%도 안 되는 판이라
   실제로 아래 조회가 도는 일은 거의 없다. */
const CRASH_X100 = 100;
const CRASH_PROFIT_GOAL = 1_000_000;
/* 0.01초의 광기 — 올라가자마자, 곧 가장 낮은 배당에서 손을 뗀다.
   1.01x 는 자동 캐시아웃의 하한이기도 해서(handleBet), 예약을 걸어 두면 누구나 얻는다.
   그래서 "자동으로 나간 판"은 세지 않는다 — 자동 정산은 배율을 예약값 그대로 적으므로
   (settleAutoCashouts) 두 값이 정확히 같으면 손이 아니라 예약이 판을 끝낸 것이다.
   1.01x 예약을 걸어 둔 사람이 그 순간 손으로 눌러도 안 열리지만, 그 판은 애초에
   "예약이 잡아 줄 판"이라 손으로 해냈다고 하기 어렵다.

   "정확히 1.01" 이 아니라 "1.01 이하" 다. 정확히로 두었더니 사실상 불가능했다 —
   배율 곡선(GROWTH_K1)으로 재면 1.01x 로 기록되는 구간이 라운드 시작 후 166~330ms,
   즉 폭이 164ms 뿐이다. 게다가 서버는 요청이 도착한 순간으로 배율을 다시 계산하므로
   (handleCashout) 화면에 1.01 이 보여서 눌러도 왕복 지연만큼 지나간 값이 찍힌다.
   실제로 1.01 을 보고 눌렀는데 안 열렸다는 제보가 왔다.

   이하로 두면 1.00x 까지 포함되어 창이 330ms 로 두 배가 된다. 1.00x 캐시아웃은 순이익이
   0 이라 오히려 이 과제의 이름에 더 맞는다 — 돈을 벌려고 누르는 것이 아니다.
   위쪽은 여전히 막혀 있다: 1.02 부터는 열리지 않으므로 "모든 캐시아웃이 걸린다"가 되지
   않는다(>= 로 적었다면 그렇게 됐을 것이다). */
const CRASH_MIN_X = 1.01;

function crashAwards(
  userId: string,
  myBet: { amount: number; cashout_multiplier: number | null; auto_cashout: number | null } | null,
) {
  // 이번 라운드에 캐시아웃한 판만 본다. 안 걸었거나 터진 판은 볼 것이 없다.
  // 안 걸었거나 터진 판에도 공통 과제는 봐야 한다 — 되살아난 것은 그 판과 무관하다
  if (!myBet || myBet.cashout_multiplier == null) return withUnlocked(commonAwards(userId));
  /* 손으로 뺐는가. 예약이 걸려 있지 않았거나, 걸려 있어도 그 배율이 아니면 손이다.
     시즌 마감 강제 환불은 두 값을 똑같이 1 로 적어 두므로 여기서 손이 아닌 것으로
     걸러진다 — 안 그러면 아무것도 안 한 사람에게 1.01배 히든 과제가 열렸다. */
  const byHand = myBet.auto_cashout == null || myBet.cashout_multiplier !== myBet.auto_cashout;
  const checks: [string, () => boolean][] = [];
  if (myBet.cashout_multiplier >= CRASH_X100) checks.push(['crash-x100', () => true]);
  if (byHand && myBet.cashout_multiplier <= CRASH_MIN_X) checks.push(['crash-x1-01', () => true]);
  /* 순수익은 캐시아웃한 판에만 오를 수 있다 — 잃어서 100만을 넘길 수는 없으므로
     여기서만 재면 된다.
     통산이 아니라 이번 시즌 값을 본다. 화면의 랭킹이 시즌 장부를 쓰기 때문이다 —
     사람이 보고 있는 순수익과 과제가 재는 순수익이 다르면, 랭킹에 100만이라고 적혀
     있는데 과제는 안 열리는 일이 생긴다. 달성 기록 자체는 시즌과 무관하게 영구히 남는다. */
  checks.push(['crash-profit-1m', () => seasonGameProfit(userId, 'graph') >= CRASH_PROFIT_GOAL]);
  return withCommon(userId, award(userId, myBet.amount, checks));
}

export async function handleBet(req: IncomingMessage, res: ServerResponse, userId: string, username: string): Promise<void> {
  // 본문 파싱(await)을 먼저 — 검증과 쓰기 사이에 await가 끼면 그 틈에 라운드가 넘어갈 수 있다
  const data = await readJson(req);
  const amount = Math.floor(Number(data?.betAmount));
  if (!Number.isFinite(amount) || amount < 1) return sendJson(res, 400, { error: '베팅 금액은 1P 이상이어야 합니다' });

  // 자동 캐시아웃(선택): 1.01배 이상만 의미가 있다 (1.00은 즉시 환불과 같아 게임이 성립하지 않음)
  let autoCashout: number | null = null;
  if (data?.autoCashout != null && data.autoCashout !== '') {
    const a = Math.floor(Number(data.autoCashout) * 100) / 100;
    if (!Number.isFinite(a) || a < 1.01) return sendJson(res, 400, { error: '자동 캐시아웃 배율은 1.01x 이상이어야 합니다' });
    autoCashout = Math.min(a, MAX_CRASH);
  }

  const round = advance();
  if (round.phase !== 'betting') return sendJson(res, 400, { error: '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.' });

  const result = placeCrashBet(userId, username, round.id, amount, autoCashout);
  if (!result.ok) {
    const msg = result.error === 'already_bet' ? '이번 라운드에는 이미 베팅했습니다'
      : result.error === 'closed' ? '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.'
      : '잔액이 부족합니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, balance: result.balance });
}

export async function handleCancel(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = advance();
  const result = cancelCrashBet(userId, round.id);
  if (!result.ok) {
    const msg = result.error === 'no_bet' ? '취소할 베팅이 없습니다' : '이미 시작되어 취소할 수 없습니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, balance: result.balance });
}

// 캐시아웃: 배율은 오직 서버 시간으로 계산한다. 클라이언트가 보낸 배율은 신뢰하지 않는다.
export async function handleCashout(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = advance();
  if (round.phase !== 'running') {
    return sendJson(res, 400, { error: round.phase === 'betting' ? '아직 시작하지 않았습니다' : '이미 터졌습니다' });
  }
  const elapsed = Date.now() - (round.started_at_ms ?? Date.now());
  const multiplier = multiplierAt(elapsed);
  // 이미 크래시 지점을 넘겼다면(지연 진행 특성상 아직 done 처리가 안 됐을 수 있음) 캐시아웃 불가
  if (multiplier >= round.crash_point) return sendJson(res, 400, { error: '이미 터졌습니다' });

  const result = cashoutCrashBet(userId, round.id, multiplier);
  if (!result.ok) {
    const msg = result.error === 'no_bet' ? '이번 라운드에 베팅하지 않았습니다' : '이미 캐시아웃했습니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, balance: result.balance, payout: result.payout, multiplier });
}

/* 규칙 도움말. 숫자는 코드 상수에서 온다 —
   HOUSE_EDGE 0.01 · MAX_CRASH 10,000 · CRASH_BETTING_SEC 10. */
const RULES_HTML = `
  <h4>목표</h4>
  <p>배율이 <b>1배부터 계속 오릅니다.</b> 터지기 전에 캐시아웃하면 그 배율만큼 받고,
     못 하면 전액을 잃습니다.</p>

  <h4>진행</h4>
  <ul>
    <li>베팅 <b>10초</b> → 배율 상승 → 터짐 → 다시 베팅</li>
    <li>상승 중에는 언제든 <b>캐시아웃</b>할 수 있습니다. 누른 순간의 배율로 확정됩니다</li>
    <li><b>자동 캐시아웃</b>에 배율을 적어 두면 그 배율에서 알아서 빠집니다 (1.01배 이상)</li>
    <li>터지는 지점은 판이 시작되기 <b>전에</b> 이미 정해져 있습니다 — 오래 버틴다고 불리해지지 않습니다</li>
  </ul>

  <h4>배당</h4>
  <table>
    <tr><td>캐시아웃하면</td><td>그 순간 배율 × 베팅액</td></tr>
    <tr><td>터질 때까지 못 누르면</td><td>0</td></tr>
    <tr><td>최대 배율</td><td>10,000 배</td></tr>
  </table>

  <p class="tip"><b>꿀팁 —</b> 목표 배율을 정했다면 손으로 누르지 말고
     <b>자동 캐시아웃에 적어 두는 쪽이 유리합니다.</b>
     정확히 그 배율에서 터진 경우, 자동은 성공으로 처리되지만 손으로 누르면 이미 늦습니다.<br>
     그 점만 빼면 2배에서 자주 빼든 100배를 노리든 되돌려받는 비율은 같습니다 —
     차이는 <b>얼마나 자주 이기느냐</b>뿐입니다.</p>

  <div class="warn"><b>주의 —</b> 배율은 <b>1.00배에서도</b> 터질 수 있습니다.
  "조금만 더"가 이 게임에서 돈을 잃는 유일한 방법입니다.</div>

  <h4>이 판의 규격</h4>
  <p class="spec">최대 배율 10,000배 · 자동 캐시아웃</p>
`;

export function crashPage(user: WebUser): string {
  const body = `
    ${gameSwitcher('graph', 'cgHelp')}
    <div class="game-shell">
      <div class="game-main">
        <div class="card">
          <div id="cHistory" class="hist-row"></div>
          <div class="crash-stage">
            <div class="crash-center">
              <div id="cCrashLabel" class="crash-label">CRASHED</div>
              <div id="cBetLabel" class="crash-betlabel">베팅 시간</div>
              <div id="cMulti" class="crash-multi">1.000x</div>
              <div id="cStatus" class="crash-status"></div>
            </div>
            <!-- preserveAspectRatio="none": 상자가 주는 만큼 늘어난다.
                 세로·데스크톱에서는 CSS 가 height:auto 라 상자 비율이 viewBox 와 같고,
                 그래서 아무것도 안 달라진다. 달라지는 곳은 가로 폰 하나다 —
                 거기서는 높이가 75px 밖에 안 나오는데 svg 는 제 비율대로 150px 을
                 고집해서 아래 34px(축 글자 줄)이 잘렸다(실측).
                 이건 사진이 아니라 판이다. 가로세로가 각각 선형으로 늘어나는 것은
                 눈금이 말하는 바를 바꾸지 않는다 — 잘려서 안 보이는 것과 다르다. -->
            <svg id="cGraph" class="crash-graph" viewBox="0 0 660 250" preserveAspectRatio="none">
              <g id="cGrid"></g>
              <path id="cArea" class="crash-area" d=""></path>
              <path id="cCurve" class="crash-curve" d=""></path>
              <circle id="cTip" class="crash-tip" r="5" cx="-20" cy="-20"></circle>
            </svg>
          </div>
        </div>
        <div class="card game-controls">
          <div class="mode-tabs">
            <button type="button" class="mode-tab active" id="cModeManual">수동</button>
            <button type="button" class="mode-tab" id="cModeAuto">자동 캐시아웃</button>
          </div>
          <div class="field-grid">
            <div class="field">
              <label>베팅 수량 (P)</label>
              <div class="bet-row">
                <input id="cBet" class="game-input" type="number" min="1" step="1" value="10">
                <button type="button" class="chip-btn" id="cHalf">½</button>
                <button type="button" class="chip-btn" id="cDouble">2×</button>
              </div>
              <div class="quick-row">
                <button type="button" class="chip-btn wide" data-amt="10">10</button>
                <button type="button" class="chip-btn wide" data-amt="100">100</button>
                <button type="button" class="chip-btn wide" data-amt="1000">1000</button>
                <button type="button" class="chip-btn wide" data-amt="10000">1만</button>
              </div>
            </div>
            <div class="field" id="cAutoField">
              <label>자동 캐시아웃 (배율)</label>
              <div class="bet-row">
                <input id="cAuto" class="game-input" type="number" min="1.01" step="0.01" placeholder="2.00" disabled>
              </div>
              <div class="quick-row">
                <button type="button" class="chip-btn wide auto-q" data-mult="1.5" disabled>1.50x</button>
                <button type="button" class="chip-btn wide auto-q" data-mult="2" disabled>2.00x</button>
                <button type="button" class="chip-btn wide auto-q" data-mult="5" disabled>5.00x</button>
                <button type="button" class="chip-btn wide auto-q" data-mult="10" disabled>10.00x</button>
              </div>
            </div>
          </div>
          <button id="cPlay" class="btn btn-primary game-action" type="button">베팅하기</button>
          <button id="cCancel" class="btn game-action" type="button" style="display:none">베팅 취소</button>
          <button id="cCashout" class="btn btn-primary game-action" type="button" style="display:none">캐시아웃</button>
          <p id="cMsg" class="game-msg"></p>
        </div>
      </div>
      ${sidePanel('c', `
        <div class="side-head">
          <span id="cCashCount">0/0 캐시아웃</span>
          <span id="cPot" class="num">0P</span>
        </div>
        <div id="cFeed" class="roster"><div class="empty" style="padding:16px 0">아직 베팅이 없습니다</div></div>
      `, rankPane('c'))}
    </div>
    <script>window.__ME__ = ${jsonForScript(user.username)}; window.__MEID__ = ${jsonForScript(user.id)}; window.__SFX_NEED__ = ['fanfare'];
      window.__CHAT_WHERE__ = 'crash';</script>
    <script>
    (function(){
    ${ROSTER_JS}
      var betInput=document.getElementById('cBet'), autoInput=document.getElementById('cAuto');
      var halfBtn=document.getElementById('cHalf'), doubleBtn=document.getElementById('cDouble');
      var modeManual=document.getElementById('cModeManual'), modeAuto=document.getElementById('cModeAuto');
      var playBtn=document.getElementById('cPlay'), cancelBtn=document.getElementById('cCancel'), cashoutBtn=document.getElementById('cCashout');
      var multiEl=document.getElementById('cMulti'), statusEl=document.getElementById('cStatus');
      var crashLabel=document.getElementById('cCrashLabel'), betLabel=document.getElementById('cBetLabel');
      var tip=document.getElementById('cTip');
      var feed=document.getElementById('cFeed'), historyEl=document.getElementById('cHistory');
      var cashCountEl=document.getElementById('cCashCount'), potEl=document.getElementById('cPot');
      var msg=document.getElementById('cMsg'), curve=document.getElementById('cCurve'), area=document.getElementById('cArea');
      var grid=document.getElementById('cGrid'), stage=document.querySelector('.crash-stage');
      var pbal=document.querySelector('.prof .pbal');
      /* 캐시아웃 성공 연출이 쓰는 본문 카드. 선언이 빠져 있어서 캐시아웃할 때마다
         ReferenceError가 나고 그 뒤의 잔액 bump·승리음·poll()이 통째로 건너뛰어졌다.
         다른 다섯 게임은 모두 이 선언을 갖고 있다. */
      var card=document.querySelector('.card');

      // 서버와 동일한 구간별 가속 상수를 주입해 표시 배율이 정산 배율과 절대 어긋나지 않게 한다
      var K1=${GROWTH_K1}, K2=${GROWTH_K2}, K3=${GROWTH_K3};
      var M1=${ACCEL_M1}, M2=${ACCEL_M2}, T1=${ACCEL_T1}, T2=${ACCEL_T2};
      var st = null;         // 최근 서버 상태
      var clockOffset = 0;   // 서버시간 - 로컬시간 (로컬 시계가 틀려도 배율이 어긋나지 않게 보정)
      var rafId = null, lastRoundId = null, notedRoundId = null, startedRoundId = null;
      var autoMode = false;

      function fmt(n){ return new Intl.NumberFormat('ko-KR').format(Math.floor(n)) + 'P'; }
      function setBalance(n){ if(pbal && typeof n === 'number') pbal.textContent = fmt(n); }
      function replay(el, cls){ el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
      function currentBalance(){ if(!pbal) return 0; return parseInt(pbal.textContent.replace(/[^0-9]/g,''),10) || 0; }
      function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
      // 배율은 세 가지 용도로 나눠 쓴다:
      //  multRaw : 양자화 없는 연속값 — 곡선/축 계산용 (2자리로 자르면 초반에 계단처럼 보인다)
      //  mult3   : 화면 표시용 3자리 (내림)
      //  multAt  : 실제 정산 기준 2자리 (내림) — 서버와 동일한 규칙. 예: 1.8599 → 1.85
      function multRaw(ms){
        if (ms <= 0) return 1;
        if (ms <= T1) return Math.exp(K1 * ms);
        if (ms <= T2) return M1 * Math.exp(K2 * (ms - T1));
        return M2 * Math.exp(K3 * (ms - T2));
      }
      function timeToReach(m){
        if (m <= 1) return 0;
        if (m <= M1) return Math.log(m) / K1;
        if (m <= M2) return T1 + Math.log(m / M1) / K2;
        return T2 + Math.log(m / M2) / K3;
      }
      function mult3(ms){ return Math.floor(multRaw(ms) * 1000) / 1000; }
      function multAt(ms){ return Math.floor(multRaw(ms) * 100) / 100; }
      function serverNow(){ return Date.now() + clockOffset; }

      function savePrefs(){
        try{
          localStorage.setItem('crash_bet', betInput.value);
          localStorage.setItem('crash_auto', autoInput.value);
          localStorage.setItem('crash_mode', autoMode ? 'auto' : 'manual');
        }catch(e){}
      }
      function loadPrefs(){
        try{
          var b=localStorage.getItem('crash_bet'); if(b) betInput.value=b;
          var a=localStorage.getItem('crash_auto'); if(a) autoInput.value=a;
          if (localStorage.getItem('crash_mode')==='auto') setMode(true);
        }catch(e){}
      }
      function setBet(n){ if(betInput.disabled) return; betInput.value=Math.max(1, Math.floor(n)); savePrefs(); }

      function setMode(auto){
        autoMode = auto;
        modeAuto.classList.toggle('active', auto);
        modeManual.classList.toggle('active', !auto);
        autoInput.disabled = !auto;
        document.querySelectorAll('.auto-q').forEach(function(b){ b.disabled = !auto; });
        savePrefs();
      }
      modeManual.addEventListener('click', function(){ setMode(false); });
      modeAuto.addEventListener('click', function(){ setMode(true); });
      halfBtn.addEventListener('click', function(){ setBet(Number(betInput.value)/2); });
      doubleBtn.addEventListener('click', function(){ setBet(Number(betInput.value)*2); });
      // 빠른 금액 버튼은 칩을 쌓듯 현재 금액에 "더한다" (교체하지 않음)
      document.querySelectorAll('.chip-btn[data-amt]').forEach(function(b){
        b.addEventListener('click', function(){
          setBet((Number(betInput.value) || 0) + Number(b.getAttribute('data-amt')));
        });
      });
      document.querySelectorAll('.auto-q').forEach(function(b){
        b.addEventListener('click', function(){ autoInput.value = Number(b.getAttribute('data-mult')).toFixed(2); savePrefs(); });
      });
      betInput.addEventListener('change', savePrefs);
      autoInput.addEventListener('change', savePrefs);
      loadPrefs();

      function lockBetControls(locked){
        betInput.disabled = locked;
        halfBtn.disabled = doubleBtn.disabled = locked;
        document.querySelectorAll('.chip-btn[data-amt]').forEach(function(b){ b.disabled = locked; });
        modeManual.disabled = modeAuto.disabled = locked;
        autoInput.disabled = locked || !autoMode;
        document.querySelectorAll('.auto-q').forEach(function(b){ b.disabled = locked || !autoMode; });
      }

      function historyClass(m){ return m < 2 ? 'low' : (m < 10 ? 'mid' : 'high'); }
      // 목록은 최신순(왼쪽이 가장 최근). 폭이 부족하면 오른쪽(오래된 결과)부터 잘리므로 스크롤을 옮기지 않는다.
      function renderHistory(list){
        historyEl.innerHTML = (list||[]).map(function(m){
          return '<span class="ch-chip '+historyClass(m)+'">'+m.toFixed(2)+'x</span>';
        }).join('');
      }

      // 우측 실시간 목록: 캐시아웃한 사람은 초록 배율, 터진 사람은 흐리게 표시
      function renderFeed(bets, phase){
        var total = 0, cashed = 0;
        bets.forEach(function(b){ total += b.amount; if (b.cashout_multiplier != null) cashed++; });
        cashCountEl.textContent = cashed + '/' + bets.length + ' 캐시아웃';
        potEl.textContent = fmt(total);

        renderRosterRows(feed, bets, window.__MEID__, function(b){
          var mid;
          if (b.cashout_multiplier != null) mid = '<span class="cash-out">'+b.cashout_multiplier.toFixed(2)+'x</span>';
          else if (b.payout === 0) mid = '<span class="cash-bust">\\u2739</span>';        // 터진 표시
          else if (b.auto_cashout != null) mid = '<span class="cash-pending">@'+b.auto_cashout.toFixed(2)+'x</span>';
          else mid = '<span class="cash-pending">-</span>';
          var amt = (b.cashout_multiplier != null)
            ? '<span class="pos">+'+fmt(b.payout)+'</span>' : fmt(b.amount);
          return '<span class="rw-tag">'+mid+'</span><span class="rw-amt">'+amt+'</span>';
        });
      }

      // ----- 그래프 -----
      // 축은 처음 "세로 1.5배 / 가로 8초"에서 시작하고, 배율이 오르면 목표치를 향해 매 프레임 조금씩
      // 보간(lerp)하며 연속적으로 확대된다. 눈금 최대값을 1.5→2→2.5처럼 단계로 점프시키면 화면이
      // 뚝뚝 끊겨 보이므로, 최대값은 연속으로 움직이고 격자선만 "보기 좋은 간격"의 배수에 그린다.
      var VW=660, VH=250, PADL=52, PADB=24, PADT=12, PADR=14;
      var INIT_M = 1.5, INIT_SEC = 8;

      function tickStepM(range){
        var steps=[0.1,0.25,0.5,1,2,2.5,5,10,20,25,50,100,200,250,500,1000,2000,5000];
        for (var i=0;i<steps.length;i++) if (range/steps[i] <= 5) return steps[i];
        return steps[steps.length-1];
      }
      function tickStepSec(maxSec){
        var steps=[2,5,10,15,30,60,120,300,600];
        for (var i=0;i<steps.length;i++) if (maxSec/steps[i] <= 5) return steps[i];
        return steps[steps.length-1];
      }
      function px(t, maxT){ return PADL + (VW-PADL-PADR) * (t/maxT); }
      function py(m, maxM){ return VH-PADB - (VH-PADB-PADT) * ((m-1)/(maxM-1)); }

      // 표본점들을 Catmull-Rom → 3차 베지어로 변환해 실제 곡선처럼 부드럽게 잇는다
      function smoothPath(p){
        if (p.length < 2) return '';
        var d = 'M' + p[0][0].toFixed(2) + ' ' + p[0][1].toFixed(2);
        for (var i=0;i<p.length-1;i++){
          var p0 = p[i>0 ? i-1 : 0], p1 = p[i], p2 = p[i+1], p3 = p[i+2<p.length ? i+2 : i+1];
          var c1x = p1[0] + (p2[0]-p0[0])/6, c1y = p1[1] + (p2[1]-p0[1])/6;
          var c2x = p2[0] - (p3[0]-p1[0])/6, c2y = p2[1] - (p3[1]-p1[1])/6;
          d += 'C' + c1x.toFixed(2)+' '+c1y.toFixed(2)+' '+c2x.toFixed(2)+' '+c2y.toFixed(2)+' '+p2[0].toFixed(2)+' '+p2[1].toFixed(2);
        }
        return d;
      }

      function drawGraph(mult, elapsedMs){
        // 축은 "배율/경과시간의 매끄러운 함수"로 매번 직접 계산한다.
        // 보간 상태(lerp)를 두고 하한 클램프까지 함께 밀면 두 힘이 매 프레임 미세하게 어긋나
        // 그래프 전체가 일렁이게 된다. 상태 없이 계산하면 배율이 연속이므로 축도 자동으로 연속이다.
        // 여유는 6%만 둬서 곡선 끝이 오른쪽 위 끝까지 차오른다.
        var elapsedSec = elapsedMs / 1000;
        var maxM = Math.max(INIT_M, mult * 1.06);
        var maxSec = Math.max(INIT_SEC, elapsedSec * 1.06);
        var maxT = maxSec * 1000;

        // 격자선: 최대값이 연속으로 변하므로 눈금은 "간격의 배수"에 그린다 → 선이 부드럽게 흐르며 지나간다
        var g = '', stepM = tickStepM(maxM - 1);
        for (var m = 1; m <= maxM + 1e-9; m += stepM) {
          var y = py(m, maxM);
          if (y < PADT - 1) break;
          g += '<line class="cg-line" x1="'+PADL+'" y1="'+y.toFixed(1)+'" x2="'+(VW-PADR)+'" y2="'+y.toFixed(1)+'"/>';
          g += '<text class="cg-lbl" x="'+(PADL-8)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end">'+m.toFixed(2)+'x</text>';
        }
        var stepS = tickStepSec(maxSec);
        for (var s = 0; s <= maxSec + 1e-9; s += stepS) {
          var x = px(s*1000, maxT);
          if (x > VW - PADR + 1) break;
          g += '<text class="cg-lbl" x="'+x.toFixed(1)+'" y="'+(VH-PADB+16)+'" text-anchor="middle">'+Math.round(s)+'s</text>';
        }
        grid.innerHTML = g;

        // 곡선 표본점은 "절대 시간 격자"에 고정한다.
        // 0~경과시간을 N등분하면 매 프레임 모든 점이 이동하고, 베지어 제어점이 전부 다시 계산되어
        // 곡선 전체가 일렁인다(점이 적은 저배율 구간에서 특히 심함). 격자를 고정하면 기존 점은
        // 그대로 있고 끝부분만 자라나므로 흔들림이 사라진다.
        var pts = [], SAMPLE_MS = 80;
        for (var t = 0; t < elapsedMs; t += SAMPLE_MS) {
          pts.push([px(t, maxT), py(multRaw(t), maxM)]);
        }
        pts.push([px(elapsedMs, maxT), py(multRaw(elapsedMs), maxM)]); // 항상 현재 끝점 포함
        var baseY = py(1, maxM);
        if (pts.length < 2) pts = [[px(0,maxT), baseY], [px(0,maxT), baseY]];
        var d = smoothPath(pts);
        curve.setAttribute('d', d);
        var last = pts[pts.length-1];
        area.setAttribute('d', d + 'L' + last[0].toFixed(2) + ' ' + baseY.toFixed(2) +
          'L' + px(0,maxT).toFixed(2) + ' ' + baseY.toFixed(2) + 'Z');
        tip.setAttribute('cx', last[0].toFixed(2));
        tip.setAttribute('cy', last[1].toFixed(2));
      }

      function tick(){
        rafId = null;
        if (!st || st.round.phase !== 'running' || st.round.startedAtMs == null) return;
        var elapsed = serverNow() - st.round.startedAtMs;
        multiEl.textContent = mult3(elapsed).toFixed(3) + 'x';   // 표시는 3자리
        drawGraph(multRaw(elapsed), elapsed);                     // 곡선은 연속값으로 → 초반 계단 현상 제거
        var my = st.myBet;
        if (my && my.cashout_multiplier == null && my.payout == null) {
          // 버튼의 예상 획득액은 실제 정산 기준(2자리 내림)으로 계산해 표시와 지급이 어긋나지 않게 한다
          cashoutBtn.textContent = '캐시아웃 ' + fmt(my.amount * multAt(elapsed));
        }
        rafId = requestAnimationFrame(tick);
      }
      function startTick(){ if (!rafId) rafId = requestAnimationFrame(tick); }
      function stopTick(){ if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

      function render(){
        var r = st.round, my = st.myBet;
        setBalance(st.balance);
        renderHistory(st.history);
        renderFeed(st.bets, r.phase);

        if (r.id !== lastRoundId) {
          lastRoundId = r.id;
          msg.innerHTML = '';
          // 주의: 여기서 그래프를 지우지 않는다. 베팅 구간에는 직전 라운드의 빨간 곡선을 그대로 남겨둔다.
        }

        if (r.phase === 'betting') {
          stopTick();
          crashLabel.style.display = 'none';
          betLabel.style.display = 'block';
          statusEl.textContent = '';
          // 큰 숫자를 카운트다운으로 사용 (직전 라운드의 빨간 곡선은 배경으로 유지)
          multiEl.textContent = r.secondsLeft + 's';
          multiEl.className = 'crash-multi betting';
          lockBetControls(!!my);
          playBtn.style.display = my ? 'none' : 'block';
          cancelBtn.style.display = my ? 'block' : 'none';
          cashoutBtn.style.display = 'none';
        } else if (r.phase === 'running') {
          // 상승 시작 시점에 비로소 이전 곡선을 지우고 축을 초기화한다
          if (startedRoundId !== r.id) {
            startedRoundId = r.id;
            stage.classList.remove('crashed');
            curve.setAttribute('d',''); area.setAttribute('d','');
            tip.setAttribute('cx','-20'); tip.setAttribute('cy','-20');
          }
          crashLabel.style.display = 'none';
          betLabel.style.display = 'none';
          statusEl.textContent = '';
          multiEl.className = 'crash-multi running';
          lockBetControls(true);
          playBtn.style.display = 'none';
          cancelBtn.style.display = 'none';
          var canCash = my && my.cashout_multiplier == null && my.payout == null;
          cashoutBtn.style.display = canCash ? 'block' : 'none';
          /* 서버가 대신 빼 준 경우에만 알린다.

             예전에는 "캐시아웃이 잡혀 있으면" 이 조건의 전부였다. 그래서 손으로 누른
             사람에게도 0.25초 뒤 폴링이 돌아오면서 방금 띄운 "캐시아웃 1.87x" 가
             "자동 캐시아웃 1.87x" 로 바뀌고 팡파르가 한 번 더 울렸다 — 자기가 누른
             것을 기계가 한 것처럼 말한다.

             예약이 실제로 발동한 판은 정산 배율이 예약 배율과 같다. 그 둘이 같을
             때만 자동이라고 말한다. */
          var byAuto = my && my.cashout_multiplier != null && my.auto_cashout != null
            && Math.abs(my.cashout_multiplier - my.auto_cashout) < 0.005;
          if (byAuto && notedRoundId !== r.id) {
            notedRoundId = r.id;
            msg.innerHTML = '<span style="color:var(--win);font-weight:700">자동 캐시아웃</span> ' +
              my.cashout_multiplier.toFixed(2) + 'x · +' + fmt(my.payout);
            if (window.casinoSfx) window.casinoSfx.win('fanfare');
          }
          startTick();
        } else { // done
          stopTick();
          crashLabel.style.display = 'block';
          betLabel.style.display = 'none';
          statusEl.textContent = '다음 라운드까지 ' + r.secondsLeft + '초';
          multiEl.textContent = r.crashPoint.toFixed(2) + 'x';
          multiEl.className = 'crash-multi crashed';
          stage.classList.add('crashed');
          lockBetControls(false);
          playBtn.style.display = 'block';
          cancelBtn.style.display = 'none';
          cashoutBtn.style.display = 'none';
          // 터진 뒤에는 축을 최종값에 고정해 결과 곡선을 그대로 남긴다
          drawGraph(r.crashPoint, timeToReach(r.crashPoint));

          if (notedRoundId !== r.id) {
            notedRoundId = r.id;
            if (my && my.cashout_multiplier != null) {
              msg.innerHTML = '<span style="color:var(--win);font-weight:700">캐시아웃 성공</span> — ' +
                my.cashout_multiplier.toFixed(2) + 'x · +' + fmt(my.payout) + ' (' + r.crashPoint.toFixed(2) + 'x에서 터짐)';
            } else if (my) {
              msg.innerHTML = '<span style="color:var(--lose);font-weight:700">' + r.crashPoint.toFixed(2) + 'x에서 터졌습니다</span> — 베팅액을 잃었습니다.';
              if (window.casinoSfx) window.casinoSfx.lose();
            }
          }
        }
      }

      async function post(url, body){
        var r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
        var d = await r.json();
        return { ok: r.ok, d: d };
      }

      // 통신 실패는 화면에 알리고 다음 주기에 다시 시도한다 (조용히 죽으면 반쪽 화면으로 굳는다)
      var pollFails = 0;
      async function poll(){
        var d = await window.casinoPoll('/api/games/crash/state');
        if (!d) {
          if (++pollFails >= 2) statusEl.textContent = '서버에 연결하는 중…';
          return;
        }
        pollFails = 0;
        clockOffset = d.round.serverNowMs - Date.now();
        st = d;
        render();
        /* 채팅은 폴을 따로 돌지 않는다 — 응답의 마지막 메시지 id 만 넘겨주면 값이 늘었을
           때만 채팅이 스스로 받아 간다(app.js 의 casinoChat). */
        if (window.casinoChat) casinoChat.note(d.chatMax, d.chatMod);
      }

      async function bet(){
        savePrefs();
        var res = await post('/api/games/crash/bet', {
          betAmount: Number(betInput.value),
          autoCashout: autoMode && autoInput.value ? Number(autoInput.value) : null,
        });
        if (!res.ok) { msg.textContent = res.d.error || '오류가 발생했습니다'; return; }
        setBalance(res.d.balance);
        poll();
      }
      async function cancel(){
        var res = await post('/api/games/crash/cancel');
        if (!res.ok) { msg.textContent = res.d.error || '오류가 발생했습니다'; poll(); return; }
        setBalance(res.d.balance);
        msg.innerHTML = '베팅을 취소하고 환불했습니다.';
        poll();
      }
      async function cashout(){
        cashoutBtn.disabled = true;
        // 눌린 순간 화면에 떠 있던 값과 그때의 보정치를 기록해 둔다 (?perf=1 진단용)
        var shownAtClick = (st && st.round.phase === 'running' && st.round.startedAtMs != null)
          ? multAt(serverNow() - st.round.startedAtMs) : null;
        var clickT = Date.now();
        var res = await post('/api/games/crash/cashout');
        cashoutBtn.disabled = false;
        if (window.casinoMark && shownAtClick != null) {
          var got = (res.ok && res.d && res.d.multiplier != null) ? res.d.multiplier : null;
          window.casinoMark('캐시아웃 — 화면 ' + shownAtClick.toFixed(2) + 'x · 정산 '
            + (got == null ? ('실패(' + (res.d && res.d.error) + ')') : got.toFixed(2) + 'x')
            + ' · 왕복 ' + (Date.now() - clickT) + 'ms · clockOffset ' + clockOffset + 'ms');
        }
        if (!res.ok) { msg.textContent = res.d.error || '오류가 발생했습니다'; poll(); return; }
        setBalance(res.d.balance);
        msg.innerHTML = '<span style="color:var(--win);font-weight:700">캐시아웃</span> ' +
          res.d.multiplier.toFixed(2) + 'x · +' + fmt(res.d.payout);
        if (card) replay(card, 'gold-flash');
        if (pbal) replay(pbal, 'bump'); // 잔액이 오르는 순간을 눈에 띄게
        if (window.casinoSfx) window.casinoSfx.win('fanfare');
        poll();
      }

      playBtn.addEventListener('click', bet);
      cancelBtn.addEventListener('click', cancel);
      cashoutBtn.addEventListener('click', cashout);

      // 폴링 비용 관리 (사다리와 동일): 탭이 숨겨지거나 오래 조작이 없으면 멈춰 서버가 잠들 수 있게 한다
      var IDLE_MS = 3 * 60 * 1000;
      var timer = null, lastAct = Date.now();
      // 배율이 오르는 동안에는 더 자주 확인한다.
      // 클라이언트는 크래시 지점을 모르므로(알면 결과가 새어 나간다) 다음 폴링이 올 때까지 계속 그린다.
      // 즉 "실제로는 1.40에서 터졌는데 화면은 1.45까지 올라갔다 터지는" 오차가 폴링 간격만큼 생긴다.
      // 1초 → 0.25초로 줄이면 그 오차도 1/4이 된다(1.40 기준 최대 +0.09 → +0.02).
      var POLL_RUNNING_MS = 250, POLL_IDLE_MS = 1000;
      var pollEvery = POLL_IDLE_MS;
      function startPolling(){
        if (timer) return;
        poll();
        timer = setInterval(function(){
          if (document.hidden) { stopPolling(); return; }
          if (Date.now() - lastAct > IDLE_MS) {
            stopPolling(); stopTick();
            statusEl.textContent = '일시정지 (화면을 클릭하면 재개)';
            return;
          }
          poll();
          // 단계가 바뀌면 주기를 갈아끼운다
          var want = (st && st.round.phase === 'running') ? POLL_RUNNING_MS : POLL_IDLE_MS;
          if (want !== pollEvery) { pollEvery = want; stopPolling(); startPolling(); }
        }, pollEvery);
      }
      function stopPolling(){ if (timer) { clearInterval(timer); timer = null; } }
      function activity(){ lastAct = Date.now(); if (!timer && !document.hidden) startPolling(); }
      ['pointerdown','keydown','focus'].forEach(function(ev){ window.addEventListener(ev, activity, true); });
      document.addEventListener('visibilitychange', function(){ if (document.hidden) { stopPolling(); stopTick(); } else activity(); });
      startPolling();
    })();

      // 우측 패널 랭킹 탭
      ${rankJs('c', 'crash')}
    </script>
    ${helpDialog("cgHelp", "그래프게임 규칙", RULES_HTML)}`;
  return layout('그래프게임', 'lobby', body);
}
