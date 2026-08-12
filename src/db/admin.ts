/* 운영용 관리 질의.
 *
 * 여기 있는 것은 전부 "사람이 눌러서 데이터를 바꾸는" 동작이다. 그래서 규칙을 하나 둔다 —
 * 위험한 조건은 화면이 아니라 이 파일이 막는다. 화면에서만 막으면 API 를 직접 부르는
 * 순간 뚫리고, 무엇보다 운영자가 실수했을 때 마지막으로 걸러 주는 곳이 없다.
 *
 * 경제 불변식: 잔액 = points_ledger 누적합. 감사가 이것을 검사한다.
 * 그래서 포인트를 만지는 일은 반드시 adjustBalance 를 거친다(원장을 함께 쓴다).
 */
import { one, all, run, tx, adjustBalance } from './queries';
import * as T from '../services/tournament';
import { getConfig } from './settings';
import { refundEntries } from './holdem';
import { notifyUser } from './notifications';

/* ── 대회 ─────────────────────────────────────────────────────────── */

export interface AdminTournamentRow {
  id: number; date_str: string; title: string;
  /** 화면이 "새 판을 열 수 있는가"를 판단하는 데 쓴다 — 다음 시작까지의 여유 */
  scheduled_start_at: number;
  started_at: number | null; finished_at: number | null; cancelled_at: number | null;
  prize_multiplier: number;
  /** 목록이 "이 판이 얼마짜리인가"를 다시 재는 데 쓴다 — 지급액만으로는 안 끝난 판을 못 읽는다 */
  prize_fixed: number;
  buy_in: number;
  /** 판의 종류. 'CLASSIC' | 'PKO_BOUNTY' | 'MYSTERY_BOUNTY' — 목록이 태그를 붙이는 데 쓴다 */
  mode: string;
  /** 바운티 몫(%). 목록이 "바운티 70%" 처럼 적는 데 쓴다 */
  bounty_pct: number;
  entries: number;
  /** 실제로 지급된 상금 합계. 0이면 이 대회는 경제에 아무 흔적도 남기지 않았다. */
  paid: number;
}

export function listTournaments(limit = 30): AdminTournamentRow[] {
  return all<AdminTournamentRow>(
    `SELECT t.*,
            (SELECT COUNT(*) FROM holdem_entries e WHERE e.tournament_id = t.id) AS entries,
            (SELECT COALESCE(SUM(e.prize), 0) FROM holdem_entries e WHERE e.tournament_id = t.id) AS paid
       FROM holdem_tournaments t
      ORDER BY t.id DESC LIMIT ?`, limit);
}

export type PurgeError = 'not_found' | 'paid' | 'running';

/**
 * 대회 기록을 통째로 지운다 — 테스트로 돌린 판을 없던 일로 만들기 위한 것이다.
 *
 * 상금이 한 푼이라도 나간 대회는 거절한다. 상금은 points_ledger 에 이미 발행돼 있고
 * 잔액은 그 누적합과 같아야 하는데, 대회 행만 지우면 원장에 근거 없는 포인트가 남는다.
 * 되돌리려면 역방향 원장을 써야 하고 그건 "지우기"가 아니라 별개의 회수 작업이다.
 *
 * 상금 0 인 대회(prize_multiplier = 0 으로 연 테스트 판)는 원장을 한 번도 건드리지
 * 않았으므로 — 홀덤이 원장에 쓰는 곳은 상금 지급 한 곳뿐이고, 그 앞에서 pool <= 0 이면
 * 곧바로 돌아간다 — 관련 행을 전부 지워도 경제가 어긋나지 않는다.
 *
 * 진행 중인 대회도 거절한다. 사람이 앉아 카드를 보고 있는 판을 지우면 화면이 무너진다.
 */
