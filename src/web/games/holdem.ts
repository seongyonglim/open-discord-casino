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
  showHoldemCards, holdemRecords,
  ACTION_SEC, actOpenAt, type HoldemStatus,
} from '../../db/holdem';
import * as G from '../../services/holdem';
import * as T from '../../services/tournament';
import { getWebUser } from '../../db/queries';
import { readJson, sendJson } from '../http';
import { layout, jsonForScript, helpDialog } from '../views';
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
      /* 남은 제한 시간. 차례가 아직 열리지 않은 구간에서는 마감이 ACTION_SEC보다 멀리
         있으므로(최소 간격만큼 뒤로 밀려 있다) 그대로 쓰면 "23초"가 찍힌다.
         제한 시간은 열린 뒤부터라 상한을 씌운다 — 열릴 때까지는 20에 멈춰 있다. */
      actionLeft: !ended && hand?.action_deadline != null
        ? Math.min(ACTION_SEC, Math.max(0, hand.action_deadline - now)) : null,
      actionSec: ACTION_SEC,
      /* 이 차례가 열리기까지 남은 초. 0보다 크면 아직 아무도 행동할 수 없다 —
         커뮤니티 카드가 열리는 중이거나 앞 사람 액션 직후의 최소 간격이다. */
      actOpenIn: !ended && hand != null
        ? Math.max(0, (actOpenAt(hand) ?? now) - now) : 0,
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
        ? {
            seat: hand.last_actor_seat, act: hand.last_actor_action,
            amount: hand.last_actor_amount,
            /* 그 자리가 이 판에 넣은 총액. committed는 스트리트가 넘어가도 초기화되지
               않으므로(bet만 초기화된다) 스트리트를 닫은 행동에도 값이 살아 있다.
               올인 음악이 레이즈 올인과 콜 올인을 가르는 데 쓴다. */
            committed: bySeat.get(hand.last_actor_seat)?.committed ?? 0,
          }
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
          /* 이 판에 지금까지 넣은 총액. 베팅은 전부 공개 정보라 숨길 것이 없다.
             올인 음악이 "이건 레이즈 올인인가, 남의 올인에 대한 콜인가"를 가르는 데 쓴다 —
             스트리트 베팅액(bet)만으로는 스트리트가 넘어가면 비교가 어긋난다. */
          committed: h?.committed ?? 0,
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

/* 역대 프리롤 전적. 끝난 대회만 집계하므로 진행 중인 판의 정보가 새지 않는다.
   폴링에 얹지 않고 따로 둔다 — 판마다 바뀌는 값이 아니라서 매초 받을 이유가 없다. */
