/* 홀덤 프리롤 — DB 계층과 지연 진행(lazy advancement).
 *
 * 이 파일의 유일한 설계 원칙: 서버 타이머를 쓰지 않는다.
 * 요청이 들어올 때마다 "지금 시각 기준으로 밀린 일을 전부 처리"한다.
 * 이 서버는 접속이 없으면 약 7분 뒤 절전에 들어가므로 setTimeout으로 블라인드
 * 시계나 액션 마감을 걸면 잠든 사이에 죽는다. 기존 게임 다섯 개가 모두 이 방식이다.
 *
 * 밀린 일이 여러 개일 수 있는 게 홀덤의 특징이다. 아무도 화면을 안 보는 사이
 * 세 명의 액션 마감이 연달아 지났다면 한 요청에서 세 번의 자동 액션을 처리해야
 * 한다. 그래서 advanceTable은 루프다 — 블랙잭처럼 "한 단계 전진"으로는 안 된다.
 *
 * 카드 규칙은 services/holdem.ts, 일정·상금은 services/tournament.ts에 있다.
 * 여기서는 그 순수 함수들을 불러 쓰고 상태를 저장하는 일만 한다.
 */
import { randomInt } from 'node:crypto';
import { one, all, run, tx } from './queries';
import * as G from '../services/holdem';
import * as T from '../services/tournament';
import { getConfig } from './settings';

/** 액션 제한 시간. 스펙에 숫자가 없어 온라인 포커의 통상값(20초)으로 잡았다. */
export const ACTION_SEC = 20;
/* ── 최소 액션 간격 ────────────────────────────────────────────────────
   차례가 넘어와도 이 시간이 지나기 전에는 아무도 행동할 수 없다.

   왜 서버에 두는가: 봇(그리고 자동 체크·자동 콜)은 즉시 결정한다. 클라이언트에서만
   버튼을 잠가도 서버는 액션을 받으므로, 실제로는 "레이즈 → 폴드 → 폴드"가 0.1초 안에
   처리되고 화면은 그 셋을 한 프레임에 몰아 보여준다. 누가 무엇을 했는지 따라갈 수 없다.
   규칙 자체에 간격이 있어야 화면이 따라갈 수 있다.

   스트리트가 열릴 때는 더 길게 준다 — 커뮤니티 카드가 다 열리는 데 클라이언트가
   약 2.1초를 쓴다(ACTION_HOLD 1.1 + 첫 장 0.42 + 두 장 0.6). 그 뒤에 한 박자 쉬고
   첫 행동자가 열리게 3초로 둔다. 보드를 보기도 전에 베팅이 시작되면 안 된다.

   구현: 새 컬럼을 두지 않고 action_deadline을 그만큼 뒤로 민다.
   열리는 시각 = action_deadline - ACTION_SEC 이 항상 성립한다(간격이 0이면 즉시 열린다). */
export const ACT_GAP_SEC = 1;
export const STREET_OPEN_SEC = 3;
/* eslint 없이도 읽히게: 두 값의 관계가 규칙이다 — 스트리트 시작이 더 길다 */
/** 이 차례가 열리는 시각. 마감에서 제한 시간을 되돌리면 나온다. */
export function actOpenAt(hand: { action_deadline: number | null }): number | null {
  return hand.action_deadline == null ? null : hand.action_deadline - ACTION_SEC;
}
/* ── 다음 판이 시작되는 시각 ──────────────────────────────────────────
   이 게임에는 서버 타이머가 없다. 판이 끝나면 "다음 판은 이 시각 이후"만 적어 두고
   (next_hand_at) 실제 진행은 요청이 올 때 일어난다. 그래서 이 값이 곧 화면 연출의
   길이여야 한다 — 짧으면 연출 중에 판이 넘어가고, 길면 끝난 화면을 보고 앉아 있는다.

   화면(web/games/holdem.ts)이 재생하는 순서를 그대로 더한다:

     [카드]  첫 핸드까지 1.10초 + 사람당 0.50초
             남은 보드 — 마지막 핸드가 열린 시점부터
               리버까지 깔림  0
               턴까지 깔림    5.56초  2.5(핸드→보드) + 0.56(첫 장) + 2.5(스퀴즈)
               플랍까지 깔림  8.56초  위 + 3.0(턴 → 리버)
               그 이전       12.02초  2.5 + 0.56 + 0.33 + 0.33 + 2.8 + 3.0 + 2.5

     [정산]  결과 지연 1.50 + 팟 지연 0.55 + 배지 대기 2.50 + 칩 이동 1.80 = 6.35초
             ← 여기까지가 "마지막 칩이 승자 안으로 사라지는" 시점

     [여유]  1.25초 — 승자 스택이 오른 것을 확인하는 시간

   ── 왜 한 번에 반올림하나
   한때 [정산]과 [카드]를 각각 정수 초로 만들어 더했다. 반올림이 두 번 일어나면서
   오차가 최대 1초까지 쌓였고, 실측 간격이 1.5~2.05초로 벌어졌다.
   합을 구하고 마지막에 한 번만 반올림하면 ±0.5초 안에 들어온다.

   ── 왜 폴링 몫을 안 더하나
   예전에는 여기에 "폴링 1초"를 얹었다. 다음 판을 1초 간격 폴링이 발견할 때까지
   기다린다는 전제였는데, 지금은 화면이 그 시각에 직접 폴을 한 번 쏜다
   (holdem.ts의 nextHandPoke). 그 몫을 여기서 또 세면 이중이다. */
const SETTLE_TAIL_SEC = 6.35;   // 카드가 다 열린 뒤 마지막 칩이 흡수될 때까지
const NEXT_HAND_GAP_SEC = 1.25; // 흡수 → 다음 판
/* 사이드 팟 한 층을 더 보여주는 데 드는 시간.
   층마다 [WIN 배지 → 1.0초 대기 → 칩 이동 1.8초 → 더미 시차]를 재생한다. */
const SIDE_POT_STEP_SEC = 2.9;

/** 카드를 다 여는 데 드는 시간(초, 실수). 화면의 박자를 그대로 옮긴 것이다. */
export function revealSec(boardAtEnd: number, liveCount = 2): number {
  const holes = 1.1 + Math.max(0, liveCount - 1) * 0.5;
  const board = boardAtEnd >= 5 ? 0
    : boardAtEnd === 4 ? 5.56
    : boardAtEnd === 3 ? 8.56
    : 12.02;
  return holes + board;
}

/** 판이 끝난 시점부터 다음 판이 시작되기까지 (초, 정수). */
export function nextHandDelaySec(o: {
  showdown: boolean; boardAtEnd: number; liveCount: number; extraPots: number;
}): number {
  const reveal = o.showdown && o.liveCount > 1 ? revealSec(o.boardAtEnd, o.liveCount) : 0;
  const sides = Math.max(0, o.extraPots) * SIDE_POT_STEP_SEC;
  return Math.round(reveal + SETTLE_TAIL_SEC + sides + NEXT_HAND_GAP_SEC);
}
/** 한 요청에서 처리할 진행 단계의 상한 — 무한 루프 방지용 안전장치 */
const MAX_STEPS = 200;

export type Presence = 'ACTIVE' | 'SIT_OUT' | 'DISCONNECTED' | 'OUT';

