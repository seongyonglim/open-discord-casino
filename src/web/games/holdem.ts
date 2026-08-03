/* 홀덤 데일리 프리롤 — 페이지와 API.
 *
 * 한 URL(/games/holdem)이 두 화면을 겸한다: 토너먼트가 진행 중이 아니면 로비,
 * 진행 중이고 내가 앉아 있으면 테이블. 상태에 따라 클라이언트가 갈아끼운다 —
 * 화면을 두 URL로 나누면 시작·종료 순간에 사용자가 직접 이동해야 한다.
 *
 * 히든 정보 규율 (다른 게임과 같다):
 *   · deck_json 은 어떤 단계에서도 내려보내지 않는다. 남은 카드가 새면 이후 판이 전부 무의미해진다.
 *   · 남의 홀 카드는 쇼다운 결과에 공개된 것만 내려보낸다. 진행 중에는 절대 안 된다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  advanceHoldem, registerHoldem, holdemAction, holdemSitIn, touchHoldemPresence,
  getTable, getSeats, getEntries, getCurrentHand, getHandSeats, getSeatAvatars,
  ACTION_SEC, type HoldemStatus,
} from '../../db/holdem';
import * as G from '../../services/holdem';
import * as T from '../../services/tournament';
import { getWebUser } from '../../db/queries';
import { readJson, sendJson } from '../http';
import { layout, jsonForScript, helpButton, helpDialog } from '../views';
import { ASSET_V } from '../assets';
import { gameSwitcher } from '../pages';
import type { WebUser } from '../../db/queries';

/* ── 상태 응답 ────────────────────────────────────────────────────── */

function statePayload(st: HoldemStatus, userId: string) {
  const now = Math.floor(Date.now() / 1000);
  const t = st.tournament;
  const table = getTable(t.id);
  const entries = getEntries(t.id);
  const pool = T.prizePool(entries.length, t.prize_multiplier);

  const base = {
    ok: true,
    me: userId,
    balance: getWebUser(userId)?.balance ?? 0,
    serverNow: now,
    tournament: {
      id: t.id,
      title: t.title,
      status: st.status,
      dateStr: t.date_str,
      regOpenAt: t.reg_open_at,
      scheduledStartAt: t.scheduled_start_at,
      graceEndsAt: t.grace_ends_at,
      startedAt: t.started_at,
      finishedAt: t.finished_at,
      multiplier: t.prize_multiplier,
      registered: entries.length,
      minPlayers: T.MIN_PLAYERS,
      maxPlayers: T.MAX_PLAYERS,
      startingStack: T.STARTING_STACK,
      prizePool: pool,
      prizes: T.prizeAmounts(pool, entries.length),
      itm: T.itmCount(entries.length),
      lateRegLeft: T.lateRegLeft(now, {
        startedAt: t.started_at, finishedAt: t.finished_at, cancelledAt: t.cancelled_at,
      }),
      iRegistered: entries.some(e => e.user_id === userId),
    },
    // 결과는 끝난 뒤에만 (진행 중 순위를 흘리면 남은 사람의 정보가 된다)
    results: st.status === 'FINISHED'
      ? entries.filter(e => e.finish_place != null)
        .sort((a, b) => a.finish_place! - b.finish_place!)
        .map(e => ({ place: e.finish_place, username: e.username, prize: e.prize }))
      : [],
    table: null as unknown,
  };

  if (!table || st.status !== 'RUNNING') return base;

  const seats = getSeats(table.id);
  const living = seats.filter(s => s.presence !== 'OUT');
  const hand = getCurrentHand(table.id);
  const profiles = getSeatAvatars(table.id);
  const avatarOf = (id: string) => profiles.get(id) ?? null;

  const level = hand
    ? { level: hand.level, sb: hand.sb, bb: hand.bb, ante: hand.ante }
    : T.levelAt(now - (t.started_at ?? now));
  const elapsed = now - (t.started_at ?? now);
  const totalChips = living.reduce((a, s) => a + s.stack, 0);

  const boardCards = hand ? JSON.parse(hand.board_json) as number[] : [];
  const handSeats = hand ? getHandSeats(hand.id) : [];
  const bySeat = new Map(handSeats.map(h => [h.seat, h]));
  const mySeat = living.find(s => s.user_id === userId);
  const myHand = mySeat ? bySeat.get(mySeat.seat) : undefined;
  const ended = hand?.ended_at != null;
  const result = ended && hand?.result_json ? JSON.parse(hand.result_json) : null;
  // 쇼다운에 공개된 홀 카드만 남의 것으로 내려보낸다
  const revealed = new Map<number, string[]>(
    (result?.reveal ?? []).map((r: { seat: number; cards: string[] }) => [r.seat, r.cards]));

  const views = handSeats.map(h => ({
    seat: h.seat, bet: h.bet, stack: h.stack, committed: h.committed,
    state: h.state, acted: h.acted === 1,
  }));
  const potTotal = views.reduce((a, v) => a + v.committed, 0);

  const myLegal = (() => {
    if (!hand || ended || !mySeat || !myHand || hand.to_act_seat !== mySeat.seat) return null;
    const me = views.find(v => v.seat === mySeat.seat);
    if (!me || me.state !== 'active') return null;
    const la = G.legalActions(me, views, hand.last_raise_size, hand.bb);
    return {
      canFold: la.canFold, canCheck: la.canCheck, canCall: la.canCall,
      callAmount: la.callAmount, minRaiseTo: la.minRaiseTo, maxRaiseTo: la.maxRaiseTo,
      raiseIsBet: la.raiseIsBet, myBet: me.bet, myStack: me.stack,
    };
  })();

  return {
    ...base,
    table: {
      handNo: hand?.hand_no ?? 0,
      street: hand?.street ?? 'preflop',
      board: G.cardsToStrings(boardCards),
      buttonSeat: hand?.button_seat ?? table.button_seat,
      toActSeat: ended ? null : hand?.to_act_seat ?? null,
      actionLeft: !ended && hand?.action_deadline != null
        ? Math.max(0, hand.action_deadline - now) : null,
      actionSec: ACTION_SEC,
      pot: potTotal,
      ended,
      result,
      nextHandIn: table.next_hand_at != null ? Math.max(0, table.next_hand_at - now) : null,
      level,
      nextLevelIn: T.nextLevelIn(elapsed),
      remaining: living.length,
      avgStack: living.length ? Math.floor(totalChips / living.length) : 0,
      seats: living.map(s => {
        const h = bySeat.get(s.seat);
        return {
          seat: s.seat,
          userId: s.user_id,
          username: s.username,
          avatar: avatarOf(s.user_id),
          stack: s.stack,
          presence: s.presence,
          inHand: h != null,
          bet: h?.bet ?? 0,
          state: h?.state ?? 'out',
          won: h?.won ?? 0,
          // 내 카드는 항상, 남의 카드는 공개된 것만
          cards: s.user_id === userId && h
            ? G.cardsToStrings(JSON.parse(h.hole_json) as number[])
            : revealed.get(s.seat) ?? [],
        };
      }),
      // 내 두 장 + 보드로 지금 무엇이 완성됐는지. 내 카드로 계산한 내 정보다.
      myHand: myHand
        ? G.readHand(JSON.parse(myHand.hole_json) as number[], boardCards)
        : null,
      mySeat: mySeat?.seat ?? null,
      myPresence: mySeat?.presence ?? null,
      legal: myLegal,
    },
  };
}

