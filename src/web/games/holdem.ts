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
  advanceHoldem, registerHoldem, unregisterHoldem, holdemAction, holdemSitIn, touchHoldemPresence,
  getTable, getSeats, getEntries, getCurrentHand, getHandSeats, getSeatAvatars, getEntryAvatars, rabbitBoard,
  showHoldemCards,
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

/* 대회가 끝난 뒤에도 테이블을 잠시 더 내려보내는 시간.
   0으로 두면(예전 동작) 마지막 판이 끝나는 순간 status가 FINISHED가 되면서 table이
   null이 되고, 화면이 그 자리에서 로비로 갈아치워진다 — 대회를 결정지은 그 판의
   쇼다운을 아무도 못 본다. 우승자가 무엇으로 이겼는지도, 팟이 넘어가는 것도 못 본다.
   그래서 마지막 판을 끝까지 보여주고 나서 축하로 넘어가게 이 창을 둔다.
   (다른 포커 클라이언트도 결과를 10초 남짓 띄워 두고 테이블을 정리한다) */
export const FINISH_LINGER_SEC = 12;

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
      ? (() => {
        const av = getEntryAvatars(t.id);
        return entries.filter(e => e.finish_place != null)
          .sort((a, b) => a.finish_place! - b.finish_place!)
          .map(e => ({
            place: e.finish_place, username: e.username, prize: e.prize,
            userId: e.user_id, avatar: av.get(e.user_id) ?? null,
          }));
      })()
      : [],
    table: null as unknown,
  };

  /* 끝난 직후 잠깐은 테이블을 계속 내려보낸다 — 마지막 판의 쇼다운을 보여주기 위해서다.
     이때 좌석은 전부 OUT이지만 shownSeats가 "끝난 판에 참여했던 자리"를 남기므로
     (탈락자에게 자기 쇼다운을 보여주려고 이미 있는 장치다) 그대로 그려진다. */
  const finishedAgo = t.finished_at != null ? now - t.finished_at : null;
  const lingering = st.status === 'FINISHED' && finishedAgo != null && finishedAgo < FINISH_LINGER_SEC;
  if (!table || (st.status !== 'RUNNING' && !lingering)) return base;

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
  /* 탈락한 사람도 "자기가 죽은 그 판"의 쇼다운은 봐야 한다.
     endHand는 결과를 쓴 뒤 같은 트랜잭션에서 presence를 OUT으로 바꾸므로,
     living만 보면 ended=true와 mySeat=null이 같은 응답에 실려 온다 —
     그러면 클라이언트가 테이블을 접어버려 자기가 어떻게 죽었는지 못 본다.
     끝난 판에 참여했던 자리는 OUT이어도 화면에 남긴다. */
  const endedNow = hand?.ended_at != null;
  const inEndedHand = (s: { seat: number; user_id: string }) =>
    endedNow && bySeat.get(s.seat)?.user_id === s.user_id;
  const shownSeats = seats.filter(s => s.presence !== 'OUT' || inEndedHand(s));
  const mySeat = shownSeats.find(s => s.user_id === userId);
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
      /* 팟의 층 구성. 올인이 섞이면 "메인 팟 + 사이드 팟"으로 갈라지는데, 합계만 보여주면
         내가 실제로 다툴 수 있는 금액이 얼마인지 알 수 없다 — 스택이 작은 사람은
         메인 팟만 가져갈 수 있다.
         정산용 buildPots를 쓰면 안 된다. 그건 투입액이 다를 때마다 층을 자르므로
         스몰·빅 블라인드만 낸 상태에서도 "사이드 팟"이 생긴다(실제로 그랬다).
         potLayers는 올인이 실제로 뚜껑을 덮은 지점에서만 자른다.
         eligible(자격 좌석)은 폴드 여부에서 나오는 값이라 히든 정보가 아니다. */
      pots: G.potLayers(views).map(p => ({ amount: p.amount, eligible: p.eligible })),
      ended,
      result,
      nextHandIn: table.next_hand_at != null ? Math.max(0, table.next_hand_at - now) : null,
      // 래빗 헌트 — 끝난 판에서만 채워진다(rabbitBoard가 진행 중에는 빈 배열을 준다)
      rabbit: hand ? rabbitBoard(hand) : [],
      /* 이 핸드의 마지막 행동. 스트리트를 닫은 행동은 좌석 표시가 같은 트랜잭션에서
         초기화되므로 이것 없이는 화면에 한 번도 뜨지 않는다. 클라이언트는 보드를
         깔기 전 정지 구간에서 이걸로 라벨을 채운다. */
      lastActor: hand && hand.last_actor_seat != null && hand.last_actor_action
        ? { seat: hand.last_actor_seat, act: hand.last_actor_action, amount: hand.last_actor_amount }
        : null,
      level,
      nextLevelIn: T.nextLevelIn(elapsed),
      // 남은 인원·평균 스택은 실제로 살아 있는 사람만 센다 (표시용 좌석 목록과 다르다)
      remaining: living.length,
      avgStack: living.length ? Math.floor(totalChips / living.length) : 0,
      seats: shownSeats.map(s => {
        const h = bySeat.get(s.seat);
        return {
          seat: s.seat,
          userId: s.user_id,
          username: s.username,
          avatar: avatarOf(s.user_id),
          /* 스택은 두 곳에 있고 시점에 따라 옳은 쪽이 다르다.
             · 핸드 진행 중: 핸드 안 스택(holdem_hand_seats). 좌석 스택은 핸드가 끝날 때만
               갱신되므로 그걸 쓰면 베팅을 해도 내 스택이 줄지 않는다 — 칩은 앞에 쌓였는데
               스택은 그대로라 내가 얼마 남았는지 알 수 없다.
             · 핸드가 끝난 뒤: 좌석 스택. 딴 금액은 좌석 스택에만 더해지므로 핸드 안 스택을
               계속 쓰면 방금 이긴 팟이 반영되지 않는다(칩 총합이 어긋난다).
             핸드에 참여하지 않은 자리도 좌석 스택을 쓴다. */
          stack: h && !ended ? h.stack : s.stack,
          presence: s.presence,
          inHand: h != null,
          bet: h?.bet ?? 0,
          state: h?.state ?? 'out',
          won: h?.won ?? 0,
          // 마지막으로 한 행동 ("콜 300"처럼 자리 옆에 띄운다)
          act: h?.last_action ?? null,
          actAmount: h?.last_amount ?? 0,
          /* 내 카드는 항상, 남의 카드는 공개된 것만.
             본인이 끝난 판에서 직접 공개(shown)했다면 그것도 공개된 것으로 본다. */
          cards: (s.user_id === userId || (ended && h?.shown === 1)) && h
            ? G.cardsToStrings(JSON.parse(h.hole_json) as number[])
            : revealed.get(s.seat) ?? [],
          // 자발적으로 깐 패는 쇼다운 공개와 구분해서 표시한다
          shown: ended && h?.shown === 1 && !revealed.has(s.seat),
        };
      }),
      // 내 두 장 + 보드로 지금 무엇이 완성됐는지. 내 카드로 계산한 내 정보다.
      myHand: myHand
        ? G.readHand(JSON.parse(myHand.hole_json) as number[], boardCards)
        : null,
      /* 패 공개 버튼을 띄울지. 판이 끝났고, 내가 그 판에 있었고,
         쇼다운에서 이미 까이지도 않았고, 아직 내가 까지도 않았을 때만. */
      canShow: ended && myHand != null && myHand.shown !== 1
        && !revealed.has(myHand.seat),
      mySeat: mySeat?.seat ?? null,
      myPresence: mySeat?.presence ?? null,
      legal: myLegal,
      /* 대회가 끝났고 지금은 마지막 판을 보여주는 중이라는 신호.
         클라이언트는 이걸 보고 "다음 판 N초" 대신 종료를 알리고, 남은 시간이 다 되면
         우승 축하로 넘어간다. 이게 없으면 테이블이 왜 멈춰 있는지 알 수 없다. */
      tournamentOver: lingering,
      finishLeft: lingering ? Math.max(0, FINISH_LINGER_SEC - finishedAgo!) : null,
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