export function purgeTournament(id: number): { ok: true; removed: number } | { ok: false; error: PurgeError } {
  return tx(() => {
    const t = one<{ id: number; started_at: number | null; finished_at: number | null; cancelled_at: number | null }>(
      `SELECT id, started_at, finished_at, cancelled_at FROM holdem_tournaments WHERE id = ?`, id);
    if (!t) return { ok: false as const, error: 'not_found' as const };
    if (t.started_at != null && t.finished_at == null && t.cancelled_at == null) {
      return { ok: false as const, error: 'running' as const };
    }
    /* 상금이 나갔거나 참가비를 걷은 채로 남아 있으면 거절한다.
       둘 다 원장에 이미 기록된 돈이라, 대회 행만 지우면 근거 없는 포인트가 남는다.
       (인원 미달로 취소된 판은 그때 이미 돌려주고 paid_in 을 0 으로 내렸으므로
       여기서는 걸리지 않는다 — 지울 수 있다.) */
    /* 바운티도 함께 본다. 프리롤 바운티 판은 상금 팟이 0 이고 참가비도 걷지 않으므로
       위의 두 값만 보면 "흔적 없는 판"으로 읽히는데, 마감에서 펀드가 실제로 나갔다. */
    const money = one<{ prize: number; fees: number; bounty: number }>(
      `SELECT COALESCE(SUM(prize), 0) AS prize, COALESCE(SUM(paid_in), 0) AS fees,
              COALESCE(SUM(bounty_paid), 0) AS bounty
         FROM holdem_entries WHERE tournament_id = ?`, id)!;
    if (money.prize > 0 || money.fees > 0 || money.bounty > 0) {
      return { ok: false as const, error: 'paid' as const };
    }

    return { ok: true as const, removed: removeTournamentRows(id) };
  });
}

/* 지우는 순서는 자식부터다. 외래키 제약을 걸어 두지 않은 스키마라 순서를 틀려도
   에러가 안 나고 고아 행만 남는다 — 그게 더 나쁘다.
   호출하는 쪽이 "지워도 되는가"를 이미 판단했다고 본다. */
function removeTournamentRows(id: number): number {
  const tables = all<{ id: number }>(`SELECT id FROM holdem_tables WHERE tournament_id = ?`, id);
  let removed = 0;
  for (const tb of tables) {
    const hands = all<{ id: number }>(`SELECT id FROM holdem_hands WHERE table_id = ?`, tb.id);
    for (const h of hands) {
      run(`DELETE FROM holdem_hand_seats WHERE hand_id = ?`, h.id);
      removed++;
    }
    run(`DELETE FROM holdem_hands WHERE table_id = ?`, tb.id);
    run(`DELETE FROM holdem_seats WHERE table_id = ?`, tb.id);
  }
  run(`DELETE FROM holdem_tables WHERE tournament_id = ?`, id);
  run(`DELETE FROM holdem_entries WHERE tournament_id = ?`, id);
  run(`DELETE FROM holdem_tournaments WHERE id = ?`, id);
  return removed;
}

/**
 * 상금을 회수하고 대회를 지운다.
 *
 * 지우기와 다른 일이다. 지우기는 경제에 흔적이 없는 판만 다루지만, 여기서는 이미 나간
 * 포인트를 사람에게서 도로 가져온다. 그래서 원장에 역방향으로 남긴다 — 잔액을 직접
 * 고치면 "잔액 = 원장 누적합"이 깨지고, 그 불변식은 감사가 매번 검사한다.
 *
 * 잔액이 음수가 되는 것을 허용한다. 상금을 받고 이미 다 쓴 사람이 있으면 회수할 방법이
 * 그것뿐이고, 막으면 그런 사람이 한 명만 있어도 정리가 통째로 불가능해진다.
 * 대신 음수가 막다른 길이 되지 않게 지원금 조건을 balance <= 0 으로 열어 뒀다
 * (queries/core.ts 의 claimRelief) — 빚이 있어도 받을 수 있고, 받은 만큼 빚이 줄어든다.
 *
 * 진행 중인 대회는 여전히 거절한다. 사람이 앉아 카드를 보고 있는 판이다.
 */