export interface HtRow {
  id: number; date_str: string; title: string;
  reg_open_at: number; scheduled_start_at: number; grace_ends_at: number;
  prize_multiplier: number;
  started_at: number | null; finished_at: number | null; cancelled_at: number | null;
  starting_stack: number; level_sec: number; late_reg_sec: number;
  prize_fixed: number;
}
export interface HtTableRow {
  id: number; tournament_id: number; table_no: number;
  button_seat: number; hand_no: number; next_hand_at: number | null;
}
export interface HtSeatRow {
  id: number; table_id: number; seat: number; user_id: string; username: string;
  stack: number; presence: Presence; last_seen_at: number;
}
export interface HtHandRow {
  id: number; table_id: number; hand_no: number;
  level: number; sb: number; bb: number; ante: number; button_seat: number;
  deck_json: string; deck_pos: number; board_json: string;
  street: G.Street; to_act_seat: number | null; action_deadline: number | null;
  last_raise_size: number; ended_at: number | null; result_json: string | null;
  started_at: number;
  last_actor_seat: number | null; last_actor_action: string | null; last_actor_amount: number;
}
export interface HtHandSeatRow {
  id: number; hand_id: number; seat: number; user_id: string;
  hole_json: string; stack: number; bet: number; committed: number;
  state: G.SeatState; acted: number; won: number;
  last_action: string | null; last_amount: number; shown: number;
}
export interface HtEntryRow {
  id: number; tournament_id: number; user_id: string; username: string;
  registered_at: number; finish_place: number | null; elim_seq: number | null;
  eliminated_at: number | null; prize: number;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/* ── 조회 ─────────────────────────────────────────────────────────── */

function todaySchedule(now: number, cfg = getConfig()): T.TournamentSchedule {
  return T.scheduleForDate(T.kstDateStr(now * 1000), {
    regOpenMin: cfg.regOpenMin, startMin: cfg.startMin, graceSec: cfg.graceMin * 60,
    weekdayMultiplier: cfg.weekdayMultiplier, weekendMultiplier: cfg.weekendMultiplier,
  });
}

/* 이미 만들어진 토너먼트의 일정은 저장된 값을 쓴다.
   매번 날짜에서 다시 계산하면 저장한 컬럼이 죽은 데이터가 되고, 특정 판의 시각을
   손볼 방법이 사라진다(감사에서 시각을 당겨 단계를 넘기는 것도 불가능해진다).
   행을 만들 때 계산값을 넣으므로 평소에는 두 값이 같다. */
function scheduleOf(t: HtRow): T.TournamentSchedule {
  const noon = T.kstTimeToUnix(t.date_str, 12, 0);
  return {
    dateStr: t.date_str,
    regOpenAt: t.reg_open_at,
    scheduledStartAt: t.scheduled_start_at,
    graceEndsAt: t.grace_ends_at,
    weekend: T.isKstWeekend(noon * 1000),
    prizeMultiplier: t.prize_multiplier,
    title: t.title,
  };
}

/**
 * 살아 있는 판. 아직 끝나지도 취소되지도 않은 것 — 시작 전(대기)도 포함한다.
 *
 * 하루에 여러 판을 열 수 있게 되면서 유니크 인덱스가 사라졌다. 대신 지켜야 할 규칙이
 * 이것 하나 남는다: 살아 있는 판은 한 번에 하나뿐이다. 둘이 동시에 살아 있으면
 * "지금 어느 판인가"가 사라지고, 등록이 어느 쪽으로 가는지도 알 수 없게 된다.
 *
 * 인덱스로는 표현할 수 없다 — 부분 유니크를 걸려면 조건이 NULL 세 개에 걸리고,
 * SQLite 의 부분 인덱스로는 "여럿 중 하나만"을 못 만든다. 그래서 질의가 지킨다.
 */
export function liveTournament(): HtRow | undefined {
  return one<HtRow>(
    `SELECT * FROM holdem_tournaments
      WHERE finished_at IS NULL AND cancelled_at IS NULL
      ORDER BY id DESC LIMIT 1`);
}

/**
 * 그 날짜의 판. 여러 개일 수 있다(운영자가 임시 판을 열 수 있으므로).
 *
 * 고르는 순서가 중요하다: 아직 살아 있는 판을 먼저 고르고, 그 다음이 최근 것이다.
 * "최근 것"만 보면 임시 판이 끝나는 순간 그 판이 계속 골라져서, 같은 날 대기 중이던
 * 정규 판이 영영 열리지 않는다. 살아 있는 쪽을 먼저 보면 임시 판이 끝난 뒤 정규 판으로
 * 저절로 돌아온다 — 그래서 임시 판을 돌리려고 정규 판을 지울 필요가 없다.
 *
 * 살아 있는 판이 없으면 최근 것을 준다. 그래야 오늘 판이 끝난 뒤에 자동 생성이
 * "오늘 판이 없다"고 보고 새로 만들어 버리는 일이 없다.
 */
function findTournament(dateStr: string): HtRow | undefined {
  return one<HtRow>(
    `SELECT * FROM holdem_tournaments WHERE date_str = ?
      ORDER BY (finished_at IS NULL AND cancelled_at IS NULL) DESC, id DESC LIMIT 1`, dateStr);
}

export function getTable(tournamentId: number): HtTableRow | undefined {
  return one<HtTableRow>(`SELECT * FROM holdem_tables WHERE tournament_id = ? AND table_no = 0`, tournamentId);
}

export function getSeats(tableId: number): HtSeatRow[] {
  return all<HtSeatRow>(`SELECT * FROM holdem_seats WHERE table_id = ? ORDER BY seat ASC`, tableId);
}

/* 최근에 끝난 대회의 우승자. 로비의 "최근 소식"이 쓴다 —
   소규모 커뮤니티에서 다시 들어오는 이유는 "내가 없는 동안 무슨 일이 있었나"다.
   진행 중인 대회는 제외한다(결과가 아직 없다). */
export function recentHoldemWinners(limit = 2): {
  dateStr: string; title: string; username: string; prize: number; players: number;
}[] {
  return all<{ dateStr: string; title: string; username: string; prize: number; players: number }>(
    `SELECT t.date_str AS dateStr, t.title AS title, e.username AS username, e.prize AS prize,
            (SELECT COUNT(*) FROM holdem_entries x WHERE x.tournament_id = t.id) AS players
       FROM holdem_tournaments t
       JOIN holdem_entries e ON e.tournament_id = t.id AND e.finish_place = 1
      WHERE t.finished_at IS NOT NULL
      ORDER BY t.finished_at DESC
      LIMIT ?`, limit);
}

/* ── 역대 프리롤 전적 ──────────────────────────────────────────────────
   지표를 게임별 랭킹(판수·승률·수익액)과 다르게 잡는다. 프리롤은 참가비가 0이라
   상금만 양수로 들어오므로 "수익액"이 실력과 무관하게 참가 횟수만큼 오른다 —
   그래서 게임 랭킹에서 홀덤을 뺐고, 여기서도 같은 함정을 반복하지 않는다.

   대신 대회에서 실제로 의미가 있는 것을 센다: 우승·입상·참가·누적 상금.

   줄 세우는 기준은 누적 상금 하나다 — "지금까지 쭉 얼마를 먹었나". 우승 횟수로도
   정렬할 수 있게 만들어 봤지만 표가 둘로 갈리기만 하고 알고 싶은 것은 하나였다.
   우승 횟수는 줄 안에 같이 적어 둔다.

   끝난 대회만 센다(finished_at). 진행 중인 대회는 등수가 아직 없다.
   새 테이블이 필요 없다 — holdem_entries에 finish_place와 prize가 이미 쌓여 있다. */
export interface HoldemRecordRow {
  userId: string; username: string;
  played: number; wins: number; itm: number; prize: number;
}
export function holdemRecords(limit = 20): HoldemRecordRow[] {
  return all<HoldemRecordRow>(
    `SELECT e.user_id AS userId,
            MAX(e.username) AS username,
            COUNT(*) AS played,
            SUM(CASE WHEN e.finish_place = 1 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN e.prize > 0 THEN 1 ELSE 0 END) AS itm,
            SUM(e.prize) AS prize
       FROM holdem_entries e
       JOIN holdem_tournaments t ON t.id = e.tournament_id
      WHERE t.finished_at IS NOT NULL AND e.finish_place IS NOT NULL
      GROUP BY e.user_id
      ORDER BY prize DESC, wins DESC, played DESC
      LIMIT ?`, limit);
}

export function getEntries(tournamentId: number): HtEntryRow[] {
  return all<HtEntryRow>(
    `SELECT * FROM holdem_entries WHERE tournament_id = ? ORDER BY registered_at ASC`, tournamentId);
}

export function getCurrentHand(tableId: number): HtHandRow | undefined {
  return one<HtHandRow>(`SELECT * FROM holdem_hands WHERE table_id = ? ORDER BY hand_no DESC LIMIT 1`, tableId);
}

export function getHandSeats(handId: number): HtHandSeatRow[] {
  return all<HtHandSeatRow>(`SELECT * FROM holdem_hand_seats WHERE hand_id = ? ORDER BY seat ASC`, handId);
}

/**
 * 래빗 헌트 — 폴드로 일찍 끝난 판에서 "깔렸을 카드"를 보여준다.
 *
 * 반드시 핸드가 끝난 뒤에만 부른다. 진행 중에 이걸 내려보내면 남은 카드가 새어
 * 이후 모든 판이 무의미해진다 — 그래서 호출부가 아니라 여기서 직접 막는다.
 * 실제로 깔린 보드는 그대로 두고, 그 뒤에 올 카드만 돌려준다(버닝 카드 규칙까지 그대로).
 */
export function rabbitBoard(hand: HtHandRow): string[] {
  if (hand.ended_at == null) return [];
  const board = JSON.parse(hand.board_json) as number[];
  if (board.length >= 5) return [];          // 이미 다 깔렸다 — 볼 게 없다
  const deck = JSON.parse(hand.deck_json) as number[];
  let pos = hand.deck_pos;
  const rest: number[] = [];
  /* 플랍 전이면 버닝 한 장 + 세 장, 그 뒤로는 스트리트마다 버닝 한 장 + 한 장.
     실제 딜링과 같은 순서로 뽑아야 "그때 나왔을 카드"가 된다. */
  if (board.length === 0) { pos++; for (let i = 0; i < 3 && pos < deck.length; i++) rest.push(deck[pos++]); }
  while (board.length + rest.length < 5 && pos + 1 < deck.length) { pos++; rest.push(deck[pos++]); }
  return G.cardsToStrings(rest);
}

/**
 * 끝난 판에서 내 패를 자발적으로 공개한다 (머킹된 패를 굳이 보여주는 실제 관례).
 *
 * 진행 중에는 절대 허용하지 않는다 — 아직 결과가 안 나온 판에서 자기 패를 흘리면
 * 남은 사람에게 정보를 주는 것이고, 담합의 통로가 된다. 조건을 `WHERE`에 박아
 * 판이 끝났고(ended_at) 내가 그 판에 있었을 때만 한 행이 바뀌게 한다.
 * 이미 쇼다운에 공개된 패라면 굳이 막지 않는다(멱등하다).
 */
export function showHoldemCards(userId: string): { ok: boolean } {
  const t = one<HtRow>(`SELECT * FROM holdem_tournaments
      WHERE started_at IS NOT NULL AND finished_at IS NULL AND cancelled_at IS NULL
      ORDER BY id DESC LIMIT 1`);
  if (!t) return { ok: false };
  const table = getTable(t.id);
  if (!table) return { ok: false };
  /* "가장 최근 판이면서 끝난 판"만 고른다. `ended_at IS NOT NULL`을 안쪽 조회에 걸면
     새 판이 도는 중에도 지난 판을 여는 요청이 통과한다 — 정보가 새지는 않지만
     화면(현재 판만 그린다)과 서버가 어긋난다. 하위 조회는 최신 판만 집고,
     끝났는지는 밖에서 본다. */
  run(`UPDATE holdem_hand_seats SET shown = 1
       WHERE user_id = ? AND hand_id = (
         SELECT id FROM holdem_hands
         WHERE table_id = ? AND ended_at IS NOT NULL
         ORDER BY hand_no DESC LIMIT 1)
         AND hand_id = (
         SELECT id FROM holdem_hands
         WHERE table_id = ? ORDER BY hand_no DESC LIMIT 1)`,
    userId, table.id, table.id);
  return { ok: one<{ n: number }>(`SELECT changes() AS n`)!.n > 0 };
}

/* 등록자들의 디스코드 아바타 — 해시가 아니라 완성된 이미지 URL이다.
   users.avatar 에는 로그인할 때(web/auth.ts) CDN 주소를 통째로 만들어 넣는다.
   "해시"라고 적어 뒀던 이 주석 때문에 홀덤 화면이 값을 해시로 알고 주소를 한 번 더
   조립했고, 프로필이 전부 깨져 보였다. 주석이 틀리면 코드도 따라 틀린다. */
export function getEntryAvatars(tournamentId: number): Map<string, string | null> {
  const rows = all<{ user_id: string; avatar: string | null }>(
    `SELECT e.user_id, u.avatar FROM holdem_entries e JOIN users u ON u.id = e.user_id
     WHERE e.tournament_id = ?`, tournamentId);
  return new Map(rows.map(r => [r.user_id, r.avatar]));
}

/** 자리에 앉은 사람들의 디스코드 아바타 URL (화면에 원형 프로필로 쓴다) */
export function getSeatAvatars(tableId: number): Map<string, string | null> {
  const rows = all<{ user_id: string; avatar: string | null }>(
    `SELECT s.user_id, u.avatar FROM holdem_seats s JOIN users u ON u.id = s.user_id
     WHERE s.table_id = ?`, tableId);
  return new Map(rows.map(r => [r.user_id, r.avatar]));
}

/** 남아 있는(탈락하지 않은) 좌석 */
function livingSeats(tableId: number): HtSeatRow[] {
  return getSeats(tableId).filter(s => s.presence !== 'OUT');
}

/** DB 행 → 순수 엔진이 쓰는 형태 */
function toViews(rows: HtHandSeatRow[]): G.SeatView[] {
  return rows.map(r => ({
    seat: r.seat, bet: r.bet, stack: r.stack, committed: r.committed,
    state: r.state, acted: r.acted === 1,
  }));
}

/**
 * 마지막 행동을 기록한다. 화면에 "콜 300"처럼 띄우는 용도다.
 *
 * 두 곳에 쓴다.
 *  · 좌석 행 — 이 스트리트에서 그 사람이 뭘 했는지. 스트리트가 넘어가면 초기화된다.
 *  · 핸드 행 — 이 핸드에서 가장 마지막 행동. 초기화되지 않는다.
 * 두 번째가 필요한 이유: 스트리트를 닫는 행동은 nextStreet가 같은 트랜잭션에서
 * 좌석 표시를 지워버리기 때문에, 1초 폴링으로는 그 행동이 클라이언트에 한 번도
 * 도달하지 않는다. 그래서 "누가 마지막에 뭘 했나"를 핸드 쪽에 따로 남긴다.
 */
function noteAction(handId: number, seat: number, kind: G.ActionKind, paid: number): void {
  run(`UPDATE holdem_hand_seats SET last_action = ?, last_amount = ?
       WHERE hand_id = ? AND seat = ?`, kind, paid, handId, seat);
  run(`UPDATE holdem_hands SET last_actor_seat = ?, last_actor_action = ?, last_actor_amount = ?
       WHERE id = ?`, seat, kind, paid, handId);
}

function saveViews(handId: number, views: G.SeatView[]): void {
  for (const v of views) {
    run(`UPDATE holdem_hand_seats SET stack = ?, bet = ?, committed = ?, state = ?, acted = ?
         WHERE hand_id = ? AND seat = ?`,
      v.stack, v.bet, v.committed, v.state, v.acted ? 1 : 0, handId, v.seat);
  }
}

/* ── 토너먼트 상태 ─────────────────────────────────────────────────── */

export interface HoldemStatus {
  tournament: HtRow;
  schedule: T.TournamentSchedule;
  status: T.TournamentStatus;
  registered: number;
  seated: number;
}

/** 오늘 토너먼트 행을 확보한다(없으면 만든다). */
function ensureTournament(now: number): HtRow {
  /* 대회를 만드는 이 순간의 설정을 행에 박는다. 진행 중인 대회를 보호하는 장치가
     바로 이것이다 — 운영자가 나중에 값을 바꿔도 이미 만들어진 행은 안 흔들린다. */
  const cfg = getConfig();
  const s = todaySchedule(now, cfg);
  /* 오늘 판이 이미 있으면 그것을 쓴다 — 끝났든 취소됐든 마찬가지다.
     여기서 상태를 따지면 오늘 판이 끝나는 순간 새 판이 저절로 열려서, 대회가 끝나자마자
     다음 등록이 시작된다. 하루 여러 판은 운영자가 여는 것이지 저절로 열리는 게 아니다.
     (여러 개 있으면 findTournament 가 가장 최근 것을 준다.) */
  const found = findTournament(s.dateStr);
  if (found) return found;
  /* 어제 판이 아직 도는 중이어도 오늘 행은 만든다. activeTournament 가 "오늘 등록이
     열리기 전까지는 어제 판을 쓴다"로 판단하고, 열리는 순간 어제 판을 버린다 —
     그 판단이 성립하려면 오늘 행의 reg_open_at 이 있어야 한다.
     여기서 만들기를 막았더니 그 자정 방어가 통째로 죽었다(감사 [6b]가 잡았다). */
  try {
    run(`INSERT INTO holdem_tournaments
           (date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier,
            starting_stack, level_sec, late_reg_sec, prize_fixed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.dateStr, s.title, s.regOpenAt, s.scheduledStartAt, s.graceEndsAt, s.prizeMultiplier,
      cfg.startingStack, cfg.levelMin * 60, cfg.lateRegMin * 60, cfg.prizeFixed);
  } catch { /* 경합 — 아래에서 다시 읽는다 */ }
  return findTournament(s.dateStr)!;
}

/**
 * 지금 다뤄야 할 토너먼트.
 *
 * 진행 중인 판이 있으면 날짜와 무관하게 그것을 계속 쓴다.
 * 22:00에 시작한 판이 자정을 넘기면(레이트 레그가 붙거나 판이 길어지면 실제로 넘어간다)
 * 날짜가 바뀌는 순간 "오늘 판"이 새로 생기고, 진행 중이던 테이블은 화면에서 사라진다 —
 * 플레이 중에 로비로 튕긴다. 실제로 자정을 넘기며 이 일이 일어나는 것을 확인했다.
 *
 * 여기서 다루는 것은 "인원 미달"과 다른 상황이다.
 *   · 3명이 안 차서 시작조차 못 한 판 → 23:00에 CANCELLED (statusAt이 판정한다)
 *   · 이미 시작해 카드까지 돌린 판 → 시작한 뒤에는 23:00 규칙이 적용되지 않는다.
 *     아무도 안 보는 사이 얼어붙어 있을 수 있고, 그 판을 계속 붙들면 다음 날 로비를 연
 *     사람이 어제의 시체를 보게 된다.
 *
 * 그래서 버리는 기준을 "다음 판 등록이 열리는 순간"으로 잡는다. 임의의 시간(6시간 등)을
 * 두는 것보다 정확하다 — 충돌이 생길 수 있는 시점이 정확히 그 순간이기 때문이다.
 * 그 전까지는(자정을 넘겨도) 진행 중인 판이 우선이다.
 */
function activeTournament(now: number): HtRow {
  const running = one<HtRow>(
    `SELECT * FROM holdem_tournaments
      WHERE started_at IS NOT NULL AND finished_at IS NULL AND cancelled_at IS NULL
      ORDER BY id DESC LIMIT 1`);
  const today = ensureTournament(now);
  if (!running || running.id === today.id) return today;
  // 오늘 등록이 아직 열리지 않았다면 어제 판이 진행 중이어도 문제될 게 없다.
  // 판단 기준은 저장된 값이다 — 매번 날짜에서 다시 계산하면 감사가 시각을 조절할 수 없다.
  if (now < today.reg_open_at) return running;
  run(`UPDATE holdem_tournaments SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL`,
    now, running.id);
  return today;
}

/* 대회 행에 박아 둔 운영 설정. 0 이면 '코드 기본값을 쓴다'는 뜻이다 —
   설정 기능이 없던 시절에 만들어진 행도 예전과 똑같이 동작해야 한다. */
export function tuning(t: HtRow) {
  return {
    startingStack: t.starting_stack > 0 ? t.starting_stack : T.STARTING_STACK,
    levelSec: t.level_sec > 0 ? t.level_sec : T.LEVEL_DURATION_SEC,
    lateRegSec: t.late_reg_sec > 0 ? t.late_reg_sec : T.LATE_REG_SEC,
    prizeFixed: t.prize_fixed > 0 ? t.prize_fixed : 0,
  };
}

function facts(t: HtRow): T.TournamentFacts {
  return { startedAt: t.started_at, finishedAt: t.finished_at, cancelledAt: t.cancelled_at };
}

/**
 * 이 사람이 앉아 있던 판. 방금 끝난 판을 화면에 붙들어 두기 위한 조회다.
 *
 * activeTournament 는 "지금 몇 시인가"에서 판을 유도한다. 그 방식은 판이 끝나는 순간
 * 무너진다 — 위의 자정 방어는 `finished_at IS NULL` 이 조건이라 종료와 동시에 풀리고,
 * 자정을 넘겨 끝난 판은 그 순간 "오늘 판"이 다음 날 판으로 바뀌어 버린다. 그러면
 * 우승 화면을 띄울 유예(FINISH_LINGER_SEC)가 아예 적용되지 않아, 이긴 사람이 결과를
 * 못 보고 로비로 튕긴다. 실제로 그랬다 — 2026-08-06 판이 23:49 에 시작해
 * 다음 날 01:13 에 끝나면서 이 일이 일어났다.
 *
 * 그래서 "무엇을 보여줄지"는 시계에서 떼어 낸다. 사람이 앉은 자리가 근거다 —
 * 자정이든 다음 판이 생겼든 상관이 없어진다. 시계는 "이제 등록할 수 있는 판"에만 쓴다.
 *
 * 유예 시간으로 창을 닫는다. 안 닫으면 어제 판에 앉았던 사람이 다음 날에도 그 시체를
 * 계속 보게 된다.
 */
function seatedTournament(userId: string, now: number): HtRow | undefined {
  return one<HtRow>(
    `SELECT t.* FROM holdem_tournaments t
       JOIN holdem_tables tb ON tb.tournament_id = t.id
       JOIN holdem_seats s   ON s.table_id = tb.id
      WHERE s.user_id = ? AND t.cancelled_at IS NULL
        AND t.finished_at IS NOT NULL AND t.finished_at > ?
      ORDER BY t.finished_at DESC LIMIT 1`,
    userId, now - T.FINISH_LINGER_SEC);
}

/* ── 진행 ─────────────────────────────────────────────────────────── */

/**
 * 오늘 토너먼트를 "지금" 기준으로 최신 상태로 만든다. 모든 요청의 첫 줄에서 부른다.
 * 여기서 하는 일: 시작 판정 → 취소 판정 → 진행 중이면 테이블 전진 → 종료 판정.
 */
export function advanceHoldem(userId?: string): HoldemStatus {
  return tx(() => {
    const now = nowSec();
    /* 방금 끝난 판에 앉아 있던 사람에게는 그 판을 돌려준다 — seatedTournament 를 보라.
       전진시킬 것은 없다(끝난 판이다). 여기서 바로 돌아가는 이유는 아래에서
       activeTournament 가 "오늘 판"으로 갈아치우는 것을 막기 위해서다.
       userId 가 없는 호출(로비)은 예전과 똑같이 시계에서 유도한다. */
    if (userId != null) {
      const mine = seatedTournament(userId, now);
      if (mine != null) {
        const ms = scheduleOf(mine);
        return {
          tournament: mine,
          schedule: ms,
          status: T.statusAt(now, ms, facts(mine), getEntries(mine.id).length),
          registered: getEntries(mine.id).length,
          seated: 0,   // 끝난 판이라 살아 있는 자리가 없다 — 화면은 shownSeats로 그린다
        };
      }
    }
    let t = activeTournament(now);
    const s = scheduleOf(t);
    let regs = getEntries(t.id);

    // 시작: 예정 시각이 지났고 최소 인원이 찼는데 아직 시작 기록이 없다
    if (t.started_at == null && t.cancelled_at == null && now >= s.scheduledStartAt
        && regs.length >= T.MIN_PLAYERS) {
      startTournament(t, regs, now);
      t = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
    }

    // 취소: 대기 시간까지 인원이 안 찼다
    if (t.started_at == null && t.cancelled_at == null && now >= s.graceEndsAt
        && regs.length < T.MIN_PLAYERS) {
      run(`UPDATE holdem_tournaments SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL`, now, t.id);
      t = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
    }

    // 진행 중이면 테이블을 전진시킨다
    if (t.started_at != null && t.finished_at == null && t.cancelled_at == null) {
      const table = getTable(t.id);
      if (table) advanceTable(t, table, now);
      t = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
    }

    regs = getEntries(t.id);
    const table = getTable(t.id);
    return {
      tournament: t,
      schedule: s,
      status: T.statusAt(now, s, facts(t), regs.length),
      registered: regs.length,
      seated: table ? livingSeats(table.id).length : 0,
    };
  });
}

/** 토너먼트 시작 — 테이블을 만들고 등록자를 앉힌 뒤 첫 핸드를 돌린다. */
function startTournament(t: HtRow, regs: HtEntryRow[], now: number): void {
  run(`UPDATE holdem_tournaments SET started_at = ? WHERE id = ? AND started_at IS NULL`, now, t.id);
  // 경합으로 이미 다른 요청이 시작시켰다면 여기서 멈춘다
  const fresh = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
  if (fresh.started_at !== now) return;

  run(`INSERT INTO holdem_tables (tournament_id, table_no, button_seat, hand_no) VALUES (?, 0, 0, 0)`, t.id);
  const tableId = one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;

  /* 자리 배치는 등록 순서를 섞어서 정한다 — 등록 순서대로 앉히면
     먼저 등록한 사람이 항상 버튼 근처에 앉아 첫 판부터 위치 이득을 본다. */
  const order = regs.map(r => r);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }
  order.forEach((r, seat) => {
    run(`INSERT INTO holdem_seats (table_id, seat, user_id, username, stack, presence, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      tableId, seat, r.user_id, r.username, tuning(t).startingStack, now);
  });

  const table = one<HtTableRow>(`SELECT * FROM holdem_tables WHERE id = ?`, tableId)!;
  startHand(t, table, now);
}

/**
 * 진행 중인 대회를 "방금 시작한 상태"로 되돌린다. 관리자용이다.
 *
 * 앉아 있는 사람은 그대로 두고 전원 시작 스택으로, 블라인드는 1레벨로,
 * 판 번호는 0으로 돌린 뒤 첫 판을 새로 돌린다.
 *
 * 왜 필요한가: 서버가 죽거나 심하게 느려서 판이 제대로 진행되지 못한 대회를
 * 그대로 두면 칩만 엉킨 채 남는다. 취소하고 새로 열면 그날 대회가 사라지고
 * 모인 사람이 흩어진다 — 사람은 그대로 두고 판만 되감는 쪽이 낫다.
 *
 * 블라인드 레벨은 저장된 값이 아니라 started_at 으로부터 흐른 시간으로 계산된다
 * (levelAt). 그래서 started_at 을 지금으로 옮기는 것이 곧 1레벨로 되돌리는 것이다.
 *
 * 이 함수는 앱 자신의 DB 연결로 돈다. 예전에 같은 일을 외부 프로세스로 sqlite 파일을
 * 열어서 처리했다가 쓰기 락이 남아 서버가 통째로 멎었다 — 그래서 앱 안에 둔다.
 */
export function adminResetRunningTournament(): {
  ok: boolean; reason?: string; tournamentId?: number; seats?: number;
} {
  const now = nowSec();
  const t = one<HtRow>(
    `SELECT * FROM holdem_tournaments
      WHERE started_at IS NOT NULL AND finished_at IS NULL AND cancelled_at IS NULL
      ORDER BY id DESC LIMIT 1`);
  if (!t) return { ok: false, reason: 'no_running_tournament' };
  const table = one<HtTableRow>(`SELECT * FROM holdem_tables WHERE tournament_id = ?`, t.id);
  if (!table) return { ok: false, reason: 'no_table' };

  /* 진행 중이던 판을 통째로 버린다. hand_seats 를 먼저 지운다 — 핸드가 먼저 사라지면
     어느 핸드에 딸린 줄인지 알 수 없어 고아 행이 남는다. */
  run(`DELETE FROM holdem_hand_seats WHERE hand_id IN
         (SELECT id FROM holdem_hands WHERE table_id = ?)`, table.id);
  run(`DELETE FROM holdem_hands WHERE table_id = ?`, table.id);

  // 앉아 있는 사람은 그대로. 스택만 되돌리고 탈락 표시를 푼다
  run(`UPDATE holdem_seats SET stack = ?, presence = 'ACTIVE', last_seen_at = ?
        WHERE table_id = ?`, tuning(t).startingStack, now, table.id);
  run(`UPDATE holdem_entries SET finish_place = NULL, elim_seq = NULL,
         eliminated_at = NULL, prize = 0 WHERE tournament_id = ?`, t.id);

  // 블라인드 1레벨 = 시작 시각을 지금으로
  run(`UPDATE holdem_tournaments SET started_at = ?, finished_at = NULL, cancelled_at = NULL
        WHERE id = ?`, now, t.id);
  run(`UPDATE holdem_tables SET hand_no = 0, button_seat = 0, next_hand_at = NULL
        WHERE id = ?`, table.id);

  const fresh = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
  const tb = one<HtTableRow>(`SELECT * FROM holdem_tables WHERE id = ?`, table.id)!;
  startHand(fresh, tb, now);

  const seats = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM holdem_seats WHERE table_id = ?`, table.id)!.c;
  return { ok: true, tournamentId: t.id, seats };
}

/**
 * 테이블을 전진시킨다. 밀린 일을 다 처리할 때까지 도는 루프다.
 *
 * 한 바퀴에서 하는 일 중 하나:
 *  · 다음 핸드를 시작한다 (쇼다운 시간이 끝났다)
 *  · 액션 마감이 지난 사람을 자동 처리한다 (체크 가능하면 체크, 아니면 폴드)
 *  · 베팅 라운드가 끝났으면 다음 스트리트로 넘기거나 쇼다운한다
 *  · 더 할 일이 없으면 빠져나온다
 */
function advanceTable(t: HtRow, table: HtTableRow, now: number): void {
  /* 베팅이 완전히 끝난 순간의 보드 장수.
     쇼다운 승률은 "결과가 남은 카드에만 달린" 시점의 보드로 계산해야 한다.
     그 값을 endHand에서 읽으면 이미 늦다 — 전원 올인이면 아래 루프가 nextStreet를
     연달아 불러 보드를 리버까지 채우고 나서 endHand에 닿기 때문에, endHand가 보는
     보드는 언제나 5장이다(실제로 승률이 한 번도 담기지 않았던 이유다).
     그래서 "더 이상 베팅이 있을 수 없다"를 처음 확인한 그 자리에서 기억해 둔다. */
  let lockedBoardLen: number | null = null;
  for (let step = 0; step < MAX_STEPS; step++) {
    const living = livingSeats(table.id);

    // 한 명만 남았으면 토너먼트 종료
    if (living.length <= 1) { finishTournament(t, table, now); return; }

    let hand = getCurrentHand(table.id);

    // 핸드가 끝났거나 아직 없다 → 다음 핸드 시작 시각을 기다린다
    if (!hand || hand.ended_at != null) {
      const at = table.next_hand_at;
      if (at == null) return;              // 시작 예약이 없다 (이상 상태 — 다음 요청에서 다시 본다)
      if (now < at) return;                // 쇼다운을 보여주는 중
      const fresh = one<HtTableRow>(`SELECT * FROM holdem_tables WHERE id = ?`, table.id)!;
      startHand(t, fresh, now);
      table = one<HtTableRow>(`SELECT * FROM holdem_tables WHERE id = ?`, table.id)!;
      continue;
    }

    const rows = getHandSeats(hand.id);
    const views = toViews(rows);

    // 팟을 다툴 사람이 한 명뿐이면 쇼다운 없이 끝난다
    if (G.contenders(views).length <= 1) {
      endHand(t, table, hand, views, false, now, lockedBoardLen);
      table = reload(table.id); continue;
    }

    /* 더 이상 베팅이 있을 수 없는가 — 남은 사람 중 칩이 있는 사람이 한 명 이하일 때다.
       혼자 남은 사람은 상대가 없어 베팅할 수 없으므로, 이 시점부터 보드는 그냥 깔릴 뿐이다.
       그 순간의 보드 장수가 승률 계산의 기준이 된다(그 뒤로는 정보가 늘지 않는다). */
    if (lockedBoardLen == null) {
      const live = views.filter(v => v.state !== 'folded');
      if (live.filter(v => v.state !== 'allin').length <= 1) {
        lockedBoardLen = (JSON.parse(hand.board_json) as number[]).length;
      }
    }

    if (G.bettingRoundClosed(views)) {
      if (hand.street === 'river') {
        endHand(t, table, hand, views, true, now, lockedBoardLen);
        table = reload(table.id); continue;
      }
      nextStreet(hand, views, now);
      continue;
    }

    // 아직 라운드가 안 끝났다 — 행동할 사람이 있어야 한다
    if (hand.to_act_seat == null) { setToAct(hand, views, hand.button_seat, now); continue; }

    /* 자리 비움인 사람은 기다리지 않고 바로 넘긴다.
       20초는 "지금 보고 있는 사람이 생각할 시간"이다. 이미 자리를 비운 사람에게 그 시간을
       주면 남은 사람 전부가 매 차례 20초씩 멈춰 서 있게 된다 — 3인 판이면 한 바퀴에 40초가
       빈다. SIT_OUT은 한 번 시간을 초과해서 붙는 표시이므로(아래) 유예는 이미 한 번 줬다.

       DISCONNECTED는 여기 넣지 않는다. 잠깐 끊긴 것일 수 있어서 20초는 돌아올 기회로 둔다 —
       돌아오지 못하면 그 한 번의 초과로 SIT_OUT이 되고, 그 뒤부터는 바로 넘어간다. */
    const awaySeat = hand.to_act_seat != null && one<{ presence: string }>(
      `SELECT presence FROM holdem_seats WHERE table_id = ? AND seat = ?`,
      table.id, hand.to_act_seat)?.presence === 'SIT_OUT';
    const deadline = hand.action_deadline ?? now;
    /* 자리 비움도 최소 간격은 지킨다. 예전에는 마감을 통째로 무시했는데, 그러면 자리 비움이
       둘 이상일 때 이 while 루프가 그들 전부를 한 번의 호출에서 접어 버린다 —
       화면에는 "레이즈 → 폴드 → 폴드"가 0.1초 안에 몰려 나온다.
       유예(20초)는 여전히 건너뛴다. 그게 자리 비움을 즉시 넘기는 목적이었다. */
    const openAt = deadline - ACTION_SEC;
    if (awaySeat ? now < openAt : now < deadline) return;   // 아직 기다리는 중

    /* 마감 초과 → 자동 액션. 체크할 수 있으면 체크, 없으면 폴드.
       강제로 콜하지 않는 게 중요하다. 게임이 플레이어 대신 칩을 걸어선 안 된다.
       그리고 스펙 8항대로 그 사람을 SIT_OUT으로 내린다. */
    const seat = hand.to_act_seat;
    const me = views.find(v => v.seat === seat);
    if (!me || !G.canAct(me)) { setToAct(hand, views, seat, now); continue; }
    const la = G.legalActions(me, views, hand.last_raise_size, hand.bb);
    const r = G.applyAction(views, seat, la.canCheck ? 'check' : 'fold', 0, hand.last_raise_size, hand.bb);
    if (r.ok) {
      saveViews(hand.id, views);
      noteAction(hand.id, seat, r.kind, r.paid);
      run(`UPDATE holdem_hands SET last_raise_size = ? WHERE id = ?`, r.lastRaiseSize, hand.id);
    }
    run(`UPDATE holdem_seats SET presence = 'SIT_OUT'
         WHERE table_id = ? AND seat = ? AND presence <> 'OUT'`, table.id, seat);
    hand = getCurrentHand(table.id)!;
    setToAct(hand, views, seat, now);
  }
}

function reload(tableId: number): HtTableRow {
  return one<HtTableRow>(`SELECT * FROM holdem_tables WHERE id = ?`, tableId)!;
}

/** 다음 행동자를 정한다. 없으면 to_act를 비운다(라운드 종료로 판정된다).
 *  gapSec: 차례가 열리기까지의 최소 간격. 마감을 그만큼 뒤로 밀어 표현한다
 *  (열리는 시각 = 마감 - ACTION_SEC). 제한 시간 20초는 열린 뒤부터 온전히 준다. */
function setToAct(
  hand: HtHandRow, views: G.SeatView[], from: number, now: number, gapSec = ACT_GAP_SEC
): void {
  const next = G.nextActor(views, from, T.MAX_PLAYERS);
  if (next == null) {
    run(`UPDATE holdem_hands SET to_act_seat = NULL, action_deadline = NULL WHERE id = ?`, hand.id);
  } else {
    run(`UPDATE holdem_hands SET to_act_seat = ?, action_deadline = ? WHERE id = ?`,
      next, now + gapSec + ACTION_SEC, hand.id);
  }
}

/** 새 핸드를 시작한다 — 블라인드 레벨을 확정하고 카드를 돌린다. */
function startHand(t: HtRow, table: HtTableRow, now: number): void {
  const living = livingSeats(table.id);
  if (living.length <= 1) return;

  const occupied = living.map(s => s.seat);
  /* 버튼은 "직전 핸드의 버튼 다음 생존자". 첫 핸드는 저장된 button_seat(0)에서
     한 칸 앞으로 되돌려 0번이 버튼이 되게 한다. */
  const button = table.hand_no === 0
    ? (occupied.includes(table.button_seat) ? table.button_seat : occupied[0])
    : (G.nextButton(occupied, table.button_seat, T.MAX_PLAYERS) ?? occupied[0]);

  /* 블라인드 레벨은 핸드를 시작하는 이 순간에 확정해서 저장한다.
     스펙 5항의 "8분이 지나도 진행 중인 핸드는 끝난 뒤 다음 핸드부터 상승"이
     이렇게 자동으로 지켜진다 — 핸드 도중에는 다시 계산하지 않는다. */
  const lv = T.levelAt(now - (t.started_at ?? now), tuning(t).levelSec);
  const deck = G.shuffleDeck(randomInt);
  const handNo = table.hand_no + 1;

  run(`INSERT INTO holdem_hands
         (table_id, hand_no, level, sb, bb, ante, button_seat, deck_json, deck_pos,
          board_json, street, last_raise_size, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', 'preflop', ?, ?)`,
    table.id, handNo, lv.level, lv.sb, lv.bb, lv.ante, button, JSON.stringify(deck), lv.bb, now);
  const handId = one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;
  run(`UPDATE holdem_tables SET hand_no = ?, button_seat = ?, next_hand_at = NULL WHERE id = ?`,
    handNo, button, table.id);

  // 좌석 등록 + 홀 카드 두 장 (실제 테이블처럼 한 바퀴씩 두 번 돈다)
  let pos = 0;
  const holes = new Map<number, number[]>();
  for (const s of living) holes.set(s.seat, []);
  for (let pass = 0; pass < 2; pass++) {
    for (const s of living) holes.get(s.seat)!.push(deck[pos++]);
  }
  for (const s of living) {
    run(`INSERT INTO holdem_hand_seats (hand_id, seat, user_id, hole_json, stack, state)
         VALUES (?, ?, ?, ?, ?, 'active')`,
      handId, s.seat, s.user_id, JSON.stringify(holes.get(s.seat)), s.stack);
  }
  run(`UPDATE holdem_hands SET deck_pos = ? WHERE id = ?`, pos, handId);

  const hand = one<HtHandRow>(`SELECT * FROM holdem_hands WHERE id = ?`, handId)!;
  const views = toViews(getHandSeats(handId));

  /* 앤티 → 블라인드 순서로 걷는다.
     스택이 부족하면 있는 만큼만 내고 올인이 된다(실제 규칙). */
  if (lv.ante > 0) {
    for (const v of views) {
      const paid = Math.min(lv.ante, v.stack);
      v.stack -= paid; v.committed += paid;
      if (v.stack === 0) v.state = 'allin';
    }
  }
  const bp = G.blindPositions(occupied, button, T.MAX_PLAYERS);
  if (!bp) { saveViews(handId, views); return; }
  for (const [seat, amount] of [[bp.sb, lv.sb], [bp.bb, lv.bb]] as const) {
    const v = views.find(x => x.seat === seat);
    if (!v) continue;
    const paid = Math.min(amount, v.stack);
    v.stack -= paid; v.bet += paid; v.committed += paid;
    if (v.stack === 0) v.state = 'allin';
  }
  saveViews(handId, views);

  /* 프리플랍 첫 행동자. 블라인드를 낸 것은 "행동"이 아니므로 acted는 그대로 0이다.
     카드가 다 돌아갈 때까지는 열지 않는다 — 화면은 앤티를 걷고 열두 장을 한 장씩 돌리는 데
     2~3초를 쓴다. 그 전에 첫 베팅이 들어오면 카드를 받기도 전에 판이 시작된다. */
  setToAct(hand, views, prevSeat(bp.firstToAct, occupied), now, STREET_OPEN_SEC);
}

/** occupied 안에서 seat의 바로 앞 자리 — setToAct가 "다음"을 찾으므로 한 칸 뒤에서 시작한다 */
function prevSeat(seat: number, occupied: number[]): number {
  for (let i = 1; i <= T.MAX_PLAYERS; i++) {
    const cand = (seat - i + T.MAX_PLAYERS * 2) % T.MAX_PLAYERS;
    if (occupied.includes(cand)) return cand;
  }
  return seat;
}

/** 다음 스트리트로 — 보드를 깔고 베팅을 초기화한다 */
function nextStreet(hand: HtHandRow, views: G.SeatView[], now: number): void {
  const idx = G.STREETS.indexOf(hand.street);
  const next = G.STREETS[idx + 1];
  const deck = JSON.parse(hand.deck_json) as number[];
  const board = JSON.parse(hand.board_json) as number[];
  let pos = hand.deck_pos;

  // 실제 딜링처럼 버닝 카드 한 장을 태운 뒤 깐다
  pos++;
  while (board.length < G.BOARD_COUNT[next]) board.push(deck[pos++]);

  for (const v of views) { v.bet = 0; v.acted = false; }
  run(`UPDATE holdem_hands SET street = ?, board_json = ?, deck_pos = ?, last_raise_size = ?,
         to_act_seat = NULL, action_deadline = NULL WHERE id = ?`,
    next, JSON.stringify(board), pos, hand.bb, hand.id);
  // 스트리트가 바뀌면 지난 스트리트의 행동 표시도 지운다 (폴드는 남겨 둔다 — 계속 유효하다)
  run(`UPDATE holdem_hand_seats SET bet = 0, acted = 0,
         last_action = CASE WHEN last_action = 'fold' THEN 'fold' ELSE NULL END,
         last_amount = 0
       WHERE hand_id = ?`, hand.id);
  saveViews(hand.id, views);

  const fresh = one<HtHandRow>(`SELECT * FROM holdem_hands WHERE id = ?`, hand.id)!;
  const occupied = views.map(v => v.seat);
  const first = G.firstToActPostflop(occupied, hand.button_seat, T.MAX_PLAYERS);
  /* 카드가 다 열릴 때까지는 아무도 행동할 수 없다. 보드를 보기 전에 베팅이 시작되면
     "카드가 펼쳐지는 중에 이미 다음 액션이 진행되는" 화면이 된다. */
  setToAct(fresh, views, prevSeat(first ?? hand.button_seat, occupied), now, STREET_OPEN_SEC);
}

/** 핸드 종료 — 팟을 나누고 스택에 반영한다.
 *  lockedBoardLen: 베팅이 완전히 끝난 순간의 보드 장수(advanceTable이 기억해 둔 값).
 *  여기서 board.length를 쓰면 안 된다 — 전원 올인이면 그 전에 nextStreet가 리버까지
 *  채워 놓아서 언제나 5가 나온다. null이면 이 핸드는 정상 진행으로 끝난 것이다. */
function endHand(
  t: HtRow, table: HtTableRow, hand: HtHandRow, views: G.SeatView[], showdown: boolean, now: number,
  lockedBoardLen: number | null = null
): void {
  const rows = getHandSeats(hand.id);
  const board = JSON.parse(hand.board_json) as number[];
  /* 콜되지 않은 초과 베팅을 먼저 돌려준다. 이걸 빼먹으면 상대가 스택이 부족해
     콜하지 못한 차액이 "자격자 없는 팟 층"으로 남아 분배에서 사라진다. */
  const uncalled = G.returnUncalled(views);
  const pots = G.buildPots(views);

  /* 쇼다운 점수. 보드가 5장이 아닌 채로 끝났다면(전원 올인 전에 폴드로 끝남)
     남은 사람이 한 명이므로 점수를 비교할 필요가 없다. */
  const scores = new Map<number, number>();
  const live = views.filter(v => v.state !== 'folded');
  /* 베팅이 끝난 시점의 보드 장수 — 클라이언트가 몇 장을 한 장씩 열어야 하는지가 이 값이고,
     다음 판 시작을 그만큼 미뤄야 마지막 카드를 열다가 판이 넘어가지 않는다.

     advanceTable이 넘겨준 값을 먼저 쓴다. 이 함수가 보는 board는 이미 리버까지 채워져
     있을 수 있다(전원 올인이면 nextStreet가 연달아 불려 여기 오기 전에 다 깐다).
     넘겨준 값이 없으면 정상 진행으로 끝난 판이므로 지금 보드가 그대로 답이다. */
  const boardAtEnd = lockedBoardLen ?? board.length;
  if (live.length === 1) {
    scores.set(live[0].seat, 1);
  } else {
    /* 전원 올인으로 베팅이 끝났는데 보드가 덜 깔렸으면 남은 카드를 채운다(런아웃).
       실제 카지노도 이렇게 한다 — 액션이 없어도 보드는 끝까지 깐다. */
    const deck = JSON.parse(hand.deck_json) as number[];
    let pos = hand.deck_pos;
    while (board.length < 5) { pos++; board.push(deck[pos++]); }
    run(`UPDATE holdem_hands SET board_json = ?, deck_pos = ? WHERE id = ?`,
      JSON.stringify(board), pos, hand.id);
    for (const v of live) {
      const row = rows.find(r => r.seat === v.seat)!;
      scores.set(v.seat, G.handScore(JSON.parse(row.hole_json) as number[], board));
    }
  }

  /* 층별 정산 내역을 그대로 받아 둔다. 화면이 팟을 하나씩 넘겨 보여주려면
     "어느 층을 누가 가져갔는지"가 필요한데, 좌석별 합계(awards)로는 알 수 없다. */
  const potAwards = G.awardPotsDetailed(pots, scores, hand.button_seat, T.MAX_PLAYERS);
  const awards = G.awardPots(pots, scores, hand.button_seat, T.MAX_PLAYERS);
  for (const a of awards) {
    run(`UPDATE holdem_hand_seats SET won = ? WHERE hand_id = ? AND seat = ?`, a.amount, hand.id, a.seat);
  }

  /* 좌석 스택 갱신. 핸드 중 스택(views)에 딴 금액을 더한 값이 최종 스택이다.
     여기서 칩 총량이 보존된다 — 나간 committed의 합과 받은 won의 합이 같아야 한다. */
  const wonBySeat = new Map(awards.map(a => [a.seat, a.amount]));
  for (const v of views) {
    const final = v.stack + (wonBySeat.get(v.seat) ?? 0);
    run(`UPDATE holdem_seats SET stack = ? WHERE table_id = ? AND seat = ?`, final, table.id, v.seat);
  }
  saveViews(hand.id, views);

  const result = {
    showdown,
    uncalled,                              // 되돌려준 초과 베팅 (없으면 null)
    board: G.cardsToStrings(board),
    pots: pots.map(p => ({ amount: p.amount, eligible: p.eligible })),
    awards,
    /* 쇼다운이면 남은 사람의 홀 카드를 공개한다 (폴드로 끝났으면 공개하지 않는다).
       무엇으로 이겼는지(hand)와 이긴 5장(five)도 같이 적어 둔다 — 화면에서 그 5장만
       밝히고 나머지를 흐리게 하려면 어느 카드가 쓰였는지 알아야 한다.
       여기서 한 번 계산해 result_json에 박아 두면 폴링마다 다시 계산할 일이 없고,
       나중에 판정이 바뀌어도 그때 본 결과가 그대로 남는다. */
    reveal: showdown && live.length > 1
      ? live.map(v => {
        const hole = JSON.parse(rows.find(r => r.seat === v.seat)!.hole_json) as number[];
        const sd = G.showdownHand(hole, board);
        return { seat: v.seat, cards: G.cardsToStrings(hole), hand: sd.name, five: sd.five };
      })
      : [],
    /* 층별 정산 — 화면이 팟을 하나씩 넘겨 보여주는 데 쓴다.
       보여줄 순서대로 담는다: 이긴 손이 강한 층부터. 실제 딜러도 가장 센 손이 걸린
       사이드 팟부터 밀어 주고 메인 팟을 마지막에 정리한다. 같은 점수면 위층(사이드)이 먼저다.
       족보 이름은 그 층을 가져간 사람의 것이다 — 층마다 이긴 손이 다를 수 있다. */
    potAwards: showdown && live.length > 1
      ? potAwards
        .slice()
        .sort((a, b) => (b.score - a.score) || (b.index - a.index))
        .map(pa => {
          const w = pa.winners[0];
          const row = w ? rows.find(r => r.seat === w.seat) : undefined;
          const name = row
            ? G.showdownHand(JSON.parse(row.hole_json) as number[], board).name
            : '';
          return {
            index: pa.index, amount: pa.amount,
            winners: pa.winners, hand: name,
          };
        })
      : [],
    /* 스트리트별 승률 — 리버 이전에 액션이 끝난 판(올인 등)에서만 채워진다.
       화면이 보드를 한 장씩 열면서 지금 깔린 장수에 맞는 단계를 보여준다.

       여기서 한 번 계산해 박아 둔다. 폴링마다 다시 계산하면 초당 한 번씩 전수 계산을
       돌리게 되고(턴 기준 46가지 × 사람 수), 무엇보다 판이 끝난 뒤에는 값이 바뀌지 않는다.
       진행 중인 판에는 절대 담기지 않는다 — 승률은 남의 홀 카드를 알아야 나오는 값이라
       진행 중에 내려보내면 그게 곧 정보 유출이다. endHand 안에서만 부르는 이유다. */
    equity: showdown && live.length > 1 && boardAtEnd < 5
      ? G.equityStages(
        live.map(v => ({
          seat: v.seat,
          hole: JSON.parse(rows.find(r => r.seat === v.seat)!.hole_json) as number[],
        })),
        board, boardAtEnd, randomInt)
      : [],
  };
  run(`UPDATE holdem_hands SET ended_at = ?, result_json = ?, to_act_seat = NULL, action_deadline = NULL
       WHERE id = ? AND ended_at IS NULL`, now, JSON.stringify(result), hand.id);

  // 스택이 0이 된 사람을 탈락 처리한다 (같은 핸드에서 여러 명이 나가면 투입액이 많은 쪽이 상위)
  eliminateBusted(t, table, hand, views, now);

  /* 팟이 여러 층이면 화면이 하나씩 넘기며 보여주므로 그만큼 시간이 더 든다.
     늘리지 않으면 마지막 층을 보여주기도 전에 다음 판이 시작된다.
     층 수는 여기서 이미 알고 있으므로 그 값으로 정확히 계산한다.

     같은 승자가 연달아 가져가는 층은 화면이 하나로 합쳐서 한 번만 보여준다
     (mergeSameWinner). 그래서 층 수가 아니라 "승자가 바뀌는 횟수"로 세야 맞다 —
     사이드 팟 세 개를 한 사람이 다 먹으면 화면은 한 번만 재생한다. */
  const shownLayers = potAwards.reduce((n, pa, i) => {
    if (i === 0) return 1;
    const key = (x: typeof pa) => x.winners.map(w => w.seat).sort((a, b) => a - b).join(',');
    return key(pa) === key(potAwards[i - 1]) ? n : n + 1;
  }, 0);
  const extraPots = showdown && live.length > 1 ? Math.max(0, shownLayers - 1) : 0;
  const delay = nextHandDelaySec({
    showdown: showdown && live.length > 1,
    boardAtEnd, liveCount: live.length, extraPots,
  });
  run(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`, now + delay, table.id);
}

/**
 * 탈락 처리. 등수는 여기서 매기지 않고 "탈락 순서"만 기록한다 —
 * 늦은 등록으로 참가자가 늘면 탈락 시점에 계산한 등수가 어긋나기 때문이다
 * (4명일 때 4등을 준 뒤 5번째가 등록되면 5등이 없는 판이 된다).
 * 같은 핸드에서 둘 이상이 나가면 이 핸드에 적게 넣은 쪽이 먼저 나간다(실제 규칙).
 */
function eliminateBusted(
  t: HtRow, table: HtTableRow, hand: HtHandRow, views: G.SeatView[], now: number
): void {
  const busted = getSeats(table.id).filter(s => s.presence !== 'OUT' && s.stack <= 0);
  if (!busted.length) return;
  const ranked = busted.sort((a, b) => {
    const ca = views.find(v => v.seat === a.seat)?.committed ?? 0;
    const cb = views.find(v => v.seat === b.seat)?.committed ?? 0;
    return ca - cb;   // 적게 넣은 사람이 먼저 나간다(= 더 낮은 등수)
  });
  let seq = (one<{ n: number }>(
    `SELECT COALESCE(MAX(elim_seq), 0) AS n FROM holdem_entries WHERE tournament_id = ?`, t.id)!).n;
  for (const s of ranked) {
    seq++;
    run(`UPDATE holdem_seats SET presence = 'OUT' WHERE table_id = ? AND seat = ?`, table.id, s.seat);
    run(`UPDATE holdem_entries SET elim_seq = ?, eliminated_at = ?
         WHERE tournament_id = ? AND user_id = ? AND elim_seq IS NULL`, seq, now, t.id, s.user_id);
  }
  void hand;
}

/**
 * 토너먼트 종료 — 마지막 생존자에게 가장 늦은 탈락 순서를 주고, 그 순서로 등수를 확정한다.
 * 등수를 여기서 한꺼번에 매기기 때문에 늦은 등록이 몇 명 끼어들었든 1..N이 빈틈없이 채워진다.
 */
function finishTournament(t: HtRow, table: HtTableRow, now: number): void {
  const living = livingSeats(table.id);
  let seq = (one<{ n: number }>(
    `SELECT COALESCE(MAX(elim_seq), 0) AS n FROM holdem_entries WHERE tournament_id = ?`, t.id)!).n;
  for (const s of living) {
    seq++;
    run(`UPDATE holdem_seats SET presence = 'OUT' WHERE table_id = ? AND seat = ?`, table.id, s.seat);
    run(`UPDATE holdem_entries SET elim_seq = ?, eliminated_at = ?
         WHERE tournament_id = ? AND user_id = ? AND elim_seq IS NULL`, seq, now, t.id, s.user_id);
  }
  /* 등록만 하고 한 판도 앉지 못한 사람(취소 직전 등록 등)도 순서를 받아야 1..N이 채워진다 */
  for (const e of getEntries(t.id)) {
    if (e.elim_seq != null) continue;
    seq++;
    run(`UPDATE holdem_entries SET elim_seq = ?, eliminated_at = ? WHERE id = ? AND elim_seq IS NULL`,
      seq, now, e.id);
  }
  // 탈락이 늦을수록 좋은 등수다 — 마지막 생존자가 1위
  const ordered = all<HtEntryRow>(
    `SELECT * FROM holdem_entries WHERE tournament_id = ? ORDER BY elim_seq ASC`, t.id);
  ordered.forEach((e, i) => {
    run(`UPDATE holdem_entries SET finish_place = ? WHERE id = ?`, ordered.length - i, e.id);
  });

  run(`UPDATE holdem_tournaments SET finished_at = ? WHERE id = ? AND finished_at IS NULL`, now, t.id);
  // 경합으로 이미 다른 요청이 정산했다면 두 번 지급하지 않는다
  const fresh = one<HtRow>(`SELECT * FROM holdem_tournaments WHERE id = ?`, t.id)!;
  if (fresh.finished_at !== now) return;
  payPrizes(fresh, now);
}

/**
 * 상금 지급. 프리롤이라 참가비가 없으므로 이 포인트는 새로 발행된다 —
 * 의도된 정책이다(재미 위주 커뮤니티 포인트). 원장에 남겨 잔액 불변식을 지킨다.
 */
function payPrizes(t: HtRow, now: number): void {
  const entries = getEntries(t.id);
  const pool = T.prizePool(entries.length, t.prize_multiplier, tuning(t).prizeFixed);
  const amounts = T.prizeAmounts(pool, entries.length);
  if (!amounts.length) return;
  const ranked = entries
    .filter(e => e.finish_place != null)
    .sort((a, b) => (a.finish_place ?? 0) - (b.finish_place ?? 0));
  amounts.forEach((amount, i) => {
    const e = ranked[i];
    if (!e || amount <= 0) return;
    // 이미 지급된 항목은 건드리지 않는다 (조건부 UPDATE로 이중 지급 차단)
    run(`UPDATE holdem_entries SET prize = ? WHERE id = ? AND prize = 0`, amount, e.id);
    const changed = one<{ n: number }>(`SELECT prize AS n FROM holdem_entries WHERE id = ?`, e.id);
    if (!changed || changed.n !== amount) return;
    run(`UPDATE users SET balance = balance + ? WHERE id = ?`, amount, e.user_id);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, e.user_id);
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      e.user_id, amount, 'game:holdem:prize', after?.balance ?? 0);
  });
  void now;
}

/* ── 유저 동작 ───────────────────────────────────────────────────── */

export type RegisterError = 'not_open' | 'late_reg_closed' | 'table_full' | 'closed' | 'already';
export type UnregisterError = 'not_registered' | 'already_started' | 'closed';

/**
 * 참가 신청 취소 — 대회가 시작되기 전에만 된다.
 *
 * 시작 전에는 등록이 holdem_entries 행 하나일 뿐이라 그 행만 지우면 깨끗하다
 * (좌석과 스택은 시작할 때 한꺼번에 만들어진다). 반대로 시작한 뒤에는 이미 칩을
 * 들고 앉아 있으므로 취소가 성립하지 않는다 — 그건 기권이지 취소가 아니고,
 * 남은 사람의 상금 구조까지 흔든다.
 *
 * 조건을 DELETE의 WHERE에 함께 넣는다. 밖에서 미리 확인만 하면 확인과 삭제 사이에
 * 대회가 시작돼(다른 요청의 advanceHoldem이 시작시킬 수 있다) 이미 앉은 사람의
 * 등록이 지워질 수 있다.
 */
export function unregisterHoldem(userId: string):
  { ok: true; registered: number } | { ok: false; error: UnregisterError } {
  return tx(() => {
    const st = advanceHoldem();
    const t = st.tournament;
    if (t.finished_at != null || t.cancelled_at != null) return { ok: false, error: 'closed' };

    run(`DELETE FROM holdem_entries
          WHERE user_id = ? AND tournament_id = (
            SELECT id FROM holdem_tournaments
             WHERE id = ? AND started_at IS NULL
               AND finished_at IS NULL AND cancelled_at IS NULL)`,
      userId, t.id);
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n === 0) {
      // 왜 안 됐는지 갈라서 안내 문구를 정확히 낸다
      const mine = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM holdem_entries WHERE tournament_id = ? AND user_id = ?`,
        t.id, userId)!.n;
      if (mine === 0) return { ok: false, error: 'not_registered' };
      return { ok: false, error: 'already_started' };
    }
    return { ok: true, registered: getEntries(t.id).length };
  });
}

