/*
 * PKO(바운티) 감사.
 *
 * 여기서 지키려는 것은 하나다 — **걷은 바운티가 1P 도 남지 않고 1P 도 늘지 않고
 * 유저에게 돌아간다.** 요구서의 "1P 의 오차도 없이 분배"이고, 이 서비스의 유일한
 * 불변식(잔액 = 원장 누적합)과 같은 무게다.
 *
 * 그래서 검사를 계산 재현이 아니라 원장으로 한다: 실제 등록·실제 KO·실제 마감을 태우고
 * points_ledger 에 찍힌 바운티 관련 항목의 합이 걷은 펀드와 같은지 본다. 계산을 다시
 * 구현해 비교하면 같은 실수를 두 번 해도 통과한다.
 */
import fsx from 'node:fs';
import os from 'node:os';
import path from 'node:path';
if (!process.env.DB_PATH) {
  process.env.DB_PATH = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-pko-'));
}
import { getDb } from '../src/db/schema';
import * as Q from '../src/db/queries';
import * as T from '../src/services/tournament';
import * as HD from '../src/db/holdem';
import * as AD from '../src/db/admin';

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
function section(s: string): void { console.log('\n' + s); }

const db = getDb();
const now = (): number => Math.floor(Date.now() / 1000);
const c = (rank: number, suit = 0): number => rank * 4 + suit;