export function revokePrizesAndPurge(id: number):
  { ok: true; revoked: number; refunded: number; users: number; removed: number }
  | { ok: false; error: 'not_found' | 'running' } {
  return tx(() => {
    const t = one<{ started_at: number | null; finished_at: number | null; cancelled_at: number | null }>(
      `SELECT started_at, finished_at, cancelled_at FROM holdem_tournaments WHERE id = ?`, id);
    if (!t) return { ok: false as const, error: 'not_found' as const };
    if (t.started_at != null && t.finished_at == null && t.cancelled_at == null) {
      return { ok: false as const, error: 'running' as const };
    }
    /* 바운티도 함께 되돌린다. 상금만 걷어 가면 마감 때 나간 바운티가 그대로 남아,
       없던 일로 만들려는 판에서 펀드 전액이 발행된 채 끝난다.

       기준을 bounty_won(예정액)이 아니라 bounty_paid(실제 지급액)로 둔다. 중간에 끊긴
       판은 예정액만 있고 나간 것이 없으므로 bounty_paid 가 0 이고, 그래서 취소된 판을
       지울 때 없는 돈을 걷어 가는 일이 생기지 않는다 — 대회 상태를 따로 따질 필요가
       없다는 뜻이기도 하다. 지급 여부의 근거를 한 칸으로 못 박아 두는 것이 요점이다. */
    /* 한 사람이 한 대회에서 상금을 두 번 받을 수는 없지만, 합쳐서 한 번에 되돌린다 —
       원장에 같은 사유가 두 줄 남는 것보다 한 줄이 읽기 쉽다. */
    const paid = all<{ user_id: string; n: number }>(
      `SELECT user_id, SUM(prize) + SUM(bounty_paid) AS n
         FROM holdem_entries WHERE tournament_id = ? GROUP BY user_id
        HAVING n > 0`, id);
    let revoked = 0;
    for (const p of paid) {
      adjustBalance(p.user_id, -p.n, 'tournament:revoke:' + id);
      revoked += p.n;
    }
    /* 참가비도 되돌린다. 상금만 걷어 가고 참가비를 안 돌려주면, 이 판에 나갔던 사람은
       돈만 잃는다 — 없던 일로 만드는 것이 이 동작의 뜻이므로 양쪽 다 되돌려야 한다. */
    const refunded = refundEntries(id, 'tournament:refund:');
    return {
      ok: true as const, revoked, refunded, users: paid.length,
      removed: removeTournamentRows(id),
    };
  });
}

/**
 * 대회를 하나 더 연다.
 *
 * 막는 조건이 둘이다.
 *
 * 1. 이미 돌고 있는 판. 카드가 돌고 사람이 앉아 있는 판이 둘일 수는 없다.
 *
 * 2. 곧 시작할 판. 아직 시작 안 한 대기 판이 있어도 만들 수는 있지만, 그 판의 시작
 *    시각이 가까우면 안 된다 — 임시 판이 끝나기 전에 정규 판의 시작 시각이 와 버리면
 *    정규 판이 뒤로 밀린다(findTournament 가 살아 있는 판 중 최근 것을 고른다).
 *    한 판이 아무리 길어도 두 시간을 넘지 않으므로, 두 시간이 남아 있으면 임시 판이
 *    먼저 끝난다. 그게 이 여유의 근거다.
 *
 * 처음에는 대기 판이 있으면 무조건 막았는데, 오늘의 정규 판이 늘 대기 상태로 앉아 있어서
 * 임시 판을 영영 만들 수 없었다 — 지우면 ensureTournament 가 1초 안에 다시 만들기 때문에
 * 빠져나갈 구멍이 없었다. 반대로 아무 때나 열게 하면 위 2번이 터진다.
 *
 * 임시 판이 끝나면 대기 중이던 정규 판이 다시 골라져 제 시각에 열린다.
 * 그래서 임시 판을 돌리려고 정규 판을 지울 필요가 없다.
 *
 * 시각은 "지금부터"로 잡는다. 오늘의 정규 판은 21시/22시라는 고정 일정이 있지만,
 * 여기서 여는 판은 운영자가 지금 열려는 것이라 그 일정을 따를 이유가 없다.
 */
/** 다음 판 시작까지 이만큼은 남아 있어야 임시 판을 연다. 한 판의 최대 길이에서 왔다. */
export const CREATE_GAP_SEC = 2 * 60 * 60;