export async function handleRecords(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  const rows = holdemRecords(20);
  return sendJson(res, 200, { ok: true, me: userId, rows });
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
        액션 버튼 자리에 나오는 <b>게임 복귀</b>를 누르면 다시 정상 플레이로 돌아옵니다</li>
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
    ${gameSwitcher('holdem', 'htHelp')}

    <div id="htLobby" class="ht-lobby" hidden></div>

    <!-- 로비(대회 전·후)에서도 역대 전적을 보여준다. 테이블 오른쪽 패널에만 두면
         자리에 앉은 사람만 볼 수 있는데, 정작 "누가 상금을 제일 많이 먹었나"가
         궁금해지는 시점은 대회를 기다리는 동안이다. -->
    <div id="htLobbyRec" class="ht-lrec" hidden>
      <h3 class="ht-h3">누적 상금 순위</h3>
      <div class="ht-rec" id="htLobbyRecList"></div>
    </div>

    <div id="htTable" class="game-shell ht-shell" hidden>
      <div class="game-main">
        <div class="ht-felt">
          <!-- 레일(바깥) → 펠트(안) → 트랙 선. 세 겹이라야 테이블처럼 보인다 -->
          <div class="ht-rail">
            <div class="ht-cloth" id="htCloth">
              <div class="ht-track" aria-hidden="true"></div>


              <div class="ht-center">
                <div class="ht-pot"><span class="ht-pot-k">POT</span><span id="htPot">0</span></div>
                <div class="ht-board" id="htBoard"></div>
                <!-- 중앙에 쌓이는 팟 칩 더미. 팟이 갈라지면 층마다 더미가 따로 선다 —
                     하나로 뭉쳐 있으면 어느 팟을 누가 가져가는지 보여줄 방법이 없다.
                     이름표(MAIN / SIDE 1…)도 각 더미가 직접 달고 있다. -->
                <div class="ht-piles" id="htPotPile"></div>
                <div class="ht-msg" id="htMsg"></div>
                <!-- 승자 족보를 알리던 노란 캡슐(.ht-outro)은 없앴다. 펠트 한가운데에
                     글자 줄이 뜨면 그것이 커뮤니티 카드보다 먼저 눈에 들어온다.
                     족보는 이제 이긴 사람의 좌석 위(.ht-win-h)에 붙는다 — 누가 무엇으로
                     이겼는지가 한 점에서 읽힌다. -->
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

              <!-- 자리 비움 배너는 없앴다. 상태는 좌석 위 회색 태그가,
                   복귀는 액션 버튼 줄의 [게임 복귀]가 맡는다(htBack3). -->
              <div id="htSeats" class="ht-seats"></div>
              <!-- 베팅 칩·행동 표시는 좌석과 분리한다. 여기가 매 액션마다 바뀌어도
                   좌석의 카드는 그대로 남아 움찔거리지 않는다. -->
              <div id="htSpots" class="ht-seats"></div>
              <!-- 앤티 연출만 쓰는 층. htSpots는 폴링마다 innerHTML로 다시 그려지므로
                   거기에 넣으면 다음 폴링(최대 1초)에 앤티 칩이 사라진다. -->
              <div id="htAnte" class="ht-seats"></div>
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
            <!-- 자리 비움일 때 이 줄에 혼자 선다. 액션 버튼이 늘 같은 자리에 있으므로
                 자리를 비운 사이에도 "내가 누르는 곳"이 바뀌지 않는다. -->
            <button type="button" class="hta back" id="htBack3" hidden>▶ 게임 복귀</button>
          </div>
          <div class="ht-pre" id="htPre">
            <label><input type="checkbox" id="htPreCheckFold"> 체크 / 폴드</label>
            <label><input type="checkbox" id="htPreCheck"> 자동 체크</label>
            <label><input type="checkbox" id="htPreCall"> <span id="htPreCallLabel">자동 콜</span></label>
          </div>
        </div>
      </div>

      <!-- 오른쪽: 토너먼트 정보 + 칩 순위 / 역대 전적 (탭으로 갈아 본다)
           대회 전·후에는 칩 순위가 비어 있어서 이 자리가 통째로 남는다.
           프리롤을 보러 온 사람이 그때 궁금해하는 건 "역대 누가 잘했나"다. -->
      <div class="game-side ht-side">
        <div class="ht-side-head">
          <span id="htSideTitle">데일리 프리롤</span>
        </div>
        <!-- 대회 종료 안내. 테이블 펠트가 아니라 여기다 — 바닥에 시스템 문구를
             인쇄하면 마지막 판의 쇼다운 위로 글자가 겹친다. -->
        <div class="ht-side-note" id="htSideNote" hidden></div>
        <div class="ht-info" id="htInfo"></div>
        <div class="ht-tabs">
          <button type="button" class="ht-tab active" data-htab="live">칩 순위</button>
          <button type="button" class="ht-tab" data-htab="rec">역대 전적</button>
        </div>
        <div class="ht-rank" id="htRank"></div>
        <div class="ht-rec-wrap" id="htRec" hidden>
          <div class="ht-rec" id="htRecList"></div>
        </div>
        <button type="button" class="btn ht-back" id="htBack" hidden>게임 복귀</button>
      </div>
    </div>

    <!-- 우승 축하 — 토너먼트가 끝나는 순간 한 번 뜬다.
         결과표만 조용히 갈아끼우면 대회가 끝난 게 아니라 화면이 넘어간 것처럼 느껴진다. -->
    <div class="ht-win" id="htWin" hidden>
      <div class="ht-win-box">
        <!-- 금빛 후광과 흩날리는 조각. 1등이 났다는 사실 자체가 연출이어야 한다 —
             결과표만 갈아끼우면 대회가 끝난 게 아니라 화면이 넘어간 것처럼 느껴진다. -->
        <div class="ht-win-glow" aria-hidden="true"></div>
        <div class="ht-win-conf" aria-hidden="true"></div>
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
    window.__SFX_NEED__ = ['card','shuffle','deal','chipbet','chipwin','victory',
      'actallin','actbet','actcall','actcheck','actraise','actfold',
      'potwin','clockwarn','allinbgm'];</script>
  <script>
  (function(){
    var MEID = window.__MEID__;
    var CARD_V = ${jsonForScript(ASSET_V)};
    var st = null, unit = 'chip', spectate = false, paidHandNo = null;
    // 판에 처음 들어온 순간에는 연출 없이 현재 상태를 그대로 보여준다
    var firstTablePaint = true;

    var lobbyEl = document.getElementById('htLobby');
    var lobbyRecEl = document.getElementById('htLobbyRec');
    var tableEl = document.getElementById('htTable');
    var seatsEl = document.getElementById('htSeats');
    var spotsEl = document.getElementById('htSpots');
    var anteEl = document.getElementById('htAnte');
    var boardEl = document.getElementById('htBoard');
    var potEl = document.getElementById('htPot');
    var msgEl = document.getElementById('htMsg');
    var readEl = document.getElementById('htRead');
    var rabbitBtn = document.getElementById('htRabbit');
    var showBtn = document.getElementById('htShow');
    var rnoteEl = document.getElementById('htRNote');
    var sideNote = document.getElementById('htSideNote');
    var lvEl = document.getElementById('htLvUp');
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
      /* 상금을 받은 자리와 못 받은 자리를 눈으로 갈라 놓는다.
         예전에는 2~4위를 한 덩어리로 같은 톤에 늘어놓고 상금란에 '-'를 찍었다.
         입상 여부가 이 표의 유일한 의미인데 그게 표에서 안 보였고, '-'는 "정보가 없다"는
         뜻이라 "0원을 받았다"와 다르다. 이제 입상자는 카드로 세우고, 미입상자는
         가라앉혀 0P로 적는다. */
      document.getElementById('htWinRest').innerHTML = results.slice(1).map(function(r){
        var itm = r.prize > 0;
        return '<div class="ht-win-row' + (itm ? ' itm' : ' out') + '">' +
          '<span class="ht-win-pl">' + r.place + '위</span>' +
          avatarHtml(r.userId, r.avatar, r.username, 'ht-win-av sm') +
          '<span class="ht-win-nm">' + esc(r.username) + '</span>' +
          '<span class="ht-win-pz">' + num(r.prize) + 'P</span></div>';
      }).join('');
      winEl.hidden = false;
      if (window.casinoSfx && window.casinoSfx.victory) window.casinoSfx.victory();
      // 우승 기록이 하나 늘었다 — 역대 전적을 다시 받아 온다
      if (recAsked) loadRecords(true);
    }
    document.getElementById('htWinClose').addEventListener('click', function(){
      winEl.hidden = true;
    });

    /* ── 역대 전적 탭 ─────────────────────────────────────────────────
       지표를 게임별 랭킹(판수·승률·수익액)과 다르게 잡는다. 프리롤은 참가비가 0이라
       상금만 양수로 들어와서 "수익액"이 실력과 무관하게 참가 횟수만큼 오른다.
       그래서 우승·입상·참가·누적 상금을 센다.

       처음 열 때 한 번만 받아 온다. 판마다 바뀌는 값이 아니라 매초 받을 이유가 없고,
       대회가 끝나면 그때 한 번 더 받는다(우승 기록이 늘었으므로). */
    /* 표는 두 곳에 걸린다 — 로비(#htLobbyRecList)와 테이블 오른쪽 패널(#htRecList).
       받아 온 줄을 한 번만 담아 두고 두 곳에 같이 그린다. 화면마다 따로 받으면
       같은 순위표가 두 벌이 되고, 대회가 끝날 때 한쪽만 갱신되는 일이 생긴다. */
    var recRows = null, recAsked = false;
    function recHtml(rows){
      if (!rows.length) return '<div class="empty" style="padding:16px 0">아직 끝난 대회가 없습니다</div>';
      /* 줄 세운 기준(누적 상금)을 오른쪽 굵은 자리에 놓는다. 우승·입상·판수는
         작게 아래에 붙인다 — 순위를 만든 값과 참고 값이 섞이지 않게.

         1~3위는 금·은·동 카드로 묶어 낸다. 순위표에서 눈이 실제로 찾는 것은 위 세 자리와
         내 자리다. 스무 줄이 같은 무게로 늘어서면 그 넷을 찾는 데도 스무 줄을 다 읽어야
         한다. 4위 아래는 글자를 줄이고 가라앉혀서, 읽지 않아도 되는 줄이라는 것을
         모양으로 말한다. */
      var PODIUM = ['gold', 'silver', 'bronze'];
      return rows.map(function(r, i){
        var mine = r.userId === MEID;
        var rank = PODIUM[i] || '';
        var sub = (r.wins > 0 ? '👑 ' + r.wins + ' · ' : '') +
          '입상 ' + r.itm + ' / ' + r.played + '판';
        return '<div class="ht-rec-row' + (mine ? ' me' : '') +
            (rank ? ' pod ' + rank : ' low') + '">' +
          '<span class="ht-rec-no">' + (i === 0 ? '👑' : (i + 1)) + '</span>' +
          '<span class="ht-rec-nm">' + esc(r.username) + '</span>' +
          '<span class="ht-rec-p">' + num(r.prize) + 'P</span>' +
          '<span class="ht-rec-s">' + sub + '</span>' +
          '</div>';
      }).join('');
    }
    /* 기록이 하나도 없으면 로비 쪽 블록은 아예 접는다 — 첫 대회 전에는 "아직 없습니다"만
       적힌 빈 카드가 로비 절반을 차지한다. 탭 쪽은 사용자가 직접 눌러서 들어온 것이니
       빈 상태라도 그대로 말해 준다. */
    var recEmpty = true;
    function paintRecords(){
      if (!recRows) return;
      recEmpty = recRows.length === 0;
      // 다음 폴링(1초)까지 기다리지 않고 여기서 바로 접거나 펼친다
      if (lobbyRecEl) lobbyRecEl.hidden = recEmpty || !tableEl.hidden;
      var html = recHtml(recRows);
      ['htRecList', 'htLobbyRecList'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.innerHTML = html;
      });
    }
    function loadRecords(force){
      if (recRows && !force) { paintRecords(); return; }
      recAsked = true;
      fetch('/api/games/holdem/records')
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (!d || !d.ok) return;
          recRows = d.rows;
          paintRecords();
        })
        .catch(function(){ /* 실패하면 다음에 탭을 다시 누를 때 받는다 */ });
    }
    document.querySelector('.ht-tabs').addEventListener('click', function(e){
      var b = e.target.closest ? e.target.closest('.ht-tab') : null;
      if (!b) return;
      var which = b.getAttribute('data-htab');
      document.querySelectorAll('.ht-tab').forEach(function(t){
        t.classList.toggle('active', t === b);
      });
      rankEl.hidden = which !== 'live';
      recEl.hidden = which !== 'rec';
      if (which === 'rec') loadRecords(false);
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
    var backAct = document.getElementById('htBack3');
    var clothEl = document.getElementById('htCloth');
    var infoEl = document.getElementById('htInfo');
    var rankEl = document.getElementById('htRank');
    var recEl = document.getElementById('htRec');
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

      /* 상금 구조와 결과를 한 표로 합친다.
         예전에는 [순위|상금] 표와 [순위|이름|상금] 표가 따로 세로로 쌓여서, 대회가 끝난
         뒤에는 같은 순위가 두 번 나오고 스크롤이 두 배로 길어졌다. 둘은 사실 같은 표의
         "예정"과 "확정"이다 — 결과가 있으면 이름을 채우고 없으면 비워 둔다. */
      var prizeList = t.prizes || [];
      var resList = st.results || [];
      var rowCount = Math.max(prizeList.length, resList.length);
      var payTable = '';
      if (rowCount) {
        var rows = '';
        for (var pi = 0; pi < rowCount; pi++) {
          var res = resList[pi];
          var place = res ? res.place : pi + 1;
          var amt = res ? res.prize : (prizeList[pi] || 0);
          // 상금을 받는 자리만 밝게. 나머지는 가라앉히고 금액도 0P로 적는다("-"는 정보가 없다)
          var itm = amt > 0;
          rows += '<tr class="' + (itm ? 'itm' : 'out') + '">' +
            '<td class="pl">' + place + '위</td>' +
            '<td class="nm">' + (res ? esc(res.username) : '<i>—<\i>') + '</td>' +
            '<td class="pz">' + num(amt) + 'P</td></tr>';
        }
        payTable = '<h3 class="ht-h3">' + (resList.length ? '결과' : '상금 구조') + '</h3>' +
          '<table class="ht-prize"><thead><tr><th>순위</th><th>플레이어</th><th>상금</th></tr></thead>' +
          '<tbody>' + rows + '<\/tbody><\/table>';
      }

      /* 안내 문구는 배지 옆으로 붙인다. 한 줄짜리 <p>로 따로 두면 그 줄 하나 때문에
         위아래 여백이 두 겹 생겨 카드가 늘어졌다 — 상태를 말하는 짧은 문장이므로
         상태 배지와 같은 줄에 있는 것이 읽기에도 맞다. */
      lobbyEl.innerHTML =
        '<div class="ht-card">' +
          '<div class="ht-card-top">' +
            '<div><h2>' + esc(t.title) + '</h2>' +
              '<p class="ht-when">' + esc(t.dateStr) + ' · 등록 21:00 · 시작 22:00 (KST)</p></div>' +
            '<div class="ht-badge-wrap">' + badge +
              (note ? '<span class="ht-note">' + esc(note) + '</span>' : '') + '</div>' +
          '</div>' +
          /* 여섯 지표를 2×3 미니 카드로 나눈다. 줄 형태(k ····· v)로 쌓았을 때는
             여섯 줄이 같은 무게로 늘어서서 무엇을 봐야 할지 정해지지 않았다. */
          '<div class="ht-grid">' +
            '<div><span class="k">참가자</span><span class="v">' + t.registered + ' / ' + t.maxPlayers + '</span></div>' +
            '<div><span class="k">상금 풀</span><span class="v gold">' + num(t.prizePool) + 'P</span></div>' +
            '<div><span class="k">1인당</span><span class="v">' + num(t.multiplier) + 'P</span></div>' +
            '<div><span class="k">시작 스택</span><span class="v">' + num(t.startingStack) + '</span></div>' +
            '<div><span class="k">지급 인원</span><span class="v">' + t.itm + '명</span></div>' +
            '<div><span class="k">최소 인원</span><span class="v">' + t.minPlayers + '명</span></div>' +
          '</div>' +
          '<div class="ht-actions">' + action + '</div>' +
          payTable +
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
       펠트(.ht-cloth) 기준 % 좌표다. 순서는 6시에서 시작해 시계방향.
         plate  아바타 중심 — 이 점이 테이블 경계에 놓여 절반은 펠트, 절반은 레일이다
         bet    베팅 칩 자리 — 좌석과 중앙 사이

       손으로 적지 않고 계산한다. 테이블이 타원이므로 경계는
         x = 50 + R·cos t,  y = 50 + R·sin t
       이고 이 식은 가로세로 비율과 무관하게 항상 경계 위의 점을 준다. 그래서 폭이
       달라져도 좌석이 경계를 따라간다 — 예전 스타디움(직선 구간이 폭에 따라 길어진다)에서는
       % 좌표로 경계를 따라갈 방법이 없었고, 그래서 좌석을 안쪽에 넉넉히 넣어야 했다.

       아바타는 R=50(경계 위), 칩은 R=41(펠트 안쪽).
       칩 반지름을 따로 두는 이유: 좌석에 붙이면 카드와 겹치고, 더 안쪽이면 보드를 가린다.
       36으로 뒀다가 좁은 티어에서 위쪽 칩이 중앙 블록을 밟았다 — 중앙 블록의 높이는
       고정 px 합이라 펠트가 작아질수록 비중이 커지는데, 칩 반지름은 %라 같이 줄어든다.
       41이면 320px 티어에서도 13px 여유가 남는다.

       ── 자리를 실제 인원으로 나눈다
       9칸을 고정해 두고 그 중 몇 칸만 채우면 사람이 한쪽에 몰린다. 4인 테이블이 오른쪽
       아래에 넉 줄로 붙어 서고 왼쪽 절반이 비었다(실측). 자리 번호는 서버가 정하지만
       화면 위치는 화면의 몫이므로, 지금 앉아 있는 인원으로 360도를 나눈다.
       내 자리는 언제나 6시이고 시계방향 순서는 그대로 유지된다 — 포지션(누가 먼저
       말하는가)이 자리 순서로 읽히므로 그 순서가 흐트러지면 게임을 잘못 읽는다. */
    /* 지금 화면에서 각 자리가 어디인가 — renderSeats가 채우고 다른 연출이 읽는다.
       좌표 계산을 두 곳에 두면 반드시 어긋난다(앤티 칩이 옛 9칸 각도에 놓인 적이 있다). */
    var seatXY = {};
    /* ── 스타디움(알약) 둘레 위의 자리 ──────────────────────────────
       테이블은 위아래가 직선이고 좌우 끝만 반원인 알약 모양이다. 타원이었을 때는
       위아래도 곡선이라 12시 근처 자리들이 안쪽으로 휘어 들어와 펠트를 파고들었다.
       직선 구간에서는 좌석이 한 줄로 나란히 서고 그 아래가 통째로 빈 초록이 된다.

       한때 타원을 썼던 이유는 % 좌표로 경계를 따라갈 수 있어서였다(스타디움은 직선
       구간 길이가 폭에 따라 달라져 % 하나로 표현되지 않는다). 지금은 좌표를 골격에
       굽지 않고 매 렌더마다 넣으므로, 펠트를 실측해서 픽셀로 풀면 된다.

       둘레를 n등분한다 — 각도가 아니라 길이다. 그래야 직선 구간과 반원 구간에
       사람이 고르게 선다. 0번(나)은 언제나 바닥 한가운데이고 거기서 왼쪽으로 돈다.

       각 점에서 바깥 법선도 같이 낸다. 직선 구간은 (0,±1), 반원 구간은 그 원의
       반지름 방향이다 — 이게 좌석을 밖으로 밀어내는 방향이 된다. */
    function stadiumSeats(n, W, H){
      var r = Math.min(W, H) / 2;
      var flat = Math.max(0, W - 2 * r);      // 위(아래) 직선 한 변의 길이
      var half = flat / 2;
      var cap = Math.PI * r;                  // 반원 하나의 길이
      var L = 2 * flat + 2 * cap;
      var out = [];
      for (var i = 0; i < n; i++) {
        var s = (L * i / n) % L;
        var x, y, nx, ny, ph;
        if (s < half) {                                   // 바닥 가운데 → 왼쪽
          x = W / 2 - s; y = H; nx = 0; ny = 1;
        } else if (s < half + cap) {                      // 왼쪽 반원 (아래 → 위)
          ph = Math.PI / 2 + (s - half) / r;
          x = r + r * Math.cos(ph); y = H / 2 + r * Math.sin(ph);
          nx = Math.cos(ph); ny = Math.sin(ph);
        } else if (s < half + cap + flat) {               // 윗변 왼쪽 → 오른쪽
          x = r + (s - half - cap); y = 0; nx = 0; ny = -1;
        } else if (s < half + 2 * cap + flat) {           // 오른쪽 반원 (위 → 아래)
          ph = -Math.PI / 2 + (s - half - cap - flat) / r;
          x = (W - r) + r * Math.cos(ph); y = H / 2 + r * Math.sin(ph);
          nx = Math.cos(ph); ny = Math.sin(ph);
        } else {                                          // 바닥 오른쪽 → 가운데
          x = (W - r) - (s - half - 2 * cap - flat); y = H; nx = 0; ny = 1;
        }
        /* 베팅 칩은 그 자리에서 안쪽으로 들어온 점이다. 가로로 들어올 때와 세로로
           들어올 때 여유가 다르다 — 세로는 중앙 블록이 거의 다 쓰고 있고 가로는 넓다.
           그래서 방향에 따라 다른 거리를 쓴다. */
        var inX = W * 0.15, inY = H * 0.11;
        var bx = x - nx * (Math.abs(nx) * inX + Math.abs(ny) * inY);
        var by = y - ny * (Math.abs(nx) * inX + Math.abs(ny) * inY);
        out.push({
          x: +(x / W * 100).toFixed(2), y: +(y / H * 100).toFixed(2),
          nx: nx, ny: ny,
          bet: [+(bx / W * 100).toFixed(2), +(by / H * 100).toFixed(2)],
        });
      }
      return out;
    }
    /* ── 좌석을 경계 밖으로 밀어내기 ────────────────────────────────
       미는 거리는 "그 방향으로 좌석 덩어리가 뻗은 길이"다. 덩어리는 위아래가 비대칭이라
       (태그가 아바타 아래에만 있다) 세 성분으로 나눠 CSS 변수로 둔다.
         --htPushX  가로로 뻗은 길이
         --htPushU  아래로 뻗은 길이 (위로 밀 때 이만큼 밀어야 아래끝이 경계에 온다)
         --htPushD  위로 뻗은 길이
       거리 = |nx|·X + |ny|·(위로 밀면 U, 아래로 밀면 D)
       이걸 법선 방향으로 뿌리면 각 축의 계수가 나온다. px 값은 CSS가 알고 방향은
       JS가 아니까, 곱셈만 calc에 맡긴다. */
    /* 승률 말풍선이 붙는 쪽. 'l'이면 좌석의 왼쪽, 'r'이면 오른쪽이다.
       규칙은 하나다 — 화면이 남아 있는 쪽으로 붙인다. 좌석의 가로 위치만 보면 된다.
         가운데 무리(26~74%)  → 바깥으로 벌린다. 12시 두 자리를 둘 다 안쪽으로 보내면
                                가운데에서 서로 포개진다(실측: 완전히 겹쳤다).
         좌우 끝(26% 밖)      → 안쪽. 여기서 바깥은 곧 화면 밖이다 —
                                12%에 앉은 자리를 바깥으로 보냈더니 23px 잘렸다(실측).
       법선(|ny|)으로 직선/반원을 갈라 봤지만 그것으로는 부족했다. 직선 구간이라도
       끝에 가까운 자리는 바깥에 자리가 없다. 결국 기준은 "구간"이 아니라 "여유"다. */
    function eqSide(p){
      var x = p.plate[0];
      if (x < 26) return 'r';
      if (x > 74) return 'l';
      return x < 50 ? 'l' : 'r';
    }
    function seatPos(pt){
      var nx = pt.nx, ny = pt.ny;
      var ax = Math.abs(nx), ay = Math.abs(ny);
      var up = ny < 0 ? ay : 0, dn = ny > 0 ? ay : 0;
      var expr = function(pct, axis){
        return 'calc(' + pct + '%'
          + ' + var(--htPushX) * ' + (axis * ax).toFixed(4)
          + ' + var(--htPushU) * ' + (axis * up).toFixed(4)
          + ' + var(--htPushD) * ' + (axis * dn).toFixed(4) + ')';
      };
      return {
        plate: [pt.x, pt.y],
        left: expr(pt.x, nx),
        top:  expr(pt.y, ny),
        bet:  pt.bet,
        // 법선도 함께 넘긴다 — 말풍선을 어느 쪽에 붙일지가 여기서 갈린다(eqSide)
        nx: nx, ny: ny,
      };
    }

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

    /* 태그에 적는 이름. 예전에는 'Seat 4'였다 — 자리 번호는 규칙을 읽는 데는 쓸모가 있지만
       "누구와 겨루는가"를 말해 주지 않았고, 실제 이름은 아바타 이니셜과 오른쪽 패널에만
       있었다. 이름을 앞에 두고, 자리 번호는 이름이 없을 때만 쓴다.
       태그 폭이 한정되어 있어 길면 잘린다(CSS ellipsis). */
    function seatLabel(s){
      var nm = (s.username || '').trim();
      if (!nm) nm = 'Seat ' + (s.seat + 1);
      return s.userId === MEID ? nm + ' (나)' : nm;
    }

    function renderSeats(){
      var tb = st.table, seats = tb.seats || [];
      // 판이 바뀌면 "아직 안 받은 상금" 장부를 비운다
      if (paidSeatHand !== tb.handNo) { paidSeatHand = tb.handNo; paidSeat = {}; }
      var blindSeats = blindSeatsOf(tb);
      /* 보드를 깔고 있는 동안(정지 + 한 장씩 공개)에는 스트리트를 닫은 행동을 붙들고 있는다.
         syncBoard가 이 함수보다 먼저 돌아 boardRevealed를 정해 준다. */
      var holdActor = !boardRevealed ? tb.lastActor : null;
      /* Hero를 항상 6시에 두려면 "내 자리 번호"를 기준으로 돌린다.
         자리 번호는 서버가 정한 그대로 두고 화면 위치만 돌린다 —
         내가 3번이든 7번이든 언제나 아래 가운데에서 플레이한다.

         자리 번호 오름차순이 곧 화면상 시계방향이므로, 내 자리에서 시작하도록 목록을
         한 바퀴 돌려 놓으면 그 순서가 그대로 배치 순서가 된다. */
      var anchor = tb.mySeat != null ? tb.mySeat : (seats.length ? seats[0].seat : 0);
      var order = seats.slice().sort(function(a, b){ return a.seat - b.seat; });
      var at = 0;
      for (var oi = 0; oi < order.length; oi++) if (order[oi].seat === anchor) { at = oi; break; }
      order = order.slice(at).concat(order.slice(0, at));
      var rotOf = {};
      order.forEach(function(s, i){ rotOf[s.seat] = i; });
      var seatCount = order.length;

      var html = '', vol = '', sigParts = [], actNow = [];
      /* 펠트의 실제 크기. 스타디움은 직선 구간 길이가 폭에 따라 달라져서 % 만으로는
         경계를 표현할 수 없다 — 재서 픽셀로 푼 뒤 %로 되돌린다. 재는 값이라 창 크기가
         바뀌면 달라지므로, 좌표는 골격에 굽지 않고 아래 갱신 루프에서 매번 넣는다. */
      var clothBox = clothEl ? clothEl.getBoundingClientRect() : null;
      var cw = clothBox && clothBox.width > 0 ? clothBox.width : 560;
      var ch = clothBox && clothBox.height > 0 ? clothBox.height : 300;
      var pts = stadiumSeats(seatCount, cw, ch);
      seatXY = {};
      seats.forEach(function(s){
        var rot = rotOf[s.seat] || 0;
        var p = seatPos(pts[rot] || pts[0]);
        // 다른 연출(앤티 등)이 같은 좌표를 써야 한다 — 계산을 두 곳에 두면 어긋난다
        seatXY[s.seat] = p;

        /* 좌석 한 자리 = 세 겹.
             .ht-hole   홀 카드 — 아바타 위. 비공개면 아바타 뒤(z1), 공개되면 앞(z3).
             .ht-avbox  아바타 원 — 좌표가 꽂히는 곳. 시계 고리·행동 배지가 여기 붙는다.
             .ht-plate  이름 + 스택 태그 — 아바타 하단을 덮는다(z5, 가장 앞).

           예전에는 카드·아바타·이름이 한 줄(.ht-plate)에 가로로 나열됐고 좌석이 테이블
           안쪽에 있었다. 그래서 테이블이 커야 했고, 보드 카드가 위로 밀려 작아졌다.
           지금은 좌석이 경계에 걸쳐 앉아 중앙이 온전히 비고, 그 공간을 보드가 쓴다.

           cards-below(12시 두 자리는 카드를 아래로) 예외는 없앴다. 카드가 위로 자라도
           테이블 밖이라 걸리는 것이 없다 — 그 예외 자체가 좌석을 안쪽에 두던 시절의
           증상이었다. */
        html += '<div class="ht-seat" data-seat="' + s.seat + '">' +
            '<div class="ht-hole"></div>' +
            '<div class="ht-avbox">' +
              avatarHtml(s.userId, s.avatar, s.username, 'ht-av') +
              /* 자리 비움 — 행동 배지와 같은 생김새의 회색 태그. 다만 스스로 사라지지 않는다.
                 행동은 "방금 일어난 일", 자리 비움은 "지금의 상태"다.
                 행동 배지와 별도 요소로 두어야 한다 — 같은 span을 쓰면 자리 비운 사람이
                 자동 체크될 때 그 배지가 덮어썼다가 1.7초 뒤 사라지면서 상태까지 지운다. */
              '<span class="ht-abadge away" hidden>자리 비움</span>' +
              /* 방금 한 행동 — 프로필 사진 위에 잠깐 떴다 사라진다.
                 "누가"와 "무엇을"이 한 점에서 읽힌다. */
              '<span class="ht-abadge" hidden></span>' +
              '<span class="ht-fold-b" title="폴드" hidden>F</span>' +
            '</div>' +
            '<div class="ht-plate">' +
              /* 배경을 따로 둔다 — 사다리꼴은 clip-path로 자르는데, 그걸 태그 자체에
                 걸면 자식(글자·시간 바)까지 같이 잘린다. 자를 것만 따로 깐다. */
              '<span class="ht-plate-bg"></span>' +
              /* 이름도 스택처럼 제자리 갱신한다(id).
                 골격 HTML에 구워 넣으면, 서버가 username을 빈 문자열로 먼저 보낸 뒤
                 실제 이름을 보내도 좌석 배치가 바뀔 때까지 'Seat N'으로 굳는다.
                 골격 서명에 이름을 넣어 해결하려 하면 이름이 바뀔 때마다 좌석 DOM이 통째로
                 다시 만들어져 카드가 다시 뒤집히고 움찔거린다 — 그건 서명 주석이 경고하는 상황이다. */
              '<span class="ht-who">' +
                '<span class="ht-nm" id="htnm-' + s.seat + '"></span>' +
                '<span class="ht-stk" id="htstk-' + s.seat + '"></span>' +
              '</span>' +
              /* 남은 행동 시간 — 태그 바로 아래, 태그와 같은 폭의 얇은 바.
                 태그의 자식이라 폭이 저절로 맞는다(태그는 이름 길이에 따라 늘어난다). */
              '<span class="ht-tbar" hidden><i></i></span>' +
            '</div>' +
            '<span class="ht-puck ' + (p.plate[0] < 50 ? 'r' : 'l') + '" title="딜러 버튼" hidden>D</span>' +
            /* 블라인드 배지 — 딜러 버튼 반대쪽에 붙인다. 같은 쪽에 두면 D와 겹친다.
               포지션(누가 먼저 말하는지)이 보이지 않으면 초보는 프리플랍 순서를 못 읽는다. */
            '<span class="ht-blind ' + (p.plate[0] < 50 ? 'l' : 'r') + '" hidden></span>' +
            /* 이 판(또는 이 팟 층)을 가져간 사람 — 칩이 움직이기 전에 먼저 뜬다 */
            '<span class="ht-win-b" hidden>WIN</span>' +
            /* 무엇으로 이겼나. 예전에는 펠트 한가운데 노란 캡슐이었는데,
               "누가"와 "무엇으로"가 화면의 서로 다른 곳에 있어 눈이 두 번 움직였다. */
            '<span class="ht-win-h" hidden></span>' +
            /* 쇼다운 승률 말풍선을 어느 쪽에 붙일지는 좌석이 테이블의 어디에 앉았느냐로 갈린다.
                 직선 구간(위·아래 변)  → 바깥쪽. 12시 두 자리를 둘 다 안쪽으로 보내면
                                          가운데에서 서로 겹친다(실측: 완전히 포개졌다).
                 반원 구간(좌·우 끝)    → 안쪽. 여기서는 바깥쪽이 곧 화면 밖이라
                                          9시 자리의 말풍선이 통째로 잘려 나갔다.
               |ny|가 큰 자리가 직선 구간이다 — 법선이 거의 수직이라는 뜻이다. */
            '<span class="ht-eq ' + eqSide(p) + '" hidden></span>' +
          '</div>';

        /* 골격 서명은 "누가 어느 자리에 앉았나"만 본다.
           카드·상태·딜러 버튼·스택은 전부 아래에서 제자리 갱신한다.
           여기에 하나라도 변하는 값을 넣으면 그때마다 좌석 DOM이 새로 만들어지고,
           카드 요소가 다시 생겨 cardFlip이 재생되고 판 폭이 흔들려 카드가 움찔거린다.
           실제로 카드가 액션마다 최대 7.5px씩 움직였다. */
        /* 화면 위치는 (순번, 인원)에서 나온다. 둘 다 넣어야 한다 —
           누가 탈락해 인원이 줄면 순번이 그대로여도 모든 자리의 각도가 달라진다.
           인원을 빼먹으면 좌석이 옛 각도에 그대로 남는다. */
        sigParts.push(s.seat + ':' + s.userId + ':' + rot + '/' + seatCount);

        // 베팅 칩과 행동 표시는 카드와 무관한 별도 레이어에 그린다 (여기가 바뀌어도 카드는 그대로)
        var act = s.act, amt = s.actAmount;
        /* 스트리트를 닫은 행동은 서버가 좌석 표시를 초기화해 버려서 s.act가 비어 있다.
           보드를 깔기 전 정지 구간에서는 핸드 쪽에 남은 기록으로 그 자리를 채운다 —
           이게 없으면 "딜러가 체크했는데 안 보이고 플랍이 바로 깔린다"가 된다. */
        if (!act && holdActor && holdActor.seat === s.seat) {
          act = holdActor.act; amt = holdActor.amount;
        }
        /* 올인도 다른 액션과 같이 "방금 한 행동"으로만 다룬다 — 잠깐 떴다 사라진다.
           "지금 올인 상태다"는 스택 자리의 ALL IN 문구가 따로 말한다(아래 htstk 갱신).
           둘은 서로 다른 것을 말하는 서로 다른 UI다:
             프로필 위 배지 = 방금 무슨 행동을 했나
             스택 자리      = 지금 칩이 하나도 없나 */
        /* 판이 끝나면 좌석 앞 칩을 그리지 않는다. 서버는 판이 끝날 때 bet을 0으로
           되돌리지 않는데(초기화는 스트리트 전환에만 있다), 그 사이 팟 더미는 이미
           마지막 스트리트 베팅까지 중앙에 그려 놓는다 — 같은 칩이 두 곳에 보인다. */
        /* 행동 이름은 여기서 그리지 않는다 — 좌석판 위 배지(.ht-abadge)가 맡는다.
           베팅 자리에는 "실제로 나간 칩"만 남긴다. 이름까지 여기 있으면 이미 지나간
           행동이 판이 끝날 때까지 테이블에 널려 있게 된다. */
        if (s.bet > 0 && !tb.ended) {
          vol += '<div class="ht-spot" id="htspot-' + s.seat + '"' +
            ' style="left:' + p.bet[0] + '%;top:' + p.bet[1] + '%">' +
            '<span class="ht-spot-chips">' + chipStack(s.bet) + '</span>' +
            '<span class="ht-spot-amt">' + stackText(s.bet) + '</span>' +
            '</div>';
        }
        actNow.push({ seat: s.seat, act: act, amount: amt });
      });

      var sig = sigParts.join('|');
      if (seatsEl.dataset.sig !== sig) { seatsEl.dataset.sig = sig; seatsEl.innerHTML = html; }
      if (spotsEl.dataset.sig !== vol) { spotsEl.dataset.sig = vol; spotsEl.innerHTML = vol; }

      // 자주 바뀌는 것은 골격을 건드리지 않고 제자리에서 갱신한다
      seats.forEach(function(s){
        var nmEl = document.getElementById('htnm-' + s.seat);
        if (nmEl) {
          var label = seatLabel(s);
          if (nmEl.textContent !== label) nmEl.textContent = label;
        }
        var el = document.getElementById('htstk-' + s.seat);
        if (el) {
          /* 스택 자리에 ALL IN을 쓴다 — 단 "정말로 칩이 하나도 없을 때"만.
             올인 상태(state)와 칩이 0인 것은 같은 말이 아니다: 100BB를 밀었는데 상대가
             40BB만 콜했으면 콜되지 않은 60BB가 판이 끝날 때 돌아온다(returnUncalled).
             그 순간부터 나는 칩을 가진 사람이므로 ALL IN이 아니고, 돌아온 숫자를 보여줘야
             한다. state만 보고 찍으면 스택이 60BB인 사람에게 ALL IN이 붙는다.
             그래서 두 조건을 함께 본다. */
          var shown = stackOf(tb, s);
          var allIn = s.state === 'allin' && shown === 0;
          var want = allIn ? 'ALL IN' : stackText(shown);
          if (el.textContent !== want) el.textContent = want;
          el.className = allIn ? 'ht-stk allin' : 'ht-stk';
        }
        var seatEl = seatsEl.querySelector('.ht-seat[data-seat="' + s.seat + '"]');
        if (!seatEl) return;
        /* 좌표는 골격이 아니라 여기서 넣는다. 등간격 계산이 실측한 가로세로 비율에
           의존하므로, 창 폭이 바뀌면 값도 바뀐다 — 골격에 구워 두면 좌석 구성이
           바뀔 때까지 옛 자리에 남는다. */
        var pp = seatXY[s.seat];
        if (pp) {
          if (seatEl.style.left !== pp.left) seatEl.style.left = pp.left;
          if (seatEl.style.top !== pp.top) seatEl.style.top = pp.top;
        }
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
        /* 자리 비움은 행동이 아니라 상태다 — 복귀할 때까지 계속 보여야 한다.
           예전에는 폴드하지 않은 사람에게만 띄웠다. 그런데 자리 비움이 되는 계기가
           "시간 초과로 자동 폴드"라서, 붙는 순간 폴드도 함께 붙어 표시가 곧바로 사라졌다.
           잠깐 떴다 사라지는 것으로 보인 이유가 이것이다. */
        var awayB = seatEl.querySelector('.ht-abadge.away');
        if (awayB) awayB.hidden = s.presence !== 'SIT_OUT';
        syncHole(seatEl.querySelector('.ht-hole'), s);
      });
      syncActBadges(tb, actNow);
      syncEquity(tb);
    }

    /* ── 쇼다운 승률 · 역전 카드 ───────────────────────────────────────
       리버 이전에 액션이 끝나면 결과는 남은 카드에만 달려 있다. 그 구간에 각자의 승률을
       보여주면 남은 카드를 기다리는 재미가 생긴다 — 관전자에게는 특히 그렇다.

       서버가 스트리트별로 미리 계산해 보냈다(result.equity). 여기서는 "지금 화면에 깔린
       보드 장수"에 맞는 단계를 고르기만 한다 — 카드가 열리는 것보다 승률이 앞서 바뀌면
       카드를 보기 전에 결과를 알려주는 것이 된다.

       팟 정산이 시작되면(WIN 배지) 내린다. 그때부터는 확률이 아니라 사실이 나온다. */
    /* 카드 번호 → 랭크·무늬. 서버(services/poker.ts cardToString)와 같은 규칙이다:
       카드 = 랭크*4 + 무늬, 무늬 순서는 스페이드·하트·다이아·클럽.
       순서를 틀리면 아웃츠 미니 카드의 무늬가 통째로 어긋난다. */
    var RANK_CH = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    var SUIT_CH = ['\\u2660', '\\u2665', '\\u2666', '\\u2663'];
    function syncEquity(tb){
      var stages = (tb.ended && tb.result && tb.result.equity) || [];
      var stage = null;
      // 정산이 시작되기 전까지만. potPaidHand는 팟을 밀기 시작할 때 세워진다
      if (stages.length && potPaidHand !== tb.handNo) {
        for (var i = 0; i < stages.length; i++) {
          if (stages[i].boardLen === shownBoard) { stage = stages[i]; break; }
        }
      }
      var byS = {}, outs = {};
      if (stage) {
        stage.seats.forEach(function(x){ byS[x.seat] = x; });
        (stage.outs || []).forEach(function(o){ outs[o.seat] = o; });
      }
      /* 지금 앞선 사람이 누구인지 — 말풍선의 색을 가르는 기준이다.
         승률이 가장 높은 사람(들)이 초록, 나머지는 붉은 쪽이다. */
      var top = 0;
      Object.keys(byS).forEach(function(k){ if (byS[k].equity > top) top = byS[k].equity; });

      (tb.seats || []).forEach(function(s){
        var seatEl = seatsEl.querySelector('.ht-seat[data-seat="' + s.seat + '"]');
        var el = seatEl && seatEl.querySelector('.ht-eq');
        if (!el) return;
        var e = byS[s.seat];
        /* 말풍선이 떠 있는 동안에는 좌석 전체를 위로 올린다.
           말풍선은 좌석 밖으로 뻗어 나가는데, 좌석끼리는 형제라서 나중에 그려진 좌석이
           이깁니다 — 6시 자리(내 자리)의 말풍선이 옆 좌석의 프로필·카드 뒤로 묻혔다.
           좌석 안에서 z-index를 아무리 올려도 소용없다. 올려야 하는 것은 좌석 자체다. */
        seatEl.classList.toggle('eqon', !!e);
        if (!e) { el.hidden = true; return; }
        var pct = Math.round(e.equity * 1000) / 10;
        var lead = e.equity >= top - 1e-9;
        var o = outs[s.seat];
        var body = '';
        if (lead) {
          // 앞선 쪽 — 숫자 하나면 된다. 이 사람에게 남은 관심사는 "얼마나 안전한가"뿐이다
          body = '<span class="ht-eq-p">' + pct.toFixed(1) + '%</span>';
        } else if (pct <= 0) {
          /* 역전할 카드가 한 장도 없다. 0.0%를 적는 것보다 이름을 붙이는 것이 낫다 —
             포커에서 이 상태에는 이미 이름이 있다.
             폭발 안에 넣는다(.ht-eq-outs) — 가장 절박한 상태인데 배경 없는 글자로
             두면 다른 말풍선들 사이에서 오히려 가장 조용해진다. */
          body = '<span class="ht-eq-outs"><span class="ht-eq-dead">DRAWING DEAD<\/span><\/span>';
        } else {
          /* 쫓는 쪽 — 숫자보다 "무엇이 나와야 하나"가 먼저다. 실제 카드를 그린다.
             글자로 "아웃 8장 · A K"라고 적던 것을 없앴다. 카드 게임인데 카드를 글자로
             옮겨 적으면 한 번 더 번역해서 읽어야 한다.
             한 무늬가 통째로 아웃이면(플러시 드로우) 무늬 하나로 줄인다. */
          var mini = '';
          (o && o.bySuit || []).forEach(function(su){
            mini += '<i class="ht-oc suit s' + su + '">' + SUIT_CH[su] + '<\/i>';
          });
          var cards = (o && o.cards) || [];
          /* 열 장까지 그린다 — 다섯 장씩 두 줄이다(줄바꿈은 .ht-oc-row의 max-width가 정한다).
             그보다 많으면 마지막 칸을 +N으로 접는다. 한 줄로 계속 늘리면 말풍선이 옆자리까지
             뻗고, 줄이 셋이 되면 좌석을 통째로 덮어서 카드가 몇 장인지도 안 읽힌다.
             무늬로 묶인 것은 카드 여러 장을 대신하므로 두 칸을 쓴 것으로 친다. */
          var room = 10 - ((o && o.bySuit) || []).length * 2;
          cards.slice(0, Math.max(0, room)).forEach(function(c){
            var su = c & 3;
            mini += '<i class="ht-oc s' + su + '">' + RANK_CH[c >> 2] +
              '<b>' + SUIT_CH[su] + '<\/b><\/i>';
          });
          if (cards.length > room && room > 0) {
            mini += '<i class="ht-oc more">+' + (cards.length - room) + '<\/i>';
          }
          /* 승률은 폭발 안, 카드 아래 가운데다. 밖에 두었더니 말풍선과 숫자가 서로 다른
             두 물체로 보였고, 좌석이 몰린 곳에서는 옆 사람 말풍선의 숫자와 헷갈렸다. */
          body = '<span class="ht-eq-outs">'
            + '<span class="ht-oc-row">' + mini + '<\/span>'
            + '<span class="ht-eq-p">' + pct.toFixed(1) + '%<\/span>'
            + '<\/span>';
        }
        el.hidden = false;
        // 좌우 위치 클래스는 골격이 정해 준 것이니 건드리지 않고 상태만 토글한다
        el.classList.toggle('lead', lead);
        el.classList.toggle('chase', !lead);
        el.title = o ? '이 카드가 나오면 이깁니다 (' + o.count + '장): ' + o.ranks.join(', ') : '';
        el.innerHTML = body;
      });
    }

    /* ── 좌석판 위 행동 배지 ──────────────────────────────────────────
       행동한 순간 좌석판 위에 뜨고 스스로 사라진다(CSS 애니메이션이 페이드까지 맡는다).
       예전에는 베팅 자리에 계속 남아서, 이미 지나간 "체크"가 판이 끝날 때까지 붙어 있었다.

       올인만 계속 남긴다 — 판이 끝날 때까지 유효한 사실이고, 남은 사람들이 무엇을 상대로
       겨루는지 알아야 한다. 나머지는 방금 일어난 일이라 잠깐 보이면 된다.

       열쇠는 (스트리트 · 자리 · 행동 · 금액)이다. 금액을 넣는 이유는 한 스트리트에서
       같은 자리가 콜 → 레이즈 → 콜을 할 수 있어서, 행동 이름만으로는 새 행동인지
       구분되지 않기 때문이다(액션 음성과 같은 규칙이다). */
    var ACT_BADGE_MS = 1700;
    /* 한 폴링에 두 사람의 행동이 함께 도착하면 시차를 두고 띄운다.
       서버는 액션 사이에 최소 1초를 두는데(ACT_GAP_SEC) 폴링도 1초 간격이라,
       두 액션이 같은 응답에 담기는 경우가 생긴다. 그때 배지를 동시에 띄우면
       "누가 무엇을 했는지" 순서가 사라진다 — 액션 음성이 줄을 서는 것과 같은 이유다. */
    var BADGE_STAGGER_MS = 520;
    var badgeKey = {}, badgeHand = null, badgeAt = 0;
    function syncActBadges(tb, list){
      if (tb.handNo !== badgeHand) {
        badgeHand = tb.handNo; badgeKey = {}; badgeAt = 0;
        // 새 판 — 지난 판의 배지와 승자 표시를 걷어낸다
        /* :not(.away)로 걸러야 한다 — 자리 비움 태그가 같은 클래스를 쓰는데
           그건 판이 바뀐다고 걷어낼 것이 아니라 복귀할 때까지 남는 상태다. */
        seatsEl.querySelectorAll('.ht-abadge:not(.away)').forEach(function(el){
          clearTimeout(el.__s); clearTimeout(el.__t);
          el.hidden = true; el.style.animation = 'none';
        });
        clearWinBadges();
      }
      list.forEach(function(x){
        var el = seatsEl.querySelector('.ht-seat[data-seat="' + x.seat + '"] .ht-abadge:not(.away)');
        if (!el) return;
        if (!x.act) {
          // 서버가 표시를 지웠다(스트리트 전환·판 종료) — 열쇠만 비운다.
          // 배지 자체는 자기 타이머로 사라지므로 여기서 억지로 감추면 도중에 툭 끊긴다.
          if (badgeKey[x.seat] != null) badgeKey[x.seat] = null;
          return;
        }
        /* 폴드만 스트리트를 열쇠에서 뺀다.
           서버는 폴드 표시를 스트리트가 바뀌어도 지우지 않으므로(계속 유효한 사실이니까),
           스트리트가 열쇠에 들어 있으면 플랍에서 접은 사람이 턴·리버마다 다시 "폴드"를
           띄운다(실제로 그랬다). 한 판에 폴드는 한 번뿐이니 열쇠도 하나면 된다.
           올인은 서버가 스트리트 전환에서 지우므로 다른 액션과 같이 다뤄도 된다. */
        var key = x.act === 'fold' ? 'fold' : tb.street + ':' + x.act + ':' + (x.amount || 0);
        if (badgeKey[x.seat] === key) return;              // 같은 행동을 다시 띄우지 않는다
        badgeKey[x.seat] = key;

        /* 앞 배지가 뜬 지 얼마 안 됐으면 그만큼 미뤄서 띄운다.
           badgeAt은 "다음 배지를 띄워도 되는 시각"이다 — 새 행동이 여러 개 몰려 오면
           차례차례 밀린다. */
        var now = Date.now();
        var wait = Math.max(0, badgeAt - now);
        badgeAt = now + wait + BADGE_STAGGER_MS;
        var act = x.act, amount = x.amount;
        var show = function(){
          el.textContent = actLabel(act, amount);
          /* 색은 행동의 성격으로 가른다: 돈을 더 넣는 것(베팅·레이즈)은 붉게,
             맞춰 가는 것(콜)은 파랗게, 안 넣는 것(체크)은 초록, 접는 것은 회색.
             올인은 나머지와 다른 등급이라 색만 따로 둔다 — 사라지는 방식은 같다. */
          el.className = 'ht-abadge a-' + act;
          el.hidden = false;
          // 애니메이션을 다시 재생시킨다 — 클래스만 바꾸면 브라우저가 이어서 틀지 않는다
          el.style.animation = 'none';
          void el.offsetWidth;
          el.style.animation = 'actBadge ' + ACT_BADGE_MS + 'ms ease-out forwards';
          /* 다 사라진 뒤에는 실제로 감춘다. 투명해진 요소를 그냥 두면 눈에는 안 보이지만
             같은 자리를 쓰는 WIN 배지와 DOM에서 겹쳐 있어 나중에 헷갈릴 여지가 남는다. */
          clearTimeout(el.__t);
          el.__t = setTimeout(function(){ el.hidden = true; }, ACT_BADGE_MS + 60);
        };
        clearTimeout(el.__s);
        if (wait > 0) el.__s = setTimeout(show, wait); else show();
      });
    }

    /* ── 행동 시간 바 ─────────────────────────────────────────────────
       서버는 남은 초를 정수로만 준다(폴링도 1초 간격이다). 그걸 그대로 그리면 바가
       1초마다 뚝뚝 끊긴다. 그래서 폴링이 준 값을 기준점으로 잡고 그 뒤로는
       실제 흐른 시간으로 보간해 매 프레임 그린다 — 다음 폴링이 오면 기준점만 새로 맞춘다.

       마지막 5초에 색을 바꾸고, 4.5초부터 똑딱 소리를 한 번 낸다(시점이 다른 이유는
       아래 CLOCK_TICK_SEC에 적었다). 시간이 다 되면 서버가 자동으로 체크(불가하면 폴드)
       하므로, 이 경고는 "지금 안 누르면 자동으로 넘어간다"는 뜻이다.

       누구 차례든 울린다. 예전에는 내 차례에만 초당 한 번 카드 소리를 냈는데, 남이
       시간에 쫓기는 것도 판의 긴장이라 보여주는 게 맞다 — 그리고 그 사람이 자동으로
       넘어가면 내 차례가 곧 온다는 신호이기도 하다. */
    var CLOCK_WARN_SEC = 5;    // 바가 붉어지고 점멸하는 시점
    var CLOCK_TICK_SEC = 4.5;  // 똑딱 소리가 시작되는 시점 (음원 길이에 맞춘 값)
    var clockBase = null;      // { seat, left, at, total, hand, street }
    var clockWarned = null;    // 이미 경고를 낸 (판:스트리트:자리) — 한 차례에 한 번만 울린다
    function noteClock(tb){
      if (!tb || tb.toActSeat == null || tb.actionLeft == null || tb.ended) {
        clockBase = null;
        return;
      }
      // 같은 자리·같은 남은 초가 계속 오는 동안에는 기준점을 흔들지 않는다
      if (clockBase && clockBase.seat === tb.toActSeat && clockBase.left === tb.actionLeft) return;
      clockBase = {
        seat: tb.toActSeat, left: tb.actionLeft, at: Date.now(),
        total: tb.actionSec || 20,
        // 경고음을 "한 차례에 한 번"으로 묶는 열쇠의 재료다
        hand: tb.handNo, street: tb.street,
      };
    }
    function paintClock(){
      var seats = seatsEl.querySelectorAll('.ht-seat');
      if (!clockBase) {
        seats.forEach(function(el){
          var b = el.querySelector('.ht-tbar'); if (b) b.hidden = true;
        });
        return;
      }
      var left = clockBase.left - (Date.now() - clockBase.at) / 1000;
      if (left < 0) left = 0;
      var frac = clockBase.total > 0 ? left / clockBase.total : 0;
      if (frac > 1) frac = 1;
      /* 색과 소리의 시점을 따로 둔다.
         색은 5초부터 — 눈으로 먼저 알아채는 게 낫다.
         소리는 4.5초부터 — 음원의 들리는 길이가 3.75초라(4.63초 파일에서 앞뒤 무음을
         잘라낸 값), 4.5초에 시작하면 0.75초쯤 남기고 끝난다. 5초에 시작하면 1.25초를
         남기고 조용해져서 "아직 시간이 남았나" 싶은 공백이 생긴다. */
      var warn = left <= CLOCK_WARN_SEC;
      var tick = left <= CLOCK_TICK_SEC;
      seats.forEach(function(el){
        var b = el.querySelector('.ht-tbar');
        if (!b) return;
        var mine = Number(el.getAttribute('data-seat')) === clockBase.seat;
        b.hidden = !mine;
        if (!mine) return;
        b.style.setProperty('--frac', String(frac));
        b.classList.toggle('warn', warn);
      });
      /* 경고음은 한 차례에 한 번. 매초 다시 부르면 겹겹이 깔려 무슨 소리인지 알 수 없다.
         "한 차례"는 (판 · 스트리트 · 자리)로 가른다. 자리 하나만 쓰면 같은 사람이
         플랍·턴·리버에서 다시 시간에 쫓길 때 첫 번째만 울린다. */
      if (tick && left > 0) {
        var key = clockBase.hand + ':' + clockBase.street + ':' + clockBase.seat;
        if (clockWarned !== key) {
          clockWarned = key;
          if (window.casinoSfx && window.casinoSfx.clockWarn) window.casinoSfx.clockWarn();
        }
      }
    }
    // 바는 폴링과 무관하게 계속 줄어든다 — 폴링 사이 1초를 메우는 것이 목적이다
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
      /* 공개 여부가 카드의 배치를 바꾼다.
           비공개 — 두 장을 겹치고 기울여 아바타 뒤에 둔다
           공개   — 나란히 펼치고 커져서 아바타 앞으로 나온다
         CSS의 .up 하나가 크기·간격·기울기·z를 함께 바꾼다(전환도 CSS가 맡는다).
         내 카드는 언제나 보이므로 항상 펼친 상태다. */
      var open = !!(s.cards && s.cards.length);
      hole.classList.toggle('up', open);
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
    /* 래빗을 펼쳐 둔 판 번호. 페이지가 살아 있는 동안 유지되므로 대회가 바뀌면 반드시
       지워야 한다 — 판 번호는 대회마다 1부터 다시 시작해서, 안 지우면 새 대회의 같은
       번호 판에서 지난 대회의 열림 상태를 물려받는다. */
    var rabbitShownHand = null, rabbitTid = null;
    function noteRabbitScope(){
      var tid = st && st.tournament ? st.tournament.id : null;
      if (tid !== rabbitTid) { rabbitTid = tid; rabbitShownHand = null; }
    }
    function syncRabbit(tb){
      var rest = tb.rabbit || [];
      var can = tb.ended && rest.length > 0;
      rabbitBtn.hidden = !can || rabbitShownHand === tb.handNo;
      var open = can && rabbitShownHand === tb.handNo;
      rnoteEl.hidden = !open;
      if (open) rnoteEl.textContent = '🐇 파란 점선 ' + rest.length + '장은 실제로 깔리지 않은 카드입니다';
      if (!open) return;
      /* 이미 눌렀다 — 실제 보드 + 래빗 카드를 한 줄로 놓고 슬롯별로 맞춘다.

         예전에는 실제 카드를 paintBoard(real, real.length)로 먼저 맞추고 래빗을 뒤에
         덧붙였는데, paintBoard는 "want보다 많은 자식을 지우는" 함수라서 뒤에 붙여 둔
         래빗 카드를 매 폴링마다 통째로 걷어냈다. 그러면 아래 반복문이 다시 만들어 붙이고,
         요소가 새로 생기니 cardFlip이 다시 재생된다 — 1초마다 카드가 뒤집혔다.
         (덤으로 paintBoard가 카드 추가를 감지해 뒤집는 소리까지 매초 냈다.)
         프리플랍 폴드면 실제 보드가 0장이라 다섯 장 전부가 매초 다시 뒤집혔다.

         그래서 paintBoard를 쓰지 않고 여기서 직접 맞춘다. 같은 카드가 이미 그 자리에
         있으면 요소를 그대로 두고 클래스만 손본다 — 요소를 다시 만들지 않는 것이 핵심이다. */
      var real = tb.board || [];
      var want = real.concat(rest);
      while (boardEl.children.length > want.length) boardEl.removeChild(boardEl.lastChild);
      for (var i = 0; i < want.length; i++) {
        var isRab = i >= real.length;
        var src = '/cards/' + want[i] + '.svg?v=' + CARD_V;
        var cur = boardEl.children[i];
        if (!cur) {
          boardEl.insertAdjacentHTML('beforeend', cardImg(want[i], isRab ? 'rabbit' : ''));
        } else if (cur.getAttribute('src') !== src) {
          cur.outerHTML = cardImg(want[i], isRab ? 'rabbit' : '');
        } else if (cur.classList) {
          cur.classList.toggle('rabbit', isRab);
        }
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
    /* ── 칩 액면 ────────────────────────────────────────────────────
       실제 카지노의 색 규약을 그대로 쓴다:
         흰 100 · 빨강 500 · 초록 1,000 · 검정 5,000 · 보라 10,000
       색이 곧 금액이라 숫자를 읽지 않아도 판의 크기가 보인다 — 보라가 섞이기
       시작하면 큰 판이다. 예전에는 전부 금색 동전과 금색 골드바 두 종류였다.
       다른 게임과 부품을 공유해서 편했지만, 홀덤 테이블 위에서 모든 칩이 같은
       색이면 "쌓였다"밖에 말하지 못한다.

       다섯 종으로 정한 근거는 이 대회의 규모다 — 시작 스택 10,000, 15명이면
       전체 15만이고 블라인드는 25/50에서 시작해 후반에 수천 단위가 된다.
       어느 구간에서도 칩 두세 개로 표현된다.
       25·50 같은 초반 블라인드는 100 하나로 뭉뚱그린다. 개수를 금액과 1:1로
       맞추는 것보다 "칩이 놓였다"가 눈에 보이는 것이 중요하다. */
    var HT_DENOMS = [10000, 5000, 1000, 500, 100];
    var HT_DCLASS = { 10000: 'd10k', 5000: 'd5k', 1000: 'd1k', 500: 'd500', 100: 'd100' };
    var HT_MAX_CHIPS = 30;
    function htDenomClass(v){ return HT_DCLASS[v] || 'd100'; }
    function htDecompose(amount){
      var out = [];
      for (var i = 0; i < HT_DENOMS.length && out.length < HT_MAX_CHIPS; i++) {
        while (amount >= HT_DENOMS[i] && out.length < HT_MAX_CHIPS) {
          out.push(HT_DENOMS[i]); amount -= HT_DENOMS[i];
        }
      }
      /* 100으로 안 나뉘는 잔액(25 스몰블라인드, 앤티 나머지)이 남는다.
         가장 작은 칩 하나로 대신 보여준다. */
      if (amount > 0 && out.length < HT_MAX_CHIPS) out.push(HT_DENOMS[HT_DENOMS.length - 1]);
      return out;
    }
    function htJit(i, span){ return ((i * 2654435761) % 1000) / 1000 * span - span / 2; }
    function htChipSprite(denom, idx, pending){
      var col = idx % 6, row = Math.floor(idx / 6);
      var x = Math.round((col - 2.5) * 13 + htJit(idx, 7));
      var y = Math.round(2 + row * 4 + htJit(idx + 7, 2));
      /* 칩 위에 숫자를 적지 않는다. 실제 칩은 액면을 색과 무늬로 말하고, 지름 17px에
         들어가는 6.5px 글자는 어차피 안 읽힌다 — 무늬만 흐려질 뿐이었다.
         금액은 더미마다 붙는 이름표(.ht-pg-v)가 적는다. */
      return '<span class="ht-pchip pkchip ' + htDenomClass(denom) +
        (pending ? ' pending' : '') + '" data-d="' + denom + '"' +
        ' style="left:calc(50% + ' + x + 'px);bottom:' + y + 'px;z-index:' + (10 + idx) + '">' +
        '</span>';
    }
    /* ── 층별 칩 더미 ───────────────────────────────────────────────
       팟이 갈라지면 더미도 갈라진다. 하나로 뭉쳐 두면 "어느 팟을 누가 가져갔나"를
       보여줄 방법이 없다 — 정산 연출이 층마다 따로 날아가려면 칩도 층마다 있어야 한다.

       칩은 금액의 표현이므로 층 금액에 비례해 나눈다. 쌓인 칩 목록(append-only)은
       그대로 두고, 그 목록을 층 금액의 누적 경계로 잘라 각 더미에 넣는다.
       총액을 층마다 다시 쪼개지 않는 이유는 예전과 같다 — 500 두 개가 1000 한 개로
       합쳐져 보이면 얼마가 어떻게 모였는지가 사라진다. */
    var potPile = { hand: null, total: 0, list: [], n: 0, sig: '' };
    /* 지금 층 구성. 서버가 준 pots를 쓰고, 없으면 층 하나로 본다. */
    function pileLayers(tb){
      var ps = (tb && tb.pots) || [];
      if (ps.length > 1) return ps.map(function(p){ return p.amount || 0; });
      return [tb ? (tb.pot || 0) : 0];
    }
    function pileLabel(i, n, amount){
      if (n < 2) return '';
      return '<span class="ht-pg-k">' + (i === 0 ? 'MAIN' : 'SIDE ' + i) + '</span>' +
        '<span class="ht-pg-v">' + stackText(amount) + '</span>';
    }
    /* 더미를 다시 그린다. 층 금액의 누적 경계로 칩 목록을 잘라 넣는다. */
    function paintPotPile(tb){
      var amts = pileLayers(tb);
      var sum = amts.reduce(function(a, b){ return a + b; }, 0) || 1;
      var chips = potPile.list;
      pileEl.style.opacity = '';
      pileEl.className = 'ht-piles' + (amts.length > 1 ? ' split' : '');
      var html = '', used = 0, acc = 0;
      for (var i = 0; i < amts.length; i++) {
        acc += amts[i];
        // 이 층까지 들어가야 할 칩 개수 (마지막 층은 남은 것 전부)
        var upto = i === amts.length - 1 ? chips.length
          : Math.min(chips.length, Math.round(chips.length * acc / sum));
        var inner = '';
        for (var k = used; k < upto; k++) inner += htChipSprite(chips[k].d, k - used, false);
        used = upto;
        html += '<div class="ht-pg" data-layer="' + i + '">' +
          '<span class="ht-pg-chips">' + inner + '</span>' +
          pileLabel(i, amts.length, amts[i]) + '</div>';
      }
      pileEl.innerHTML = html;
    }
    function resetPotPile(tb, settled){
      potPile = { hand: tb.handNo, total: 0, list: [], n: 0, sig: '' };
      if (settled > 0) { potPile.total = settled; potPile.list = htDecompose(settled).map(function(d, i){
        return { d: d, i: i % HT_MAX_CHIPS };
      }); }
      potPile.n = potPile.list.length;
      potPile.sig = pileLayers(tb).join(',');
      paintPotPile(tb);
    }
    function syncPotPile(tb){
      /* 지금 이 스트리트에 각자 앞에 놓인 칩은 아직 중앙에 온 것이 아니다.
         팟 총액에서 그것을 빼면 "이미 중앙에 모인 금액"이 된다.
         단 판이 끝나면 마지막 스트리트의 베팅까지 전부 중앙으로 모인다 — 그걸 빼두면
         팟은 1,050인데 더미에는 450어치만 쌓인 채로 승자에게 날아간다. */
      var live = 0;
      (tb.seats || []).forEach(function(s){ live += s.bet || 0; });
      var settled = tb.ended ? (tb.pot || 0) : Math.max(0, (tb.pot || 0) - live);
      if (potPile.hand !== tb.handNo) return resetPotPile(tb, settled);
      // 콜되지 않은 초과 베팅을 돌려주면 팟이 줄어든다 — 그때는 연출 없이 다시 그린다
      if (settled < potPile.total) return resetPotPile(tb, settled);
      var sig = pileLayers(tb).join(',');
      var delta = settled - potPile.total;
      if (delta > 0) {
        potPile.total = settled;
        var denoms = htDecompose(delta);
        for (var i = 0; i < denoms.length; i++) {
          if (potPile.list.length >= HT_MAX_CHIPS) potPile.list.shift();
          potPile.list.push({ d: denoms[i], i: potPile.n++ % HT_MAX_CHIPS });
        }
        potPile.sig = sig;
        paintPotPile(tb);
        /* 각자 앞의 칩 기둥이 중앙으로 미끄러지는 연출(flyStack)이 620ms다.
           그것이 도착하는 바로 그 순간 더미에 나타나야 "모여서 쌓였다"로 읽힌다 —
           일찍 켜면 칩이 두 벌 보이고, 늦게 켜면 사라졌다가 다시 생긴 것처럼 보인다.
           새로 들어온 만큼만 뒤에서부터 순서대로 켠다. */
        if (!firstTablePaint) {
          var all = pileEl.querySelectorAll('.ht-pchip');
          var from = Math.max(0, all.length - denoms.length);
          for (var j = from; j < all.length; j++) {
            (function(el, k){
              el.classList.add('pending');
              setTimeout(function(){ el.classList.remove('pending'); }, STACK_FLY_MS - 60 + k * 40);
            })(all[j], j - from);
          }
        }
        return;
      }
      // 층 구성이 바뀌었거나 골격이 다시 그려졌다면 기록대로 복원한다
      if (sig !== potPile.sig || !pileEl.querySelector('.ht-pg')) {
        potPile.sig = sig;
        paintPotPile(tb);
      }
    }

    /* ── 좌석 앞 베팅 칩 ────────────────────────────────────────────
       금액을 액면으로 쪼개 실제로 그 조합대로 쌓는다. 예전에는 금액 구간에 따라
       똑같이 생긴 금색 원반을 1~3장 얹었다 — 높이는 대충 맞았지만 색이 하나뿐이라
       "얼마"인지는 옆의 숫자를 읽어야만 알 수 있었다.

       지금은 큰 액면이 아래, 작은 액면이 위로 쌓인다(실제 딜러가 쌓는 순서다).
       그래서 더미의 아래쪽 색만 봐도 자릿수를 알 수 있다 — 검정이 깔려 있으면 만 단위,
       흰 것만 있으면 몇백이다.

       8장에서 끊는다. 그 위로는 높이가 화면 밖으로 자라기만 하고 정보는 늘지 않는다
       (정확한 금액은 바로 옆 숫자가 말한다). */
    var BET_MAX_CHIPS = 8;
    function chipStack(amount){
      var ds = htDecompose(amount).slice(0, BET_MAX_CHIPS);
      var out = '';
      /* 큰 액면이 아래로 가야 하므로 뒤에서부터 쌓는다 —
         htDecompose는 큰 액면부터 담는데, 나중에 그린 것이 위에 온다.

         맨 위 한 장만 윗면(타원 탑뷰)이고 나머지는 옆면 띠다. 실제로 칩을 쌓아
         비스듬히 내려다보면 그렇게 보인다 — 전부 윗면으로 그리면 원반을 부채처럼
         늘어놓은 것이 되어 기둥으로 안 읽힌다. */
      for (var i = ds.length - 1; i >= 0; i--) {
        var lvl = ds.length - 1 - i;      // 0이 맨 아래
        // 윗면만 pkchip(탑뷰 무늬)을 쓴다. 옆면은 .ht-chip 자체의 줄무늬다.
        var top = i === 0 ? ' top pkchip' : '';
        out += '<i class="ht-chip' + top + ' ' + htDenomClass(ds[i]) +
          '" style="bottom:' + (lvl * 4) + 'px;z-index:' + (10 + lvl) + '"></i>';
      }
      return '<i class="ht-chip-sh"></i>' + out;
    }
    /* 태그 안에는 칩 그림을 넣지 않는다. 한때 스택 숫자 앞에 액면 세 종을 겹쳐
       규모를 색으로 보였는데, 아홉 자리에 작은 색점이 스물일곱 개 붙으니 테이블 위에서
       가장 시끄러운 요소가 됐다. 태그는 이름과 숫자만 말한다 —
       칩 그림이 필요한 곳은 실제로 칩이 움직이는 곳(베팅 자리·중앙 팟)이다. */

    /* ── 스택 숫자는 칩이 도착한 뒤에 오른다 ────────────────────────
       서버는 판이 끝나는 순간 상금이 이미 반영된 스택을 보낸다. 그대로 그리면
       쇼다운 카드가 열리기도 전에 숫자가 먼저 올라 결과를 알려 버린다 — 전원 올인이면
       카드 다섯 장이 깔리는 동안 이미 누가 이겼는지 스택에 적혀 있었다.
       그래서 "아직 화면에서 안 받은 상금"을 빼고 그린다. payLayer가 그 층의 칩을
       실제로 날려 보내고 도착할 때 paidSeat에 적고, 그때 숫자가 오른다.
       판이 바뀌면 초기화한다(그 판의 상금은 이미 다 반영된 뒤다). */
    var paidSeat = {}, paidSeatHand = null;
    function stackOf(tb, s){
      if (!tb.ended || !tb.result || !tb.result.awards) return s.stack;
      var owed = 0;
      tb.result.awards.forEach(function(a){
        if (a.seat === s.seat) owed += a.amount || 0;
      });
      owed -= (paidSeat[s.seat] || 0);
      return owed > 0 ? Math.max(0, s.stack - owed) : s.stack;
    }

    /* ── 오른쪽 패널 ─────────────────────────────────────────────── */
    function renderSide(){
      var t = st.tournament, tb = st.table;
      sideTitle.textContent = t.title;
      /* 대회 종료 안내는 오른쪽 패널 머리에 붙인다. 예전에는 펠트 한가운데에
         "대회 종료 · 결과 8초"라고 찍었는데, 테이블 바닥에 시스템 문구가 인쇄된 꼴이라
         마지막 판의 쇼다운 위로 글자가 겹쳤다. 테이블은 게임만 그리는 자리다. */
      if (tb.tournamentOver) {
        sideNote.hidden = false;
        sideNote.textContent = '대회 종료'
          + (tb.finishLeft != null && tb.finishLeft > 0 ? ' · 결과 ' + tb.finishLeft + '초' : '');
      } else {
        sideNote.hidden = true;
      }
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
      backBtn.hidden = tb.myPresence !== 'SIT_OUT';
    }

    /* ── 테이블 ───────────────────────────────────────────────────── */
    /* ── 보드를 한 장씩 깐다 ─────────────────────────────────────────
       서버는 플랍 세 장을 한꺼번에 준다(스트리트 단위로 상태가 바뀐다).
       그대로 그리면 프리플랍이 끝난 순간 세 장이 뿅 나타난다.
       그래서 클라이언트가 "지금 몇 장까지 보여줄지"를 따로 들고, 남은 장을
       한 장씩 늘려가며 깐다. 서버는 초 단위 해상도라 이 박자는 클라이언트 몫이다. */
    var BOARD_FIRST_MS = 560;     // 이번에 깔 첫 장까지
    var BOARD_STEP_MS = 330;      // 같은 스트리트 안(플랍 세 장) 사이
    /* 한 번에 여러 스트리트를 여는 경우(올인·전원 콜로 쇼다운이 확정된 판)의 스트리트 사이.
       여기가 이 판의 긴장이 만들어지는 유일한 구간이다 — 결과는 이미 정해져 있고
       사람이 할 수 있는 건 기다리는 것뿐이라, 빠르게 넘기면 판이 그냥 스킵된 것처럼 느껴진다.
       500ms였을 때 "플랍 턴 리버가 너무 빨리 지나간다"는 말이 나왔고, 1,500ms로 올린
       뒤에도 같은 말이 나왔다.

       그리고 세 구간을 같은 값으로 두면 안 된다. 남은 카드가 줄어들수록 한 장의 무게가
       커지기 때문이다 — 플랍은 세 장이 한꺼번에 나와 아직 판이 열리는 중이고,
       턴은 "이 한 장으로 뒤집힐 수 있다"가 처음 성립하는 지점이며, 리버는 마지막이다.
       실제 중계도 리버 앞에서 가장 오래 뜸을 들인다. 그래서 뒤로 갈수록 길게 잡는다.
         프리플랍 → 플랍  1.6초
         플랍 → 턴        2.2초
         턴 → 리버        2.6초
       한 스트리트씩 정상 진행할 때는 이 값을 쓰지 않는다 — 그때는 이미 ACTION_HOLD_MS로
       한 박자 쉬고 있고, 거기에 또 얹으면 진행이 늘어진다. */
    var BOARD_RUNOUT_MS = { 1: 1600, 2: 2200, 3: 2600 };
    // 몇 번째 카드가 어느 스트리트인지 (0~2 플랍 · 3 턴 · 4 리버)
    function streetOfCard(i){ return i <= 2 ? 0 : i - 2; }
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
    /* 이번에 깔 카드 앞에 두는 간격.
       절대 위치가 아니라 "이번 묶음 안에서 몇 번째인가"로 정한다 — 턴 한 장만 여는
       정상 진행에서 그 장은 묶음의 첫 장이므로 BOARD_FIRST_MS를 받아야 한다.
       예전에는 절대 위치로 정해서(i>=3이면 STREET) 턴·리버가 정상 진행에서도
       스트리트 간격을 받았다. */
    function boardGap(i, from){
      if (i === from) return BOARD_FIRST_MS;
      var st1 = streetOfCard(i), st0 = streetOfCard(i - 1);
      // 스트리트가 넘어가는 자리에만 긴 정지를 둔다. 어느 스트리트로 넘어가느냐로 길이가 다르다
      return st1 !== st0 ? (BOARD_RUNOUT_MS[st1] || 1600) : BOARD_STEP_MS;
    }
    function syncBoard(tb){
      var cards = tb.board || [];
      /* 래빗을 펼쳐 둔 판이면 그쪽이 보드를 그린다.

         조건에 "래빗이 실제로 열릴 수 있는 상태인가"까지 넣는다. 판 번호만 비교하면
         위험한 구멍이 하나 생긴다 — rabbitShownHand는 페이지가 살아 있는 동안 유지되는
         값이고 판 번호는 대회마다 1부터 다시 시작한다. 새 대회의 1판이 열렸을 때
         우연히 번호가 같으면 syncRabbit으로 넘어가는데, 진행 중인 판은 서버가 rabbit을
         빈 배열로 주므로 syncRabbit이 아무것도 그리지 않고 빠져나온다 —
         그러면 그 판은 보드가 영원히 비어 있게 된다.
         (진짜로 열려 있을 때만 위임하면 그 경로가 아예 생기지 않는다) */
      if (rabbitShownHand === tb.handNo && tb.ended && (tb.rabbit || []).length > 0) {
        syncRabbit(tb); return;
      }
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
      var t = ACTION_HOLD_MS, from = shownBoard;
      for (var i = from; i < cards.length; i++) {
        t += boardGap(i, from);
        (function(upto, at){
          boardTimers.push(setTimeout(function(){
            shownBoard = upto;
            var now = (st.table && st.table.board) || [];
            paintBoard(now, upto);
            /* 승률은 "지금 깔린 보드"에 맞는 단계를 보여준다. 폴링(1초)에만 맡기면
               플랍이 다 깔린 뒤에도 최대 1초는 이전 단계가 떠 있고, 런아웃이 빠르면
               플랍 단계를 아예 못 보고 지나간다. 카드를 열 때마다 여기서 갱신한다. */
            if (st && st.table) syncEquity(st.table);
            if (upto >= now.length) {
              boardRevealed = true;
              clearBoardReveal();
              /* 폴링(1초)을 기다리지 않고 바로 다시 그린다 — 액션 버튼이 이 값에 걸려
                 있어서, 기다리면 카드가 다 깔린 뒤에도 최대 1초는 누를 수 없다. */
              if (st && st.table && !tableEl.hidden) { renderSeats(); renderControls(); }
            }
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
        /* 테이블 안에 붙인다. position:fixed라 어디에 붙어도 화면 좌표로 움직이지만,
           body 직속이면 --ht* 변수와 .ht-shell 스코프 규칙이 닿지 않아 복제된 카드가
           기본 .pcard(48×72)로 떨어진다. 지금은 인라인 크기가 그걸 가려 주고 있을 뿐이다. */
        tableEl.appendChild(fxLayer);
      }
      return fxLayer;
    }
    function flyChip(fromRect, toRect, delay, cls){
      var c = document.createElement('i');
      c.className = 'ht-chip top pkchip fly' + (cls ? ' ' + cls : '');
      c.style.cssText = 'position:fixed;left:' + fromRect.left + 'px;top:' + fromRect.top + 'px;' +
        'width:20px;height:10px;';
      c.style.setProperty('--tx', Math.round((toRect.left + toRect.width/2) - fromRect.left) + 'px');
      c.style.setProperty('--ty', Math.round((toRect.top + toRect.height/2) - fromRect.top) + 'px');
      c.style.animationDelay = delay + 'ms';
      getFx().appendChild(c);
      setTimeout(function(){ if (c.parentNode) c.parentNode.removeChild(c); }, 700 + delay);
    }
    /* 좌석 앞의 칩 기둥을 통째로 복제해 중앙까지 미끄러뜨린다.
       익명의 칩 하나를 날리는 것과 다른 점: 출발한 것과 도착한 것이 같은 물건이다.
       실제로 그 사람이 낸 액면 조합 그대로 움직이므로 "저 칩이 팟으로 갔다"가 된다. */
    var STACK_FLY_MS = 620;
    function flyStack(snap, toRect, delay){
      if (!snap || !snap.rect.width) return;
      var r = snap.rect;
      var w = document.createElement('div');
      w.className = 'ht-fly-stack';
      w.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;' +
        'width:' + r.width + 'px;height:' + r.height + 'px;';
      w.innerHTML = snap.html;
      w.style.setProperty('--tx',
        Math.round((toRect.left + toRect.width / 2) - (r.left + r.width / 2)) + 'px');
      w.style.setProperty('--ty',
        Math.round((toRect.top + toRect.height / 2) - (r.top + r.height / 2)) + 'px');
      w.style.animationDelay = delay + 'ms';
      getFx().appendChild(w);
      setTimeout(function(){ if (w.parentNode) w.parentNode.removeChild(w); },
        STACK_FLY_MS + delay + 80);
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
        if (!el || !(s.bet > 0)) return;
        var chips = el.querySelector('.ht-spot-chips');
        if (!chips) return;
        var r = chips.getBoundingClientRect();
        /* 좌표만이 아니라 칩 기둥의 생김새까지 통째로 기억한다.
           날릴 시점에는 이미 서버가 베팅을 0으로 되돌려 원본이 화면에서 사라진 뒤라,
           그때 가서 복제하려 하면 복제할 것이 없다. */
        next[s.seat] = {
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          html: chips.innerHTML,
        };
      });
      /* 스트리트가 넘어갈 때, 그리고 판이 끝날 때 각자 앞의 칩이 중앙으로 간다.
         판이 끝나는 경우를 빼먹으면 마지막 스트리트 베팅이 그 자리에서 그냥 사라진다. */
      var streetChanged = (tb.handNo === spotHand && tb.street !== spotStreet);
      var handEnded = tb.ended && sweptEndHand !== tb.handNo;
      if (streetChanged || handEnded) {
        if (handEnded) sweptEndHand = tb.handNo;
        var pot = pileEl.getBoundingClientRect();
        /* 목표는 팟 금액표가 아니라 칩 더미다. 칩이 숫자 알약으로 빨려 들어가면
           "칩이 어디로 갔나"가 어긋난다 — 칩은 칩 더미로 가야 한다.
           더미가 아직 비어 있으면(첫 스트리트) 그 자리라도 팟 알약보다는 낫다. */
        if (!pot.width) pot = potEl.getBoundingClientRect();
        var n = 0;
        Object.keys(prevSpots).forEach(function(k){
          flyStack(prevSpots[k], pot, n * 55);
          n++;
        });
      }
      prevSpots = next;
      spotStreet = tb.street; spotHand = tb.handNo;
    }

    /* 중앙 더미에 실제로 쌓여 있는 칩 하나를 그대로 복제해 날린다.
       예전에는 팟 라벨 위치에서 익명의 작은 칩을 날렸는데, 그러면 쌓인 더미와
       무관한 것이 지나가서 "대충 넣은 애니메이션"으로 보인다. */
    // .ht-pchip.flyout 애니메이션 길이와 같아야 한다 (CSS htPileFly .7s)
    var PILE_FLY_MS = 700;
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
        pushPotToWinners(tb, forHand);
      }, 550);
    }

    /* ── 팟을 층별로 하나씩 넘겨 준다 ─────────────────────────────────
       예전에는 모든 층을 한 번에 정산해서 칩이 여러 자리로 동시에 흩어졌다. 사이드 팟이
       있으면 누가 어느 팟을 가져갔는지 알 수 없었고, 큰 판일수록 더 그랬다.

       이제 한 층씩 간다: 그 층의 승자와 족보를 띄우고 → 칩을 그 사람에게 보내고 →
       도착할 때까지 기다렸다가 다음 층으로. 서버가 이긴 손이 강한 층부터 담아 주므로
       가장 센 손이 먼저 자기 몫을 가져간다(실제 딜러의 순서다).

       한 층의 순서는 [WIN 배지 → WIN_HOLD_MS 대기 → 칩 이동(약 0.9초)]이다.
       그래서 층 간격은 1.4 + 0.9에 여유를 더한 2.5초다. 서버도 같은 값
       (SIDE_POT_STEP_SEC)으로 다음 판 시작을 미룬다 — 한쪽만 바꾸면 마지막 층을
       보여주다가 판이 넘어간다. */
    var POT_STEP_MS = 2500;
    // 층 이름표를 띄워 둔 동안에는 syncOutro가 그 줄을 건드리지 않는다
    var potLabelUntil = 0;
    function pushPotToWinners(tb, forHand){
      /* 칩이 도착하는 곳은 아바타다 — "사람이 앉아 있는 자리"다.
         예전에는 좌석판이었고 그때는 그것이 좌석의 몸통이었다. 지금 좌석판은 아바타 아래에
         걸친 작은 이름 태그이고, 6시 자리에서는 그 태그 중심이 펠트 경계보다 아래에 있다 —
         거기로 칩을 보내면 칩이 테이블을 벗어나 사라지는 것처럼 보인다.
         seatOf는 "이 좌석이 화면에 있나"를 확인하는 문(gate)도 겸하므로 한 곳에서 정한다.
         두 곳에 따로 적어 한쪽만 바꾸면 문은 통과하고 목표가 null이 되어, 그 승자만
         칩·WIN·층 이름표가 통째로 사라진다. */
      var seatOf = function(seat){
        return seatsEl.querySelector('.ht-seat[data-seat="' + seat + '"] .ht-avbox');
      };
      var raw = (tb.result.potAwards || []).filter(function(pa){
        return pa.winners && pa.winners.some(function(w){ return seatOf(w.seat); });
      });
      /* 폴드로 끝난 판이나 옛 판(potAwards가 없는 기록)은 층 정보가 없다.
         그때는 좌석별 합계 하나를 층 하나로 취급한다 — 층이 하나뿐이라 순서를 보여줄
         것은 없지만, WIN 배지와 "먼저 띄우고 나중에 칩" 순서는 똑같이 밟아야 한다.
         예전에는 이 경로가 payLayer를 바로 불러서, 폴드로 끝난 판에서는 승자 표시가
         아예 없고 칩만 날아갔다. 판의 대부분이 이 경로다. */
      var layers;
      if (!raw.length) {
        var flat = (tb.result.awards || []).filter(function(a){ return seatOf(a.seat); });
        if (!flat.length) return;
        layers = [{ __key: '', __span: 1, index: 0, score: 0, amount: tb.pot || 0, winners: flat }];
      } else {
        layers = mergeSameWinner(raw);
      }
      /* WIN 배지를 먼저 띄우고 한 박자 쉰 뒤에 칩을 옮긴다.
         칩이 곧바로 날아가면 "누가 이겼나"를 읽기 전에 정산이 끝나 버린다.
         참고 클라이언트도 배지가 1.5초쯤 떠 있고 그 다음에 칩이 움직인다. */
      layers.forEach(function(pa, i){
        var at = i * POT_STEP_MS;
        setTimeout(function(){
          if (!st || !st.table || st.table.handNo !== forHand) return;   // 새 판이면 중단
          showPotLabel(tb, pa, layers.length);
          showWinBadges(tb, pa);
          /* 층마다 다시 낸다 — 첫 층에서만 울리면 뒤 층은 조용히 지나가서
             "이게 아직 정산 중인가, 끝난 건가"가 소리로는 안 잡힌다.
             첫 층은 위쪽 chipWin/potWin이 이미 울렸으므로 두 번째 층부터다. */
          if (i > 0 && window.casinoSfx) {
            if (window.casinoSfx.chipWin) window.casinoSfx.chipWin();
            if (window.casinoSfx.potWin) window.casinoSfx.potWin();
          }
        }, at);
        setTimeout(function(){
          if (!st || !st.table || st.table.handNo !== forHand) return;
          payLayer(tb, pa, i === layers.length - 1);
        }, at + WIN_HOLD_MS);
      });
    }

    /* 인접한 층의 승자가 같으면 하나로 합친다.
       사이드 팟 세 개를 같은 사람이 다 가져가는 상황에서 세 번 따로 칩을 보내면,
       같은 사람에게 같은 연출이 세 번 반복되면서 "무슨 일이 세 번 일어났나" 싶어진다.
       실제 딜러도 그때는 한 번에 밀어 준다.

       승자가 다른 층은 합치지 않는다 — 그 경계가 바로 사이드 팟이 존재하는 이유이고,
       누가 어느 팟을 가져갔는지 순서로 보여줘야 한다. */
    function mergeSameWinner(layers){
      var out = [];
      layers.forEach(function(pa){
        var key = pa.winners.map(function(w){ return w.seat; }).sort().join(',');
        var prev = out.length ? out[out.length - 1] : null;
        if (prev && prev.__key === key) {
          prev.amount += pa.amount || 0;
          prev.winners = prev.winners.map(function(w){
            var add = pa.winners.filter(function(x){ return x.seat === w.seat; })[0];
            return { seat: w.seat, amount: (w.amount || 0) + (add ? add.amount || 0 : 0) };
          });
          // 합쳐진 층은 이름표에서 "MAIN + SIDE 1" 처럼 묶어 보여준다
          prev.__span = (prev.__span || 1) + 1;
          return;
        }
        out.push({
          __key: key, __span: 1, index: pa.index, score: pa.score,
          amount: pa.amount || 0,
          winners: pa.winners.map(function(w){ return { seat: w.seat, amount: w.amount || 0 }; }),
        });
      });
      return out;
    }

    /* ── WIN 배지 ────────────────────────────────────────────────────
       이 층을 가져가는 사람의 좌석판 위에 WIN을 띄운다. 칩이 움직이기 전에 먼저 뜬다 —
       칩부터 날아가면 이미 끝난 뒤에 누가 이겼는지 알게 된다. */
    var WIN_HOLD_MS = 1400;
    function showWinBadges(tb, pa){
      var win = {};
      pa.winners.forEach(function(w){ win[w.seat] = 1; });
      /* 족보는 층 정보(pa.hand)가 있으면 그걸, 없으면 공개된 패에서 찾는다.
         폴드로 끝난 판은 둘 다 없다 — 보여줄 족보가 실제로 없는 것이다. */
      var reveal = (tb.result && tb.result.reveal) || [];
      (tb.seats || []).forEach(function(s){
        var seatSel = '.ht-seat[data-seat="' + s.seat + '"] ';
        var el = seatsEl.querySelector(seatSel + '.ht-win-b');
        var hEl = seatsEl.querySelector(seatSel + '.ht-win-h');
        if (!el) return;
        if (!win[s.seat]) {
          el.hidden = true;
          if (hEl) hEl.hidden = true;
          return;
        }
        el.hidden = false;
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
        if (hEl) {
          var r = reveal.filter(function(x){ return x.seat === s.seat; })[0];
          var name = pa.hand || (r && r.hand) || '';
          hEl.textContent = name;
          hEl.hidden = !name;
        }
      });
    }
    function clearWinBadges(){
      seatsEl.querySelectorAll('.ht-win-b,.ht-win-h').forEach(function(el){ el.hidden = true; });
    }

    /* 층 이름표를 펠트에 띄우던 함수는 없앴다.
       "MAIN + SIDE 1 POT 89,550 — 정폴드 · 플러시"를 중앙에 한 줄로 적었는데,
       그 정보는 이미 세 곳에 흩어져 있지 않고 제자리에 다 있다:
         어느 팟이 얼마인가 → 더미마다 붙은 MAIN/SIDE 이름표와 금액
         누가 가져가는가   → 그 사람 좌석 위의 WIN 배지
         무엇으로 이겼나   → 그 아래 족보 라벨
       한가운데에 요약을 한 번 더 적으면 눈이 카드에서 글자로 끌려간다. */

    /* 한 층의 칩을 승자에게 보낸다.
       "그 층의 더미"에서만 꺼낸다 — 층마다 더미가 따로 서 있으므로 어느 팟이 누구에게
       가는지가 칩의 출발점으로 드러난다. 예전에는 하나의 더미에서 비율만큼 세어 꺼냈고,
       그래서 세 사람이 각각 다른 층을 가져가도 칩이 늘 같은 자리에서 출발했다.
       합쳐진 층(mergeSameWinner)은 __span만큼 여러 더미를 함께 비운다.
       last면 남은 더미까지 전부 털어 중앙을 비운다. */
    function payLayer(tb, pa, last){
      var payHand = tb.handNo;
      var boxes = Array.prototype.slice.call(pileEl.querySelectorAll('.ht-pg'));
      var first = pa.index || 0, span = pa.__span || 1;
      var mine = boxes.filter(function(b, i){
        if (last) return true;                       // 마지막 층은 남은 것 전부
        var li = Number(b.getAttribute('data-layer'));
        void i;
        return li >= first && li < first + span;
      });
      // 층 정보가 없는 옛 기록이나 폴드 종료는 더미가 하나뿐이라 그것이 곧 전부다
      if (!mine.length) mine = boxes;
      var chips = [];
      mine.forEach(function(b){
        Array.prototype.slice.call(b.querySelectorAll('.ht-pchip')).forEach(function(c){
          if (!c.dataset || c.dataset.sent !== '1') chips.push(c);
        });
      });
      var winners = pa.winners;
      var total = winners.reduce(function(a, x){ return a + (x.amount || 0); }, 0) || 1;
      var quota = chips.length;
      var n = 0, used = 0;
      winners.forEach(function(w, k){
        // 위 seatOf와 반드시 같은 요소여야 한다 (다르면 문은 통과하고 목표가 null이 된다)
        var target = seatsEl.querySelector('.ht-seat[data-seat="' + w.seat + '"] .ht-avbox');
        if (!target) return;
        var tr = target.getBoundingClientRect();
        var take = k === winners.length - 1
          ? quota - used
          : Math.max(1, Math.round(quota * (w.amount || 0) / total));
        take = Math.min(take, quota - used);
        for (var i = 0; i < take; i++) {
          var c = chips[used + i];
          if (!c) break;
          if (c.dataset) c.dataset.sent = '1';
          flyPileChip(c, tr, (n++) * 45);
        }
        used += take;
        // 더미가 비어 있으면(판 도중 합류 등) 최소한 칩 몇 개는 날아가게 한다
        if (!chips.length) {
          var pot = potEl.getBoundingClientRect();
          var amt = w.amount || 0;
          var cnt = amt >= tb.level.bb * 20 ? 5 : amt >= tb.level.bb * 5 ? 3 : 2;
          for (var j = 0; j < cnt; j++) flyChip(pot, tr, (n++) * 45, 'towin');
        }
      });
      /* 보낸 더미는 그 자리에서 접는다 — 마지막 층에서만 전부 접으면 앞 층의 빈 상자가
         이름표만 남아 계속 서 있다. 층이 비워지는 것이 보여야 "이 팟은 끝났다"가 읽힌다. */
      mine.forEach(function(b){ b.classList.add('paid'); });
      /* 칩이 도착한 다음에야 스택 숫자를 올린다.
         서버는 판이 끝나는 순간 이미 상금이 반영된 스택을 보낸다. 그걸 그대로 그리면
         쇼다운 카드가 열리기도 전에 숫자가 먼저 올라 누가 이겼는지 알려 버린다 —
         올인 판에서 특히 심했다. 그래서 화면은 "아직 안 받은 상금"을 빼고 그리다가
         (renderSeats의 stackOf), 그 층의 칩이 실제로 날아가 닿는 시점에 풀어 준다.
         칩 비행은 flyPileChip이 45ms씩 시차를 두고 띄우므로 마지막 칩까지 기다린다. */
      var landed = PILE_FLY_MS + n * 45;
      setTimeout(function(){
        if (!st || !st.table || st.table.handNo !== payHand) return;
        winners.forEach(function(w){
          paidSeat[w.seat] = (paidSeat[w.seat] || 0) + (w.amount || 0);
        });
        renderSeats();
      }, landed);
      if (last) {
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
    /* 앤티를 각자 앞에 놓고 중앙으로 보내는 데 드는 시간.
       카드보다 먼저다 — 실제 테이블도 앤티·블라인드를 걷고 나서 딜링을 시작한다. */
    var ANTE_HOLD_MS = 520;
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

      /* 앤티가 있으면 카드보다 먼저 걷는다. 서버는 앤티를 committed에만 더하고 bet에는
         넣지 않으므로(그래서 좌석 앞에 칩이 안 보인다) 화면이 그 순간을 직접 만든다.
         레벨 6부터 앤티가 붙는다 — 그때부터 매 판 스택이 줄어드는 이유가 보여야 한다. */
      var anteWait = anteSequence(tb, inHand);

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
        }, anteWait + DEAL_START_MS + n * step));
      });
      // 연출이 끊겨도 카드는 반드시 다시 보이게 하는 안전장치
      dealTimers.push(setTimeout(clearDeal,
        anteWait + DEAL_START_MS + cards.length * step + DEAL_FLIGHT_MS + 600));
    }

    /* ── 앤티 제출 ────────────────────────────────────────────────────
       각자 앞에 앤티를 놓고, 잠깐 뒤 전부 중앙으로 보낸다.
       "모두가 같은 금액을 먼저 낸다"는 것이 앤티의 성격이라 한 사람씩 순차로 걷지 않고
       한꺼번에 놓았다가 한꺼번에 보낸다 — 실제 딜러도 그렇게 걷는다.

       돌려주는 값은 "딜링이 이만큼 기다려야 한다"는 시간이다. */
    function anteSequence(tb, inHand){
      var ante = (tb.level && tb.level.ante) || 0;
      if (ante <= 0 || !inHand.length) return 0;

      var made = [];
      inHand.forEach(function(s){
        // 좌표는 renderSeats가 이미 계산해 둔 것을 쓴다 (좌석이 실제로 어디 있는지의 유일한 출처)
        var p = seatXY[s.seat];
        if (!p) return;
        var el = document.createElement('div');
        el.className = 'ht-ante';
        el.style.left = p.bet[0] + '%';
        el.style.top = p.bet[1] + '%';
        el.innerHTML = '<span class="ht-spot-chips">' + chipStack(ante) + '</span>' +
          '<span class="ht-ante-a">' + stackText(ante) + '</span>';
        anteEl.appendChild(el);
        made.push(el);
      });
      if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();

      // 다 놓인 뒤 한꺼번에 중앙으로. 칩이 도착할 즈음 더미가 그 금액을 받아 그린다
      dealTimers.push(setTimeout(function(){
        var pot = pileEl.getBoundingClientRect();
        if (!pot.width) pot = potEl.getBoundingClientRect();
        made.forEach(function(el, k){
          var chips = el.querySelector('.ht-spot-chips');
          var r = chips && chips.getBoundingClientRect();
          if (r && r.width) {
            flyStack({ rect: { left: r.left, top: r.top, width: r.width, height: r.height },
              html: chips.innerHTML }, pot, k * 35);
          }
          if (el.parentNode) el.parentNode.removeChild(el);
        });
        if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
      }, ANTE_HOLD_MS));
      // 연출이 끊겨도 남지 않게 (clearDeal이 dealTimers를 걷지만 요소는 따로 지운다)
      dealTimers.push(setTimeout(function(){
        made.forEach(function(el){ if (el.parentNode) el.parentNode.removeChild(el); });
      }, ANTE_HOLD_MS + 900));
      return ANTE_HOLD_MS + 150;
    }

    function renderTable(){
      var tb = st.table;
      noteRabbitScope();      // 대회가 바뀌면 래빗 열림 상태를 버린다
      syncBoard(tb);
      /* 팟 금액은 다음 판이 시작될 때까지 그대로 둔다.
         한때는 칩이 승자에게 날아간 순간 0으로 바꿨다. 총 칩을 세는 사람에게는 그게 맞다 —
         승자 스택에 이미 반영됐으니 팟까지 남기면 같은 칩이 두 곳에 보인다.
         그런데 실제로 화면을 보는 사람이 그 순간 궁금해하는 건 총 칩이 아니라
         "방금 얼마짜리 판이었나"다. 0으로 지워버리면 그걸 확인할 기회가 사라진다 —
         칩은 이미 날아갔고 숫자도 없어져서 판의 크기를 되짚을 데가 없다.
         중앙 칩 더미는 정산과 함께 사라지므로 "칩은 갔고 금액만 기록으로 남았다"로 읽힌다.
         서버 pot은 다음 판이 열리면 그 판의 블라인드·앤티로 저절로 바뀐다. */
      potEl.textContent = stackText(tb.pot) + (unit === 'chip' ? ' P' : '');
      renderSeats();
      dealSequence(tb);
      renderSide();
      // 칩이 중앙으로 밀려가 더미로 쌓이고, 판이 끝나면 그 더미가 승자에게 넘어간다
      rememberSpots(tb);
      syncPotPile(tb);
      // 팟 회수와 래빗 버튼은 보드를 다 깐 뒤에 — 결과가 카드보다 먼저 오면 안 된다
      if (boardRevealed) { flyPotToWinners(tb); syncRabbit(tb); syncShow(tb); }
      else { showBtn.hidden = true; rabbitBtn.hidden = true; rnoteEl.hidden = true; }

      /* 중앙에는 이제 보드와 팟만 둔다.
         한때 이 자리에 "OO 차례 · N초"가 있었고, 그다음에는 "OO +12,500 (다음 판 8초)"가
         있었다. 둘 다 같은 이유로 없앴다 — 그 정보가 이미 다른 데서 더 잘 말해지고 있다.
           누가 이겼나  → 좌석 위 WIN 배지
           얼마를 땄나  → 승자에게 날아가는 칩 + 그 자리에서 오르는 스택
           판이 얼마였나 → 중앙 POT (이제 다음 판까지 남는다)
           다음 판까지  → 어차피 몇 초라 읽고 나면 이미 시작한다
         중앙은 커뮤니티 카드를 보는 자리인데, 매 판 끝마다 글자 줄이 나타났다 사라지면서
         시선을 그리로 당겼다. 이 자리는 오류 메시지에만 쓴다(act()가 직접 채운다). */
      msgEl.textContent = '';

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
        /* 두 소리를 같이 낸다. 칩이 밀려가는 소리는 "돈이 움직였다"는 촉감이고,
           팟 음악은 "이겼다"는 뜻이다 — 하나로 갈음하면 한쪽이 사라진다. */
        if (window.casinoSfx) {
          if (window.casinoSfx.chipWin) window.casinoSfx.chipWin();
          if (window.casinoSfx.potWin) window.casinoSfx.potWin();
        }
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
      playActionVoices(tb);
      renderControls();
    }

    /* ── 액션 음성 ────────────────────────────────────────────────────
       칩 소리와 별개다. 칩 소리는 "돈이 나갔다", 이건 "무슨 행동을 했다"를 알린다.
       그래서 체크처럼 칩이 안 나가는 행동도 소리가 나고, 콜은 둘 다 난다.
       (칩 소리를 이걸로 대체하면 안 된다 — 두 정보가 겹치지 않는다)

       같은 행동에 두 번 울리지 않게 (판·스트리트·자리·행동·금액)으로 열쇠를 만든다.
       금액까지 넣는 이유: 같은 자리가 한 스트리트에서 콜 → 레이즈 → 콜을 할 수 있고,
       그때 행동 이름만으로는 새 행동인지 구분되지 않는다.

       판에 처음 들어온 순간에는 울리지 않는다 — 이미 지나간 행동을 소급해서 떠들면
       무슨 일이 일어난 줄 알고 화면을 다시 보게 된다. */
    var voiceSeen = {}, voiceHand = null;
    /* 이 판에서 올인이 올려놓은 가장 높은 총액.
       올인 음악을 "판을 통째로 거는 순간"에만 깔기 위한 기준이다 —
       남이 올인한 뒤 그걸 콜했는데 마침 내 스택 전부였던 경우는 올인이 아니라 콜이다.
       그래서 총액이 이 값을 넘길 때만 음악을 깐다. 더 큰 금액으로 다시 올인하면
       상한 1인 셋이라 앞 음악이 끊기고 새로 시작한다.

       스트리트 베팅액(bet)이 아니라 판 총액(committed)으로 비교한다. 베팅액으로 보면
       "프리플랍 올인 500 → 플랍에서 300 올인"이 500 > 300이라 레이즈가 아닌 것처럼
       읽힌다(실제로는 총 800으로 올린 레이즈다). */
    var allinTop = 0;
    function playActionVoices(tb){
      if (tb.handNo !== voiceHand) { voiceHand = tb.handNo; voiceSeen = {}; allinTop = 0; }
      var sfx = window.casinoSfx;
      if (!sfx || !sfx.action) return;

      function fire(seat, act, amount, committed){
        if (!act) return;
        /* 폴드는 스트리트를 열쇠에 넣지 않는다 — 배지와 같은 이유다.
           서버가 폴드 표시를 스트리트 전환에도 남겨 두므로, 스트리트가 들어 있으면
           플랍에서 접은 사람의 폴드 소리가 턴·리버마다 다시 울렸다. */
        var key = act === 'fold'
          ? 'fold:' + seat
          : tb.street + ':' + seat + ':' + act + ':' + (amount || 0);
        if (voiceSeen[key]) return;
        voiceSeen[key] = 1;

        /* 올인 판정은 소리를 낼지와 별개로 항상 갱신한다 — 들어온 순간에 이미
           올인이 걸려 있었다면, 그 뒤에 콜하는 사람에게 음악이 깔리면 안 된다. */
        var raisedAllin = false;
        if (act === 'allin') {
          var total = committed || 0;
          if (total > allinTop) { allinTop = total; raisedAllin = true; }
        }

        if (firstTablePaint) return;                     // 들어온 순간의 과거 행동은 조용히 넘긴다
        // 음악은 내가 눌렀든 남이 눌렀든 깐다 — 판의 분위기이고, 목소리와 역할이 다르다
        if (raisedAllin && sfx.allinBgm) sfx.allinBgm();
        // 내가 방금 눌렀다면 클릭 순간에 이미 울렸다
        if (seat === tb.mySeat && (Date.now() - myVoiceAt) < 2500) return;
        sfx.action(act);
      }

      (tb.seats || []).forEach(function(s){ fire(s.seat, s.act, s.actAmount, s.committed); });
      /* 스트리트를 닫은 행동은 좌석 표시가 초기화되어 s.act에 안 남는다.
         칩 소리와 같은 이유로 여기서도 hand에 남은 기록을 따로 본다. */
      var la = tb.lastActor;
      if (la && la.seat != null) fire(la.seat, la.act, la.amount, la.committed);
    }

    /* 메인 팟 / 사이드 팟의 알약 줄(.ht-pots)은 없앴다.
       이제 층마다 칩 더미가 따로 서고 각 더미가 이름표와 금액을 직접 달고 있다 —
       같은 것을 두 곳에 적을 이유가 없다. 층 구성은 syncPotPile이 그린다. */

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

    /* ── 무엇으로 이겼나를 승자 좌석에 붙인다 ─────────────────────────
       족보명이 없으면 무엇으로 이겼는지 카드를 직접 읽어야 한다. 실제로 다른 클라이언트도
       이걸 안 보여줘서 "4초 안에 카드를 다 읽어야 한다"는 불만이 흔하다.

       한때는 펠트 한가운데 노란 캡슐 한 줄이었다. 정보는 맞았지만 자리가 틀렸다 —
       "누가"는 좌석에, "무엇으로"는 중앙에 있어서 눈이 두 번 움직였고, 무엇보다
       커뮤니티 카드를 보는 자리에 글자가 떴다. 이제 이긴 사람 위에 직접 붙인다. */
    function syncOutro(tb){
      var reveal = (tb.ended && boardRevealed && tb.result && tb.result.reveal) || [];
      var awards = (tb.ended && boardRevealed && tb.result && tb.result.awards) || [];
      /* 정산이 시작되면 showWinBadges가 층마다 주인이 된다 — 여기서 덮어쓰면
         층별 족보가 1초 폴링에 지워진다. */
      if (potPaidHand === tb.handNo) return;
      var wonSeats = {};
      awards.forEach(function(a){ if (a.amount > 0) wonSeats[a.seat] = 1; });
      (tb.seats || []).forEach(function(s){
        var hEl = seatsEl.querySelector('.ht-seat[data-seat="' + s.seat + '"] .ht-win-h');
        if (!hEl) return;
        var r = wonSeats[s.seat] ? reveal.filter(function(x){ return x.seat === s.seat; })[0] : null;
        hEl.textContent = r ? r.hand : '';
        hEl.hidden = !r;
      });
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
      /* 차례가 아직 열리지 않았으면 버튼을 켜지 않는다.
         "열렸는가"는 서버가 정한다(actOpenIn) — 커뮤니티 카드가 열리는 중이거나
         앞 사람 액션 직후의 최소 간격이다. 예전에는 클라이언트의 boardRevealed만 봤는데,
         그건 내 화면의 애니메이션일 뿐이어서 봇은 그대로 즉시 눌렀다.
         규칙이 서버에 있으니 여기서는 그 값을 그대로 따른다. */
      var la = st.table.legal;
      if (la && st.table.actOpenIn > 0) la = null;
      /* 자리 비움이면 이 줄은 통째로 [게임 복귀] 하나짜리가 된다.
         행동할 수 없는 상태이므로 la는 어차피 비어 있지만, 판이 끝난 뒤의 래빗·패 공개
         버튼은 자리를 비웠어도 뜰 수 있다 — 그것들과 나란히 서면 "지금 눌러야 할 것"이
         흐려지므로 복귀가 있을 때는 나머지를 다 내린다. 자리를 비운 사람이 할 일은 하나다. */
      var away = st.table.myPresence === 'SIT_OUT';
      backAct.hidden = !away;
      /* 판이 끝난 뒤의 두 버튼도 이 패널 안(ht-acts)에 있다. 그래서 내 차례가 아니라고
         패널 전체를 접으면 그 버튼이 뜨고 싶어도 보이지 않는다 — 실제로 그렇게 됐다.
         버튼이 하나라도 뜰 상황이면 패널은 열어두고, 베팅 금액 줄과 미리 지정 줄만 접는다. */
      var post = !away && (!rabbitBtn.hidden || !showBtn.hidden);
      if (away) { rabbitBtn.hidden = true; showBtn.hidden = true; rnoteEl.hidden = true; }
      ctrlEl.hidden = !la && !post && !away;
      ctopEl.hidden = !la || away;
      preEl.hidden = !la || away;
      if (!la || away) {
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
    // 내가 직접 눌러 액션 음성을 낸 시각 (폴링이 같은 소리를 또 내지 않게)
    var myVoiceAt = 0;
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
      /* 액션 음성은 칩과 별개로, 체크·폴드에도 낸다. 서버 응답을 기다리지 않고 클릭 순간에
         울려야 손맛이 난다 — 칩 소리와 같은 이유다.
         내 것을 여기서 울렸다고 폴링 쪽에 표시해 둔다(겹쳐 울리지 않게). */
      myVoiceAt = Date.now();
      if (window.casinoSfx && window.casinoSfx.action) window.casinoSfx.action(kind);
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
    backAct.addEventListener('click', sitIn);

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
      /* 차례가 아직 열리지 않았으면 보내지 않는다. 서버가 too_soon으로 거절하는데
         아래 코드는 보내기 전에 체크박스를 먼저 끄므로, 거절당하면 미리 지정한 액션이
         사라진 채로 제한 시간까지 흘러 자동 폴드된다. 다음 폴링에서 다시 본다. */
      if (st.table.actOpenIn > 0) return;
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
      lobbyRecEl.hidden = showTable || recEmpty;
      tableEl.hidden = !showTable;
      if (showTable) { renderTable(); updatePreLabels(); firstTablePaint = false; }
      else { renderLobby(); loadRecords(false); }
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