function wipe(): void {
  db.exec(`DELETE FROM holdem_hand_seats; DELETE FROM holdem_hands; DELETE FROM holdem_seats;
           DELETE FROM holdem_tables; DELETE FROM holdem_entries; DELETE FROM holdem_tournaments;`);
}
function mkUser(id: string, bal: number): void {
  Q.upsertUser(id, id, null);
  const cur = db.prepare(`SELECT balance FROM users WHERE id = ?`).get(id) as { balance: number };
  Q.adjustBalance(id, bal - cur.balance, 'test:seed');
}
/** 바운티 관련 원장 항목의 합 — 실제로 유저에게 나간 바운티다 */
function bountyPaid(tid: number): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger WHERE reason LIKE ?`,
    ).get('game:holdem:bounty%' + '') as { s: number }).s;
  void tid;
}
function entriesOf(tid: number) {
  return db.prepare(
    `SELECT user_id, bounty, bounty_won, ko_count, prize, finish_place, paid_in
       FROM holdem_entries WHERE tournament_id = ? ORDER BY user_id`).all(tid) as {
    user_id: string; bounty: number; bounty_won: number; ko_count: number;
    prize: number; finish_place: number | null; paid_in: number;
  }[];
}

async function main(): Promise<void> {
  /* ── 1. 순수 계산 ────────────────────────────────────────────── */
  section('[1] 나누기 — 쪼갠 값의 합이 언제나 원래 값이다');
  {
    /* 여기가 무너지면 총액이 무너진다. 홀수·1P·0 처럼 내림이 물리는 값을 특히 본다.
       "합이 원래 값"을 성질로 검사한다 — 기대값을 손으로 적으면 그 표가 곧 두 번째 구현이다. */
    for (const b of [0, 1, 2, 3, 7, 99, 100, 101, 999, 1_000, 12_345, 1_000_001]) {
      const s = T.bountySplit(b);
      ck(`${b}: 머리+현금 = 원래 값`, s.head + s.cash === Math.floor(b), `${s.head}+${s.cash}`);
      ck(`${b}: 음수가 없다`, s.head >= 0 && s.cash >= 0);
    }
    for (const b of [0, 1, 5, 7, 100, 999, 12_345]) {
      for (const w of [1, 2, 3, 4, 7]) {
        const parts = T.splitBounty(b, w);
        const sum = parts.reduce((n, x) => n + x, 0);
        ck(`${b} 을 ${w} 명이: 합이 원래 값`, sum === Math.floor(b), `${sum} vs ${b}`);
        ck(`${b} 을 ${w} 명이: 몫 수가 맞다`, parts.length === w);
        /* 몫 차이가 1P 를 넘으면 "나눠 가졌다"가 아니라 누군가 손해를 본 것이다 */
        ck(`${b} 을 ${w} 명이: 몫 차이가 1P 이내`,
          Math.max(...parts) - Math.min(...parts) <= 1, parts.join(','));
      }
    }
    ck('0 명에게 나누면 빈 배열', T.splitBounty(100, 0).length === 0);
    // 참가비 쪼개기도 같은 성질이어야 한다
    for (const f of [0, 1, 999, 1_000, 10_001]) {
      ck(`참가비 ${f}: 상금몫+바운티몫 = 참가비`,
        T.prizeShare(f) + T.bountyShare(f) === Math.floor(f),
        `${T.prizeShare(f)}+${T.bountyShare(f)}`);
    }
    /* 비율 상수를 어떤 값으로 바꿔도 보존이 유지되는가 — 요구서의 "현금 100% + 머리 50%"
       같은 합이 100% 가 아닌 설정이 들어올 수 없는 구조인지 본다. */
    ck('머리 비율이 0~1 사이다', T.PKO_HEAD_RATIO >= 0 && T.PKO_HEAD_RATIO <= 1,
      String(T.PKO_HEAD_RATIO));
    /* 바운티 몫은 이제 대회마다 다르다 — 범위 밖 값이 들어와도 다듬어져야 한다.
       0% 면 바운티가 없어 모드의 뜻이 사라지고, 100% 를 넘으면 순위 상금이 음수가 된다. */
    for (const v of [-50, 0, 5, 10, 50, 100, 150, NaN, null, undefined]) {
      const got = T.clampBountyPct(v as never);
      ck(`몫 ${String(v)} → ${got}% (범위 안)`,
        got >= T.BOUNTY_PCT_MIN && got <= T.BOUNTY_PCT_MAX);
    }
    ck('기본값이 범위 안이다',
      T.BOUNTY_PCT_DEFAULT >= T.BOUNTY_PCT_MIN && T.BOUNTY_PCT_DEFAULT <= T.BOUNTY_PCT_MAX);
    /* 몫을 어떤 값으로 잡아도 두 갈래의 합이 1인당 금액이어야 한다 — 여기가 무너지면
       걷은 돈보다 많거나 적게 나간다. */
    for (const pct of [10, 33, 50, 67, 100]) {
      for (const unit of [3, 999, 1_001, 10_000, 123_457]) {
        ck(`몫 ${pct}% · ${unit}P: 바운티+상금 = 1인당 금액`,
          T.bountyShare(unit, pct) + T.prizeShare(unit, pct) === unit,
          `${T.bountyShare(unit, pct)}+${T.prizeShare(unit, pct)}`);
      }
    }
    const src = fsx.readFileSync('src/services/tournament.ts', 'utf8');
    ck('현금은 "나머지 전부" 로 계산한다 (별도 비율 상수가 없다)',
      /cash:\s*b\s*-\s*head/.test(src));
  }

  /* ── 2. 참가비 쪼개기 ───────────────────────────────────────── */
  section('[2] 등록 — 참가비가 두 통으로 갈리고 펀드가 그 합이다');
  const BUY = 10_000;
  let tid = 0;
  {
    wipe();
    for (const p of ['p1', 'p2', 'p3']) mkUser(p, 100_000);
    const made = AD.createTournament({
      title: 'PKO 검사', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: BUY, mode: 'PKO_BOUNTY',
    });
    ck('PKO 대회가 열린다', made.ok, made.ok ? '' : made.error);
    if (!made.ok) { console.log('열지 못해 중단'); process.exit(1); }
    tid = made.id;
    const t0 = db.prepare(`SELECT mode, bounty_pool FROM holdem_tournaments WHERE id = ?`)
      .get(tid) as { mode: string; bounty_pool: number };
    ck('mode 가 PKO_BOUNTY 다', t0.mode === 'PKO_BOUNTY', t0.mode);
    ck('아직 걷은 펀드가 없다', t0.bounty_pool === 0, String(t0.bounty_pool));

    for (const p of ['p1', 'p2', 'p3']) HD.registerHoldem(p, p);
    const rows = entriesOf(tid);
    ck('세 명이 등록됐다', rows.length === 3, String(rows.length));
    const share = T.bountyShare(BUY);
    ck('머리 값이 바운티 몫이다', rows.every(r => r.bounty === share),
      rows.map(r => r.bounty).join(','));
    ck('걷은 금액은 참가비 전액이다', rows.every(r => r.paid_in === BUY));
    const t1 = db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
      .get(tid) as { bounty_pool: number };
    ck('펀드 = 머리 값의 합', t1.bounty_pool === share * 3, `${t1.bounty_pool} vs ${share * 3}`);
    /* 상금 팟은 나머지로만 세어야 한다 — 전액으로 세면 화면이 약속한 상금이 실제보다 크다 */
    const t = db.prepare(`SELECT * FROM holdem_tournaments WHERE id = ?`).get(tid) as never;
    ck('상금 팟은 나머지 몫으로만 센다',
      HD.prizePoolOf(t, 3) === T.prizeShare(BUY) * 3,
      `${HD.prizePoolOf(t, 3)} vs ${T.prizeShare(BUY) * 3}`);
    ck('상금 팟 + 펀드 = 걷은 총액',
      HD.prizePoolOf(t, 3) + t1.bounty_pool === BUY * 3);

    // 등록을 물리면 펀드에서도 빠져야 한다
    HD.unregisterHoldem('p3');
    const t2 = db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
      .get(tid) as { bounty_pool: number };
    ck('등록 취소가 펀드를 되돌린다', t2.bounty_pool === share * 2,
      `${t2.bounty_pool} vs ${share * 2}`);
    ck('취소한 사람은 전액 환급',
      (db.prepare(`SELECT balance FROM users WHERE id = 'p3'`).get() as { balance: number })
        .balance === 100_000);
  }

  /* ── 3. CLASSIC 은 아무것도 달라지지 않는다 ───────────────────── */
  section('[2-b] 프리롤 PKO — 참가비 없이 상금 배수를 반으로 가른다');
  {
    /* 바운티는 "1인당 금액의 절반"이고, 프리롤에도 1인당 금액이 있다(상금 배수).
       한때 참가비만 보고 프리롤을 통째로 막아 두었는데 막을 이유가 없었다 —
       배수 10,000 이면 5,000 은 상금 5,000 은 머리 값으로 두면 되고, 서비스가 발행하는
       총액은 어느 쪽이든 인원 × 배수로 같다. */
    wipe();
    const MULT = 10_000;
    const who = ['fr1', 'fr2', 'fr3', 'fr4'];
    for (const p of who) mkUser(p, 100_000);
    const made = AD.createTournament({
      title: '프리롤 PKO', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: 0, prizeMultiplier: MULT, prizeFixed: 0, mode: 'PKO_BOUNTY',
    });
    ck('프리롤에도 바운티를 걸 수 있다', made.ok, made.ok ? '' : made.error);
    if (made.ok) {
      for (const p of who) HD.registerHoldem(p, p);
      const t = db.prepare(`SELECT * FROM holdem_tournaments WHERE id = ?`).get(made.id) as never;
      const rows = entriesOf(made.id);
      ck('1인당 금액은 배수다', HD.bountyUnitOf(t) === MULT, String(HD.bountyUnitOf(t)));
      ck('머리 값이 배수의 절반이다', rows.every(r => r.bounty === T.bountyShare(MULT)),
        rows.map(r => r.bounty).join(','));
      ck('참가비는 걷지 않는다', rows.every(r => r.paid_in === 0));
      const pool = (db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
        .get(made.id) as { bounty_pool: number }).bounty_pool;
      ck('펀드 = 머리 값의 합', pool === T.bountyShare(MULT) * who.length, String(pool));
      /* 상금 팟 + 펀드가 "배수 × 인원" 과 같아야 한다 — 어긋나면 서비스가 발행하는
         총액이 예전 프리롤과 달라진다(운영자가 약속한 금액이 바뀐다). */
      ck('상금 팟 + 펀드 = 배수 × 인원',
        HD.prizePoolOf(t, who.length) + pool === MULT * who.length,
        `${HD.prizePoolOf(t, who.length)} + ${pool} vs ${MULT * who.length}`);
      ck('상금 팟은 나머지 몫으로만 센다',
        HD.prizePoolOf(t, who.length) === T.prizeShare(MULT) * who.length);
    }
    /* 1인당 금액이 없는 판(배수 0 · GTD 만)에는 걸 수 없어야 한다 — 열리면
       "이름만 바운티 대회"가 된다. 화면도 잠그지만 화면을 안 거치는 경로가 있다. */
    wipe();
    const bad = AD.createTournament({
      title: 'GTD 만', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: 0, prizeMultiplier: 0, prizeFixed: 50_000, mode: 'PKO_BOUNTY',
    });
    ck('배수도 참가비도 0 이면 바운티 대회를 거부한다', !bad.ok,
      bad.ok ? '열렸다' : String((bad as { detail?: string }).detail ?? bad.error));
    // 어드민 화면도 같은 기준으로 잠근다
    const admSrc = fsx.readFileSync('src/web/admin.ts', 'utf8');
    ck('화면은 1인당 금액으로 잠근다 (참가 방식이 아니라)',
      /ncMode\.disabled = unit <= 0/.test(admSrc));
    ck('금액을 고치면 잠금이 따라온다',
      /\['ncBuyIn', 'ncMult', 'ncPct'\]\.forEach/.test(admSrc));
  }

  section('[2-c] 미스터리 바운티 — 봉투가 제각각이고 열릴 때까지 감춰진다');
  {
    /* 봉투 나누기부터 본다. 합이 펀드와 정확히 같아야 하고, 잭팟이 실제로 커야 한다 —
       전부 비슷하면 봉투를 열 이유가 없고, 합이 어긋나면 없는 돈이 나가거나 남는다. */
    for (const n of [2, 3, 6, 9, 12]) {
      for (const fund of [3, 999, 30_000, 90_000, 123_457]) {
        const e = T.mysteryEnvelopes(fund, n);
        ck(`봉투 ${n}개 · 펀드 ${fund}: 합이 펀드와 같다`,
          e.reduce((a, b) => a + b, 0) === fund, `${e.reduce((a, b) => a + b, 0)}`);
        ck(`봉투 ${n}개 · 펀드 ${fund}: 개수가 인원과 같다`, e.length === n);
        ck(`봉투 ${n}개 · 펀드 ${fund}: 음수가 없다`, e.every(x => x >= 0));
        /* 봉투 수를 인원과 같게 두는 이유: KO 가 인원-1 번이고 마지막 하나를 우승자가
           열어서 남는 봉투가 없다. 그래서 개수 검사가 총액 검사와 같은 무게다. */
        if (fund >= 30_000) {
          ck(`봉투 ${n}개 · 펀드 ${fund}: 잭팟이 가장 크다`,
            e[0] === Math.max(...e), `${e[0]} vs ${Math.max(...e)}`);
        }
      }
    }
    ck('0 명이면 빈 배열', T.mysteryEnvelopes(1_000, 0).length === 0);

    /* 실제 대회를 열어 봉투가 배정되고, 감춰지고, 열리는지 본다. */
    wipe();
    const BUY2 = 10_000;
    const who = ['m1', 'm2', 'm3', 'm4'];
    for (const p of who) mkUser(p, 100_000);
    const made = AD.createTournament({
      title: '미스터리', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: BUY2, mode: 'MYSTERY_BOUNTY', bountyPct: 100,
    });
    ck('미스터리 대회가 열린다', made.ok, made.ok ? '' : made.error);
    if (!made.ok) { console.log('열지 못해 중단'); process.exit(1); }
    const mid = made.id;
    for (const p of who) HD.registerHoldem(p, p);
    const trow = db.prepare(`SELECT * FROM holdem_tournaments WHERE id = ?`).get(mid) as never;
    ck('isMystery 가 참이다', HD.isMystery(trow));
    ck('isPko 도 참이다 (바운티가 걸린 판이다)', HD.isPko(trow));
    /* 이 판은 100% 로 열었다 — 전액 바운티면 순위 상금이 한 푼도 남지 않아야 한다 */
    ck('고른 몫(100%)이 그대로 쓰인다', HD.bountyPctOf(trow) === 100,
      String(HD.bountyPctOf(trow)));
    ck('전액 바운티면 순위 상금 팟이 0 이다', HD.prizePoolOf(trow, who.length) === 0,
      String(HD.prizePoolOf(trow, who.length)));
    const pool2 = (db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
      .get(mid) as { bounty_pool: number }).bounty_pool;
    ck('펀드가 걷은 전액이다', pool2 === BUY2 * who.length, String(pool2));

    // 시작하면 봉투가 배정된다
    db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
    HD.advanceHoldem();
    const rows2 = db.prepare(
      `SELECT user_id, bounty, bounty_revealed FROM holdem_entries WHERE tournament_id = ?`)
      .all(mid) as { user_id: string; bounty: number; bounty_revealed: number }[];
    ck('봉투 합이 펀드와 같다', rows2.reduce((s, r) => s + r.bounty, 0) === pool2,
      `${rows2.reduce((s, r) => s + r.bounty, 0)} vs ${pool2}`);
    /* 금액이 제각각이어야 한다 — 전부 같으면 봉투가 아니라 균등 배분이다 */
    ck('금액이 제각각이다', new Set(rows2.map(r => r.bounty)).size > 1,
      rows2.map(r => r.bounty).join(','));
    ck('시작 시점에는 아무 봉투도 열려 있지 않다',
      rows2.every(r => r.bounty_revealed === 0));

    /* 감추는 일을 화면에 맡기면 안 된다 — 응답에 들어 있으면 개발자 도구로 그대로 읽히고,
       그러면 감춘 것이 아니다. 홀 카드와 같은 규율이므로 소스에서 확인한다. */
    const stSrc = fsx.readFileSync('src/web/games/holdem.ts', 'utf8');
    ck('열리지 않은 봉투는 payload 에 실리지 않는다',
      /\(mysteryOn && e\.bounty_revealed !== 1\) \? null : e\.bounty/.test(stSrc));
    ck('내 봉투도 감춘다 (본인조차 모른다)',
      /isMystery\(t\) && entries\.find\([\s\S]{0,80}?bounty_revealed !== 1/.test(stSrc));
    ck('0 이 아니라 null 로 준다 (빈 봉투와 구분된다)',
      /\? null : e\.bounty/.test(stSrc));
    /* 화면은 null 을 물음표로 그린다. seatsSrc 는 뒤쪽 [8] 절에서 다시 읽으므로
       여기서는 지역 변수로 따로 읽는다 — 절 사이에 변수를 공유하면 순서를 바꿀 수 없다. */
    const seatsSrc2 = fsx.readFileSync('src/web/games/holdem-client/seats.ts', 'utf8');
    ck('감춘 봉투는 물음표로 그린다',
      /bEl\.textContent = '\?'/.test(seatsSrc2) && /classList\.add\('sealed'\)/.test(seatsSrc2));
    ck('물음표에서 금액으로 뒤집히는 것도 상승으로 본다',
      /prev !== undefined && \(prev === null \|\| bv > prev\)/.test(seatsSrc2));
    /* 등수 표와 갈래 줄은 모드가 아니라 "순위 상금이 실제로 있는지"로 갈라야 한다 —
       모드로 가르면 순위 상금을 남긴 미스터리에서 상금표가 사라진다. */
    const sideSrc = fsx.readFileSync('src/web/games/holdem-client/side.ts', 'utf8');
    ck('등수 표는 순위 상금이 있을 때만 그린다',
      /var hasRank = t\.prizePool > 0/.test(sideSrc)
      && /hasRank \? '<div class="ht-pz-list">/.test(sideSrc));
    ck('갈래 줄도 순위 상금 유무로 가른다', /\(isPko && hasRank/.test(sideSrc));
    ck('모드로 등수 표를 가르지 않는다', !/mystery \? '' : '<div class="ht-pz-list">/
      .test(sideSrc));
    // 어드민에서 고를 수 있고, 비율은 두 바운티 모드가 함께 쓴다
    const admSrc2 = fsx.readFileSync('src/web/admin.ts', 'utf8');
    ck('어드민에 미스터리 선택이 있다', /value="MYSTERY_BOUNTY"/.test(admSrc2));
    ck('바운티 몫 입력이 있다', /id="ncPct"/.test(admSrc2));
    ck('몫 입력은 일반 대회에서만 감춘다',
      /pctWrap\.hidden = ncMode\.value === 'CLASSIC'/.test(admSrc2));
    ck('서버가 모드로 몫을 덮어쓰지 않는다',
      !/mode === 'MYSTERY_BOUNTY' \? 100/
        .test(fsx.readFileSync('src/db/admin.ts', 'utf8')));
    ck('bountyPctOf 가 미스터리를 예외로 두지 않는다',
      !/isMystery\(t\)\) return 100/.test(fsx.readFileSync('src/db/holdem.ts', 'utf8')));
  }

  /* 미스터리도 순위 상금을 함께 둘 수 있다. 모드가 정하는 것은 "금액을 감추는가"와
     "잡은 사람이 독식하는가"이고, 순위 상금을 남길지는 그것과 별개다. 여기서는 몫을
     쪼갠 판이 두 갈래로 정확히 갈리고, 걷은 돈이 한 푼도 새지 않는지를 원장으로 본다. */
  section('[2-d] 미스터리 + 순위 상금 — 몫을 쪼개도 갈래와 총액이 맞는다');
  {
    for (const pct of [10, 40, 60, 75, 100]) {
      wipe();
      const BUY3 = 7_777;                       // 나누면 딱 떨어지지 않는 값으로 본다
      const who3 = ['s1', 's2', 's3', 's4', 's5'];
      for (const p of who3) mkUser(p, 100_000);
      const mk = AD.createTournament({
        title: `미스터리 ${pct}%`, regOpenAt: now() - 60, startAt: now() + 3_600,
        buyIn: BUY3, mode: 'MYSTERY_BOUNTY', bountyPct: pct,
      });
      ck(`${pct}%: 대회가 열린다`, mk.ok, mk.ok ? '' : mk.error);
      if (!mk.ok) continue;
      for (const p of who3) HD.registerHoldem(p, p);
      const tr = db.prepare(`SELECT * FROM holdem_tournaments WHERE id = ?`)
        .get(mk.id) as { bounty_pool: number; bounty_pct: number };
      ck(`${pct}%: 고른 몫이 행에 남는다`, tr.bounty_pct === pct, String(tr.bounty_pct));
      ck(`${pct}%: bountyPctOf 가 그 값을 읽는다`,
        HD.bountyPctOf(tr as never) === pct, String(HD.bountyPctOf(tr as never)));

      /* 두 갈래의 합이 걷은 전액이어야 한다 — 한쪽을 비율로 정하고 다른 쪽을 "나머지"로
         두었으므로 이 등식은 구조적으로 성립한다. 그래도 확인한다: 예전에 keep 이 0 일 때
         프리롤 경로로 새어 상금이 두 배가 된 적이 있다. */
      const unit = BUY3;
      const wantBty = Math.floor(unit * pct / 100);
      const collected = unit * who3.length;
      ck(`${pct}%: 펀드가 1인당 ${wantBty}P × ${who3.length} 이다`,
        tr.bounty_pool === wantBty * who3.length, String(tr.bounty_pool));
      const rank = HD.prizePoolOf(tr as never, who3.length);
      ck(`${pct}%: 순위 상금 팟이 나머지다`,
        rank === (unit - wantBty) * who3.length, `${rank}`);
      ck(`${pct}%: 두 갈래 합이 걷은 전액이다`,
        rank + tr.bounty_pool === collected, `${rank}+${tr.bounty_pool} vs ${collected}`);
      /* 내 봉투는 감춰지지만, 배정 전 등록 시점의 머리 값은 1인 몫이어야 한다 */
      ck(`${pct}%: 등록 시 머리 값이 1인 몫이다`,
        entriesOf(mk.id).every(r => r.bounty === wantBty),
        entriesOf(mk.id).map(r => r.bounty).join(','));

      // 봉투는 바운티 갈래만 흩는다 — 순위 상금까지 봉투에 들어가면 상금이 사라진다
      db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
      HD.advanceHoldem();
      const envs = entriesOf(mk.id).map(r => r.bounty);
      ck(`${pct}%: 봉투 합이 바운티 갈래와 같다`,
        envs.reduce((a, b) => a + b, 0) === tr.bounty_pool,
        `${envs.reduce((a, b) => a + b, 0)} vs ${tr.bounty_pool}`);
      ck(`${pct}%: 봉투가 제각각이다`, new Set(envs).size > 1, envs.join(','));
    }
    /* 독식 규칙은 몫과 무관하게 유지돼야 한다 — 잡으면 전액을 받고 내 머리는 그대로다.
       (PKO 는 절반만 현금이고 절반이 머리로 옮겨간다.) */
    const hdSrc = fsx.readFileSync('src/db/holdem.ts', 'utf8');
    ck('미스터리는 머리 몫이 0 이다 (잡은 사람이 독식한다)',
      /isMystery\(t\) \? 0 : T\.PKO_HEAD_RATIO/.test(hdSrc));
  }

  section('[3] 일반 대회 — 바운티 칸이 전부 0 이다');
  {
    wipe();
    for (const p of ['c1', 'c2', 'c3']) mkUser(p, 100_000);
    const made = AD.createTournament({
      title: '일반', regOpenAt: now() - 60, startAt: now() + 3_600, buyIn: BUY,
    });
    if (!made.ok) { console.log('일반 대회 실패'); process.exit(1); }
    for (const p of ['c1', 'c2', 'c3']) HD.registerHoldem(p, p);
    const t = db.prepare(`SELECT * FROM holdem_tournaments WHERE id = ?`).get(made.id) as
      { mode: string; bounty_pool: number };
    ck('mode 는 CLASSIC 이다', t.mode === 'CLASSIC', t.mode);
    ck('isPko 가 false 다', !HD.isPko(t));
    ck('펀드가 0 이다', t.bounty_pool === 0, String(t.bounty_pool));
    ck('머리 값이 전부 0 이다', entriesOf(made.id).every(r => r.bounty === 0));
    /* 상금 팟은 예전 그대로 전액이어야 한다 — PKO 계산이 일반 판에 새면 상금이 반토막 난다 */
    ck('상금 팟은 참가비 전액으로 센다',
      HD.prizePoolOf(t as never, 3) === BUY * 3, String(HD.prizePoolOf(t as never, 3)));
  }

  /* ── 4. 실제 KO 정산 ────────────────────────────────────────── */
  section('[4] KO — 머리 값이 절반은 현금, 절반은 머리로 옮겨간다');
  {
    wipe();
    for (const p of ['k1', 'k2', 'k3', 'k4']) mkUser(p, 100_000);
    const made = AD.createTournament({
      title: 'KO 검사', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: BUY, mode: 'PKO_BOUNTY',
    });
    if (!made.ok) { console.log('KO 대회 실패'); process.exit(1); }
    const id = made.id;
    for (const p of ['k1', 'k2', 'k3', 'k4']) HD.registerHoldem(p, p);
    db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
    HD.advanceHoldem();
    const table = HD.getTable(id)!;
    const hand = HD.getCurrentHand(table.id)!;

    /* 승패를 카드로 못 박는다 — 확률에 맡기면 감사가 이따금 실패한다.
       k1 에게 AA, 나머지에게 22·33, 보드는 7·9·J·Q·K (페어·플러시·스트레이트 없음). */
    const hole: Record<string, number[]> = {
      k1: [c(12, 0), c(12, 1)], k2: [c(0, 0), c(0, 1)],
      k3: [c(1, 0), c(1, 1)], k4: [c(2, 0), c(2, 1)],
    };
    for (const s of HD.getSeats(table.id)) {
      db.prepare(`UPDATE holdem_hand_seats SET hole_json = ? WHERE hand_id = ? AND seat = ?`)
        .run(JSON.stringify(hole[s.user_id]), hand.id, s.seat);
    }
    db.prepare(`UPDATE holdem_hands SET board_json = ? WHERE id = ?`)
      .run(JSON.stringify([c(5, 2), c(7, 3), c(9, 0), c(10, 1), c(11, 3)]), hand.id);
    // 짧은 둘이 같은 판에 털린다 → k1 이 KO 둘
    for (const [uid, v] of [['k2', 300], ['k3', 900]] as [string, number][]) {
      db.prepare(`UPDATE holdem_hand_seats SET stack = ? WHERE hand_id = ? AND user_id = ?`)
        .run(v, hand.id, uid);
      db.prepare(`UPDATE holdem_seats SET stack = ? WHERE table_id = ? AND user_id = ?`)
        .run(v, table.id, uid);
    }
    const before = new Map(entriesOf(id).map(r => [r.user_id, r.bounty]));
    const balBefore = (db.prepare(`SELECT balance FROM users WHERE id = 'k1'`)
      .get() as { balance: number }).balance;

    for (let i = 0; i < 60; i++) {
      const h = HD.getCurrentHand(table.id);
      if (!h || h.ended_at != null || h.to_act_seat == null) break;
      const seat = HD.getSeats(table.id).find(x => x.seat === h.to_act_seat)!;
      db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`).run(now() + HD.ACTION_SEC, h.id);
      /* k4 는 접는다. 넷 다 올인시키면 셋이 한 판에 털려 대회가 그 자리에서 끝나고,
         마감 정산까지 돌아 버려서 "진행 중"을 볼 수 없다(그래서 이 검사가 두 번 헛돌았다). */
      if (seat.user_id === 'k4') { HD.holdemAction('k4', 'fold', 0); continue; }
      if (!HD.holdemAction(seat.user_id, 'allin', 0).ok) HD.holdemAction(seat.user_id, 'call', 0);
    }

    const after = entriesOf(id);
    const k1 = after.find(r => r.user_id === 'k1')!;
    const share = T.bountyShare(BUY);
    /* 털린 둘만 0 이어야 한다. 접고 살아남은 k4 는 자기 머리 값을 그대로 들고 있다 —
       "k1 이 아닌 전부"로 적으면 그 정상 동작이 실패로 잡힌다. */
    ck('검사 전제: 짧은 둘이 털렸다',
      after.filter(r => r.user_id === 'k2' || r.user_id === 'k3').every(r => r.bounty === 0),
      after.map(r => `${r.user_id}=${r.bounty}`).join(','));
    ck('접고 살아남은 사람은 머리 값을 지킨다',
      after.find(r => r.user_id === 'k4')!.bounty === T.bountyShare(BUY),
      String(after.find(r => r.user_id === 'k4')!.bounty));
    ck('검사 전제: KO 가 둘이다', k1.ko_count === 2, String(k1.ko_count));

    /* 머리 값 두 개(각 share)를 가져갔으니 절반씩 머리로 오고 절반씩 현금이다 */
    const one = T.bountySplit(share);
    ck('머리가 자기 몫 + 얻은 몫 만큼 늘었다',
      k1.bounty === (before.get('k1') ?? 0) + one.head * 2,
      `${k1.bounty} vs ${(before.get('k1') ?? 0) + one.head * 2}`);
    ck('현금 누계가 맞다', k1.bounty_won === one.cash * 2,
      `${k1.bounty_won} vs ${one.cash * 2}`);
    /* 원장에 실제로 들어갔는지 본다 — 표만 고치고 잔액을 안 올리는 실수가 가장 흔하다 */
    const balAfter = (db.prepare(`SELECT balance FROM users WHERE id = 'k1'`)
      .get() as { balance: number }).balance;
    ck('현금이 잔액에 즉시 들어갔다', balAfter - balBefore === one.cash * 2,
      `${balAfter - balBefore} vs ${one.cash * 2}`);
    ck('원장에 바운티 항목이 남았다',
      (db.prepare(
        `SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = 'k1' AND reason LIKE 'game:holdem:bounty%'`)
        .get() as { n: number }).n > 0);

    /* 이 순간의 보존: 아직 마감 전이라도 [현금으로 나간 것 + 머리에 남은 것] 이 펀드와 같아야 한다 */
    const pool = (db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
      .get(id) as { bounty_pool: number }).bounty_pool;
    const heads = after.reduce((n, r) => n + r.bounty, 0);
    const cash = after.reduce((n, r) => n + r.bounty_won, 0);
    ck('진행 중에도 펀드가 보존된다 (머리 + 나간 현금 = 걷은 펀드)',
      heads + cash === pool, `${heads}+${cash} vs ${pool}`);
  }

  /* ── 5. 마감 — 1P 도 남지 않는다 ─────────────────────────────── */
  section('[5] 마감 — 걷은 바운티가 전부 유저에게 돌아간다');
  {
    /* 여러 인원·여러 참가비로 대회를 끝까지 돌린다. 홀수 참가비를 섞는 것이 요점이다 —
       내림이 물리는 자리가 있으면 여기서 잔돈이 남는다.
       두 바운티 모드를 같은 검사에 넣는다. 지급 규칙이 서로 다르므로(PKO 는 절반이
       머리로 옮겨가고 미스터리는 잡은 사람이 독식한다) 보존이 한쪽에서만 성립할 수 있다.
       몫을 쪼갠 판(60%/75%)도 섞는다 — 상금과 바운티 두 갈래로 나가도 총액이 맞아야 한다. */
    const CASES: [number, number, 'PKO_BOUNTY' | 'MYSTERY_BOUNTY', number][] = [
      [3, 10_000, 'PKO_BOUNTY', 50],
      [4, 9_999, 'PKO_BOUNTY', 50],
      [5, 1_001, 'PKO_BOUNTY', 50],
      [6, 3, 'PKO_BOUNTY', 50],
      [4, 9_999, 'PKO_BOUNTY', 70],
      [5, 10_000, 'MYSTERY_BOUNTY', 100],
      [4, 7_777, 'MYSTERY_BOUNTY', 60],
      [6, 1_001, 'MYSTERY_BOUNTY', 75],
      [3, 3, 'MYSTERY_BOUNTY', 40],
    ];
    for (const [n, buy, mode, pct] of CASES) {
      const tag = `${n}명/${buy}P/${mode === 'MYSTERY_BOUNTY' ? '미스터리' : 'PKO'}${pct}%`;
      wipe();
      const who = Array.from({ length: n }, (_, i) => `f${i}`);
      for (const p of who) mkUser(p, 1_000_000);
      const balBefore = new Map(who.map(p =>
        [p, (db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number }).balance]));
      const made = AD.createTournament({
        title: `마감 ${tag}`, regOpenAt: now() - 60, startAt: now() + 3_600,
        buyIn: buy, mode, bountyPct: pct,
      });
      if (!made.ok) { ck(`${tag}: 대회가 열린다`, false, made.error); continue; }
      const id = made.id;
      for (const p of who) HD.registerHoldem(p, p);
      const pool = (db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
        .get(id) as { bounty_pool: number }).bounty_pool;
      db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
      HD.advanceHoldem();
      const table = HD.getTable(id)!;

      /* 끝까지 돌린다. 카드는 손대지 않는다 — 누가 이기든 검사가 성립해야 하고,
         그게 이 검사의 요점이다(특정 승자에 기대면 보존을 증명한 것이 아니다). */
      for (let step = 0; step < 4_000; step++) {
        const tRow = db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
          .get(id) as { finished_at: number | null };
        if (tRow.finished_at != null) break;
        const h = HD.getCurrentHand(table.id);
        if (!h || h.ended_at != null || h.to_act_seat == null) {
          db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(now() - 1, table.id);
          HD.advanceHoldem();
          continue;
        }
        const seat = HD.getSeats(table.id).find(x => x.seat === h.to_act_seat);
        if (!seat) break;
        db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`).run(now() + HD.ACTION_SEC, h.id);
        if (!HD.holdemAction(seat.user_id, 'allin', 0).ok) {
          if (!HD.holdemAction(seat.user_id, 'call', 0).ok) {
            HD.holdemAction(seat.user_id, 'check', 0);
          }
        }
      }
      const done = db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
        .get(id) as { finished_at: number | null };
      ck(`${tag}: 검사 전제 — 대회가 끝났다`, done.finished_at != null);
      if (done.finished_at == null) continue;

      const rows = entriesOf(id);
      /* 이것이 이 감사의 핵심 단정문이다. 원장에 찍힌 바운티 지급의 합이 걷은 펀드와
         같은지 본다 — 계산을 다시 구현해 비교하는 것이 아니라, 실제로 유저 잔액을
         움직인 기록을 센다. */
      const paid = (db.prepare(
        `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger
          WHERE reason LIKE ?`).get(`game:holdem:bounty%${id}`) as { s: number }).s;
      const paidAll = (db.prepare(
        `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger
          WHERE reason = ? OR reason = ?`)
        .get(`game:holdem:bounty:${id}`, `game:holdem:bounty:final:${id}`) as { s: number }).s;
      ck(`${tag}: 나간 바운티 = 걷은 펀드 (1P 오차 없음)`,
        paidAll === pool, `${paidAll} vs ${pool}`);
      ck(`${tag}: 머리에 남은 값이 없다`,
        rows.every(r => r.bounty === 0), rows.map(r => `${r.user_id}=${r.bounty}`).join(','));
      ck(`${tag}: bounty_won 합 = 걷은 펀드`,
        rows.reduce((s, r) => s + r.bounty_won, 0) === pool,
        `${rows.reduce((s, r) => s + r.bounty_won, 0)} vs ${pool}`);
      void paid;

      /* 대회 전체로도 본다: 걷은 참가비 총액이 상금 + 바운티로 정확히 나갔는가.
         이쪽이 요구서의 "전체 바이인 총액 중 1P 의 오차도 없이" 그 자체다. */
      const collected = rows.reduce((s, r) => s + r.paid_in, 0);
      const prizes = rows.reduce((s, r) => s + r.prize, 0);
      ck(`${tag}: 상금 + 바운티 = 걷은 참가비`,
        prizes + paidAll === collected, `${prizes}+${paidAll} vs ${collected}`);
      /* 잔액 변화로도 확인한다. 표를 안 보고 유저 지갑만 보는 검사다 —
         표와 지갑이 어긋나는 실수를 이쪽이 잡는다. */
      const delta = who.reduce((s, p) =>
        s + ((db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number })
          .balance - (balBefore.get(p) ?? 0)), 0);
      ck(`${tag}: 참가자 잔액 총합이 그대로다 (서비스가 삼킨 돈 0)`,
        delta === 0, String(delta));
    }
  }

  /* ── 6. 이중 지급 ───────────────────────────────────────────── */
  section('[6] 이중 지급 — 두 번 불러도 한 번만 나간다');
  {
    /* 지연 진행(advanceHoldem)이 여러 요청에서 겹쳐 돈다. 마감 정산이 두 번 돌면
       없는 포인트가 발행되므로, 두 번째 호출이 아무것도 하지 않아야 한다. */
    wipe();
    for (const p of ['d1', 'd2', 'd3']) mkUser(p, 1_000_000);
    const made = AD.createTournament({
      title: '이중', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: BUY, mode: 'PKO_BOUNTY',
    });
    if (!made.ok) { console.log('이중 대회 실패'); process.exit(1); }
    const id = made.id;
    for (const p of ['d1', 'd2', 'd3']) HD.registerHoldem(p, p);
    db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
    HD.advanceHoldem();
    const table = HD.getTable(id)!;
    for (let step = 0; step < 4_000; step++) {
      const tRow = db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
        .get(id) as { finished_at: number | null };
      if (tRow.finished_at != null) break;
      const h = HD.getCurrentHand(table.id);
      if (!h || h.ended_at != null || h.to_act_seat == null) {
        db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(now() - 1, table.id);
        HD.advanceHoldem();
        continue;
      }
      const seat = HD.getSeats(table.id).find(x => x.seat === h.to_act_seat);
      if (!seat) break;
      db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`).run(now() + HD.ACTION_SEC, h.id);
      if (!HD.holdemAction(seat.user_id, 'allin', 0).ok) {
        if (!HD.holdemAction(seat.user_id, 'call', 0).ok) HD.holdemAction(seat.user_id, 'check', 0);
      }
    }
    const paidOnce = (db.prepare(
      `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger WHERE reason = ? OR reason = ?`)
      .get(`game:holdem:bounty:${id}`, `game:holdem:bounty:final:${id}`) as { s: number }).s;
    // 몇 번 더 전진시켜 본다 — 마감은 이미 지났으므로 아무 일도 없어야 한다
    for (let i = 0; i < 5; i++) HD.advanceHoldem();
    const paidTwice = (db.prepare(
      `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger WHERE reason = ? OR reason = ?`)
      .get(`game:holdem:bounty:${id}`, `game:holdem:bounty:final:${id}`) as { s: number }).s;
    ck('다시 전진시켜도 지급이 늘지 않는다', paidOnce === paidTwice,
      `${paidOnce} → ${paidTwice}`);
    ck('한 번은 실제로 나갔다', paidOnce > 0, String(paidOnce));
  }

  /* ── 7. 경제 불변식 ─────────────────────────────────────────── */
  section('[7] 잔액 = 원장 누적합');
  {
    /* 이 서비스의 유일한 불변식이다. 바운티 지급이 adjustBalance 를 안 거치면 여기서 깨진다. */
    const bad = db.prepare(
      `SELECT u.id, u.balance, COALESCE(SUM(p.delta), 0) AS s
         FROM users u LEFT JOIN points_ledger p ON p.user_id = u.id
        GROUP BY u.id HAVING u.balance != COALESCE(SUM(p.delta), 0)`).all() as unknown[];
    ck('모든 유저의 잔액이 원장 누적합과 같다', bad.length === 0, JSON.stringify(bad).slice(0, 200));
    const srcH = fsx.readFileSync('src/db/holdem.ts', 'utf8');
    ck('바운티 지급이 잔액을 직접 고치지 않는다',
      !/bounty[\s\S]{0,400}?UPDATE users SET balance/.test(srcH));
  }

  /* ── 8. UI 차별화 ───────────────────────────────────────────── */
  section('[8] 화면 — 일반 대회에는 바운티가 그려질 수 없다');
  {
    /* 요구가 명확했다: "같은 베이스지만 서로 UI 는 철저히 차별화". 그래서 검사도
       "숨겨져 있나"가 아니라 "그릴 수단 자체가 없나"를 본다 — 숨기는 방식이면 조건이
       언젠가 빠지면서 일반 판에 바운티가 뜨고, 그때는 아무도 못 알아챈다. */
    const seatsSrc = fsx.readFileSync('src/web/games/holdem-client/seats.ts', 'utf8');
    const stateSrc = fsx.readFileSync('src/web/games/holdem.ts', 'utf8');

    /* (1) 좌석 골격: 바운티 관련 요소가 전부 pko 조건 뒤에 있어야 한다.
       클래스 이름으로 줄을 찾는다 — 자국은 'ht-hole-shot s1' 처럼 뒤에 번호가 붙으므로
       정확히 일치로 찾으면 못 찾는다(한 번 그렇게 헛돌았다). */
    for (const cls of ['ht-bounty', 'ht-bgain', 'ht-hole-shot', 'ht-muzzle']) {
      /* 자국·섬광은 한 삼항식이 여러 줄에 걸쳐 있어 그 줄만 보면 `(pko ?` 가 안 보인다.
         조건이 시작된 줄부터 이어 붙여 본다. */
      const lines = seatsSrc.split(/\r?\n/);
      const at = lines.findIndex(l => l.includes(`class="${cls}`) && l.includes('span'));
      const block = at < 0 ? '' : lines.slice(Math.max(0, at - 3), at + 1).join(' ');
      ck(`${cls} 는 pko 일 때만 만들어진다`, at >= 0 && /\(pko \?/.test(block),
        at < 0 ? '(줄을 못 찾았다)' : lines[at].trim().slice(0, 70));
    }
    // (2) 골격 서명에 pko 가 들어가야 한다 — 안 들어가면 모드가 바뀌어도 DOM 이 재사용된다
    ck('좌석 골격 서명이 모드를 포함한다', /sigParts\.push\([^)]*pko/.test(seatsSrc));
    /* (3) KO 연출은 pko 조건 뒤에서만 터진다. 조건은 koShow 한 곳에 모여 있다 —
       예전에는 조건을 쓰는 자리마다 pko 를 다시 적었는데, 그러면 한 곳을 고칠 때
       다른 곳이 남는다(정산 대기를 넣으면서 실제로 그 문제가 생겼다). */
    ck('KO 조건에 pko 가 들어 있다', /var koShow = pko &&/.test(seatsSrc));
    ck('KO 조건이 한 곳에만 있다',
      (seatsSrc.match(/s\.presence === 'OUT' && resultReady\(\) && settleDone/g) ?? []).length === 1);

    // (4) payload: 일반 판에는 칸 자체가 없어야 한다
    ck('bountyPool 은 PKO 에서만 실린다', /bountyPool: isPko\(t\) \?/.test(stateSrc));
    ck('좌석 bounty 는 PKO 에서만 실린다', /bounty: pkoOn \?/.test(stateSrc));
    ck('mode 를 화면에 내려보낸다', /\bmode: t\.mode\b/.test(stateSrc));

    // (5) 소리와 CSS 가 실제로 있는지
    const appSrc = fsx.readFileSync('src/web/assets/app.js', 'utf8');
    ck('총성이 합성음으로 있다 (음원 다운로드가 없다)',
      /gunshot: function\(\)\{/.test(appSrc) && /noiseBurst\(c,/.test(appSrc));
    ck('바운티 상향 소리가 있다', /bountyUp: function\(\)\{/.test(appSrc));
    const cssSrc = fsx.readFileSync('src/web/assets/css/09-holdem.css', 'utf8');
    for (const need of ['.ht-bounty', 'htBountyUp', '.ht-hole-shot', 'htShot',
      '.ht-seat.koed', 'htKoShake']) {
      ck(`CSS 에 ${need} 가 있다`, cssSrc.includes(need));
    }
    /* (5-a) 금빛 명찰 — 아바타 상단 테두리에 물려 앉는다 */
    {
      /* 여러 규칙에 나뉘어 있으므로(transition 을 따로 둔다) 전부 이어 본다 */
      const rule = (cssSrc.match(/\.ht-bounty\{[^}]*\}/g) ?? []).join('');
      ck('명찰이 아바타 상단에 물린다 (top:-10px + X 중앙 정렬)',
        /top:-10px/.test(rule) && /transform:translateX\(-50%\)/.test(rule), rule.slice(0, 90));
      ck('금속 골드 그라데이션 (가운데 단차가 하이라이트 선을 만든다)',
        /linear-gradient\(180deg,#f0e2c8 0%,#d4b583 45%,#b8955a 50%,#ead7b7 100%\)/i.test(rule));
      ck('짙은 금테 + 안쪽 밝은 선 (두 겹이 두께감을 만든다)',
        /border:1px solid #7d6133/i.test(rule) && /inset 0 0 0 1px #fff1d0/i.test(rule));
      ck('각진 모서리 (위만 2px, 아래는 직각)', /border-radius:2px 2px 0 0/.test(rule));
      ck('펠트에서 판을 떼어 놓는 그림자', /0 2px 4px rgba\(0,0,0,\.55\)/.test(rule));
      ck('각인 느낌의 굵은 좁은 글자',
        /font-family:Impact/.test(rule) && /font-size:12px/.test(rule)
        && /font-weight:900/.test(rule) && /letter-spacing:-\.5px/.test(rule)
        && /color:#1f1406/i.test(rule));
      ck('글자 하이라이트가 있다', /text-shadow:0 1px 0 rgba\(255,255,255,\.6\)/.test(rule));
      ck('얇고 다부진 높이 (18~20px)', /height:19px/.test(rule));
      /* 단위는 붙여 쓴다 — 숫자만 있으면 칩인지 포인트인지 알 수 없다 */
      ck('금액에 P 단위를 붙인다', /stackText\(bv\) \+ 'P'/.test(seatsSrc));

      // 상승 펄스: 1.2배 · 0.5초 · 황금 글로우
      const kf = /@keyframes htBountyUp\{([\s\S]*?)\n  \}/.exec(cssSrc)?.[1] ?? '';
      ck('펄스가 0.5초다', /\.ht-bounty\.up\{animation:htBountyUp \.5s/.test(cssSrc));
      ck('펄스가 1.2배까지 커진다', /scale\(1\.2\)/.test(kf));
      ck('황금 글로우가 있다', /0 0 16px rgba\(255,215,80,\.9\)/.test(kf));
      /* transform 은 통째로 대체된다. keyframes 의 모든 프레임에 translate 를 같이
         적지 않으면 펄스가 도는 동안 명찰이 오른쪽 아래로 튄다 — 눈에 바로 띄는 버그다. */
      const frames = kf.match(/\d+%\{[^}]*/g) ?? [];
      const withTransform = frames.filter(f => /transform:/.test(f));
      ck('펄스 프레임을 찾았다', frames.length >= 3, String(frames.length));
      ck('모든 프레임이 translate 를 함께 적는다 (명찰이 튀지 않게)',
        withTransform.length === frames.length
        && withTransform.every(f => /translateX\(-50%\)/.test(f)),
        `${withTransform.length}/${frames.length}`);
    }

    /* 흔들림을 펠트에 걸어야 한다. #htTable 에 걸면 그 안의 .chip-fly-layer 가
       position:fixed 라 조상 transform 에 끌려가 날아가는 칩이 통째로 어긋난다 —
       KO 와 팟 정산은 같은 순간이라 반드시 겹친다. */
    ck('흔들림은 펠트에 걸린다 (칩 비행이 어긋나지 않게)',
      cssSrc.includes('.ht-felt.koshake') && !cssSrc.includes('.ht-shell.koshake'));
    ck('흔들림 대상이 코드에서도 펠트다',
      /querySelector\('\.ht-felt'\)/.test(seatsSrc));
    // 움직임을 줄이는 설정을 존중한다 (소리와 총자국은 남는다 — 그게 사건 자체다)
    ck('prefers-reduced-motion 에서 애니메이션을 끈다',
      /prefers-reduced-motion[\s\S]{0,300}htKoShake|prefers-reduced-motion[\s\S]{0,300}koshake/
        .test(cssSrc));

    /* (5-b) hidden 으로 감추는 요소에 display 를 주면 감춰지지 않는다.
       UA 스타일시트의 [hidden]{display:none} 보다 클래스 규칙의 우선순위가 높기 때문이다.
       한때 KO 오버레이가 display:flex 라서, 탈락자가 하나도 없는 판에서 전 좌석에 KO 가
       떠 있었다. 속성값만 읽는 검사는 이것을 못 잡는다(hidden = true 를 확인하고 통과했다).
       그래서 "hidden 으로 감추는 클래스" 전부를 훑어 display 를 주면서 방어가 없는 것을
       찾는다 — 그 오버레이는 없앴지만 함정 자체는 남아 있어 다음 요소가 또 걸릴 수 있다. */
    {
      const hid = new Set<string>();
      for (const m of seatsSrc.matchAll(/class="([a-z0-9 -]+)"[^>]*hidden/g)) {
        for (const cls of m[1].split(/\s+/)) if (cls) hid.add(cls);
      }
      ck('hidden 으로 감추는 클래스를 찾았다', hid.size > 0, [...hid].join(','));
      const bad: string[] = [];
      for (const cls of hid) {
        const rule = new RegExp('\\.' + cls.replace(/-/g, '\\-') + '\\{[^}]*display\\s*:');
        if (rule.test(cssSrc) && !cssSrc.includes(`.${cls}[hidden]`)) bad.push(cls);
      }
      ck('display 를 주면서 [hidden] 방어가 없는 요소가 없다', bad.length === 0, bad.join(','));
    }

    /* (5-c) 결과 연출이 끝나기 전에 KO·바운티가 먼저 나오면 안 된다.
       서버는 판이 끝나는 순간 정산을 확정하지만 화면은 그때부터 보드를 열고 팟을 옮긴다.
       그 사이에 KO 를 띄우면 쇼다운을 볼 이유가 없어지고, 뱃지를 올리면 "카드도 안 열렸는데
       남의 바운티를 이미 가져갔다"로 보인다 — 실제로 플랍만 깔린 화면에서 그랬다. */
    ck('KO 연출이 정산 완료를 기다린다',
      /var koShow = pko && s\.presence === 'OUT' && resultReady\(\) && settleDone\(tb\)/.test(seatsSrc));
    ck('총자국과 흑백 처리가 같은 신호를 쓴다',
      /shots\[si\]\.hidden = !koShow/.test(seatsSrc) && /toggle\('koed', koShow\)/.test(seatsSrc));
    ck('바운티 뱃지 변화도 정산 완료를 기다린다',
      /if \(prev !== undefined && bv !== prev && waiting\) bv = prev/.test(seatsSrc));
    /* KO 표시는 총자국 하나다. 빨간 "KO" 글자를 얹었다가 없앴다 — 총자국이 이미 다 말하고
       있고 글자와 검은 원이 그 그림을 덮기만 했다. 되살아나지 않게 못 박는다. */
    ck('KO 글자 오버레이가 없다',
      !seatsSrc.includes('ht-ko-ov') && !cssSrc.includes('ht-ko-ov'));

    /* (5-d) 처형은 세 발이다. 음원(gunshot.mp3)에 세 발이 들어 있고, 총알이 박히는
       시각은 그 음원의 실제 발사 시점을 읽어 쓴다 — 간격을 화면이 따로 정하면
       소리와 그림이 어긋난다. 값은 소리 옆(app.js)에 한 벌만 둔다. */
    /* 음원이 실제로 재생될 수 있는가. 여기가 이 기능에서 가장 조용하게 깨졌던 자리다:
       파일을 넣고 SFX_EXT·화이트리스트에 올렸는데도 SFX_SETS 에 이름을 안 넣어서
       playSample 이 늘 실패하고 합성음으로 떨어졌다 — 소리가 한 번도 나가지 않았고,
       "함수가 있다"만 보는 검사는 그것을 통과시켰다.

       그래서 playSample 로 부르는 모든 이름이 SFX_SETS 에 있는지 전부 훑는다.
       다음에 음원을 추가하는 사람도 같은 함정에 빠지지 않는다. */
    {
      const sets = /var SFX_SETS = \{([\s\S]*?)\n  \};/.exec(appSrc)?.[1] ?? '';
      const named = new Set(Array.from(sets.matchAll(/^\s*([a-z0-9]+):/gm), m => m[1]));
      ck('SFX_SETS 를 읽었다', named.size > 5, [...named].join(','));
      const used = new Set(Array.from(appSrc.matchAll(/playSample\('([a-z0-9]+)'/g), m => m[1]));
      const missing = [...used].filter(n => !named.has(n));
      ck('playSample 로 부르는 이름이 전부 SFX_SETS 에 있다', missing.length === 0,
        missing.join(','));
      ck('총성이 SFX_SETS 에 있다', named.has('gunshot'));
      // 미리 받아 두지 않으면 첫 KO 는 파일이 아니라 합성음으로 나간다
      const holdemSrc = fsx.readFileSync('src/web/games/holdem.ts', 'utf8');
      ck('총성을 홀덤 화면이 미리 받는다',
        /__SFX_NEED__[\s\S]{0,400}?'gunshot'/.test(holdemSrc));
    }
    ck('음원의 발사 시각이 app.js 에 있다', /gunfireShots: \[30, 305, 1335\]/.test(appSrc));
    ck('세 발이 한 번의 재생으로 나간다 (발마다 재생하지 않는다)',
      /gunfire: function\(\)\{\s*\r?\n\s*if \(playSample\('gunshot', 1\)\) return;/.test(appSrc));
    ck('음원을 못 받았을 때 합성음으로 같은 리듬을 낸다',
      /gunfireShots\.forEach/.test(appSrc) && /self\.gunshot\(\)/.test(appSrc));
    ck('화면이 음원의 발사 시각을 읽어 쓴다',
      /casinoSfx\.gunfireShots/.test(seatsSrc));
    ck('화면에 발사 간격을 따로 박아 두지 않았다',
      !/KO_SHOT_GAP_MS\s*=\s*\d/.test(seatsSrc));
    ck('총자국이 셋이다', /s1/.test(seatsSrc) && /s2/.test(seatsSrc) && /s3/.test(seatsSrc)
      && /\.ht-hole-shot\.s3\{/.test(cssSrc));
    ck('자국마다 흰 균열이 있다 (검은 구멍만으로는 얼룩으로 보인다)',
      /\.ht-hole-shot\{[\s\S]*?conic-gradient/.test(cssSrc));
    ck('총구 섬광이 있고 남지 않는다',
      /\.ht-muzzle\{/.test(cssSrc) && /mz\.hidden = true/.test(seatsSrc));

    /* (5-e) 순서: [칩 이동 → 처형 3발 → 현상금 상승]. 상승이 총격보다 먼저 뜨면
       무엇 때문에 올랐는지가 안 읽힌다. 좌석 루프는 번호대로 도는데 승자가 탈락자보다
       먼저 나올 수 있어서, 루프에 들어가기 전에 총격 시각을 잡아 두어야 한다 —
       그러지 않으면 승자를 판단하는 시점에 값이 아직 0 이라 증가액이 먼저 떴다(실측). */
    ck('현상금 상승이 총격이 끝날 때까지 기다린다',
      /var waiting = !settleDone\(tb\) \|\| Date\.now\(\) < koBurstEndsAt/.test(seatsSrc));
    ck('총격 시각을 좌석 루프 전에 잡는다 (좌석 순서에 걸리지 않게)',
      /if \(pko && resultReady\(\) && settleDone\(tb\)\) \{[\s\S]{0,400}?koBurstEndsAt = end/.test(seatsSrc));
/* (5-g) 다음 판이 연출보다 먼저 시작되면 탈락한 자리가 화면에서 사라져 처형이
       통째로 생략된다 — 실제로 사이드 팟 판에서 그렇게 스킵됐다. 서버가 그 시간을
       계산에 넣어야 한다(화면은 다음 판 시작을 미룰 수 없다). */
    {
      const base = { showdown: true, boardAtEnd: 5, liveCount: 3, extraPots: 1 };
      const noKo = HD.nextHandDelaySec(base);
      const withKo = HD.nextHandDelaySec({ ...base, koExecution: true });
      ck('처형이 있으면 다음 판을 더 미룬다', withKo > noKo, `${noKo} → ${withKo}초`);
      /* 연출 전체가 5초를 넘으므로(결과 대기 1.5 + 정리 0.6 + 총알 1.335 + 잔향 0.42
         + 바운티 1.6) 그만큼은 확보돼야 한다 */
      ck('미루는 시간이 연출 길이를 덮는다', withKo - noKo >= 5, String(withKo - noKo));
      ck('처형이 없으면 예전과 같다', HD.nextHandDelaySec(base) === noKo);
      const hdSrc = fsx.readFileSync('src/db/holdem.ts', 'utf8');
      ck('탈락이 있을 때만 미룬다', /koExecution: isPko\(t\) && bustedNow > 0/.test(hdSrc));
    }
    /* (5-h) 우승 팝업이 처형·바운티 상승보다 먼저 뜨면 화면을 덮어 마지막 연출을 못 본다 */
    {
      const celSrc = fsx.readFileSync('src/web/games/holdem-client/celebrate.ts', 'utf8');
      ck('우승 팝업이 처형이 끝날 때까지 기다린다',
        /koBurstEndsAt \+ KO_GAIN_HOLD_MS/.test(celSrc));
      ck('오른 바운티가 떠 있는 시간까지 기다린다',
        /KO_GAIN_HOLD_MS = \d+/.test(seatsSrc));
    }
    ck('오른 만큼을 따로 띄운다', /\.ht-bgain\{/.test(cssSrc)
      /* 봉투가 열릴 때(prev 가 null)는 차액이 아니라 열린 금액 전체를 띄운다 */
      && /htBGain/.test(cssSrc)
      && /stackText\(prev === null \? bv : bv - prev\)/.test(seatsSrc));

    /* (5-f) 명찰 자리는 카드 상태로 갈린다. 자리(hero)로 가르면 카드가 없는 동안에도
       떠 있어 "프레임에 물린 명찰"이라는 레퍼런스의 핵심을 잃는다. */
    /* .up 만 보면 폴드한 패(visibility:hidden)에서도 명찰이 떠 있는다 — 실측 -13px.
       "카드가 실제로 보이는 자리"만 올려야 한다. */
    ck('카드가 실제로 보일 때만 명찰이 올라간다',
      /\.ht-hole\.up:not\(\.folded\):not\(:empty\) \+ \.ht-avbox \.ht-bounty\{top:/.test(cssSrc));
    ck('자리로 가르지 않는다', !/\.ht-seat\.hero \.ht-bounty\{top:/.test(cssSrc));
    /* 접은 패는 마우스를 올리면 다시 보인다 — 그때는 명찰도 같이 비켜서야 한다.
       치우면 카드가 사라지고 명찰도 내려온다(transition 이 둘을 잇는다). */
    ck('접은 패에 마우스를 올리면 명찰도 같이 올라간다',
      /\.ht-seat\.hero:hover \.ht-hole\.up\.folded:not\(:empty\) \+ \.ht-avbox \.ht-bounty\{/
        .test(cssSrc));
    // transition 은 본 규칙 안에 있다(같은 클래스를 두 번 정의하면 CSS 감사가 잡는다)
    ck('명찰이 부드럽게 움직인다', /\.ht-bounty\{[^}]*transition:top/.test(cssSrc));
    /* 베팅 칩이 명찰 자리를 파고들지 않아야 한다 — 실측 11px 겹쳤다 */
    ck('아래쪽 자리 베팅 칩을 명찰만큼 더 올렸다',
      /H \* 0\.119/.test(seatsSrc) && !/H \* 0\.067/.test(seatsSrc));

    // (6) 어드민에서 PKO 를 열 수 있고, 프리롤에는 걸 수 없다
    const admSrc = fsx.readFileSync('src/web/admin.ts', 'utf8');
    ck('어드민에 대회 종류 선택이 있다', /id="ncMode"/.test(admSrc));
    /* 잠그는 기준이 "참가 방식"에서 "1인당 금액"으로 바뀌었다 — 프리롤도 배수가 있으면
       바운티를 걸 수 있다(자세한 검사는 [2-b]). 여기서는 옛 기준이 되살아나지 않는지만 본다. */
    ck('참가 방식으로 잠그지 않는다', !/ncMode\.disabled = !buyin/.test(admSrc));
    ck('프리롤을 CLASSIC 으로 강제하지 않는다',
      !/mode: buyin \? ncMode\.value : 'CLASSIC'/.test(admSrc));
    ck('서버가 모르는 값을 CLASSIC 으로 떨어뜨린다',
      /b\?\.mode === 'MYSTERY_BOUNTY' \? 'MYSTERY_BOUNTY' : 'CLASSIC'/.test(admSrc));
  }

  /* ── 9. 중단 ────────────────────────────────────────────────────
     "상금은 대회가 끝날 때만 나간다"는 전제로 짜인 자리들이 있다. 바운티는 그 전제를
     깬다 — KO 현금은 판 도중에 나간다. 그래서 중단·마감 양쪽에서 총액을 다시 본다. */
  section('[9] 중단 — 진행 중인 판을 취소해도 포인트가 늘거나 줄지 않는다');
  {
    for (const mode of ['PKO_BOUNTY', 'MYSTERY_BOUNTY'] as const) {
      wipe();
      const BUY9 = 10_000;
      const who9 = ['q1', 'q2', 'q3', 'q4'];
      for (const p of who9) mkUser(p, 500_000);
      const before = new Map(who9.map(p =>
        [p, (db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number }).balance]));
      const mk = AD.createTournament({
        title: '중단 ' + mode, regOpenAt: now() - 60, startAt: now() + 3_600,
        buyIn: BUY9, mode, bountyPct: 50, startingStack: 5_000, levelMin: 2,
        lateRegMin: 1, graceMin: 30,
      });
      if (!mk.ok) { ck(`${mode}: 대회가 열린다`, false, mk.error); continue; }
      for (const p of who9) HD.registerHoldem(p, p);
      db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
      HD.advanceHoldem();
      const tb = HD.getTable(mk.id)!;

      /* KO 를 딱 한 번 만들고 멈춘다. 한 자리 칩을 줄여 그 자리와 한 명만 붙인다 —
         전원 올인으로 두면 첫 판에 셋이 동시에 터져 대회가 끝나 버리고, 그러면
         "진행 중인 판 취소"를 볼 수 없다. */
      const h0 = HD.getCurrentHand(tb.id)!;
      const hs0 = HD.getHandSeats(h0.id);
      db.prepare(`UPDATE holdem_hand_seats SET stack = 200 WHERE hand_id = ? AND seat = ?`)
        .run(h0.id, hs0[0]!.seat);
      const fighters = new Set([hs0[0]!.seat, hs0[1]!.seat].map(s =>
        HD.getSeats(tb.id).find(x => x.seat === s)!.user_id));
      for (let step = 0; step < 2_000; step++) {
        const kos = (db.prepare(`SELECT COALESCE(SUM(ko_count), 0) AS s FROM holdem_entries
                                  WHERE tournament_id = ?`).get(mk.id) as { s: number }).s;
        const fin = (db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
          .get(mk.id) as { finished_at: number | null }).finished_at;
        if (kos > 0 || fin != null) break;
        const h = HD.getCurrentHand(tb.id);
        if (!h || h.ended_at != null || h.to_act_seat == null) {
          db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(now() - 1, tb.id);
          HD.advanceHoldem();
          continue;
        }
        const s = HD.getSeats(tb.id).find(x => x.seat === h.to_act_seat && x.presence !== 'OUT');
        if (!s) break;
        db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`)
          .run(now() + HD.ACTION_SEC, h.id);
        db.prepare(`UPDATE holdem_seats SET last_seen_at = ?, presence = 'ACTIVE'
                     WHERE table_id = ? AND presence != 'OUT'`).run(now(), tb.id);
        if (fighters.has(s.user_id)) {
          if (!HD.holdemAction(s.user_id, 'allin', 0).ok
            && !HD.holdemAction(s.user_id, 'call', 0).ok) HD.holdemAction(s.user_id, 'check', 0);
        } else if (!HD.holdemAction(s.user_id, 'fold', 0).ok) {
          HD.holdemAction(s.user_id, 'check', 0);
        }
      }
      const cashOut = (db.prepare(
        `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger WHERE reason = ?`)
        .get('game:holdem:bounty:' + mk.id) as { s: number }).s;
      ck(`${mode}: 검사 전제 — 판 도중에 이미 현금이 나갔다`, cashOut > 0, String(cashOut));
      ck(`${mode}: 검사 전제 — 아직 끝나지 않았다`,
        (db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
          .get(mk.id) as { finished_at: number | null }).finished_at == null);

      // 재시작 취소 — 배포마다 실제로 도는 그 함수다
      HD.cancelRunningHoldemOnBoot();
      const delta = who9.reduce((n, p) => n +
        ((db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number })
          .balance - (before.get(p) ?? 0)), 0);
      /* 이것이 이 절의 핵심이다. 예전에는 참가비를 전액 돌려주면서 이미 나간 KO 현금을
         회수하지 않아 그만큼 발행됐다(4인 10,000P 판에서 2,500P). */
      ck(`${mode}: 참가자 잔액 총합이 그대로다 (걷지 않은 발행 0)`, delta === 0, String(delta));
      ck(`${mode}: 머리에 남은 값이 없다`,
        (db.prepare(`SELECT COALESCE(SUM(bounty), 0) AS s FROM holdem_entries
                      WHERE tournament_id = ?`).get(mk.id) as { s: number }).s === 0);
      // 두 번 불러도 같아야 한다 — 취소와 삭제가 잇달아 지나가는 경로가 있다
      HD.refundEntries(mk.id, 'holdem:cancel:');
      const delta2 = who9.reduce((n, p) => n +
        ((db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number })
          .balance - (before.get(p) ?? 0)), 0);
      ck(`${mode}: 환불을 두 번 불러도 한 번만 나간다`, delta2 === 0, String(delta2));
    }

    /* 시작 전 취소는 예전 그대로 전액이어야 한다 — 흔한 쪽 동작을 바꾸면 안 된다. */
    wipe();
    const who0 = ['r1', 'r2', 'r3'];
    for (const p of who0) mkUser(p, 100_000);
    const mk0 = AD.createTournament({
      title: '시작 전 취소', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: 10_000, mode: 'PKO_BOUNTY', bountyPct: 50,
    });
    if (mk0.ok) {
      for (const p of who0) HD.registerHoldem(p, p);
      const back = HD.refundEntries(mk0.id, 'holdem:cancel:');
      ck('시작 전 취소는 참가비 전액을 돌려준다', back === 30_000, String(back));
      ck('시작 전 취소 뒤 잔액이 원래대로다',
        who0.every(p => (db.prepare(`SELECT balance FROM users WHERE id = ?`)
          .get(p) as { balance: number }).balance === 100_000));
    } else ck('시작 전 취소 대회가 열린다', false, mk0.error);

    /* 마감에서 "갇힌 머리 값"이 회수되는지. settleBounty 를 거치지 않은 탈락자를
       만들어 두고(잡은 사람이 없는 경우와 같은 상태) 마감을 태운다. */
    wipe();
    const who1 = ['s9', 's8', 's7'];
    for (const p of who1) mkUser(p, 100_000);
    const mk1 = AD.createTournament({
      title: '갇힘', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: 0, prizeMultiplier: 10_000, mode: 'PKO_BOUNTY', bountyPct: 100,
      startingStack: 5_000, levelMin: 2, lateRegMin: 1, graceMin: 30,
    });
    if (mk1.ok) {
      for (const p of who1) HD.registerHoldem(p, p);
      const pool1 = (db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
        .get(mk1.id) as { bounty_pool: number }).bounty_pool;
      db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
      HD.advanceHoldem();
      const tb1 = HD.getTable(mk1.id)!;
      const ss = HD.getSeats(tb1.id);
      // 두 명을 머리 값 그대로 남긴 채 OUT 으로 돌린다 — settleBounty 를 타지 않는다
      for (let i = 1; i < ss.length; i++) {
        db.prepare(`UPDATE holdem_seats SET presence = 'OUT', stack = 0
                     WHERE table_id = ? AND seat = ?`).run(tb1.id, ss[i]!.seat);
        db.prepare(`UPDATE holdem_entries SET elim_seq = ?, eliminated_at = ?
                     WHERE tournament_id = ? AND user_id = ?`, ).run(i, now(), mk1.id, ss[i]!.user_id);
      }
      db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(now() - 1, tb1.id);
      HD.advanceHoldem();
      const out1 = (db.prepare(
        `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger WHERE reason LIKE ?`)
        .get('game:holdem:bounty%' + mk1.id) as { s: number }).s;
      const heads1 = (db.prepare(`SELECT COALESCE(SUM(bounty), 0) AS s FROM holdem_entries
                                   WHERE tournament_id = ?`).get(mk1.id) as { s: number }).s;
      ck('잡은 사람이 없어 갇힌 머리 값도 우승자에게 나간다',
        out1 === pool1, `${out1} vs ${pool1}`);
      ck('갇혔던 자리도 비워진다', heads1 === 0, String(heads1));
    } else ck('갇힘 검사 대회가 열린다', false, mk1.error);
  }

  /* ── 10. 삭제 ───────────────────────────────────────────────────
     "없던 일로 만들기"(revokePrizesAndPurge)는 상금만 걷어 가도록 짜여 있었다. 바운티
     현금은 KO 마다 이미 나갔으므로 그것까지 걷지 않으면 펀드 전액이 발행된 채로 끝난다. */
  section('[10] 삭제 — 대회를 없던 일로 만들면 수지가 정확히 0 이 된다');
  {
    /** 대회를 끝까지 돌린다 — [5] 와 같은 방식(카드에 손대지 않는다) */
    function drive(tid: number, tableId: number): void {
      for (let step = 0; step < 4_000; step++) {
        const fin = (db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
          .get(tid) as { finished_at: number | null }).finished_at;
        if (fin != null) return;
        const h = HD.getCurrentHand(tableId);
        if (!h || h.ended_at != null || h.to_act_seat == null) {
          db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(now() - 1, tableId);
          HD.advanceHoldem();
          continue;
        }
        const s = HD.getSeats(tableId).find(x => x.seat === h.to_act_seat && x.presence !== 'OUT');
        if (!s) return;
        db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`)
          .run(now() + HD.ACTION_SEC, h.id);
        if (!HD.holdemAction(s.user_id, 'allin', 0).ok
          && !HD.holdemAction(s.user_id, 'call', 0).ok) HD.holdemAction(s.user_id, 'check', 0);
      }
    }

    for (const mode of ['PKO_BOUNTY', 'MYSTERY_BOUNTY', 'CLASSIC'] as const) {
      wipe();
      const who = ['g1', 'g2', 'g3'];
      for (const p of who) mkUser(p, 500_000);
      const before = new Map(who.map(p =>
        [p, (db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number }).balance]));
      const mk = AD.createTournament({
        title: '삭제 ' + mode, regOpenAt: now() - 60, startAt: now() + 3_600,
        buyIn: 10_000, mode, bountyPct: 50,
        startingStack: 5_000, levelMin: 2, lateRegMin: 1, graceMin: 30,
      });
      if (!mk.ok) { ck(`${mode}: 대회가 열린다`, false, mk.error); continue; }
      for (const p of who) HD.registerHoldem(p, p);
      db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
      HD.advanceHoldem();
      drive(mk.id, HD.getTable(mk.id)!.id);
      ck(`${mode}: 검사 전제 — 대회가 끝났다`,
        (db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
          .get(mk.id) as { finished_at: number | null }).finished_at != null);
      /* 끝난 직후에는 걷은 만큼 정확히 나가 있어야 한다 — 여기가 어긋나면 아래 검사는
         무의미하다(삭제가 아니라 정산이 틀린 것이다). */
      const midDelta = who.reduce((n, p) => n +
        ((db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number })
          .balance - (before.get(p) ?? 0)), 0);
      ck(`${mode}: 마감 직후 잔액 총합이 그대로다`, midDelta === 0, String(midDelta));

      const rv = AD.revokePrizesAndPurge(mk.id);
      ck(`${mode}: 삭제가 된다`, rv.ok, rv.ok ? '' : rv.error);
      const after = who.reduce((n, p) => n +
        ((db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number })
          .balance - (before.get(p) ?? 0)), 0);
      /* 이것이 이 절의 핵심이다. 예전에는 바운티 현금을 걷지 않아 펀드 전액이 남았다. */
      ck(`${mode}: 삭제 뒤에도 잔액 총합이 그대로다`, after === 0, String(after));
    }

    /* 취소된 판을 삭제하는 경로. 취소가 이미 정산을 끝냈으므로 삭제는 돈을 건드리면
       안 된다 — 여기서 또 걷으면 유저가 두 번 손해를 본다. */
    wipe();
    const who2 = ['g7', 'g8', 'g9', 'g0'];
    for (const p of who2) mkUser(p, 500_000);
    const before2 = new Map(who2.map(p =>
      [p, (db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number }).balance]));
    const mk2 = AD.createTournament({
      title: '취소 후 삭제', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: 10_000, mode: 'PKO_BOUNTY', bountyPct: 50,
      startingStack: 5_000, levelMin: 2, lateRegMin: 1, graceMin: 30,
    });
    if (mk2.ok) {
      for (const p of who2) HD.registerHoldem(p, p);
      db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
      HD.advanceHoldem();
      const tb2 = HD.getTable(mk2.id)!;
      // KO 를 한 번 만들고 취소한다 (한 자리만 짧게 만들어 둘이 붙인다)
      const h2 = HD.getCurrentHand(tb2.id)!;
      const hs2 = HD.getHandSeats(h2.id);
      db.prepare(`UPDATE holdem_hand_seats SET stack = 200 WHERE hand_id = ? AND seat = ?`)
        .run(h2.id, hs2[0]!.seat);
      const fight = new Set([hs2[0]!.seat, hs2[1]!.seat].map(s =>
        HD.getSeats(tb2.id).find(x => x.seat === s)!.user_id));
      for (let step = 0; step < 2_000; step++) {
        const kos = (db.prepare(`SELECT COALESCE(SUM(ko_count), 0) AS s FROM holdem_entries
                                  WHERE tournament_id = ?`).get(mk2.id) as { s: number }).s;
        const fin = (db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
          .get(mk2.id) as { finished_at: number | null }).finished_at;
        if (kos > 0 || fin != null) break;
        const h = HD.getCurrentHand(tb2.id);
        if (!h || h.ended_at != null || h.to_act_seat == null) {
          db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(now() - 1, tb2.id);
          HD.advanceHoldem();
          continue;
        }
        const s = HD.getSeats(tb2.id).find(x => x.seat === h.to_act_seat && x.presence !== 'OUT');
        if (!s) break;
        db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`)
          .run(now() + HD.ACTION_SEC, h.id);
        db.prepare(`UPDATE holdem_seats SET last_seen_at = ?, presence = 'ACTIVE'
                     WHERE table_id = ? AND presence != 'OUT'`).run(now(), tb2.id);
        if (fight.has(s.user_id)) {
          if (!HD.holdemAction(s.user_id, 'allin', 0).ok
            && !HD.holdemAction(s.user_id, 'call', 0).ok) HD.holdemAction(s.user_id, 'check', 0);
        } else if (!HD.holdemAction(s.user_id, 'fold', 0).ok) {
          HD.holdemAction(s.user_id, 'check', 0);
        }
      }
      HD.cancelRunningHoldemOnBoot();
      const afterCancel = who2.reduce((n, p) => n +
        ((db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number })
          .balance - (before2.get(p) ?? 0)), 0);
      ck('취소 직후 잔액 총합이 그대로다', afterCancel === 0, String(afterCancel));
      const rv2 = AD.revokePrizesAndPurge(mk2.id);
      ck('취소된 판도 삭제된다', rv2.ok, rv2.ok ? '' : rv2.error);
      const afterPurge = who2.reduce((n, p) => n +
        ((db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number })
          .balance - (before2.get(p) ?? 0)), 0);
      ck('취소된 판을 삭제해도 돈이 다시 걷히지 않는다', afterPurge === 0, String(afterPurge));
    } else ck('취소 후 삭제 대회가 열린다', false, mk2.error);
  }

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

void bountyPaid;
main().catch(e => { console.error(e); process.exit(1); });