/* ── API ─────────────────────────────────────────────────────────── */

export async function handleState(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  const st = advanceHoldem();
  // 폴링 자체가 "접속 중" 신호다. SIT_OUT은 여기서 풀지 않는다 — 본인이 복귀를 눌러야 한다.
  const table = getTable(st.tournament.id);
  if (table) touchHoldemPresence(userId, table.id);
  return sendJson(res, 200, statePayload(st, userId));
}

export async function handleRegister(
  _req: IncomingMessage, res: ServerResponse, userId: string, username: string
): Promise<void> {
  const r = registerHoldem(userId, username);
  if (!r.ok) {
    const msg = r.error === 'not_open' ? '아직 등록이 열리지 않았습니다'
      : r.error === 'late_reg_closed' ? '늦은 등록 시간이 지났습니다'
      : r.error === 'table_full' ? '테이블이 꽉 찼습니다'
      : r.error === 'already' ? '이미 등록하셨습니다'
      : '지금은 등록할 수 없습니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, registered: r.registered });
}

export async function handleAction(
  req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  // 본문 파싱(await)을 먼저 끝낸다 — 확인과 쓰기 사이에 await가 있으면
  // 그 틈에 차례가 넘어가 엉뚱한 시점에 액션이 들어갈 수 있다.
  const data = await readJson(req);
  const kinds: G.ActionKind[] = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];
  const kind = kinds.find(k => k === data?.action);
  if (!kind) return sendJson(res, 400, { error: '알 수 없는 동작입니다' });
  const amount = Math.floor(Number(data?.amount ?? 0));
  if (!Number.isFinite(amount) || amount < 0) return sendJson(res, 400, { error: '금액이 올바르지 않습니다' });

  const r = holdemAction(userId, kind, amount);
  if (!r.ok) {
    const msg = r.error === 'not_your_turn' ? '지금은 당신의 차례가 아닙니다'
      : r.error === 'not_seated' ? '이 토너먼트에 참여하지 않았습니다'
      : r.error === 'no_hand' ? '진행 중인 핸드가 없습니다'
      : r.error === 'illegal' ? legalMessage(r.detail)
      : '토너먼트가 진행 중이 아닙니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true });
}

function legalMessage(detail?: string): string {
  return detail === 'below_min_raise' ? '최소 레이즈 금액보다 적습니다'
    : detail === 'above_stack' ? '스택보다 많이 걸 수 없습니다'
    : detail === 'cannot_check' ? '콜해야 하는 상황입니다'
    : detail === 'nothing_to_call' ? '콜할 금액이 없습니다'
    : detail === 'cannot_raise' ? '지금은 레이즈할 수 없습니다'
    : '허용되지 않는 동작입니다';
}

export async function handleSitIn(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  const st = advanceHoldem();
  const table = getTable(st.tournament.id);
  if (!table) return sendJson(res, 400, { error: '진행 중인 테이블이 없습니다' });
  holdemSitIn(userId, table.id);
  return sendJson(res, 200, { ok: true });
}

/* ── 도움말 ──────────────────────────────────────────────────────── */

const HELP_BODY = `
  <h4>어떤 대회인가요</h4>
  <p>참가비가 없는 <b>프리롤</b>입니다. 포인트를 잃지 않고, 상위 입상자만 상금을 받습니다.
     평일은 참가자 1인당 1,000P, 주말은 2,000P가 상금 풀에 쌓입니다.</p>
  <ul>
    <li>등록 <b>21:00</b> · 시작 <b>22:00</b> (KST)</li>
    <li>최소 3명 · 최대 9명 (한 테이블)</li>
    <li>22:00에 3명이 안 되면 22:20까지 기다리고, 그래도 미달이면 취소됩니다</li>
    <li>시작 후 <b>24분</b>까지 늦은 등록이 가능합니다 (빈자리가 있을 때)</li>
    <li>시작 스택 10,000칩 · 블라인드는 8분마다 오릅니다</li>
  </ul>

  <h4>상금</h4>
  <p>참가자의 약 30%가 상금을 받습니다. 1위가 가장 많이 받고 순위가 내려갈수록 줄어듭니다.
     늦은 등록으로 참가자가 늘면 상금 풀도 함께 커집니다.</p>

  <h4>진행</h4>
  <ul>
    <li>노리밋 텍사스 홀덤. 각자 두 장을 받고 보드 다섯 장과 조합해 가장 센 다섯 장을 만듭니다</li>
    <li>내 차례에 <b>폴드 / 체크 / 콜 / 베팅·레이즈 / 올인</b> 중 하나를 고릅니다</li>
    <li>제한 시간을 넘기면 자동으로 체크(체크가 불가하면 폴드)되고 자리 비움으로 바뀝니다.
        상단의 <b>게임 복귀</b>를 누르면 다시 정상 플레이로 돌아옵니다</li>
    <li>브라우저를 닫아도 자리는 유지됩니다. 다시 들어오면 그대로 이어집니다</li>
  </ul>

  <h4>베팅 버튼</h4>
  <p>빠른 금액 버튼(1/3 팟, 1/2 팟, 팟, 2BB, 3BB, 올인)은 <b>금액만 채워 넣습니다.</b>
     실제로 나가려면 <b>베팅 / 레이즈</b> 확인 버튼을 눌러야 합니다 — 실수로 전 재산이
     나가는 일을 막기 위한 안전장치입니다.</p>
  <p>스택 표시는 <b>칩</b>과 <b>BB</b>(빅블라인드 배수) 중에서 고를 수 있습니다.</p>
`;
/* ── 페이지 ──────────────────────────────────────────────────────────
 *
 * 배치 규칙(참고 디자인을 그대로 따른 것 — 여기서 어긋나면 화면이 무너진다):
 *
 *  · 테이블은 스타디움(양끝이 둥근 사각). 바깥에 두꺼운 레일, 안쪽에 초록 펠트,
 *    펠트 안쪽으로 한 겹 더 얇은 트랙 선.
 *  · 라이브 딜러는 두지 않는다. 홀덤은 버튼이 플레이어를 돌기 때문에 상단에 딜러를
 *    앉히면 "누가 딜러인가"가 두 곳에서 말해져 오히려 헷갈린다. 버튼 퍽만 쓴다.
 *  · 좌석 9개는 테이블 둘레 바깥에. 내(Hero) 자리는 언제나 6시 방향이고,
 *    나머지는 자리 번호 순서대로 시계방향으로 돌려서 붙인다.
 *  · 좌석판은 가로형: [아바타][Seat N (이름)] / [스택]
 *  · 각 좌석의 카드 두 장은 좌석판 "바로 위"에. 모든 자리가 같은 규칙이라
 *    위치가 들쭉날쭉해 보이지 않는다.
 *  · 베팅 칩은 좌석과 테이블 중앙 "사이"에. 좌석마다 안쪽 좌표를 따로 잡아 둔다.
 *  · 딜러 버튼(퍽)은 그 좌석판의 중앙을 향한 옆면에 붙인다 — 펠트 위에 띄워 두면
 *    "떠 있는 물체"로 보여서 누구 버튼인지 한눈에 안 잡힌다.
 *  · 보드 5장과 POT은 중앙. 액션 버튼은 테이블 아래.
 *  · 오른쪽 패널에 토너먼트 정보와 칩 순위.
 */

export function holdemPage(user: WebUser): string {
  const body = `
  <div class="wrap">
    ${gameSwitcher('holdem')}

    <div id="htLobby" class="ht-lobby" hidden></div>

    <div id="htTable" class="game-shell ht-shell" hidden>
      <div class="game-main">
        <div class="ht-felt">
          <!-- 레일(바깥) → 펠트(안) → 트랙 선. 세 겹이라야 테이블처럼 보인다 -->
          <div class="ht-rail">
            <div class="ht-cloth">
              <div class="ht-track" aria-hidden="true"></div>


              <div class="ht-center">
                <div class="ht-pot"><span class="ht-pot-k">POT</span><span id="htPot">0</span></div>
                <div class="ht-board" id="htBoard"></div>
                <div class="ht-msg" id="htMsg"></div>
                <div class="ht-read" id="htRead" hidden></div>
              </div>

              <!-- 자리 비움 배너 — 오른쪽 패널의 버튼만으로는 놓치기 쉽다.
                   지금 자동으로 체크/폴드되고 있다는 사실과 복귀 방법을 테이블 위에 붙인다. -->
              <div class="ht-sitout-bar" id="htSitBar" hidden>
                <span class="ht-sitout-t">자리 비움 — 내 차례는 자동으로 체크(불가하면 폴드)됩니다</span>
                <button type="button" class="btn btn-gold ht-sitout-btn" id="htBack2">게임 복귀</button>
              </div>

              <div id="htSeats" class="ht-seats"></div>
            </div>
          </div>
        </div>

        <div class="ht-controls" id="htControls" hidden>
          <div class="ht-ctop">
            <div class="ht-quick" id="htQuick">
              <button type="button" class="ht-q" data-q="third">1/3 팟</button>
              <button type="button" class="ht-q" data-q="half">1/2 팟</button>
              <button type="button" class="ht-q" data-q="pot">팟</button>
              <button type="button" class="ht-q" data-q="bb2">2BB</button>
              <button type="button" class="ht-q" data-q="bb3">3BB</button>
              <button type="button" class="ht-q" data-q="allin">올인</button>
            </div>
            <div class="ht-slider">
              <input type="range" id="htRange" min="0" max="0" step="1" value="0">
              <input type="text" id="htAmount" class="ht-amount" inputmode="numeric" value="0">
              <span class="ht-unit-tag" id="htUnitTag">칩</span>
            </div>
          </div>
          <div class="ht-acts">
            <button type="button" class="hta fold" id="htFold">폴드</button>
            <button type="button" class="hta check" id="htCheck">체크</button>
            <button type="button" class="hta call" id="htCall">콜</button>
            <button type="button" class="hta raise" id="htRaise">레이즈</button>
          </div>
          <div class="ht-pre" id="htPre">
            <label><input type="checkbox" id="htPreCheckFold"> 체크 / 폴드</label>
            <label><input type="checkbox" id="htPreCheck"> 자동 체크</label>
            <label><input type="checkbox" id="htPreCall"> <span id="htPreCallLabel">자동 콜</span></label>
          </div>
        </div>
      </div>

      <!-- 오른쪽: 토너먼트 정보 + 칩 순위 -->
      <div class="game-side ht-side">
        <div class="ht-side-head">
          <span id="htSideTitle">데일리 프리롤</span>
          ${helpButton('htHelp')}
        </div>
        <div class="ht-info" id="htInfo"></div>
        <div class="ht-side-sub">칩 순위</div>
        <div class="ht-rank" id="htRank"></div>
        <button type="button" class="btn ht-back" id="htBack" hidden>게임 복귀</button>
      </div>
    </div>

    ${helpDialog('htHelp', '홀덤 프리롤 규칙', HELP_BODY)}
  </div>
  <script>window.__ME__ = ${jsonForScript(user.username)}; window.__MEID__ = ${jsonForScript(user.id)};
    window.__SFX_NEED__ = ['card','shuffle','deal','chipbet','chipwin'];</script>
  <script>
  (function(){
    var MEID = window.__MEID__;
    var CARD_V = ${jsonForScript(ASSET_V)};
    var st = null, unit = 'chip', spectate = false, paidHandNo = null;

    var lobbyEl = document.getElementById('htLobby');
    var tableEl = document.getElementById('htTable');
    var seatsEl = document.getElementById('htSeats');
    var boardEl = document.getElementById('htBoard');
    var potEl = document.getElementById('htPot');
    var msgEl = document.getElementById('htMsg');
    var readEl = document.getElementById('htRead');
    var ctrlEl = document.getElementById('htControls');
    var rangeEl = document.getElementById('htRange');
    var amountEl = document.getElementById('htAmount');
    var unitTag = document.getElementById('htUnitTag');
    var backBtn = document.getElementById('htBack');
    var sitBar = document.getElementById('htSitBar');
    var infoEl = document.getElementById('htInfo');
    var rankEl = document.getElementById('htRank');
    var sideTitle = document.getElementById('htSideTitle');

    function esc(s){ return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function num(n){ return Number(n||0).toLocaleString('ko-KR'); }
    function mmss(sec){
      if (sec == null) return '--:--';
      var s = Math.max(0, Math.floor(sec));
      return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
    }
    /* 스택 표기 — 칩 또는 BB. 숏스택일 때 3.4BB처럼 소수 한 자리가 의미 있다. */
    function stackText(chips){
      if (unit === 'chip' || !st || !st.table) return num(chips);
      var bb = (st.table.level && st.table.level.bb) || 1;
      var v = chips / bb;
      return (v >= 10 ? Math.floor(v) : Math.floor(v * 10) / 10) + 'BB';
    }
    function avatarHtml(userId, avatar, username, cls){
      if (avatar) return '<img class="' + cls + '" src="https://cdn.discordapp.com/avatars/' +
        esc(userId) + '/' + esc(avatar) + '.png?size=64" alt="">';
      return '<span class="' + cls + ' ph">' + esc((username||'?').slice(0,1)) + '</span>';
    }
    function cardImg(code, cls){
      var k = 'pcard' + (cls ? ' ' + cls : '');
      if (!code) return '<img class="' + k + ' back" src="/cards/back-red.svg?v=' + CARD_V + '" alt="">';
      return '<img class="' + k + '" src="/cards/' + code + '.svg?v=' + CARD_V + '" alt="' + code + '">';
    }

    /* ── 로비 ─────────────────────────────────────────────────────── */
    function renderLobby(){
      var t = st.tournament, now = st.serverNow;
      var badge = '', action = '', note = '';
      if (t.status === 'SCHEDULED') {
        badge = '<span class="ht-badge">예정</span>';
        note = '등록은 ' + mmss(t.regOpenAt - now) + ' 후에 열립니다 (21:00)';
        action = '<button type="button" class="btn btn-gold" disabled>참가 신청</button>';
      } else if (t.status === 'REGISTRATION_OPEN') {
        badge = '<span class="ht-badge open">등록 중</span>';
        note = '시작까지 ' + mmss(t.scheduledStartAt - now);
        action = t.iRegistered
          ? '<button type="button" class="btn" disabled>신청 완료</button>'
          : '<button type="button" class="btn btn-gold" id="htJoin">참가 신청</button>';
      } else if (t.status === 'WAITING_MIN_PLAYERS') {
        badge = '<span class="ht-badge wait">최소 인원 대기</span>';
        note = '최소 인원 대기 중 (' + mmss(t.graceEndsAt - now) + ')';
        action = t.iRegistered
          ? '<button type="button" class="btn" disabled>신청 완료</button>'
          : '<button type="button" class="btn btn-gold" id="htJoin">참가 신청</button>';
      } else if (t.status === 'RUNNING') {
        if (t.lateRegLeft != null) {
          badge = '<span class="ht-badge late">LATE REGIST</span>';
          note = '늦은 등록 마감까지 ' + mmss(t.lateRegLeft);
          action = '<button type="button" class="btn btn-gold" id="htJoin">Late Reg 참가하기</button>' +
            ' <button type="button" class="btn" id="htSpectate">관전하기</button>';
        } else {
          badge = '<span class="ht-badge run">진행 중</span>';
          note = '늦은 등록이 마감되었습니다';
          action = '<button type="button" class="btn" id="htSpectate">관전하기</button>';
        }
      } else if (t.status === 'FINISHED') {
        badge = '<span class="ht-badge done">종료</span>';
        note = '오늘 대회가 끝났습니다';
      } else {
        badge = '<span class="ht-badge cancel">취소</span>';
        note = '최소 인원(' + t.minPlayers + '명)이 모이지 않아 취소되었습니다';
      }

      var prizeRows = (t.prizes||[]).map(function(p,i){
        return '<tr><td>' + (i+1) + '위</td><td>' + num(p) + 'P</td></tr>'; }).join('');
      var results = (st.results||[]).map(function(r){
        return '<tr><td>' + r.place + '위</td><td>' + esc(r.username) + '</td><td>' +
          (r.prize > 0 ? num(r.prize) + 'P' : '-') + '</td></tr>'; }).join('');

      lobbyEl.innerHTML =
        '<div class="ht-card">' +
          '<div class="ht-card-top">' +
            '<div><h2>' + esc(t.title) + '</h2>' +
              '<p class="ht-when">' + esc(t.dateStr) + ' · 등록 21:00 · 시작 22:00 (KST)</p></div>' +
            badge +
          '</div>' +
          '<div class="ht-grid">' +
            '<div><span class="k">참가자</span><span class="v">' + t.registered + ' / ' + t.maxPlayers + '</span></div>' +
            '<div><span class="k">상금 풀</span><span class="v gold">' + num(t.prizePool) + 'P</span></div>' +
            '<div><span class="k">1인당</span><span class="v">' + num(t.multiplier) + 'P</span></div>' +
            '<div><span class="k">시작 스택</span><span class="v">' + num(t.startingStack) + '</span></div>' +
            '<div><span class="k">지급 인원</span><span class="v">' + t.itm + '명</span></div>' +
            '<div><span class="k">최소 인원</span><span class="v">' + t.minPlayers + '명</span></div>' +
          '</div>' +
          '<p class="ht-note">' + esc(note) + '</p>' +
          '<div class="ht-actions">' + action + '</div>' +
          (prizeRows ? '<h3 class="ht-h3">상금 구조</h3><table class="ht-prize"><thead><tr><th>순위</th><th>상금</th></tr></thead><tbody>' +
            prizeRows + '</tbody></table>' : '') +
          (results ? '<h3 class="ht-h3">결과</h3><table class="ht-prize"><thead><tr><th>순위</th><th>이름</th><th>상금</th></tr></thead><tbody>' +
            results + '</tbody></table>' : '') +
        '</div>';

      var join = document.getElementById('htJoin');
      if (join) join.addEventListener('click', function(){
        join.disabled = true;
        post('/api/games/holdem/register', {}).then(function(r){
          if (!r.ok) { alert(r.d && r.d.error ? r.d.error : '등록할 수 없습니다'); join.disabled = false; }
          poll();
        });
      });
      var spec = document.getElementById('htSpectate');
      if (spec) spec.addEventListener('click', function(){ spectate = true; render(); });
    }

    /* ── 좌석 좌표 ──────────────────────────────────────────────────
       스테이지(테이블 바깥 여백 포함) 기준 % 좌표다. 순서는 6시에서 시작해 시계방향.
         plate  좌석판 중심
         bet    베팅 칩 자리 — 좌석과 중앙 사이
       카드는 좌석판 바로 위에 붙이므로 좌표가 따로 필요 없다(CSS가 위로 쌓는다). */
    var POS = [
      { plate: [50, 93], bet: [50, 76] },   // 0 = 6시 (Hero)
      { plate: [25, 90], bet: [31, 74] },
      { plate: [8,  68], bet: [20, 62] },
      { plate: [8,  41], bet: [20, 45] },
      { plate: [25, 16], bet: [32, 30] },
      { plate: [75, 16], bet: [68, 30] },
      { plate: [92, 41], bet: [80, 45] },
      { plate: [92, 68], bet: [80, 62] },
      { plate: [75, 90], bet: [69, 74] },
    ];

    function renderSeats(){
      var tb = st.table, seats = tb.seats || [];
      /* Hero를 항상 6시에 두려면 "내 자리 번호"를 기준으로 회전시킨다.
         자리 번호는 서버가 정한 그대로 두고 화면 위치만 돌린다 —
         내가 3번이든 7번이든 언제나 아래 가운데에서 플레이한다. */
      var anchor = tb.mySeat != null ? tb.mySeat : (seats.length ? seats[0].seat : 0);
      var html = '';
      seats.forEach(function(s){
        var rot = ((s.seat - anchor) % 9 + 9) % 9;
        var p = POS[rot];
        var cls = 'ht-seat';
        if (s.userId === MEID) cls += ' hero';
        if (s.seat === tb.toActSeat) cls += ' turn';
        if (s.state === 'folded') cls += ' folded';
        if (s.presence === 'SIT_OUT') cls += ' sitout';
        if (s.state === 'allin') cls += ' allin';
        if (s.presence === 'DISCONNECTED') cls += ' disc';

        /* 카드 — 내 것은 앞면 크게, 남의 것은 마룬 뒷면 (쇼다운에 공개되면 앞면).
           폴드한 사람의 카드는 흑백으로 죽이고 비스듬히 눕혀 '버린 패'로 보이게 한다.
           좌석 전체를 흐리게 하는 것만으로는 누가 팟에 남았는지 한눈에 안 읽힌다. */
        var cardCls = (s.userId === MEID ? 'hero' : 'sm') + (s.state === 'folded' ? ' mucked' : '');
        var cards = s.cards && s.cards.length
          ? s.cards.map(function(c){ return cardImg(c, cardCls); }).join('')
          : (s.inHand ? cardImg(null, cardCls) + cardImg(null, cardCls) : '');

        html += '<div class="' + cls + '" style="left:' + p.plate[0] + '%;top:' + p.plate[1] + '%">' +
            '<div class="ht-hole">' + cards + '</div>' +
            '<div class="ht-plate">' +
              avatarHtml(s.userId, s.avatar, s.username, 'ht-av') +
              '<span class="ht-who">' +
                '<span class="ht-nm">Seat ' + (s.seat + 1) +
                  (s.userId === MEID ? ' (나)' : '') + '</span>' +
                (s.state === 'allin'
                  ? '<span class="ht-allin">ALL IN</span>'
                  : '<span class="ht-stk">' + stackText(s.stack) + '</span>') +
              '</span>' +
              (s.seat === tb.buttonSeat
                ? '<span class="ht-puck ' + (p.plate[0] < 50 ? 'r' : 'l') + '" title="딜러 버튼">D</span>'
                : '') +
              (s.state === 'folded' ? '<span class="ht-fold-b" title="폴드">F</span>'
                : s.presence === 'SIT_OUT' ? '<span class="ht-zzz" title="자리 비움">II</span>' : '') +

            '</div>' +
          '</div>';

        // 베팅 칩 — 좌석과 중앙 사이 (좌석판과 별개 요소라 겹치지 않는다)
        if (s.bet > 0) {
          html += '<div class="ht-spot" style="left:' + p.bet[0] + '%;top:' + p.bet[1] + '%">' +
            '<span class="ht-spot-chips">' + chipStack(s.bet) + '</span>' +
            '<span class="ht-spot-amt">' + stackText(s.bet) + '</span></div>';
        }
      });
      seatsEl.innerHTML = html;
    }

    /* 칩 더미 — 금액이 클수록 층이 높아 보이게 최대 3장까지 겹친다.
       포커 플립·바카라의 .pchip과 같은 모양을 작게 쓴다. */
    function chipStack(amount){
      var bb = (st.table.level && st.table.level.bb) || 1;
      var n = amount >= bb * 20 ? 3 : amount >= bb * 5 ? 2 : 1;
      var out = '';
      for (var i = 0; i < n; i++) out += '<i class="ht-chip" style="bottom:' + (i * 3) + 'px"></i>';
      return out;
    }

    /* ── 오른쪽 패널 ─────────────────────────────────────────────── */
    function renderSide(){
      var t = st.tournament, tb = st.table;
      sideTitle.textContent = t.title;
      infoEl.innerHTML =
        '<div class="ht-i"><span class="k">블라인드</span><span class="v gold">' +
          num(tb.level.sb) + ' / ' + num(tb.level.bb) +
          (tb.level.ante ? ' <i>앤티 ' + num(tb.level.ante) + '</i>' : '') + '</span></div>' +
        '<div class="ht-i"><span class="k">레벨</span><span class="v">Level ' + tb.level.level +
          ' <i>다음 ' + (tb.nextLevelIn == null ? '없음' : mmss(tb.nextLevelIn)) + '</i></span></div>' +
        '<div class="ht-i"><span class="k">남은 인원</span><span class="v">' + tb.remaining +
          ' / ' + t.registered + '명</span></div>' +
        '<div class="ht-i"><span class="k">평균 스택</span><span class="v">' + stackText(tb.avgStack) + '</span></div>' +
        '<div class="ht-i"><span class="k">상금 풀</span><span class="v gold">' + num(t.prizePool) + 'P</span></div>' +
        '<div class="ht-i"><span class="k">지급 인원</span><span class="v">' + t.itm + '명</span></div>' +
        (t.lateRegLeft != null
          ? '<div class="ht-i late"><span class="k">LATE REG</span><span class="v">' + mmss(t.lateRegLeft) + '</span></div>'
          : '') +
        '<div class="ht-i"><span class="k">표시 단위</span>' +
          '<span class="v"><button type="button" class="ht-unit" id="htUnit">' +
          (unit === 'chip' ? '칩' : 'BB') + '</button></span></div>';
      document.getElementById('htUnit').addEventListener('click', function(){
        unit = unit === 'chip' ? 'bb' : 'chip';
        render();
      });

      // 칩 순위 — 스택 많은 순. 참고 디자인처럼 번호·아바타·이름·스택 한 줄.
      var rows = (tb.seats||[]).slice().sort(function(a,b){ return b.stack - a.stack; });
      rankEl.innerHTML = rows.map(function(s, i){
        return '<div class="ht-rw' + (s.userId === MEID ? ' me' : '') + '">' +
          '<span class="ht-rw-n">' + (i+1) + '</span>' +
          avatarHtml(s.userId, s.avatar, s.username, 'ht-rw-av') +
          '<span class="ht-rw-nm">' + esc(s.username) + '</span>' +
          '<span class="ht-rw-st">' + stackText(s.stack) + '</span>' +
          '</div>';
      }).join('') || '<div class="empty" style="padding:14px 0">아직 없습니다</div>';
      var out = tb.myPresence === 'SIT_OUT';
      backBtn.hidden = !out;
      sitBar.hidden = !out;
    }

    /* ── 테이블 ───────────────────────────────────────────────────── */
    function renderTable(){
      var tb = st.table;
      boardEl.innerHTML = (tb.board||[]).map(function(c){ return cardImg(c); }).join('');
      potEl.textContent = stackText(tb.pot) + (unit === 'chip' ? ' P' : '');
      renderSeats();
      renderSide();

      var msg = '';
      if (tb.ended && tb.result) {
        var aw = tb.result.awards || [];
        msg = aw.map(function(a){
          var s = (tb.seats||[]).filter(function(x){ return x.seat === a.seat; })[0];
          return (s ? s.username : 'Seat ' + (a.seat+1)) + ' +' + stackText(a.amount);
        }).join(' · ') || '핸드 종료';
        if (tb.nextHandIn != null) msg += '  (다음 판 ' + tb.nextHandIn + '초)';
      } else if (tb.toActSeat != null) {
        var who = (tb.seats||[]).filter(function(x){ return x.seat === tb.toActSeat; })[0];
        msg = (tb.toActSeat === tb.mySeat ? '내 차례' : (who ? who.username + ' 차례' : ''))
          + (tb.actionLeft != null ? ' · ' + tb.actionLeft + '초' : '');
      }
      msgEl.textContent = msg;

      /* 소리 두 가지.
         · 남이 칩을 올렸을 때 (내 것은 클릭 순간에 이미 울렸다)
         · 팟이 승자에게 밀려갈 때 — 한 판에 딱 한 번. 폴링이 같은 종료 상태를 계속
           보내오므로 핸드 번호로 이미 울렸는지 표시해 둔다. */
      playBetSounds();
      if (tb.ended && paidHandNo !== tb.handNo) {
        paidHandNo = tb.handNo;
        if (window.casinoSfx && window.casinoSfx.chipWin) window.casinoSfx.chipWin();
      }

      /* 내 조합 — 초심자가 플러시를 완성해 놓고도 모르고 폴드하는 걸 막는다.
         내 카드로 계산한 내 정보라 남에게 새지 않는다. */
      var mh = tb.myHand;
      readEl.hidden = !mh || !mh.text;
      if (mh && mh.text) {
        readEl.textContent = mh.text;
        readEl.className = 'ht-read' + (mh.category != null && mh.category >= 2 ? ' strong' : '');
      }
      renderControls();
    }

    /* ── 베팅 컨트롤 ─────────────────────────────────────────────── */
    function toChips(v){ return unit === 'chip' ? Math.floor(v) : Math.floor(v * (st.table.level.bb || 1)); }
    function fromChips(c){
      return unit === 'chip' ? Math.floor(c) : Math.floor(c / (st.table.level.bb || 1) * 10) / 10;
    }
    function setAmount(chips){
      var la = st.table.legal; if (!la) return;
      var lo = la.minRaiseTo == null ? la.maxRaiseTo : la.minRaiseTo;
      var v = Math.max(lo, Math.min(la.maxRaiseTo, Math.floor(chips)));
      rangeEl.value = String(v);
      amountEl.value = String(fromChips(v));
    }
    function currentTarget(){ return Math.floor(Number(rangeEl.value) || 0); }

    function renderControls(){
      var la = st.table.legal;
      ctrlEl.hidden = !la;
      if (!la) return;
      var lo = la.minRaiseTo == null ? la.maxRaiseTo : la.minRaiseTo;
      rangeEl.min = String(lo);
      rangeEl.max = String(la.maxRaiseTo);
      if (currentTarget() < lo || currentTarget() > la.maxRaiseTo) setAmount(lo);
      document.getElementById('htFold').hidden = !la.canFold;
      document.getElementById('htCheck').hidden = !la.canCheck;
      var call = document.getElementById('htCall');
      call.hidden = !la.canCall;
      call.textContent = '콜 ' + stackText(la.callAmount);
      var raise = document.getElementById('htRaise');
      raise.hidden = la.minRaiseTo == null;
      raise.textContent = (currentTarget() >= la.maxRaiseTo ? '올인 '
        : la.raiseIsBet ? '베팅 ' : '레이즈 ') + stackText(currentTarget());
      unitTag.textContent = unit === 'chip' ? '칩' : 'BB';
    }

    document.getElementById('htQuick').addEventListener('click', function(e){
      var b = e.target.closest ? e.target.closest('.ht-q') : null;
      if (!b || !st || !st.table || !st.table.legal) return;
      var la = st.table.legal, tb = st.table, bb = tb.level.bb;
      var q = b.getAttribute('data-q');
      /* 빠른 금액 버튼은 슬라이더에 값만 채운다 — 여기서 바로 서버로 보내면
         손가락이 미끄러진 순간 전 재산이 나간다. 확인 버튼을 눌러야 나간다. */
      var v = q === 'third' ? la.myBet + Math.floor(tb.pot / 3)
        : q === 'half' ? la.myBet + Math.floor(tb.pot / 2)
        : q === 'pot' ? la.myBet + tb.pot
        : q === 'bb2' ? bb * 2
        : q === 'bb3' ? bb * 3
        : la.maxRaiseTo;
      setAmount(v);
      renderControls();
    });
    rangeEl.addEventListener('input', function(){
      amountEl.value = String(fromChips(currentTarget()));
      renderControls();
    });
    amountEl.addEventListener('change', function(){
      setAmount(toChips(parseFloat(String(amountEl.value).replace(/[^0-9.]/g, '')) || 0));
      renderControls();
    });

    /* 남의 베팅은 폴링으로만 알 수 있다. 자리별 "이번 스트리트 베팅액"을 기억해 두고
       늘어난 자리가 있을 때 칩 소리를 낸다. 여러 명이 한꺼번에 늘어도 한 번만 울린다 —
       같은 소리가 겹치면 지저분해진다. 내 자리는 클릭 순간에 이미 울렸으니 뺀다. */
    var lastBets = {}, betHandNo = null;
    function playBetSounds(){
      var tb = st.table;
      if (!tb) return;
      if (tb.handNo !== betHandNo) { lastBets = {}; betHandNo = tb.handNo; }
      var any = false;
      (tb.seats || []).forEach(function(s){
        if (s.bet > (lastBets[s.seat] || 0) && s.seat !== tb.mySeat) any = true;
        lastBets[s.seat] = s.bet;
      });
      if (any && window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
    }

    function act(kind, amount){
      // 칩이 실제로 나가는 액션에만 소리를 낸다 (폴드·체크는 칩이 안 나간다).
      // 서버 응답을 기다리지 않고 클릭 순간에 울려야 손맛이 난다.
      if (kind !== 'fold' && kind !== 'check'
          && window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
      return post('/api/games/holdem/action', { action: kind, amount: amount || 0 })
        .then(function(r){
          if (!r.ok && r.d && r.d.error) msgEl.textContent = r.d.error;
          return poll();
        });
    }
    document.getElementById('htFold').addEventListener('click', function(){ act('fold'); });
    document.getElementById('htCheck').addEventListener('click', function(){ act('check'); });
    document.getElementById('htCall').addEventListener('click', function(){ act('call'); });
    document.getElementById('htRaise').addEventListener('click', function(){
      var la = st.table.legal; if (!la) return;
      var target = currentTarget();
      act(target >= la.maxRaiseTo ? 'allin' : (la.raiseIsBet ? 'bet' : 'raise'), target);
    });
    function sitIn(){ post('/api/games/holdem/sitin', {}).then(poll); }
    backBtn.addEventListener('click', sitIn);
    document.getElementById('htBack2').addEventListener('click', sitIn);

    /* ── 사전 액션 ───────────────────────────────────────────────────
       내 차례가 오기 전에 미리 정해두는 것. 상황이 바뀌면(베팅·레이즈가 들어오면)
       스스로 해제된다 — 그래야 "콜 200을 걸어뒀는데 상대가 5000으로 올려서
       그대로 콜되는" 사고가 안 난다. */
    var preCF = document.getElementById('htPreCheckFold');
    var preC = document.getElementById('htPreCheck');
    var preCall = document.getElementById('htPreCall');
    var preCallAmount = null;
    [preCF, preC, preCall].forEach(function(box){
      box.addEventListener('change', function(){
        if (box.checked) [preCF, preC, preCall].forEach(function(o){ if (o !== box) o.checked = false; });
        preCallAmount = (box === preCall && box.checked && st && st.table && st.table.legal)
          ? st.table.legal.callAmount : null;
      });
    });
    function runPreAction(){
      var la = st.table.legal;
      if (!la) return;
      if (preCF.checked) { preCF.checked = false; act(la.canCheck ? 'check' : 'fold'); return; }
      if (preC.checked) {
        if (la.canCheck) { act('check'); return; }
        preC.checked = false;                 // 베팅이 들어왔다 — 자동 체크 해제
        return;
      }
      if (preCall.checked) {
        if (la.canCall && (preCallAmount == null || la.callAmount <= preCallAmount)) {
          preCall.checked = false; act('call'); return;
        }
        preCall.checked = false;              // 레이즈가 들어왔다 — 자동 콜 해제
      }
    }
    function updatePreLabels(){
      var la = st.table && st.table.legal;
      document.getElementById('htPreCallLabel').textContent =
        la && la.callAmount ? '자동 콜 ' + stackText(la.callAmount) : '자동 콜';
    }

    /* ── 렌더 / 폴링 ─────────────────────────────────────────────── */
    function render(){
      var showTable = st.table != null && (st.table.mySeat != null || spectate);
      lobbyEl.hidden = showTable;
      tableEl.hidden = !showTable;
      if (showTable) { renderTable(); updatePreLabels(); }
      else renderLobby();
    }
    function post(url, body){
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}) })
        .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
        .catch(function(){ return { ok: false, d: null }; });
    }
    var polling = false;
    function poll(){
      if (polling) return Promise.resolve();
      polling = true;
      return fetch('/api/games/holdem/state').then(function(r){ return r.json(); })
        .then(function(d){
          if (!d || !d.ok) return;
          st = d;
          render();
          if (st.table && st.table.legal) runPreAction();
        })
        .catch(function(){ /* 일시적 실패는 다음 폴링에서 회복된다 */ })
        .then(function(){ polling = false; });
    }
    poll();
    setInterval(poll, 1000);
  })();
  </script>`;
  return layout('홀덤 프리롤', 'lobby', body);
}