export async function handleUnregister(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  const r = unregisterHoldem(userId);
  if (!r.ok) {
    const msg = r.error === 'not_registered' ? '신청하지 않으셨습니다'
      : r.error === 'already_started' ? '대회가 이미 시작되어 취소할 수 없습니다'
      : '지금은 취소할 수 없습니다';
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

export async function handleShow(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  // 판이 끝났는지는 showHoldemCards가 SQL 조건으로 직접 확인한다.
  const r = showHoldemCards(userId);
  if (!r.ok) return sendJson(res, 400, { error: '지금은 패를 공개할 수 없습니다' });
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
                <!-- 올인이 섞여 팟이 갈라졌을 때만 나온다 (메인 / 사이드) -->
                <div class="ht-pots" id="htPots" hidden></div>
                <div class="ht-board" id="htBoard"></div>
                <!-- 실제로 중앙에 쌓이는 팟 칩 더미. 숫자만 있으면 팟이 커지는 게 안 보이고,
                     끝나서 승자에게 갈 때도 "무엇이" 가는지가 없다. -->
                <div class="ht-potpile" id="htPotPile"></div>
                <div class="ht-msg" id="htMsg"></div>
                <!-- 무엇으로 이겼나. 카드 강조(win5)와 짝을 이룬다 — 밝은 5장이 왜
                     밝은지를 이 한 줄이 설명한다. 쇼다운이 있었던 판에만 나온다. -->
                <div class="ht-outro" id="htOutro" hidden></div>
                <div class="ht-read" id="htRead" hidden></div>
                <!-- 래빗 카드가 몇 장인지 글자로도 알려준다 (색만으로는 부족하다) -->
                <div class="ht-rnote" id="htRNote" hidden></div>
                <!-- 래빗 헌트 · 패 공개 버튼은 아래 액션 버튼 줄에 있다 (ht-acts) -->
              </div>

              <!-- 블라인드 상승 알림 — 3초만 뜬다. 테이블 위에 겹쳐 띄워서 놓치지 않게 한다. -->
              <div class="ht-lvup" id="htLvUp" hidden>
                <div class="ht-lvup-t">LEVEL UP</div>
                <div class="ht-lvup-n" id="htLvNo"></div>
                <div class="ht-lvup-b">
                  <span class="ht-lvup-from" id="htLvFrom"></span>
                  <span class="ht-lvup-ar">→</span>
                  <span class="ht-lvup-to" id="htLvTo"></span>
                </div>
              </div>

              <!-- 자리 비움 배너 — 오른쪽 패널의 버튼만으로는 놓치기 쉽다.
                   지금 자동으로 체크/폴드되고 있다는 사실과 복귀 방법을 테이블 위에 붙인다. -->
              <div class="ht-sitout-bar" id="htSitBar" hidden>
                <span class="ht-sitout-t">자리 비움 — 내 차례는 자동으로 체크(불가하면 폴드)됩니다</span>
                <button type="button" class="btn btn-gold ht-sitout-btn" id="htBack2">게임 복귀</button>
              </div>

              <div id="htSeats" class="ht-seats"></div>
              <!-- 베팅 칩·행동 표시는 좌석과 분리한다. 여기가 매 액션마다 바뀌어도
                   좌석의 카드는 그대로 남아 움찔거리지 않는다. -->
              <div id="htSpots" class="ht-seats"></div>
            </div>
          </div>
        </div>

        <div class="ht-controls" id="htControls" hidden>
          <div class="ht-ctop" id="htCtop">
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
            <!-- 판이 끝나면 위 네 버튼이 사라지므로 그 자리를 그대로 쓴다.
                 테이블 중앙의 작은 버튼은 눈에 잘 들어오지 않았다.
                 래빗은 왼쪽(나만 보는 것), 패 공개는 오른쪽(남에게 보이는 것). -->
            <button type="button" class="hta post rabbit" id="htRabbit" hidden>🐇 남은 카드 보기</button>
            <button type="button" class="hta post show" id="htShow" hidden>👁 내 패 공개</button>
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

    <!-- 우승 축하 — 토너먼트가 끝나는 순간 한 번 뜬다.
         결과표만 조용히 갈아끼우면 대회가 끝난 게 아니라 화면이 넘어간 것처럼 느껴진다. -->
    <div class="ht-win" id="htWin" hidden>
      <div class="ht-win-box">
        <div class="ht-win-crown">👑</div>
        <div class="ht-win-title">WINNER</div>
        <!-- 디스코드 프로필 + 이름을 한 줄에 — 누가 이겼는지가 한눈에 잡혀야 한다 -->
        <div class="ht-win-id"><span id="htWinAv"></span><span class="ht-win-who" id="htWinWho"></span></div>
        <div class="ht-win-prize" id="htWinPrize"></div>
        <div class="ht-win-rest" id="htWinRest"></div>
        <button type="button" class="btn btn-gold ht-win-close" id="htWinClose">확인</button>
      </div>
    </div>

    ${helpDialog('htHelp', '홀덤 프리롤 규칙', HELP_BODY)}
  <script>window.__ME__ = ${jsonForScript(user.username)}; window.__MEID__ = ${jsonForScript(user.id)};
    window.__SFX_NEED__ = ['card','shuffle','deal','chipbet','chipwin','victory'];</script>
  <script>
  (function(){
    var MEID = window.__MEID__;
    var CARD_V = ${jsonForScript(ASSET_V)};
    var st = null, unit = 'chip', spectate = false, paidHandNo = null;
    // 판에 처음 들어온 순간에는 연출 없이 현재 상태를 그대로 보여준다
    var firstTablePaint = true;

    var lobbyEl = document.getElementById('htLobby');
    var tableEl = document.getElementById('htTable');
    var seatsEl = document.getElementById('htSeats');
    var spotsEl = document.getElementById('htSpots');
    var boardEl = document.getElementById('htBoard');
    var potEl = document.getElementById('htPot');
    var msgEl = document.getElementById('htMsg');
    var readEl = document.getElementById('htRead');
    var rabbitBtn = document.getElementById('htRabbit');
    var showBtn = document.getElementById('htShow');
    var rnoteEl = document.getElementById('htRNote');
    var outroEl = document.getElementById('htOutro');
    var lvEl = document.getElementById('htLvUp');
    var potsEl = document.getElementById('htPots');
    var pileEl = document.getElementById('htPotPile');
    var winEl = document.getElementById('htWin');

    /* ── 우승 축하 ───────────────────────────────────────────────────
       마지막 판을 다 보여준 뒤에 뜬다(FINISH_LINGER_SEC). 그 전에 띄우면 대회를
       결정지은 판의 쇼다운을 덮어버린다.

       한 대회에 한 번만 뜨고, 닫으면 다시 뜨지 않는다. 다만 표시 기록의 열쇠에
       종료 시각을 함께 넣는다 — 대회 id만 쓰면, 같은 대회를 다시 돌렸을 때(테스트 중
       서버를 다시 띄우면 그날 대회가 같은 id로 초기화된다) 축하가 영구히 억제된다.
       실제로 이 때문에 "우승 연출이 안 뜬다"는 제보가 나왔다. */
    function celebrateKey(t){ return 'od_ht_win_' + t.id + ':' + (t.finishedAt || 0); }
    function celebrate(){
      var t = st.tournament;
      if (t.status !== 'FINISHED') return;
      var results = st.results || [];
      if (!results.length) return;
      // 마지막 판을 보여주는 중이면 아직이다 — 링거가 끝나고 나서 축하한다
      if (st.table && st.table.tournamentOver) return;
      var key = celebrateKey(t);
      try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); }
      catch (e) { /* 저장을 못 쓰는 환경이면 매번 뜬다 — 축하가 안 뜨는 것보다 낫다 */ }

      var first = results[0];
      document.getElementById('htWinAv').innerHTML =
        avatarHtml(first.userId, first.avatar, first.username, 'ht-win-av');
      document.getElementById('htWinWho').textContent = first.username;
      document.getElementById('htWinPrize').textContent =
        first.prize > 0 ? num(first.prize) + 'P' : '';
      document.getElementById('htWinRest').innerHTML = results.slice(1, 4).map(function(r){
        return '<div class="ht-win-row"><span>' + r.place + '위</span>' +
          avatarHtml(r.userId, r.avatar, r.username, 'ht-win-av sm') +
          '<span class="ht-win-nm">' + esc(r.username) + '</span>' +
          '<span>' + (r.prize > 0 ? num(r.prize) + 'P' : '-') + '</span></div>';
      }).join('');
      winEl.hidden = false;
      if (window.casinoSfx && window.casinoSfx.victory) window.casinoSfx.victory();
    }
    document.getElementById('htWinClose').addEventListener('click', function(){
      winEl.hidden = true;
    });
    var ctrlEl = document.getElementById('htControls');
    var ctopEl = document.getElementById('htCtop');
    var preEl = document.getElementById('htPre');
    var ACT_BTNS = ['htFold', 'htCheck', 'htCall', 'htRaise'].map(function(id){
      return document.getElementById(id);
    });
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
    /* 두 가지 시간 표기를 쓴다.
       mmss는 '똑딱거리는 시계'용이다 — 다음 블라인드(04:32)처럼 1시간 안쪽의 카운트다운.
       dur은 사람이 읽는 길이용이다. 내일 21:00까지 남은 시간을 mmss로 찍으면
       '1253:42'가 되어 무슨 뜻인지 알 수 없다. */
    function mmss(sec){
      if (sec == null) return '--:--';
      var s = Math.max(0, Math.floor(sec));
      return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
    }
    function dur(sec){
      if (sec == null) return '-';
      var s = Math.max(0, Math.floor(sec));
      var d = Math.floor(s/86400); s -= d*86400;
      var h = Math.floor(s/3600); s -= h*3600;
      var m = Math.floor(s/60), ss = s - m*60;
      if (d) return d + '일 ' + h + '시간';
      if (h) return h + '시간 ' + m + '분';
      if (m) return m + '분 ' + ss + '초';
      return ss + '초';
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
        note = '등록은 ' + dur(t.regOpenAt - now) + ' 후에 열립니다 (KST 21:00)';
        action = '<button type="button" class="btn btn-gold" disabled>참가 신청</button>';
      } else if (t.status === 'REGISTRATION_OPEN') {
        badge = '<span class="ht-badge open">등록 중</span>';
        note = '시작까지 ' + dur(t.scheduledStartAt - now);
        /* 시작 전에는 신청을 되돌릴 수 있다. 좌석과 스택은 대회가 시작될 때
           한꺼번에 만들어지므로, 이 시점의 취소는 등록 행 하나를 지우는 것뿐이다.
           시작한 뒤에는 이미 칩을 들고 앉아 있어 취소가 성립하지 않는다. */
        action = t.iRegistered
          ? '<span class="ht-joined">신청 완료</span>'
            + ' <button type="button" class="btn ht-leave" id="htLeave">신청 취소</button>'
          : '<button type="button" class="btn btn-gold" id="htJoin">참가 신청</button>';
      } else if (t.status === 'WAITING_MIN_PLAYERS') {
        badge = '<span class="ht-badge wait">최소 인원 대기</span>';
        note = '최소 인원 대기 중 — ' + dur(t.graceEndsAt - now) + ' 남음';
        /* 시작 전에는 신청을 되돌릴 수 있다. 좌석과 스택은 대회가 시작될 때
           한꺼번에 만들어지므로, 이 시점의 취소는 등록 행 하나를 지우는 것뿐이다.
           시작한 뒤에는 이미 칩을 들고 앉아 있어 취소가 성립하지 않는다. */
        action = t.iRegistered
          ? '<span class="ht-joined">신청 완료</span>'
            + ' <button type="button" class="btn ht-leave" id="htLeave">신청 취소</button>'
          : '<button type="button" class="btn btn-gold" id="htJoin">참가 신청</button>';
      } else if (t.status === 'RUNNING') {
        if (t.lateRegLeft != null) {
          badge = '<span class="ht-badge late">LATE REGIST</span>';
          note = '늦은 등록 마감까지 ' + dur(t.lateRegLeft);
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
      var leave = document.getElementById('htLeave');
      if (leave) leave.addEventListener('click', function(){
        if (!confirm('참가 신청을 취소할까요?')) return;
        leave.disabled = true;
        post('/api/games/holdem/unregister', {}).then(function(r){
          if (!r.ok) alert(r.d && r.d.error ? r.d.error : '취소할 수 없습니다');
          leave.disabled = false;
          poll();
        });
      });
      if (spec) spec.addEventListener('click', function(){ spectate = true; render(); });
    }

    /* ── 좌석 좌표 ──────────────────────────────────────────────────
       스테이지(테이블 바깥 여백 포함) 기준 % 좌표다. 순서는 6시에서 시작해 시계방향.
         plate  좌석판 중심
         bet    베팅 칩 자리 — 좌석과 중앙 사이
       카드는 좌석판 바로 위에 붙이므로 좌표가 따로 필요 없다(CSS가 위로 쌓는다). */
    /* 아래 세 자리(6시·5시·7시)는 카드가 자라는 방향과 칩이 놓인 방향이 같아서
       칩이 카드 위를 가로질렀다. 특히 6시는 카드와 칩이 같은 수직선(x=50%)에 있어
       카드를 키우면 칩이 카드 위에 그대로 얹힌다. 칩을 중앙 쪽으로 더 밀어
       "카드는 몸 앞, 칩은 베팅 라인 너머"라는 실제 배치로 맞췄다.
       나머지 여섯 자리는 카드와 칩이 30px 이상 떨어져 있어 건드리지 않는다 —
       중앙 쪽으로 밀면 보드를 가린다. */
    var POS = [
      { plate: [50, 93], bet: [50, 67] },   // 0 = 6시 (Hero)
      { plate: [25, 90], bet: [34, 70] },
      { plate: [8,  68], bet: [20, 62] },
      { plate: [8,  41], bet: [20, 45] },
      /* 이 두 자리는 카드를 판 아래(중앙 방향)로 깐다(cards-below). 그래서 칩도
         카드보다 더 중앙 쪽으로 내려야 한다 — 위로 깔던 시절 좌표(30%)를 그대로 두면
         내려온 카드 위에 칩이 얹힌다. */
      { plate: [25, 16], bet: [33, 38] },
      { plate: [75, 16], bet: [67, 38] },
      { plate: [92, 41], bet: [80, 45] },
      { plate: [92, 68], bet: [80, 62] },
      { plate: [75, 90], bet: [66, 70] },
    ];

    /* 이 판의 SB·BB 자리. 딜링 순서를 정할 때 쓰는 sbSeatOf를 그대로 쓴다 —
       규칙이 두 곳에 따로 적히면 배지와 실제 블라인드가 어긋난다. */
    function blindSeatsOf(tb){
      var inHand = (tb.seats || []).filter(function(s){ return s.inHand; });
      if (inHand.length < 2) return { sb: null, bb: null };
      var sb = sbSeatOf(inHand, tb.buttonSeat);
      var nums = inHand.map(function(s){ return s.seat; });
      var bb = null;
      for (var i = 1; i <= 9; i++) {
        var cand = (sb + i) % 9;
        if (nums.indexOf(cand) >= 0) { bb = cand; break; }
      }
      return { sb: sb, bb: bb };
    }

    function renderSeats(){
      var tb = st.table, seats = tb.seats || [];
      var blindSeats = blindSeatsOf(tb);
      /* 보드를 깔고 있는 동안(정지 + 한 장씩 공개)에는 스트리트를 닫은 행동을 붙들고 있는다.
         syncBoard가 이 함수보다 먼저 돌아 boardRevealed를 정해 준다. */
      var holdActor = !boardRevealed ? tb.lastActor : null;
      /* Hero를 항상 6시에 두려면 "내 자리 번호"를 기준으로 회전시킨다.
         자리 번호는 서버가 정한 그대로 두고 화면 위치만 돌린다 —
         내가 3번이든 7번이든 언제나 아래 가운데에서 플레이한다. */
      var anchor = tb.mySeat != null ? tb.mySeat : (seats.length ? seats[0].seat : 0);
      var html = '', vol = '', sigParts = [];
      seats.forEach(function(s){
        var rot = ((s.seat - anchor) % 9 + 9) % 9;
        var p = POS[rot];

        /* 12시 쪽 두 자리(rot 4·5)는 카드를 좌석판 아래로 깐다.
           카드는 원래 판 위로만 자라는데, 이 두 자리는 펠트 상단까지 55px밖에 없어서
           카드를 키우면 둥근 펠트 경계를 뚫고 나간다(1050px 폭에서 47px). 아래는
           테이블 중앙이라 공간이 넉넉하다 — 실제 9인 클라이언트도 위쪽 자리는
           카드를 아래에 놓는다. */
        var below = (rot === 4 || rot === 5);
        html += '<div class="ht-seat' + (below ? ' cards-below' : '') + '" data-seat="' + s.seat + '"' +
            ' style="left:' + p.plate[0] + '%;top:' + p.plate[1] + '%">' +
            '<div class="ht-hole"></div>' +
            '<div class="ht-plate">' +
              avatarHtml(s.userId, s.avatar, s.username, 'ht-av') +
              /* 남은 행동 시간 — 아바타를 두르는 고리 + 작은 숫자.
                 좌석판 가운데에 두면 이름과 스택을 덮는다(실제로 그랬다). 아바타 둘레는
                 비어 있는 자리이고, "누구의 시간인지"도 아바타에 붙어 있어야 분명하다. */
              '<span class="ht-clock" hidden></span>' +
              '<span class="ht-clock-n" hidden></span>' +
              '<span class="ht-who">' +
                '<span class="ht-nm">Seat ' + (s.seat + 1) +
                  (s.userId === MEID ? ' (나)' : '') + '</span>' +
                '<span class="ht-stk" id="htstk-' + s.seat + '"></span>' +
              '</span>' +
              '<span class="ht-puck ' + (p.plate[0] < 50 ? 'r' : 'l') + '" title="딜러 버튼" hidden>D</span>' +
              /* 블라인드 배지 — 딜러 버튼 반대쪽에 붙인다. 같은 쪽에 두면 D와 겹친다.
                 포지션(누가 먼저 말하는지)이 보이지 않으면 초보는 프리플랍 순서를 못 읽는다. */
              '<span class="ht-blind ' + (p.plate[0] < 50 ? 'l' : 'r') + '" hidden></span>' +
              '<span class="ht-fold-b" title="폴드" hidden>F</span>' +
              '<span class="ht-zzz" title="자리 비움" hidden>II</span>' +
            '</div>' +
            /* 남은 행동 시간 — 좌석판을 두르는 고리. 숫자만으로는 "얼마 안 남았다"가
               몸으로 안 느껴진다. 각도는 클라이언트가 매 프레임 보간한다(서버 해상도는 1초). */
          '</div>';

        /* 골격 서명은 "누가 어느 자리에 앉았나"만 본다.
           카드·상태·딜러 버튼·스택은 전부 아래에서 제자리 갱신한다.
           여기에 하나라도 변하는 값을 넣으면 그때마다 좌석 DOM이 새로 만들어지고,
           카드 요소가 다시 생겨 cardFlip이 재생되고 판 폭이 흔들려 카드가 움찔거린다.
           실제로 카드가 액션마다 최대 7.5px씩 움직였다. */
        /* rot도 넣는다 — 화면 위치와 카드 방향(cards-below)이 rot에서 나오므로,
           기준 자리(내 자리)가 바뀌면 골격을 다시 그려야 한다. */
        sigParts.push(s.seat + ':' + s.userId + ':' + rot);

        // 베팅 칩과 행동 표시는 카드와 무관한 별도 레이어에 그린다 (여기가 바뀌어도 카드는 그대로)
        var act = s.act, amt = s.actAmount;
        /* 스트리트를 닫은 행동은 서버가 좌석 표시를 초기화해 버려서 s.act가 비어 있다.
           보드를 깔기 전 정지 구간에서는 핸드 쪽에 남은 기록으로 그 자리를 채운다 —
           이게 없으면 "딜러가 체크했는데 안 보이고 플랍이 바로 깔린다"가 된다. */
        if (!act && holdActor && holdActor.seat === s.seat) {
          act = holdActor.act; amt = holdActor.amount;
        }
        /* 판이 끝나면 좌석 앞 칩을 그리지 않는다. 서버는 판이 끝날 때 bet을 0으로
           되돌리지 않는데(초기화는 스트리트 전환에만 있다), 그 사이 팟 더미는 이미
           마지막 스트리트 베팅까지 중앙에 그려 놓는다 — 같은 칩이 두 곳에 보인다. */
        if (s.bet > 0 && !tb.ended) {
          /* 칩이 있을 때 행동 이름은 칩 위에 층을 쌓지 않고 같은 줄에 붙인다.
             위로 쌓으면 아래 좌석에서 중앙 블록(보드·조합)까지 밀고 올라간다. */
          vol += '<div class="ht-spot" id="htspot-' + s.seat + '"' +
            ' style="left:' + p.bet[0] + '%;top:' + p.bet[1] + '%">' +
            '<span class="ht-spot-chips">' + chipStack(s.bet) + '</span>' +
            '<span class="ht-spot-amt">' + stackText(s.bet) + '</span>' +
            (act ? '<span class="ht-spot-act">' + actLabel(act, amt) + '</span>' : '') +
            '</div>';
        }
        // 칩이 없을 때(체크·폴드)는 베팅 자리에 행동 이름만 단독으로 띄운다
        else if (act) {
          vol += '<div class="ht-act" style="left:' + p.bet[0] + '%;top:' + p.bet[1] + '%">' +
            actLabel(act, amt) + '</div>';
        }
      });

      var sig = sigParts.join('|');
      if (seatsEl.dataset.sig !== sig) { seatsEl.dataset.sig = sig; seatsEl.innerHTML = html; }
      if (spotsEl.dataset.sig !== vol) { spotsEl.dataset.sig = vol; spotsEl.innerHTML = vol; }

      // 자주 바뀌는 것은 골격을 건드리지 않고 제자리에서 갱신한다
      seats.forEach(function(s){
        var el = document.getElementById('htstk-' + s.seat);
        if (el) {
          el.textContent = s.state === 'allin' ? 'ALL IN' : stackText(s.stack);
          el.className = s.state === 'allin' ? 'ht-allin' : 'ht-stk';
        }
        var seatEl = seatsEl.querySelector('.ht-seat[data-seat="' + s.seat + '"]');
        if (!seatEl) return;
        seatEl.classList.toggle('hero', s.userId === MEID);
        seatEl.classList.toggle('turn', s.seat === tb.toActSeat);
        seatEl.classList.toggle('folded', s.state === 'folded');
        seatEl.classList.toggle('allin', s.state === 'allin');
        seatEl.classList.toggle('sitout', s.presence === 'SIT_OUT');
        seatEl.classList.toggle('disc', s.presence === 'DISCONNECTED');
        // 딜러 버튼·배지는 만들어 두고 감췄다 켠다 (요소를 새로 만들면 카드까지 딸려 다시 생긴다)
        var puck = seatEl.querySelector('.ht-puck');
        if (puck) puck.hidden = s.seat !== tb.buttonSeat;
        /* SB / BB 배지. 판이 끝난 뒤에는 지운다 — 다음 판이면 자리가 바뀐다.
           헤즈업에서는 버튼이 곧 SB라 D와 SB가 같은 자리에 나란히 붙는다(실제 규칙이다). */
        var blind = seatEl.querySelector('.ht-blind');
        if (blind) {
          var role = !tb.ended && s.inHand
            ? (s.seat === blindSeats.sb ? 'SB' : s.seat === blindSeats.bb ? 'BB' : '')
            : '';
          blind.hidden = !role;
          blind.textContent = role;
          blind.classList.toggle('bb', role === 'BB');
        }
        var foldB = seatEl.querySelector('.ht-fold-b');
        if (foldB) foldB.hidden = s.state !== 'folded';
        var zzz = seatEl.querySelector('.ht-zzz');
        if (zzz) zzz.hidden = !(s.state !== 'folded' && s.presence === 'SIT_OUT');
        syncHole(seatEl.querySelector('.ht-hole'), s);
      });
    }

    /* ── 행동 시간 고리 ───────────────────────────────────────────────
       서버는 남은 초를 정수로만 준다(폴링도 1초 간격이다). 그걸 그대로 그리면 고리가
       1초마다 뚝뚝 끊긴다. 그래서 폴링이 준 값을 기준점으로 잡고 그 뒤로는
       실제 흐른 시간으로 보간해 매 프레임 그린다 — 다음 폴링이 오면 기준점만 새로 맞춘다.

       마지막 5초에 색을 바꾸고 초당 한 번 짧게 울린다. 시간이 다 되면 서버가 자동으로
       체크(불가하면 폴드)하므로, 이 경고는 "지금 안 누르면 자동으로 넘어간다"는 뜻이다. */
    var clockBase = null;      // { seat, left, at, total }
    var clockBeeped = null;    // 마지막으로 울린 남은 초 (같은 초에 두 번 울리지 않게)
    function noteClock(tb){
      if (!tb || tb.toActSeat == null || tb.actionLeft == null || tb.ended) {
        clockBase = null; clockBeeped = null;
        return;
      }
      // 같은 자리·같은 남은 초가 계속 오는 동안에는 기준점을 흔들지 않는다
      if (clockBase && clockBase.seat === tb.toActSeat && clockBase.left === tb.actionLeft) return;
      clockBase = {
        seat: tb.toActSeat, left: tb.actionLeft, at: Date.now(),
        total: tb.actionSec || 20,
      };
    }
    function paintClock(){
      var seats = seatsEl.querySelectorAll('.ht-seat');
      if (!clockBase) {
        // 고리와 숫자를 같이 감춘다 — 하나만 감추면 지난 판의 남은 초가 화면에 남는다
        seats.forEach(function(el){
          var c = el.querySelector('.ht-clock'); if (c) c.hidden = true;
          var n = el.querySelector('.ht-clock-n'); if (n) n.hidden = true;
        });
        return;
      }
      var left = clockBase.left - (Date.now() - clockBase.at) / 1000;
      if (left < 0) left = 0;
      var frac = clockBase.total > 0 ? left / clockBase.total : 0;
      if (frac > 1) frac = 1;
      var warn = left <= 5;
      seats.forEach(function(el){
        var c = el.querySelector('.ht-clock');
        if (!c) return;
        var n = el.querySelector('.ht-clock-n');
        var mine = Number(el.getAttribute('data-seat')) === clockBase.seat;
        c.hidden = !mine;
        if (n) n.hidden = !mine;
        if (!mine) return;
        c.style.setProperty('--frac', String(frac));
        c.classList.toggle('warn', warn);
        if (n) {
          n.textContent = String(Math.ceil(left));
          n.classList.toggle('warn', warn);
        }
      });
      // 경고음은 내 차례일 때만. 남의 시계까지 울리면 시끄럽고 내 것과 구분도 안 된다.
      if (warn && st.table && clockBase.seat === st.table.mySeat) {
        var sec = Math.ceil(left);
        if (sec > 0 && sec !== clockBeeped) {
          clockBeeped = sec;
          if (window.casinoSfx && window.casinoSfx.card) window.casinoSfx.card();
        }
      }
    }
    // 고리는 폴링과 무관하게 계속 돈다 — 폴링 사이 1초를 메우는 것이 목적이다
    setInterval(function(){ if (st && st.table && !tableEl.hidden) paintClock(); }, 80);

    /* 홀 카드를 "바뀐 칸만" 갈아 끼운다.
       카드마다 cardFlip 애니메이션이 걸려 있어서, 같은 카드인데 요소를 새로 만들면
       애니메이션이 다시 재생되고 위치도 흔들린다. src가 실제로 달라진 칸만 교체한다
       (다른 게임의 syncCards와 같은 방식). */
    function syncHole(hole, s){
      if (!hole) return;
      var cls = s.userId === MEID ? 'hero' : 'sm';
      var want = (s.cards && s.cards.length) ? s.cards.slice()
        : (s.inHand ? [null, null] : []);
      while (hole.children.length > want.length) hole.removeChild(hole.lastChild);
      for (var i = 0; i < want.length; i++) {
        var src = want[i] ? '/cards/' + want[i] + '.svg?v=' + CARD_V
          : '/cards/back-red.svg?v=' + CARD_V;
        var cur = hole.children[i];
        if (!cur) {
          hole.insertAdjacentHTML('beforeend', cardImg(want[i], cls));
          cur = hole.lastChild;
        } else if (cur.getAttribute('src') !== src) {
          cur.outerHTML = cardImg(want[i], cls);
          cur = hole.children[i];
        }
        /* 버린 패 · 자발적 공개 표시는 클래스만 바꾼다 — 요소를 다시 만들지 않는다.
           본인이 깐 패는 흐리게 하지 않는다. 굳이 보여준 것을 가릴 이유가 없다. */
        if (cur && cur.classList) {
          cur.classList.toggle('mucked', s.state === 'folded' && !s.shown);
          cur.classList.toggle('shown', !!s.shown);
        }
      }
    }

    /* ── 래빗 헌트 ───────────────────────────────────────────────────
       폴드로 일찍 끝난 판에서 "그대로 갔으면 뭐가 깔렸을까"를 확인한다.
       서버는 핸드가 끝난 뒤에만 이 카드를 내려보낸다(rabbitBoard가 직접 막는다).
       버튼을 누른 판만 보여주고, 새 판이 시작되면 저절로 닫힌다. */
    var rabbitShownHand = null;
    function syncRabbit(tb){
      var rest = tb.rabbit || [];
      var can = tb.ended && rest.length > 0;
      rabbitBtn.hidden = !can || rabbitShownHand === tb.handNo;
      var open = can && rabbitShownHand === tb.handNo;
      rnoteEl.hidden = !open;
      if (open) rnoteEl.textContent = '🐇 파란 점선 ' + rest.length + '장은 실제로 깔리지 않은 카드입니다';
      if (!open) return;
      /* 이미 눌렀다 — 실제 보드 뒤에 이어 붙인다.
         실제 카드는 paintBoard로 유지하고(이미 깔린 장은 건드리지 않는다)
         래빗 카드만 뒤에 덧붙인다. */
      var real = tb.board || [];
      paintBoard(real, real.length);
      for (var i = 0; i < rest.length; i++) {
        var at = real.length + i;
        var src = '/cards/' + rest[i] + '.svg?v=' + CARD_V;
        var cur = boardEl.children[at];
        if (!cur) boardEl.insertAdjacentHTML('beforeend', cardImg(rest[i], 'rabbit'));
        else if (cur.getAttribute('src') !== src) cur.outerHTML = cardImg(rest[i], 'rabbit');
      }
      while (boardEl.children.length > real.length + rest.length) {
        boardEl.removeChild(boardEl.lastChild);
      }
    }
    rabbitBtn.addEventListener('click', function(){
      if (!st || !st.table) return;
      rabbitShownHand = st.table.handNo;
      rabbitBtn.hidden = true;
      if (window.casinoSfx && window.casinoSfx.card) window.casinoSfx.card();
      syncRabbit(st.table);
    });

    /* ── 내 패 공개 ──────────────────────────────────────────────────
       래빗과 달리 이건 서버에 남는다 — 나만 보는 게 아니라 남에게 보여주는 것이
       목적이니까. 폴드했더라도 공개할 수 있다(블러프를 보여주는 실제 관례).
       판이 끝난 뒤에만 되고, 서버가 SQL 조건으로 다시 확인한다. */
    var showSent = null;                 // 눌러놓고 폴링을 기다리는 판 번호
    function syncShow(tb){
      // 이미 눌렀으면 서버가 반영해줄 때까지 다시 못 누르게 둔다
      showBtn.hidden = !tb.canShow || showSent === tb.handNo;
    }
    showBtn.addEventListener('click', function(){
      if (!st || !st.table || !st.table.ended) return;
      showSent = st.table.handNo;
      showBtn.hidden = true;
      fetch('/api/games/holdem/show', { method: 'POST' })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d && d.error) { showSent = null; return; }
          if (window.casinoSfx && window.casinoSfx.card) window.casinoSfx.card();
          poll();                        // 내가 깐 게 바로 보이게 한 번 당겨온다
        })
        .catch(function(){ showSent = null; });
    });

    /* 행동 이름. 금액이 의미 있는 것만 금액을 붙인다 —
       "체크 0" 같은 표기는 정보가 아니라 잡음이다. */
    function actLabel(kind, amount){
      if (kind === 'fold') return '폴드';
      if (kind === 'check') return '체크';
      if (kind === 'allin') return 'ALL IN';
      if (kind === 'call') return '콜';
      if (kind === 'bet') return '베팅';
      if (kind === 'raise') return '레이즈';
      void amount;
      return '';
    }

    /* ── 중앙 팟 칩 더미 ────────────────────────────────────────────
       스트리트가 닫힐 때마다 각자 앞의 칩이 중앙으로 모인다. 그 "모인 것"을 실제로
       쌓아 둔다 — 숫자만 있으면 팟이 커지는 게 보이지 않고, 끝나서 승자에게 갈 때도
       무엇이 가는지가 없다.

       올린 칩은 목록으로 기억한다. 총액을 다시 쪼개면 500 두 개가 1000 한 개로
       합쳐져 버린다 — 블랙잭에서 똑같은 문제를 겪고 칩 로그로 고쳤다. */
    var HT_DENOMS = [25000, 5000, 1000, 500, 100, 25];
    var HT_BAR_FROM = 1000;        // 이 액면 이상은 골드바 모양
    var HT_MAX_CHIPS = 30;
    function htChipLabel(v){ return v >= 10000 ? (v / 10000) + '만' : String(v); }
    function htDecompose(amount){
      var out = [];
      for (var i = 0; i < HT_DENOMS.length && out.length < HT_MAX_CHIPS; i++) {
        while (amount >= HT_DENOMS[i] && out.length < HT_MAX_CHIPS) {
          out.push(HT_DENOMS[i]); amount -= HT_DENOMS[i];
        }
      }
      /* 블라인드가 오르면 25로도 안 나뉘는 잔액(앤티 나머지 등)이 남을 수 있다.
         남은 것은 가장 작은 칩 하나로 대신 보여준다 — 개수보다 "쌓였다"가 중요하다. */
      if (amount > 0 && out.length < HT_MAX_CHIPS) out.push(HT_DENOMS[HT_DENOMS.length - 1]);
      return out;
    }
    function htJit(i, span){ return ((i * 2654435761) % 1000) / 1000 * span - span / 2; }
    function htChipSprite(denom, idx, pending){
      var col = idx % 6, row = Math.floor(idx / 6);
      var x = Math.round((col - 2.5) * 13 + htJit(idx, 7));
      var y = Math.round(2 + row * 4 + htJit(idx + 7, 2));
      return '<span class="ht-pchip ' + (denom >= HT_BAR_FROM ? 'c-bar' : 'c-coin') +
        (pending ? ' pending' : '') + '" data-d="' + denom + '"' +
        ' style="left:calc(50% + ' + x + 'px);bottom:' + y + 'px;z-index:' + (10 + idx) + '">' +
        htChipLabel(denom) + '</span>';
    }
    var potPile = { hand: null, total: 0, list: [], n: 0 };
    function paintPotPile(){
      pileEl.style.opacity = '';
      pileEl.innerHTML = '';
      for (var i = 0; i < potPile.list.length; i++) {
        pileEl.insertAdjacentHTML('beforeend', htChipSprite(potPile.list[i].d, potPile.list[i].i, false));
      }
    }
    function resetPotPile(handNo, settled){
      potPile = { hand: handNo, total: 0, list: [], n: 0 };
      pileEl.style.opacity = '';
      pileEl.innerHTML = '';
      // 판 도중에 들어온 경우엔 이미 쌓여 있던 만큼을 연출 없이 그린다
      if (settled > 0) { potPile.total = settled; pushPotChips(htDecompose(settled), false); }
    }
    function pushPotChips(denoms, animate){
      var added = [];
      for (var i = 0; i < denoms.length; i++) {
        if (potPile.list.length >= HT_MAX_CHIPS) {
          potPile.list.shift();
          if (pileEl.firstChild) pileEl.removeChild(pileEl.firstChild);
        }
        var slot = potPile.n++ % HT_MAX_CHIPS;
        potPile.list.push({ d: denoms[i], i: slot });
        pileEl.insertAdjacentHTML('beforeend', htChipSprite(denoms[i], slot, animate));
        added.push(pileEl.lastElementChild);
      }
      /* 각자 앞의 칩이 중앙으로 날아오는 연출(flyChip 'topot')이 약 700ms다.
         그것이 도착할 즈음 더미에 나타나게 해야 "모여서 쌓였다"로 읽힌다. */
      if (animate) {
        added.forEach(function(el, k){
          setTimeout(function(){ if (el) el.classList.remove('pending'); }, 420 + k * 40);
        });
      }
      return added;
    }
    function syncPotPile(tb){
      /* 지금 이 스트리트에 각자 앞에 놓인 칩은 아직 중앙에 온 것이 아니다.
         팟 총액에서 그것을 빼면 "이미 중앙에 모인 금액"이 된다.
         단 판이 끝나면 마지막 스트리트의 베팅까지 전부 중앙으로 모인다 — 그걸 빼두면
         팟은 1,050인데 더미에는 450어치만 쌓인 채로 승자에게 날아간다. */
      var live = 0;
      (tb.seats || []).forEach(function(s){ live += s.bet || 0; });
      var settled = tb.ended ? (tb.pot || 0) : Math.max(0, (tb.pot || 0) - live);
      if (potPile.hand !== tb.handNo) return resetPotPile(tb.handNo, settled);
      // 콜되지 않은 초과 베팅을 돌려주면 팟이 줄어든다 — 그때는 연출 없이 다시 그린다
      if (settled < potPile.total) return resetPotPile(tb.handNo, settled);
      var delta = settled - potPile.total;
      if (delta > 0) {
        potPile.total = settled;
        pushPotChips(htDecompose(delta), !firstTablePaint);
        return;
      }
      // 금액은 그대로인데 칸이 비었다면 골격이 다시 그려진 것이다 — 기록대로 복원
      if (pileEl.childElementCount !== potPile.list.length) paintPotPile();
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
      var infoHtml =
        '<div class="ht-i"><span class="k">블라인드</span><span class="v gold">' +
          num(tb.level.sb) + ' / ' + num(tb.level.bb) +
          (tb.level.ante ? ' <i>앤티 ' + num(tb.level.ante) + '</i>' : '') + '</span></div>' +
        '<div class="ht-i"><span class="k">레벨</span><span class="v">Level ' + tb.level.level + '</span></div>' +
        /* 블라인드 업까지 남은 시간은 따로 한 줄을 준다. 예전에는 레벨 옆에 10.5px 회색
           <i>로 붙어 있어서 사실상 안 보였다. 이건 다음 판을 어떻게 칠지 정하는 정보다.
           1분 이하면 색을 올리고 깜빡인다. mmss는 항상 5글자라 등폭 폰트에서 폭이 고정된다. */
        '<div class="ht-i"><span class="k">블라인드 업</span><span class="v">' +
          (tb.nextLevelIn == null
            ? '<span class="ht-nextlv done">최종 레벨</span>'
            : '<span class="ht-nextlv' + (tb.nextLevelIn <= 60 ? ' soon' : '') + '">' +
              mmss(tb.nextLevelIn) + '</span>') + '</span></div>' +
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
      if (infoEl.dataset.sig !== infoHtml) {
        infoEl.dataset.sig = infoHtml;
        infoEl.innerHTML = infoHtml;
        // 버튼이 새로 만들어질 때만 이벤트를 다시 붙인다
        document.getElementById('htUnit').addEventListener('click', function(){
          unit = unit === 'chip' ? 'bb' : 'chip';
          render();
        });
      }

      // 칩 순위 — 스택 많은 순. 참고 디자인처럼 번호·아바타·이름·스택 한 줄.
      var rows = (tb.seats||[]).slice().sort(function(a,b){ return b.stack - a.stack; });
      var rankHtml = rows.map(function(s, i){
        return '<div class="ht-rw' + (s.userId === MEID ? ' me' : '') + '">' +
          '<span class="ht-rw-n">' + (i+1) + '</span>' +
          avatarHtml(s.userId, s.avatar, s.username, 'ht-rw-av') +
          '<span class="ht-rw-nm">' + esc(s.username) + '</span>' +
          '<span class="ht-rw-st">' + stackText(s.stack) + '</span>' +
          '</div>';
      }).join('') || '<div class="empty" style="padding:14px 0">아직 없습니다</div>';
      if (rankEl.dataset.sig !== rankHtml) { rankEl.dataset.sig = rankHtml; rankEl.innerHTML = rankHtml; }
      var out = tb.myPresence === 'SIT_OUT';
      backBtn.hidden = !out;
      sitBar.hidden = !out;
    }

    /* ── 테이블 ───────────────────────────────────────────────────── */
    /* ── 보드를 한 장씩 깐다 ─────────────────────────────────────────
       서버는 플랍 세 장을 한꺼번에 준다(스트리트 단위로 상태가 바뀐다).
       그대로 그리면 프리플랍이 끝난 순간 세 장이 뿅 나타난다.
       그래서 클라이언트가 "지금 몇 장까지 보여줄지"를 따로 들고, 남은 장을
       한 장씩 늘려가며 깐다. 서버는 초 단위 해상도라 이 박자는 클라이언트 몫이다. */
    var BOARD_FIRST_MS = 340;     // 플랍 첫 장까지
    var BOARD_STEP_MS = 260;      // 플랍 세 장 사이
    var BOARD_STREET_MS = 500;    // 한 번에 여러 스트리트를 열 때(올인) 스트리트 사이의 박자
    /* 스트리트가 넘어갈 때 카드를 깔기 전에 두는 정지.
       서버는 마지막 액션과 새 스트리트를 같은 응답에 담아 보낸다 — 그래서 이게 없으면
       "콜 300"이 뜨는 것과 플랍이 깔리는 것이 거의 동시에 일어나 마지막 액션을 볼 틈이 없다.
       실제 딜러도 액션이 끝나면 칩을 팟으로 모으고 나서 카드를 깐다. 칩이 팟으로
       날아가는 연출(약 700ms)과 겹쳐, 칩이 도착할 즈음 첫 장이 나오게 맞췄다.

       650ms로 뒀더니 "체크가 뜨는 것과 카드가 열리는 것이 거의 동시"라는 말이 나왔다.
       칩 연출이 끝나기를 기다리는 게 아니라, 사람이 마지막 액션을 읽을 시간이 기준이어야 한다.
       1,100ms면 첫 장까지 1.44초(+BOARD_FIRST_MS)라서 라벨을 읽고 나서 카드가 열린다. */
    var ACTION_HOLD_MS = 1100;
    var shownBoard = 0, boardTimers = [], boardHandNo = null;
    /* 보드를 다 깔았나. 올인으로 판이 즉시 끝나는 경우가 이 값의 존재 이유다 —
       서버는 액션이 끝나면 보드를 끝까지 깔고 정산까지 해버리므로, 클라이언트가
       ended만 보고 전부 그리면 플랍도 못 보고 결과가 뜬다. 결과를 아는 것과
       보여주는 속도는 별개다. 이 값이 false인 동안 결과 표시·칩 회수를 미룬다. */
    var boardRevealed = true;

    function clearBoardReveal(){
      boardTimers.forEach(clearTimeout);
      boardTimers = [];
    }
    /* 보드도 "바뀐 칸만" 갈아 끼운다.
       innerHTML을 통째로 쓰면 턴 한 장을 열 때 이미 깔려 있던 플랍 3장까지 새로 만들어져
       네 장 모두 cardFlip이 재생된다 — 실측으로 확인했다(기존 요소 3개가 전부 파괴됐다).
       소리도 새로 깔린 장수만큼만 낸다. */
    function paintBoard(cards, n, cls){
      var want = cards.slice(0, n);
      var added = 0;
      while (boardEl.children.length > want.length) boardEl.removeChild(boardEl.lastChild);
      for (var i = 0; i < want.length; i++) {
        var src = '/cards/' + want[i] + '.svg?v=' + CARD_V;
        var cur = boardEl.children[i];
        if (!cur) {
          boardEl.insertAdjacentHTML('beforeend', cardImg(want[i], cls));
          added++;
        } else if (cur.getAttribute('src') !== src) {
          cur.outerHTML = cardImg(want[i], cls);
          added++;
        }
      }
      if (added && window.casinoSfx && window.casinoSfx.card) window.casinoSfx.card();
      return added;
    }
    // 몇 번째 카드인지에 따라 앞에 두는 간격 (0~2 = 플랍, 3 = 턴, 4 = 리버)
    function boardGap(i){
      if (i === 0) return BOARD_FIRST_MS;
      if (i <= 2) return BOARD_STEP_MS;
      return BOARD_STREET_MS;
    }
    function syncBoard(tb){
      var cards = tb.board || [];
      // 래빗을 펼쳐 둔 판이면 그쪽이 보드를 그린다
      if (rabbitShownHand === tb.handNo) { syncRabbit(tb); return; }
      if (tb.handNo !== boardHandNo) {
        boardHandNo = tb.handNo;
        clearBoardReveal();
        shownBoard = 0;
        boardEl.innerHTML = '';
      }
      /* 판에 처음 들어온 순간만 연출을 건너뛴다(이미 진행 중인 판을 구경하는 경우).
         끝난 판이어도 연출은 그대로 돈다 — 올인 판에서 플랍·턴·리버를 한 장씩 봐야 한다. */
      if (firstTablePaint) {
        clearBoardReveal();
        shownBoard = cards.length;
        boardRevealed = true;
        paintBoard(cards, shownBoard);
        return;
      }
      if (cards.length <= shownBoard) {
        paintBoard(cards, shownBoard);
        boardRevealed = true;
        return;
      }
      boardRevealed = false;
      if (boardTimers.length) return;          // 이미 깔고 있는 중
      /* 첫 장 앞에만 정지를 둔다. 한 번에 여러 스트리트를 여는 올인 판에서도
         정지는 맨 앞에 한 번이고, 그 뒤 스트리트 사이는 BOARD_STREET_MS로 이어진다. */
      var t = ACTION_HOLD_MS;
      for (var i = shownBoard; i < cards.length; i++) {
        t += boardGap(i);
        (function(upto, at){
          boardTimers.push(setTimeout(function(){
            shownBoard = upto;
            var now = (st.table && st.table.board) || [];
            paintBoard(now, upto);
            if (upto >= now.length) { boardRevealed = true; clearBoardReveal(); }
          }, at));
        })(i + 1, t);
      }
    }

    /* ── 칩 이동 연출 ────────────────────────────────────────────────
       화면 전체를 덮는 레이어 위에서 복제본을 날린다. 자리 안에서 움직이면
       테이블 밖을 지나는 구간이 잘린다 (포커 플립·바카라와 같은 방식).      */
    var fxLayer = null;
    function getFx(){
      if (!fxLayer || !fxLayer.parentNode) {
        fxLayer = document.createElement('div');
        fxLayer.className = 'chip-fly-layer';
        document.body.appendChild(fxLayer);
      }
      return fxLayer;
    }
    function flyChip(fromRect, toRect, delay, cls){
      var c = document.createElement('i');
      c.className = 'ht-chip fly' + (cls ? ' ' + cls : '');
      c.style.cssText = 'position:fixed;left:' + fromRect.left + 'px;top:' + fromRect.top + 'px;' +
        'width:18px;height:11px;';
      c.style.setProperty('--tx', Math.round((toRect.left + toRect.width/2) - fromRect.left) + 'px');
      c.style.setProperty('--ty', Math.round((toRect.top + toRect.height/2) - fromRect.top) + 'px');
      c.style.animationDelay = delay + 'ms';
      getFx().appendChild(c);
      setTimeout(function(){ if (c.parentNode) c.parentNode.removeChild(c); }, 700 + delay);
    }

    /* 스트리트가 끝나면 각자 앞의 칩이 중앙 팟으로 밀려간다.
       서버는 스트리트가 넘어갈 때 베팅을 0으로 초기화하므로, 그 순간을 잡아
       "직전에 칩이 있던 자리"에서 팟으로 날린다. 초기화된 뒤에 날리려 하면
       출발 위치가 이미 사라져 있다 — 그래서 좌표를 미리 기억해 둔다. */
    var prevSpots = {}, spotStreet = null, spotHand = null, sweptEndHand = null;
    function rememberSpots(tb){
      var next = {};
      (tb.seats||[]).forEach(function(s){
        var el = document.getElementById('htspot-' + s.seat);
        if (el && s.bet > 0) {
          var r = el.getBoundingClientRect();
          next[s.seat] = { left: r.left, top: r.top, width: r.width, height: r.height };
        }
      });
      /* 스트리트가 넘어갈 때, 그리고 판이 끝날 때 각자 앞의 칩이 중앙으로 간다.
         판이 끝나는 경우를 빼먹으면 마지막 스트리트 베팅이 그 자리에서 그냥 사라진다. */
      var streetChanged = (tb.handNo === spotHand && tb.street !== spotStreet);
      var handEnded = tb.ended && sweptEndHand !== tb.handNo;
      if (streetChanged || handEnded) {
        if (handEnded) sweptEndHand = tb.handNo;
        var pot = potEl.getBoundingClientRect();
        var n = 0;
        Object.keys(prevSpots).forEach(function(k){
          flyChip(prevSpots[k], pot, n * 60, 'topot');
          n++;
        });
      }
      prevSpots = next;
      spotStreet = tb.street; spotHand = tb.handNo;
    }

    /* 중앙 더미에 실제로 쌓여 있는 칩 하나를 그대로 복제해 날린다.
       예전에는 팟 라벨 위치에서 익명의 작은 칩을 날렸는데, 그러면 쌓인 더미와
       무관한 것이 지나가서 "대충 넣은 애니메이션"으로 보인다. */
    function flyPileChip(chipEl, toRect, delay){
      var r = chipEl.getBoundingClientRect();
      if (!r.width) return;
      var c = chipEl.cloneNode(true);
      c.classList.remove('pending');
      c.className += ' flyout';
      c.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;' +
        'margin:0;width:' + r.width + 'px;height:' + r.height + 'px;z-index:70;';
      c.style.setProperty('--tx', Math.round((toRect.left + toRect.width/2) - (r.left + r.width/2)) + 'px');
      c.style.setProperty('--ty', Math.round((toRect.top + toRect.height/2) - (r.top + r.height/2)) + 'px');
      c.style.animationDelay = delay + 'ms';
      getFx().appendChild(c);
      setTimeout(function(){ if (c.parentNode) c.parentNode.removeChild(c); }, 760 + delay);
    }
    /* 핸드가 끝나면 팟이 승자에게 밀려간다. 한 판에 한 번만.
       중앙에 쌓인 칩을 지분대로 나눠 각 승자에게 보낸다. */
    var potPaidHand = null;
    function flyPotToWinners(tb){
      if (!tb.ended || !tb.result || potPaidHand === tb.handNo) return;
      potPaidHand = tb.handNo;
      /* 판이 끝나는 순간에는 마지막 스트리트 베팅이 아직 중앙으로 모이는 중이다
         (칩이 날아오고 더미에 나타나기까지 약 420ms). 그게 끝난 뒤에 밀어야
         "모아서 넘겨준다"로 읽힌다 — 실제 딜러도 걷어서 한 박자 쉬고 넘긴다. */
      var forHand = tb.handNo;
      setTimeout(function(){
        /* 지연 콜백이 도는 사이에 새 판이 시작됐으면 아무것도 하지 않는다.
           pushPotToWinners는 실시간 pileEl을 읽고 마지막에 비우므로, 그냥 두면
           다음 판의 팟 더미를 지워 버린다. */
        if (!st || !st.table || st.table.handNo !== forHand) return;
        pushPotToWinners(tb);
      }, 550);
    }
    function pushPotToWinners(tb){
      var awards = (tb.result.awards || []).filter(function(a){
        var seat = seatsEl.querySelector('.ht-seat[data-seat="' + a.seat + '"]');
        return seat && seat.querySelector('.ht-plate');
      });
      if (!awards.length) return;
      var chips = Array.prototype.slice.call(pileEl.children);
      var total = awards.reduce(function(a, x){ return a + x.amount; }, 0) || 1;
      var n = 0, used = 0;
      awards.forEach(function(a, k){
        var target = seatsEl.querySelector('.ht-seat[data-seat="' + a.seat + '"] .ht-plate');
        var tr = target.getBoundingClientRect();
        /* 그 사람이 가져가는 몫만큼의 칩을 보낸다. 마지막 승자가 남은 것을 전부 받아
           더미에 칩이 남지 않게 한다(사이드 팟이 있어도 중앙이 깨끗하게 비워진다). */
        var take = k === awards.length - 1
          ? chips.length - used
          : Math.max(1, Math.round(chips.length * a.amount / total));
        take = Math.min(take, chips.length - used);
        for (var i = 0; i < take; i++) flyPileChip(chips[used + i], tr, (n++) * 45);
        used += take;
        // 더미가 비어 있으면(판 도중 합류 등) 최소한 칩 몇 개는 날아가게 한다
        if (!chips.length) {
          var pot = potEl.getBoundingClientRect();
          var cnt = a.amount >= tb.level.bb * 20 ? 5 : a.amount >= tb.level.bb * 5 ? 3 : 2;
          for (var j = 0; j < cnt; j++) flyChip(pot, tr, (n++) * 45, 'towin');
        }
      });
      // 날아간 만큼 중앙은 비운다
      if (chips.length) {
        pileEl.style.opacity = '0';
        setTimeout(function(){ pileEl.innerHTML = ''; potPile.list = []; }, 900);
      }
    }

    /* ── 딜링 연출 ───────────────────────────────────────────────────
       서버는 "두 장을 다 받은 상태"만 준다. 그대로 그리면 카드가 그냥 생겨 있다.
       실제 딜러처럼 테이블 중앙에서 각 자리로 한 장씩, 두 바퀴 돌며 날린다.
       카드 값 자체는 서버가 준 것만 쓰고 남의 것은 뒷면이라 이 연출이 결과를 노출하지 않는다.

       포커 플립·바카라에서 배운 것: 마지막 장의 콜백에서 연출을 닫으면 아직 날고 있던
       복제본까지 걷어내 끝의 두 장이 툭 생겨난다. 닫는 일은 별도 타이머로 뺀다. */
    /* 한 장씩 도는 간격. 인원에 따라 정한다 — 3인(6장)에 고정 간격을 쓰면 순식간에
       끝나 "사사삭" 소리만 나고, 9인(18장)에 같은 간격을 쓰면 늘어진다.
       총 딜링 시간을 1.3~1.6초에 맞춰, 장당 90~220ms 사이로 조절한다. */
    function dealStepMs(cards){
      return Math.max(90, Math.min(220, Math.round(1400 / cards)));
    }
    var DEAL_START_MS = 380;      // 셔플 소리가 끝나고 첫 장이 나가기까지
    var DEAL_FLIGHT_MS = 300;     // 복제본이 나는 시간 (CSS deal-in과 맞춘다)
    var dealtHandNo = null, dealTimers = [];
    function clearDeal(){
      dealTimers.forEach(clearTimeout);
      dealTimers = [];
      // 감춰둔 것을 전부 되돌린다 — 연출이 끊겨도 카드는 보여야 한다
      seatsEl.querySelectorAll('.ht-hole').forEach(function(h){
        h.style.visibility = '';
        for (var i = 0; i < h.children.length; i++) h.children[i].style.visibility = '';
      });
    }
    /* 스몰블라인드 좌석 — services/holdem.ts blindPositions와 같은 규칙.
       헤즈업은 버튼이 SB이고, 그 외에는 버튼 다음(시계방향) 자리가 SB다. */
    function sbSeatOf(seatsInHand, buttonSeat){
      var live = seatsInHand.map(function(s){ return s.seat; }).sort(function(a,b){ return a-b; });
      if (live.length < 2) return live.length ? live[0] : null;
      if (live.length === 2) return live.indexOf(buttonSeat) >= 0 ? buttonSeat : live[0];
      for (var i = 1; i <= 9; i++) {
        var cand = (buttonSeat + i) % 9;
        if (live.indexOf(cand) >= 0) return cand;
      }
      return live[0];
    }
    function dealSequence(tb){
      if (tb.handNo === dealtHandNo) return;
      dealtHandNo = tb.handNo;
      clearDeal();
      if (firstTablePaint || tb.ended) return;      // 들어온 순간이거나 이미 끝난 판이면 연출 없이

      var inHand = (tb.seats || []).filter(function(s){ return s.inHand; });
      if (!inHand.length) return;

      /* 실제 딜링 순서 — 스몰블라인드부터 시계방향으로 한 바퀴, 다시 한 바퀴.
         POS 배열이 6시부터 시계방향이고 화면 위치는 (좌석번호 - 내자리)로 회전시키므로,
         "좌석 번호 증가 = 화면상 시계방향"이 된다. 그래서 좌석 번호 오름차순을
         SB에서 시작하도록 돌리면 그대로 시계방향 순서가 된다. */
      var sb = sbSeatOf(inHand, tb.buttonSeat);
      var byNum = inHand.slice().sort(function(a,b){ return a.seat - b.seat; });
      var start = 0;
      for (var i = 0; i < byNum.length; i++) if (byNum[i].seat === sb) { start = i; break; }
      var order = byNum.slice(start).concat(byNum.slice(0, start));

      // 셔플은 작게 깔아 둔다 — 기본 크기면 이어지는 딜링음 열여덟 장을 전부 덮는다
      if (window.casinoSfx && window.casinoSfx.shuffle) window.casinoSfx.shuffle(0.5);

      // 두 바퀴 — 실제 테이블처럼 한 사람에게 두 장을 몰아주지 않는다
      var steps = [];
      for (var pass = 0; pass < 2; pass++) {
        for (var j = 0; j < order.length; j++) steps.push({ seat: order[j].seat, idx: pass });
      }

      /* 카드마다 따로 감춘다. 예전에는 .ht-hole 컨테이너를 감췄다가 그 자리의 첫 장을
         돌릴 때 컨테이너를 다시 보이게 했는데, 그러면 아직 돌지 않은 두 번째 장이
         같이 드러났다 — 두 바퀴로 도는 의미가 사라지고 딜링이 어정쩡해 보인 원인이다. */
      var cards = [];
      steps.forEach(function(x){
        var hole = seatsEl.querySelector('.ht-seat[data-seat="' + x.seat + '"] .ht-hole');
        var card = hole && hole.children[x.idx];
        if (card) { card.style.visibility = 'hidden'; cards.push(card); }
      });
      if (!cards.length) return;

      var step = dealStepMs(cards.length);
      var center = boardEl.getBoundingClientRect();
      if (!center.width) center = potEl.getBoundingClientRect();
      cards.forEach(function(card, n){
        dealTimers.push(setTimeout(function(){
          var r = card.getBoundingClientRect();
          if (!r.width) { card.style.visibility = ''; return; }
          // 딜러 자리(테이블 중앙)에서 그 카드 자리로 날아오는 복제본
          var c = card.cloneNode(true);
          c.className = card.className.replace(/\\bdeal-in\\b/g, '').trim() + ' deal-in';
          c.style.cssText = 'position:fixed;margin:0;left:' + r.left + 'px;top:' + r.top + 'px;' +
            'width:' + r.width + 'px;height:' + r.height + 'px;z-index:60;';
          c.style.setProperty('--dfx',
            Math.round((center.left + center.width/2) - (r.left + r.width/2)) + 'px');
          c.style.setProperty('--dfy',
            Math.round((center.top + center.height/2) - (r.top + r.height/2)) + 'px');
          getFx().appendChild(c);
          // 복제본이 도착하는 순간에 실제 카드를 드러낸다
          dealTimers.push(setTimeout(function(){
            if (c.parentNode) c.parentNode.removeChild(c);
            card.style.visibility = '';
          }, DEAL_FLIGHT_MS));
          if (window.casinoSfx && window.casinoSfx.deal) window.casinoSfx.deal();
        }, DEAL_START_MS + n * step));
      });
      // 연출이 끊겨도 카드는 반드시 다시 보이게 하는 안전장치
      dealTimers.push(setTimeout(clearDeal,
        DEAL_START_MS + cards.length * step + DEAL_FLIGHT_MS + 600));
    }

    function renderTable(){
      var tb = st.table;
      syncBoard(tb);
      /* 팟이 승자에게 넘어간 뒤에는 0으로 만든다.
         서버의 pot은 "이 판에 들어간 돈의 합"이라 판이 끝나도 값이 남는데, 그때 이미
         스택에는 딴 금액이 반영되어 있다. 그래서 팟을 계속 띄워 두면 같은 칩이 두 곳에
         보이고, 스택을 더해 보는 사람은 총 칩이 늘어난 것처럼 읽는다
         (실측: 스택합 40,000 + 팟 20,100 = 60,100).
         칩 더미가 날아가기 전까지는 그대로 보여준다 — 얼마짜리 팟이었는지가 정보다. */
      var potPaid = tb.ended && boardRevealed && paidHandNo === tb.handNo;
      potEl.textContent = stackText(potPaid ? 0 : tb.pot) + (unit === 'chip' ? ' P' : '');
      syncPots(tb, potPaid);
      renderSeats();
      dealSequence(tb);
      renderSide();
      // 칩이 중앙으로 밀려가 더미로 쌓이고, 판이 끝나면 그 더미가 승자에게 넘어간다
      rememberSpots(tb);
      syncPotPile(tb);
      // 팟 회수와 래빗 버튼은 보드를 다 깐 뒤에 — 결과가 카드보다 먼저 오면 안 된다
      if (boardRevealed) { flyPotToWinners(tb); syncRabbit(tb); syncShow(tb); }
      else { showBtn.hidden = true; rabbitBtn.hidden = true; rnoteEl.hidden = true; }

      var msg = '';
      if (tb.ended && !boardRevealed) {
        // 보드를 아직 깔고 있다 — 결과를 먼저 말해버리면 카드를 볼 이유가 없어진다
        msg = '';
      } else if (tb.ended && tb.result) {
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
      /* 보드를 다 깐 뒤에만 울린다. boardRevealed를 안 보면 올인 판에서 플랍이
         깔리기도 전에 승리 칩 소리가 나서 결과를 미리 알려준다 — 결과 표시·팟 회수는
         이미 이 가드를 지키는데 소리만 통과하고 있었다. */
      if (tb.ended && boardRevealed && paidHandNo !== tb.handNo) {
        paidHandNo = tb.handNo;
        if (window.casinoSfx && window.casinoSfx.chipWin) window.casinoSfx.chipWin();
      }

      /* 내 조합 — 초심자가 플러시를 완성해 놓고도 모르고 폴드하는 걸 막는다.
         내 카드로 계산한 내 정보라 남에게 새지 않는다. */
      var mh = boardRevealed ? tb.myHand : null;
      readEl.hidden = !mh || !mh.text;
      if (mh && mh.text) {
        readEl.textContent = mh.text;
        readEl.className = 'ht-read' + (mh.category != null && mh.category >= 2 ? ' strong' : '');
      }
      syncHighlight(tb, mh);
      syncOutro(tb);
      noteClock(tb);
      paintClock();
      syncLevelUp(tb);
      renderControls();
    }

    /* ── 메인 팟 / 사이드 팟 ──────────────────────────────────────────
       층이 하나면 위의 POT 숫자로 충분하므로 아무것도 띄우지 않는다. 올인이 섞여 층이
       갈라졌을 때만 나온다 — 이때는 합계만 보면 내가 다툴 수 있는 금액을 오해한다.
       내가 자격이 있는 층은 표시해 준다("내가 이 층을 가져갈 수 있다"). */
    function syncPots(tb, potPaid){
      var pots = tb.pots || [];
      // 팟이 이미 승자에게 갔으면 층도 지운다 (같은 칩이 스택과 팟에 동시에 보이지 않게)
      if (potPaid || pots.length < 2) { potsEl.hidden = true; potsEl.textContent = ''; return; }
      potsEl.hidden = false;
      potsEl.innerHTML = pots.map(function(p, i){
        var mine = tb.mySeat != null && (p.eligible || []).indexOf(tb.mySeat) >= 0;
        return '<span class="ht-pl' + (mine ? ' mine' : '') + '">' +
          '<span class="ht-pl-k">' + (i === 0 ? 'MAIN' : 'SIDE ' + i) + '</span>' +
          '<span class="ht-pl-v">' + stackText(p.amount) + '</span></span>';
      }).join('');
    }

    /* ── 블라인드 상승 알림 ───────────────────────────────────────────
       예전에는 오른쪽 패널 숫자가 조용히 바뀌기만 했다. 토너먼트에서 블라인드가 오른 걸
       모르면 스택을 BB로 환산하는 감각이 어긋나서 판단이 통째로 틀어진다.
       레벨이 바뀐 것을 처음 본 순간 이전 값과 새 값을 함께 띄운다. */
    var seenLevel = null, levelTimer = null;
    function syncLevelUp(tb){
      var lv = tb.level;
      if (!lv) return;
      if (seenLevel == null) { seenLevel = lv; return; }   // 들어온 순간은 알림 없이 기준만 잡는다
      if (lv.level === seenLevel.level) return;
      var prev = seenLevel;
      seenLevel = lv;
      document.getElementById('htLvFrom').textContent = num(prev.sb) + ' / ' + num(prev.bb);
      document.getElementById('htLvTo').textContent = num(lv.sb) + ' / ' + num(lv.bb);
      document.getElementById('htLvNo').textContent = 'LEVEL ' + lv.level;
      lvEl.hidden = false;
      if (window.casinoSfx && window.casinoSfx.chipWin) window.casinoSfx.chipWin();
      clearTimeout(levelTimer);
      levelTimer = setTimeout(function(){ lvEl.hidden = true; }, 3000);
    }

    /* ── 어느 카드가 지금 내 손을 만들고 있나 ─────────────────────────
       카드 요소의 alt에 카드 코드가 들어 있다(cardImg가 넣는다). 한 판에 같은 카드는
       한 장뿐이므로 코드로 찾으면 어디에 있든(내 손·보드) 정확히 그 한 장이 잡힌다.

       클래스만 토글한다 — 요소를 다시 만들면 cardFlip이 재생되어 카드가 다시 뒤집힌다.
       상태에서 매 폴링 다시 계산하므로, 스트리트가 넘어가면 저절로 맞춰진다. */
    function markCards(codes, cls){
      var want = {};
      (codes || []).forEach(function(c){ if (c) want[c] = 1; });
      tableEl.querySelectorAll('.pcard').forEach(function(el){
        var code = el.getAttribute('alt');
        el.classList.toggle(cls, !!(code && want[code]));
      });
    }

    function syncHighlight(tb, mh){
      /* 판이 끝나면 "이긴 5장"으로 넘어간다. 진행 중에는 "내 등급을 만든 카드"다 —
         목적이 다르다. 진행 중에 5장을 다 밝히면 플랍에서는 전부가 밝아져 아무
         신호가 되지 않고, 쇼다운에서 등급 카드만 밝히면 킥커로 갈린 판을 설명하지 못한다. */
      var reveal = (tb.ended && boardRevealed && tb.result && tb.result.reveal) || [];
      var awards = (tb.ended && boardRevealed && tb.result && tb.result.awards) || [];
      if (reveal.length && awards.length) {
        // 팟을 받은 자리 중 공개된 사람 = 이긴 손. 분할 팟이면 여럿일 수 있다.
        var wonSeats = {};
        awards.forEach(function(a){ if (a.amount > 0) wonSeats[a.seat] = 1; });
        var five = [], winnerCards = [];
        reveal.forEach(function(r){
          if (!wonSeats[r.seat]) return;
          five = five.concat(r.five || []);
          winnerCards = winnerCards.concat(r.cards || []);
        });
        markCards(five, 'win5');
        markCards([], 'made');
        /* 이긴 손에 쓰이지 않은 카드는 물린다 — 승자의 홀 카드와 보드 중 5장에 안 든 것.
           강조의 반대편이 있어야 "이 5장"이 읽힌다. 진 사람의 카드는 건드리지 않는다
           (그 손은 전부가 진 것이지 "안 쓰인" 게 아니다). */
        var inFive = {};
        five.forEach(function(c){ inFive[c] = 1; });
        var pool = winnerCards.concat((tb.board || []));
        markCards(pool.filter(function(c){ return !inFive[c]; }), 'unused');
        return;
      }
      markCards([], 'win5');
      markCards([], 'unused');
      markCards(mh ? mh.highlight : [], 'made');
    }

    /* ── 판·대회가 끝났다는 것을 말로 알려 준다 ───────────────────────
       족보명이 없으면 무엇으로 이겼는지 카드를 직접 읽어야 안다. 실제로 다른 클라이언트도
       이걸 안 보여줘서 "4초 안에 카드를 다 읽어야 한다"는 불만이 흔하다. */
    function syncOutro(tb){
      var reveal = (tb.ended && boardRevealed && tb.result && tb.result.reveal) || [];
      var awards = (tb.ended && boardRevealed && tb.result && tb.result.awards) || [];
      var text = '';
      if (reveal.length && awards.length) {
        var wonSeats = {};
        awards.forEach(function(a){ if (a.amount > 0) wonSeats[a.seat] = 1; });
        var parts = [];
        reveal.forEach(function(r){
          if (!wonSeats[r.seat] || !r.hand) return;
          var s = (tb.seats||[]).filter(function(x){ return x.seat === r.seat; })[0];
          parts.push((s ? s.username : 'Seat ' + (r.seat+1)) + ' — ' + r.hand);
        });
        text = parts.join('  ·  ');
      }
      outroEl.hidden = !text;
      if (text) outroEl.textContent = text;

      /* 대회 종료 — 마지막 판을 보여주는 동안은 테이블에 남아 있고, 시간이 다 되면
         우승 축하로 넘어간다. 이 안내가 없으면 테이블이 왜 멈춰 있는지 알 수 없다. */
      if (tb.tournamentOver) {
        msgEl.textContent = '대회 종료'
          + (tb.finishLeft != null && tb.finishLeft > 0 ? ' · 결과 ' + tb.finishLeft + '초' : '');
      }
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
      /* 판이 끝난 뒤의 두 버튼도 이 패널 안(ht-acts)에 있다. 그래서 내 차례가 아니라고
         패널 전체를 접으면 그 버튼이 뜨고 싶어도 보이지 않는다 — 실제로 그렇게 됐다.
         버튼이 하나라도 뜰 상황이면 패널은 열어두고, 베팅 금액 줄과 미리 지정 줄만 접는다. */
      var post = !rabbitBtn.hidden || !showBtn.hidden;
      ctrlEl.hidden = !la && !post;
      ctopEl.hidden = !la;
      preEl.hidden = !la;
      if (!la) {
        /* 행동할 수 없으면 네 버튼을 반드시 내린다. 전에는 패널이 통째로 닫혀서
           그냥 두어도 보이지 않았는데, 이제 판이 끝나도 패널이 열려 있으므로
           내리지 않으면 지난 판의 "폴드·콜 100"이 공개 버튼 옆에 그대로 남는다. */
        ACT_BTNS.forEach(function(b){ b.hidden = true; });
        return;
      }
      var lo = la.minRaiseTo == null ? la.maxRaiseTo : la.minRaiseTo;
      rangeEl.min = String(lo);
      rangeEl.max = String(la.maxRaiseTo);
      if (currentTarget() < lo || currentTarget() > la.maxRaiseTo) setAmount(lo);
      /* 체크할 수 있을 때는 폴드를 내린다.
         낼 금액이 없는 상황에서 폴드는 공짜로 받을 수 있는 패를 버리는 것이라 어떤 패에서도
         이득이 될 수 없다 — 이길 확률이 0이어도 체크가 같거나 낫다. 남는 건 오조작 위험뿐이다.
         낼 금액이 생기면(canCheck=false) 그때 다시 나온다.

         서버는 폴드를 계속 허용한다(canFold는 항상 true). 마감 초과 자동 처리가
         "체크 가능하면 체크, 아니면 폴드"로 폴드를 쓰고, 클라이언트가 버튼을 감추는 것과
         규칙이 허용하는 것은 별개다. 여기서 막는 건 손가락이 미끄러지는 경우다. */
      document.getElementById('htFold').hidden = !la.canFold || la.canCheck;
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
    var lastBets = {}, betHandNo = null, betStreet = null, myClickAt = 0;
    // 스트리트를 닫은 액션에 소리를 한 번만 내기 위한 기억
    var lastCloseKey = null, endSoundHand = null;
    function playBetSounds(){
      var tb = st.table;
      if (!tb) return;
      /* 스트리트가 넘어가면 서버가 이 스트리트 베팅을 0으로 되돌린다. 기억을 판 단위로만
         비우면, 새 스트리트의 첫 베팅이 지난 스트리트 금액보다 작을 때 "늘지 않았다"고
         판정되어 소리가 삼켜진다 (프리플랍 200 콜 → 플랍 100 벳 = 무음).
         한 번의 폴링 안에서 스트리트 전환과 새 베팅이 같이 오면 반드시 그렇게 된다. */
      var streetJustChanged = false;
      if (tb.handNo !== betHandNo || tb.street !== betStreet) {
        // 판이 바뀐 것은 "스트리트가 닫혔다"가 아니다 — 새 판의 첫 폴링에서 울리면 안 된다
        streetJustChanged = tb.handNo === betHandNo;
        lastBets = {}; betHandNo = tb.handNo; betStreet = tb.street;
      }
      // 리버에서 콜로 판이 끝나면 street는 그대로 river이므로 위 조건에 걸리지 않는다
      if (tb.ended && !endSoundHand) { endSoundHand = tb.handNo; streetJustChanged = true; }
      if (!tb.ended && endSoundHand === tb.handNo) endSoundHand = null;
      var any = false;
      (tb.seats || []).forEach(function(s){
        /* 내 자리도 센다. 예전에는 "내 것은 클릭 순간에 울렸다"며 빼놨는데, 자리 비움
           자동 콜이나 자동 콜 체크박스로 나간 칩은 클릭이 없어서 아무 소리도 안 났다.
           단 내가 방금 직접 눌렀다면 그 소리는 이미 울렸으므로 겹쳐 울리지 않는다. */
        var grew = s.bet > (lastBets[s.seat] || 0);
        var mineJustClicked = s.seat === tb.mySeat && (Date.now() - myClickAt) < 2500;
        if (grew && !mineJustClicked) any = true;
        lastBets[s.seat] = s.bet;
      });

      /* 스트리트를 닫은 칩 액션은 위 방법으로 절대 잡히지 않는다.
         그 액션이 라운드를 끝내면 서버가 같은 트랜잭션에서 이 스트리트 베팅을 0으로
         되돌리므로, 폴링이 보는 것은 이미 0이다 — "늘었다"가 성립할 수 없다.
         마지막 액션이 콜일 때 소리가 안 난다는 제보가 정확히 이 경로였다.
         그래서 스트리트가 바뀐(또는 판이 끝난) 폴링에서는 hand에 남은 마지막 액션 기록을
         근거로 울린다. 같은 액션에 두 번 울리지 않게 키로 기억해 둔다. */
      var la = tb.lastActor;
      if (streetJustChanged && la && la.seat != null) {
        var chipAct = la.act === 'call' || la.act === 'bet' || la.act === 'raise' || la.act === 'allin';
        var key = tb.handNo + ':' + la.seat + ':' + la.act + ':' + (la.amount || 0);
        if (chipAct && key !== lastCloseKey) {
          lastCloseKey = key;
          var mineJust = la.seat === tb.mySeat && (Date.now() - myClickAt) < 2500;
          if (!mineJust) any = true;
        }
      }
      if (any && window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
    }

    function act(kind, amount){
      // 칩이 실제로 나가는 액션에만 소리를 낸다 (폴드·체크는 칩이 안 나간다).
      // 서버 응답을 기다리지 않고 클릭 순간에 울려야 손맛이 난다.
      if (kind !== 'fold' && kind !== 'check') {
        myClickAt = Date.now();        // 폴링이 같은 칩 소리를 또 울리지 않게 표시해 둔다
        if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
      }
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
      /* 탈락한 뒤에도 대회가 끝날 때까지 테이블에 남긴다(자동 관전).
         예전에는 내 자리가 사라지는 순간 로비로 튕겨서, 내가 어떻게 죽었는지 본 다음의
         이야기 — 남은 사람들의 승부와 대회를 결정짓는 마지막 판 — 을 하나도 못 봤다.
         참가했던 사람만 대상이다. 구경만 하러 온 사람은 로비에서 [관전하기]로 들어온다. */
      if (st.table != null && st.table.mySeat == null && st.tournament.iRegistered) spectate = true;
      var showTable = st.table != null && (st.table.mySeat != null || spectate);
      lobbyEl.hidden = showTable;
      tableEl.hidden = !showTable;
      if (showTable) { renderTable(); updatePreLabels(); firstTablePaint = false; }
      else { renderLobby(); }
      // 테이블에 있든 로비에 있든 축하는 뜬다 — 예전엔 로비 분기에만 있었다
      celebrate();
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