export function registerHoldem(userId: string, username: string):
  { ok: true; registered: number } | { ok: false; error: RegisterError } {
  return tx(() => {
    const st = advanceHoldem();
    const t = st.tournament;
    const can = T.canRegister(nowSec(), st.schedule, facts(t), st.registered, st.seated,
      tuning(t).lateRegSec);
    if (!can.ok) return { ok: false, error: can.reason };

    /* 마지막 자리를 두고 두 요청이 겹치는 것은 유니크 인덱스가 막는다.
       "빈자리 수를 세고 나서 INSERT" 사이에 다른 요청이 끼어들 수 있으므로
       코드 순서에 기대지 않고 DB 제약으로 막는 게 핵심이다. */
    try {
      run(`INSERT INTO holdem_entries (tournament_id, user_id, username, registered_at)
           VALUES (?, ?, ?, ?)`, t.id, userId, username, nowSec());
    } catch {
      return { ok: false, error: 'already' };
    }

    /* 진행 중(늦은 등록)이면 빈자리에 바로 앉힌다. 시작 전이면 시작할 때 한꺼번에 앉는다.
       늦게 온 사람도 시작 스택을 받는다 — 프리롤이므로 형평이 아니라 참여가 목적이다. */
    if (t.started_at != null) {
      const table = getTable(t.id);
      if (table) {
        const taken = new Set(getSeats(table.id).filter(s => s.presence !== 'OUT').map(s => s.seat));
        for (let seat = 0; seat < T.MAX_PLAYERS; seat++) {
          if (taken.has(seat)) continue;
          // 예전에 그 자리에 앉았다 탈락한 행이 남아 있으면 치운다
          run(`DELETE FROM holdem_seats WHERE table_id = ? AND seat = ?`, table.id, seat);
          run(`INSERT INTO holdem_seats (table_id, seat, user_id, username, stack, presence, last_seen_at)
               VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
            table.id, seat, userId, username, tuning(t).startingStack, nowSec());
          break;
        }
      }
    }
    return { ok: true, registered: getEntries(t.id).length };
  });
}

export type ActionError =
  /* too_soon은 "차례는 맞지만 아직 열리지 않았다"다. 실패가 아니라 잠깐 뒤에 다시 하면
     되는 상태이므로 호출부(봇·자동 액션)는 다음 주기에 그대로 재시도하면 된다. */
  | 'no_tournament' | 'not_seated' | 'no_hand' | 'not_your_turn' | 'too_soon' | 'illegal';

/** 힛/폴드가 아니라 포커 액션. amount는 "이 스트리트에 올릴 총액"이다. */
export function holdemAction(
  userId: string, kind: G.ActionKind, amount: number
): { ok: true } | { ok: false; error: ActionError; detail?: string } {
  return tx(() => {
    /* 자리 비움 상태에서 직접 버튼을 눌렀다면 전진시키기 전에 먼저 앉은 것으로 되돌린다.
       advanceHoldem이 자리 비움 좌석을 기다리지 않고 즉시 넘기기 때문에, 순서가 반대면
       내 차례가 사라진 뒤에 요청이 도착해 'not_your_turn'이 된다 — 돌아온 사람이
       버튼을 눌러도 아무 일도 일어나지 않고 계속 자동 폴드된다.
       (아래 "직접 행동했으니 앉아 있는 상태로 되돌린다"는 이미 있던 규칙이다.
        즉시 넘기기를 넣으면서 그 규칙이 닿기 전에 차례가 사라지게 됐다.) */
    run(`UPDATE holdem_seats SET presence = 'ACTIVE', last_seen_at = ?
         WHERE user_id = ? AND presence = 'SIT_OUT' AND table_id IN (
           SELECT tb.id FROM holdem_tables tb
             JOIN holdem_tournaments t ON t.id = tb.tournament_id
            WHERE t.finished_at IS NULL AND t.cancelled_at IS NULL)`, nowSec(), userId);
    const st = advanceHoldem();
    if (st.status !== 'RUNNING') return { ok: false, error: 'no_tournament' };
    const table = getTable(st.tournament.id);
    if (!table) return { ok: false, error: 'no_tournament' };
    const seatRow = getSeats(table.id).find(s => s.user_id === userId && s.presence !== 'OUT');
    if (!seatRow) return { ok: false, error: 'not_seated' };
    const hand = getCurrentHand(table.id);
    if (!hand || hand.ended_at != null) return { ok: false, error: 'no_hand' };
    if (hand.to_act_seat !== seatRow.seat) return { ok: false, error: 'not_your_turn' };
    const now = nowSec();
    if (hand.action_deadline != null && now > hand.action_deadline) {
      return { ok: false, error: 'not_your_turn' };   // 이미 마감돼 자동 처리될 차례다
    }
    /* 아직 차례가 열리지 않았다. 최소 간격이 규칙에 있어야 봇도 그것을 지킨다 —
       클라이언트에서 버튼만 잠그면 봇(과 자동 체크·자동 콜)은 그대로 즉시 눌러서
       화면이 따라갈 수 없는 속도로 판이 흘러간다. */
    const open = actOpenAt(hand);
    if (open != null && now < open) return { ok: false, error: 'too_soon' };

    const views = toViews(getHandSeats(hand.id));
    const r = G.applyAction(views, seatRow.seat, kind, amount, hand.last_raise_size, hand.bb);
    if (!r.ok) return { ok: false, error: 'illegal', detail: r.error };
    saveViews(hand.id, views);
    noteAction(hand.id, seatRow.seat, r.kind, r.paid);
    run(`UPDATE holdem_hands SET last_raise_size = ? WHERE id = ?`, r.lastRaiseSize, hand.id);
    // 직접 행동했으니 앉아 있는 상태로 되돌린다
    run(`UPDATE holdem_seats SET presence = 'ACTIVE', last_seen_at = ?
         WHERE table_id = ? AND seat = ? AND presence <> 'OUT'`, now, table.id, seatRow.seat);
    const fresh = one<HtHandRow>(`SELECT * FROM holdem_hands WHERE id = ?`, hand.id)!;
    setToAct(fresh, views, seatRow.seat, now);
    // 이 액션으로 라운드가 끝났을 수 있다 — 바로 이어서 전진시킨다
    advanceTable(st.tournament, reload(table.id), now);
    return { ok: true };
  });
}

/** 폴링마다 부른다 — 접속 중임을 표시하되 SIT_OUT은 자동으로 풀지 않는다 */
export function touchHoldemPresence(userId: string, tableId: number): void {
  run(`UPDATE holdem_seats SET last_seen_at = ?,
         presence = CASE WHEN presence = 'DISCONNECTED' THEN 'ACTIVE' ELSE presence END
       WHERE table_id = ? AND user_id = ? AND presence <> 'OUT'`, nowSec(), tableId, userId);
}

/** [게임 복귀] — SIT_OUT을 직접 풀 때만 부른다 */
export function holdemSitIn(userId: string, tableId: number): void {
  run(`UPDATE holdem_seats SET presence = 'ACTIVE', last_seen_at = ?
       WHERE table_id = ? AND user_id = ? AND presence <> 'OUT'`, nowSec(), tableId, userId);
}

/**
 * 부팅 시 진행 중이던 토너먼트를 취소한다(스펙 9항).
 * 절전-재개는 부팅이 아니므로 여기 걸리지 않는다 — 상태를 전부 SQLite에 두었기 때문에
 * 절전은 애초에 복구할 게 없다. 실제 재시작(배포·장애)에서만 걸린다.
 */
export function cancelRunningHoldemOnBoot(): number {
  return tx(() => {
    const rows = all<HtRow>(
      `SELECT * FROM holdem_tournaments WHERE started_at IS NOT NULL
         AND finished_at IS NULL AND cancelled_at IS NULL`);
    for (const t of rows) {
      run(`UPDATE holdem_tournaments SET cancelled_at = ? WHERE id = ?`, nowSec(), t.id);
    }
    return rows.length;
  });
}