export function createTournament(o: {
  title?: string; prizeMultiplier?: number;
  /** 등록이 열리는 시각(unix초). 안 주면 지금 */
  regOpenAt?: number;
  /** 시작 시각(unix초). 안 주면 regMin 분 뒤 */
  startAt?: number;
  regMin?: number;
  /** 참가비. 0(기본)이면 프리롤 — 지금까지의 대회는 전부 이쪽이다 */
  buyIn?: number;
  /* 판의 종류. 기본은 CLASSIC 이라 부르는 곳을 고치지 않으면 지금까지의 대회가 나온다.
     PKO_BOUNTY 는 참가비를 상금 팟과 바운티 펀드로 나누고, 화면도 바운티를 그린다. */
  mode?: 'CLASSIC' | 'PKO_BOUNTY' | 'MYSTERY_BOUNTY';
  /** 1인당 금액 중 바운티로 갈 몫(%). PKO_BOUNTY 에서만 쓰고, 미스터리는 늘 100 이다 */
  bountyPct?: number;
  /** 보장 상금(GTD). 참가비 대회에서 걷은 돈이 이에 못 미치면 모자란 만큼 얹는다 */
  prizeFixed?: number;
  /* 판의 모양. 안 주면 자동 개최 전용 템플릿의 값을 쓴다 — 반복 개최가 그 길로 들어온다.
     운영자가 손으로 여는 판은 화면에서 네 값을 늘 채워 보내므로 템플릿을 타지 않는다.
     그래서 템플릿을 고쳐도 지금 손으로 여는 판이 조용히 따라 바뀌는 일이 없다. */
  startingStack?: number;
  levelMin?: number;
  lateRegMin?: number;
  graceMin?: number;
}):
  { ok: true; id: number }
  | { ok: false; error: 'live_exists' } | { ok: false; error: 'too_close'; startsAt: number }
  | { ok: false; error: 'bad_time' } | { ok: false; error: 'bad_rules'; detail: string } {
  return tx(() => {
    const running = one<{ id: number }>(
      `SELECT id FROM holdem_tournaments
        WHERE started_at IS NOT NULL AND finished_at IS NULL AND cancelled_at IS NULL LIMIT 1`);
    if (running) return { ok: false as const, error: 'live_exists' as const };

    /* 대기 중인 판 가운데 가장 빨리 시작하는 것을 본다. 여럿일 수 있고, 막아야 할 기준은
       "가장 가까운 시작"이다 — 그보다 뒤의 판은 자동으로 여유가 더 크다. */
    const soon = one<{ scheduled_start_at: number }>(
      `SELECT MIN(scheduled_start_at) AS scheduled_start_at FROM holdem_tournaments
        WHERE started_at IS NULL AND finished_at IS NULL AND cancelled_at IS NULL`);
    const nowSec = Math.floor(Date.now() / 1000);
    if (soon?.scheduled_start_at != null && soon.scheduled_start_at - nowSec < CREATE_GAP_SEC) {
      return { ok: false as const, error: 'too_close' as const, startsAt: soon.scheduled_start_at };
    }

    const now = nowSec;
    const cfg = getConfig();
    /* 시각을 직접 받는다. 안 주면 "지금 등록을 열고 regMin 분 뒤 시작"으로 둔다 —
       테스트 대회처럼 지금 당장 열려는 경우가 그렇다. */
    const regOpenAt = o.regOpenAt != null ? Math.floor(o.regOpenAt) : now;
    const startAt = o.startAt != null ? Math.floor(o.startAt)
      : regOpenAt + Math.max(0, Math.floor(o.regMin ?? 10)) * 60;
    /* 등록이 시작보다 늦으면 등록 창이 아예 열리지 않는다 — 아무도 신청할 수 없는 대회다.
       화면에서도 막지만 마지막 문은 여기다. */
    if (!Number.isFinite(regOpenAt) || !Number.isFinite(startAt) || regOpenAt > startAt) {
      return { ok: false as const, error: 'bad_time' as const };
    }
    /* 판의 모양은 대회 행에 박힌다 — 한 번 시작하면 그 판은 끝까지 이 값만 본다.
       그래서 여기가 마지막 문이다. 0이나 소수가 지나가면 블라인드가 안 오르거나
       (levelSec 0) 칩 없이 앉는 판이 만들어지고, 그건 사람이 앉은 뒤에야 드러난다. */
    const rule = (v: number | undefined, fallback: number, label: string) => {
      if (v == null) return { n: fallback };
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < 1) return { n: 0, bad: `${label}은(는) 1 이상이어야 합니다` };
      return { n };
    };
    const stack = rule(o.startingStack, cfg.startingStack, '시작 칩');
    const level = rule(o.levelMin, cfg.levelMin, '블라인드 주기');
    const late = rule(o.lateRegMin, cfg.lateRegMin, '레이트 레지 시간');
    const grace = rule(o.graceMin, cfg.graceMin, '최소 인원 대기 시간');
    const badRule = [stack, level, late, grace].find(x => x.bad);
    if (badRule) return { ok: false as const, error: 'bad_rules' as const, detail: badRule.bad! };

    const mult = Math.max(0, Math.floor(o.prizeMultiplier ?? cfg.weekdayMultiplier));
    /* 안 주면 템플릿([자동 개최 전용 템플릿])의 값을 쓴다. 반복 개최가 이 길로 들어오므로,
       템플릿을 바이인으로 바꿔 두면 자동으로 열리는 판도 바이인이 된다.
       테스트 대회는 0 을 명시해서 언제나 프리롤로 남는다 — 지울 수 있어야 하기 때문이다. */
    const buyIn = Math.max(0, Math.floor(o.buyIn ?? cfg.buyIn));
    /* 모르는 값이 오면 CLASSIC 으로 떨어뜨린다. 오타가 그대로 저장되면 mode 비교가
       전부 빗나가 "바운티 대회인데 바운티가 없는 판"이 되고, 그건 걷은 돈이 갈 곳을
       잃는다는 뜻이다. 알 수 없는 값은 지금까지의 대회로 보는 편이 안전하다. */
    const mode = o.mode === 'PKO_BOUNTY' ? 'PKO_BOUNTY'
      : o.mode === 'MYSTERY_BOUNTY' ? 'MYSTERY_BOUNTY' : 'CLASSIC';
    /* 미스터리는 전액 바운티다 — 순위 상금을 두지 않는 것이 그 모드의 뜻이다. */
    /* 두 바운티 모드가 같은 규칙을 쓴다 — 미스터리도 순위 상금을 함께 둘 수 있다.
       모드가 정하는 것은 "금액을 감추고 봉투로 흩는가"와 "잡은 사람이 독식하는가"이고,
       순위 상금을 얼마 남길지는 그것과 별개의 선택이다. */
    const bountyPct = T.clampBountyPct(o.bountyPct);
    /* 바운티는 "1인당 금액의 절반"이다 — 참가비 대회는 참가비, 프리롤은 상금 배수가
       그 값이다. 둘 다 0 이면 머리에 걸 값이 없어서, 열려도 바운티가 하나도 없는
       "이름만 바운티 대회"가 된다. 화면도 잠그지만 여기서 한 번 더 막는다:
       화면을 거치지 않는 경로(반복 개최 템플릿·직접 호출)가 있다. */
    if (mode !== 'CLASSIC' && buyIn <= 0
      && Math.max(0, Math.floor(o.prizeMultiplier ?? cfg.weekdayMultiplier)) <= 0) {
      return {
        ok: false as const, error: 'bad_rules' as const,
        detail: '바운티 대회는 참가비나 상금 배수가 있어야 합니다 (그 절반이 현상금이 됩니다)',
      };
    }
    const fixed = Math.max(0, Math.floor(o.prizeFixed ?? cfg.prizeFixed));
    /* 이름을 성격에 맞춘다. "홀덤 프리롤"이라고 적힌 참가비 대회는 그 자체로 거짓말이다. */
    const title = (o.title ?? '').trim() || (buyIn > 0 ? '홀덤 토너먼트' : '홀덤 프리롤');
    /* date_str 은 이제 "하루 하나"의 열쇠가 아니다(유니크 인덱스를 걷어냈다).
       시작 시각이 속한 날을 적어 두는 이름표로만 쓴다 — 목록에서 언제 열린 판인지 읽는다. */
    run(`INSERT INTO holdem_tournaments
           (date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier,
            starting_stack, level_sec, late_reg_sec, prize_fixed, buy_in, mode, bounty_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      T.kstDateStr(startAt * 1000), title,
      regOpenAt, startAt, startAt + grace.n * 60, mult,
      stack.n, level.n * 60, late.n * 60, fixed, buyIn, mode, bountyPct);
    return { ok: true as const, id: one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id };
  });
}

/**
 * 테스트 대회 — 상금 배수를 0 으로 두어 포인트가 한 푼도 나가지 않게 한다.
 *
 * 그래서 끝난 뒤 기록을 통째로 지울 수 있다(purgeTournament). 홀덤이 원장에 쓰는 곳은
 * 상금 지급 한 곳뿐이고 그 앞에서 pool <= 0 이면 곧바로 돌아가므로, 이 판은 경제에
 * 아무 흔적도 남기지 않는다. 실서버에서 시험하려고 스테이징 서버를 따로 두지 않아도
 * 되는 이유가 이것이다.
 *
 * 예전에는 오늘 행을 덮어썼다 — 하루 하나라는 유니크 인덱스 때문에 나란히 만들 수가
 * 없었다. 이제 인덱스가 없으니 그냥 새로 만든다. 대신 살아 있는 판이 있으면 거절한다.
 */
export function openTestTournament() {
  // 만드는 조건은 하나뿐이므로 결과를 그대로 넘긴다 — 여기서 뭉개면 거절 이유를 못 알려 준다
  /* 참가비를 0 으로 못 박는다. 템플릿이 바이인이어도 테스트 판은 프리롤이어야 한다 —
     이 판의 존재 이유가 "경제에 아무 흔적도 남기지 않는 것"이고, 참가비를 걷는 순간
     원장이 움직여서 끝난 뒤 통째로 지울 수 없게 된다. */
  return createTournament({
    title: '테스트 대회 (상금 없음)', prizeMultiplier: 0, regMin: 0, buyIn: 0, prizeFixed: 0,
  });
}

/**
 * 진행 중인 대회를 중단시킨다.
 *
 * 예전에는 이런 판이 저절로 정리됐다 — 자정이 지나면 "오늘 판"이 바뀌면서 밀려났고,
 * 재시작하면 부팅 취소가 걷어 갔다. 그 두 장치가 다 없어졌으므로(날짜로 고르지 않고,
 * 재시작도 늘 일어나지는 않는다) 막힌 판을 사람이 풀 수 있어야 한다.
 *
 * 지우는 것이 아니라 취소로 표시한다. 이미 돌아간 핸드와 등록 기록은 남는다 —
 * 무슨 일이 있었는지 지우면 다시 볼 방법이 없다. 상금은 대회가 끝날 때만 나가므로
 * 중단된 판은 원장을 건드리지 않았고, 따라서 경제도 어긋나지 않는다.
 */
export function cancelRunningTournament():
  { ok: true; id: number; refunded: number } | { ok: false; error: 'none_running' } {
  return tx(() => {
    const t = one<{ id: number }>(
      `SELECT id FROM holdem_tournaments
        WHERE started_at IS NOT NULL AND finished_at IS NULL AND cancelled_at IS NULL
        ORDER BY id DESC LIMIT 1`);
    if (!t) return { ok: false as const, error: 'none_running' as const };
    run(`UPDATE holdem_tournaments SET cancelled_at = unixepoch() WHERE id = ?`, t.id);
    /* 참가비를 걷었으면 돌려준다. 판이 끝까지 가지 않아 상금이 나가지 않았으므로,
       돌려주지 않으면 걷기만 하고 아무에게도 주지 않은 돈이 된다. */
    const refunded = refundEntries(t.id, 'holdem:abort:');
    return { ok: true as const, id: t.id, refunded };
  });
}

/* ── 사용자 · 포인트 ──────────────────────────────────────────────── */

export interface AdminUserRow {
  id: string; username: string; avatar: string | null;
  balance: number; role: string | null; last_active: number | null;
}

/** 이름이나 아이디로 찾는다. 빈 검색어는 최근 활동 순으로 보여 준다. */
/**
 * 이름이나 아이디로 찾는다. 빈 검색어는 최근 활동 순으로 보여 준다.
 *
 * 한글은 같은 글자를 두 가지로 적을 수 있다 — "태준"을 완성형 두 자로도, 자모 여섯 개로도
 * 저장할 수 있다(NFC / NFD). 보기에는 같지만 바이트가 달라서 LIKE 로는 안 걸린다.
 * 디스코드 이름이 어느 쪽으로 오는지는 그 사람이 쓴 기기와 입력기에 달렸으므로,
 * 양쪽을 같은 모양으로 맞춰 놓고 비교한다.
 *
 * SQLite 에는 정규화 함수가 없어서 자바스크립트에서 거른다. 인원이 수십 명 규모라
 * 전부 읽어 걸러도 부담이 없다 — 그 규모를 넘어가면 이름 정규화 열을 따로 두어야 한다.
 */
export function searchUsers(q: string, limit = 20): AdminUserRow[] {
  const term = q.trim();
  if (term === '') {
    return all<AdminUserRow>(
      `SELECT id, username, avatar, balance, role, last_active FROM users
        ORDER BY last_active DESC, balance DESC LIMIT ?`, limit);
  }
  const norm = (s: string) => s.normalize('NFC').toLowerCase();
  const needle = norm(term);
  return all<AdminUserRow>(
    `SELECT id, username, avatar, balance, role, last_active FROM users
      ORDER BY balance DESC`)
    .filter(u => norm(u.username ?? '').includes(needle) || u.id.includes(term))
    .slice(0, limit);
}

export interface LedgerRow {
  id: number; delta: number; reason: string; balance_after: number; created_at: number;
}

/**
 * 한 사람의 원장. 읽기만 한다.
 *
 * 운영자가 "이 사람 잔액이 왜 이런가"에 답할 수 있어야 한다. 잔액은 이 표의 누적합과
 * 같다는 것이 이 서비스의 경제 불변식인데, 정작 그 표를 볼 방법이 없었다 —
 * 포인트를 지급하거나 상금을 회수한 뒤 무슨 일이 있었는지 확인할 자리가 없었다.
 *
 * 최근 것부터 준다. 오래된 기록을 뒤지는 일은 드물고, 방금 한 조치가 제대로 남았는지
 * 보는 일이 대부분이다.
 */
export function userLedger(userId: string, limit = 50): LedgerRow[] {
  return all<LedgerRow>(
    `SELECT id, delta, reason, balance_after, created_at FROM points_ledger
      WHERE user_id = ? ORDER BY id DESC LIMIT ?`, userId, Math.min(200, Math.max(1, limit)));
}

export type GrantError = 'no_user' | 'bad_amount' | 'would_go_negative';

/**
 * 포인트를 주거나 뺀다. 반드시 adjustBalance 를 거친다 — 원장을 함께 써야 하기 때문이다.
 * 잔액을 음수로 만드는 차감은 막는다. 음수 잔액은 게임 어디에서도 상정하지 않은 상태다.
 */
export function grantPoints(userId: string, delta: number, memo: string):
  { ok: true; balance: number } | { ok: false; error: GrantError } {
  const amount = Math.floor(Number(delta));
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, error: 'bad_amount' };
  return tx(() => {
    const u = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId);
    if (!u) return { ok: false as const, error: 'no_user' as const };
    if (u.balance + amount < 0) return { ok: false as const, error: 'would_go_negative' as const };
    const note = memo.trim().slice(0, 40);
    const reason = 'admin:' + (note || 'manual');
    const balance = adjustBalance(userId, amount, reason);
    /* 받은 사람에게 알린다. 사유를 함께 담는 것이 핵심이다 — 잔액만 달라져 있으면
       받은 쪽은 그것이 선물인지 정산 오류인지 알 수 없다.
       회수(음수)도 알린다. 조용히 줄어드는 쪽이 훨씬 나쁘다. */
    const gave = amount > 0;
    notifyUser(userId,
      'POINT_GIFT',
      gave ? '포인트를 받았습니다' : '포인트가 회수되었습니다',
      (gave ? '+' : '') + amount.toLocaleString('ko-KR') + 'P'
      + (note ? ' · ' + note : ''));
    return { ok: true as const, balance };
  });
}
