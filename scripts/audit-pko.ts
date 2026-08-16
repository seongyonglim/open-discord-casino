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
    `SELECT user_id, bounty, bounty_won, bounty_paid, ko_count, prize, finish_place, paid_in
       FROM holdem_entries WHERE tournament_id = ? ORDER BY user_id`).all(tid) as {
    user_id: string; bounty: number; bounty_won: number; bounty_paid: number;
    ko_count: number; prize: number; finish_place: number | null; paid_in: number;
  }[];
}

async function main(): Promise<void> {
  /* ── 1. 순수 계산 ────────────────────────────────────────────── */
  section('[1] 나누기 — 쪼갠 값의 합이 언제나 원래 값이다');
  {
    /* 여기가 무너지면 총액이 무너진다. 홀수·1P·0 처럼 내림이 물리는 값을 특히 본다.
       "합이 원래 값"을 성질로 검사한다 — 기대값을 손으로 적으면 그 표가 곧 두 번째 구현이다. */
    /* 머리/현금 쪼개기(bountySplit)는 없어졌다 — 잡은 사람이 전액을 가져가므로 쪼갤 것이
       없다. 되살아나면 "머리 값이 자란다"가 함께 돌아온 것이라, 없다는 사실을 검사한다. */
    ck('머리/현금 쪼개기가 남아 있지 않다',
      (T as Record<string, unknown>).bountySplit === undefined);
    ck('머리 비율 상수도 남아 있지 않다',
      (T as Record<string, unknown>).PKO_HEAD_RATIO === undefined);
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
    /* 바운티 몫은 대회마다 다르다 — 범위 밖 값이 들어와도 다듬어져야 한다.
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
    /* 상금 몫은 "나머지 전부" 로 계산해야 한다. 양쪽을 각각 비율로 내리면 홀수마다 1P 가
       증발한다 — 한쪽만 정하고 다른 쪽을 나머지로 두는 것이 보존의 근거다. */
    const src = fsx.readFileSync('src/services/tournament.ts', 'utf8');
    ck('상금 몫은 "나머지 전부" 로 계산한다',
      /return b - bountyShare\(b, pct\)/.test(src));
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
    /* 봉투 나누기부터 본다. 금액은 대회마다 새로 뽑히므로(고정 표를 버렸다) 기대값을 손으로
       적을 수 없다 — 성질을 검사한다. 합이 펀드와 정확히 같아야 하고, 빈 봉투가 없어야
       하고, 금액이 실제로 흩어져야 한다.

       무작위 원천을 넣어 돌린다. 뽑기가 들어간 함수를 기본 난수로 검사하면 어쩌다 통과하는
       판이 생긴다 — 여러 수열로 여러 번 돌려 성질이 언제나 성립하는지 본다. */
    const mkRand = (seed: number): (() => number) => {
      /* 선형 합동 — 씨앗을 주면 늘 같은 수열이 나온다(검사가 재현된다). 암호적 강도는
         필요 없다: 실서버는 crypto 를 넣는다(holdem.ts 의 배정 자리). */
      let s = seed >>> 0;
      return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
    };
    for (const n of [2, 3, 6, 9, 12]) {
      for (const fund of [3, 999, 30_000, 90_000, 123_457]) {
        let sumBad = 0, negBad = 0, lenBad = 0, zeroBad = 0, overBad = 0, underBad = 0;
        let widest = 0;
        const { lo, hi } = T.envelopeRange(n);
        for (let seed = 1; seed <= 60; seed++) {
          const e = T.mysteryEnvelopes(fund, n, mkRand(seed * 7919));
          if (e.reduce((a, b) => a + b, 0) !== fund) sumBad++;
          if (e.some(x => x < 0)) negBad++;
          if (e.length !== n) lenBad++;
          /* 빈 봉투는 열리는 순간이 허탕이라 연출이 죽는다. 펀드가 인원보다 작으면
             1P 도 못 받는 봉투가 어쩔 수 없이 생기므로 그때는 세지 않는다. */
          if (fund >= n * 100 && e.some(x => x === 0)) zeroBad++;
          /* 범위를 지키는지. 1% 단위로 나눈 뒤 금액으로 바꾸면서 내림이 물리므로,
             큰 펀드에서만 정확히 잰다(작은 펀드는 1P 가 1% 를 넘는다). */
          if (fund >= 30_000) {
            const pct = e.map(x => x * 100 / fund);
            /* 남는 1P 를 가장 큰 봉투에 얹으므로 상한을 1% 만큼 넘을 수 있다 */
            if (pct.some(p => p > hi + 1)) overBad++;
            if (pct.some(p => p < lo - 0.001)) underBad++;
          }
          widest = Math.max(widest, Math.max(...e) / Math.max(1, Math.min(...e)));
        }
        ck(`봉투 ${n}개 · 펀드 ${fund}: 합이 언제나 펀드와 같다`, sumBad === 0, `${sumBad}/60`);
        ck(`봉투 ${n}개 · 펀드 ${fund}: 음수가 없다`, negBad === 0, `${negBad}/60`);
        /* 봉투 수를 인원과 같게 두는 이유: KO 가 인원-1 번이고 마지막 하나를 우승자가
           열어서 남는 봉투가 없다. 그래서 개수 검사가 총액 검사와 같은 무게다. */
        ck(`봉투 ${n}개 · 펀드 ${fund}: 개수가 인원과 같다`, lenBad === 0, `${lenBad}/60`);
        ck(`봉투 ${n}개 · 펀드 ${fund}: 빈 봉투가 없다`, zeroBad === 0, `${zeroBad}/60`);
        if (fund >= 30_000) {
          /* 상한이 이 모드의 균형이다. 없으면 5 인에서 89% 짜리 봉투가 나오고(실측)
             나머지 넷이 껍데기가 되어 대회가 "그 한 명을 누가 잡느냐"로 줄어든다. */
          ck(`봉투 ${n}개 · 펀드 ${fund}: 상한 ${hi}% 를 넘지 않는다`,
            overBad === 0, `${overBad}/60`);
          ck(`봉투 ${n}개 · 펀드 ${fund}: 하한 ${lo}% 아래로 내려가지 않는다`,
            underBad === 0, `${underBad}/60`);
          /* 흩어져야 한다 — 전부 비슷하면 봉투를 열 이유가 없다. 범위가 허락하는 최대
             배수(hi/lo)의 절반은 넘어야 "제각각"이라고 할 수 있다. */
          if (n >= 3) {
            ck(`봉투 ${n}개 · 펀드 ${fund}: 금액이 흩어진다`, widest >= hi / lo / 2,
              `${widest.toFixed(1)}배 (최대 ${(hi / lo).toFixed(1)}배)`);
          }
        }
      }
    }
    /* 범위 표. 계산식이 아니라 표로 둔 값이라, 표가 흔들리면 모드의 균형이 흔들린다.
       바닥 합이 전체의 절반 근처여야 한다 — 너무 높으면 흩을 칸이 없어 전부 비슷해지고,
       너무 낮으면 껍데기 봉투가 생긴다. */
    for (const [n, lo, hi] of [[3, 15, 50], [4, 12, 50], [5, 10, 45],
      [6, 8, 40], [7, 7, 36], [8, 6, 32], [9, 5, 30]] as [number, number, number][]) {
      const r = T.envelopeRange(n);
      ck(`${n}인 범위가 ${lo}~${hi}% 다`, r.lo === lo && r.hi === hi, `${r.lo}~${r.hi}`);
      ck(`${n}인: 바닥을 다 깔 수 있다 (lo × n ≤ 100)`, r.lo * n <= 100, `${r.lo * n}`);
      ck(`${n}인: 상한으로 100 칸을 채울 수 있다 (hi × n ≥ 100)`, r.hi * n >= 100, `${r.hi * n}`);
      ck(`${n}인: 바닥 합이 절반 근처다 (40~55%)`, r.lo * n >= 40 && r.lo * n <= 55,
        `${r.lo * n}%`);
      /* 잭팟이 평균의 1.5~3 배. 그 아래면 평범하고, 그 위면 나머지가 껍데기가 된다. */
      const times = r.hi / (100 / n);
      ck(`${n}인: 잭팟이 평균의 1.5~3배다`, times >= 1.5 && times <= 3,
        `${times.toFixed(1)}배`);
    }
    ck('0 명이면 빈 배열', T.mysteryEnvelopes(1_000, 0, mkRand(1)).length === 0);
    ck('1 명이면 펀드 전액', T.mysteryEnvelopes(1_000, 1, mkRand(1))[0] === 1_000);
    /* ── 고정 표를 버렸다는 것 ──────────────────────────────────────
       예전에는 가중치가 표로 박혀 있어서 인원이 같으면 금액도 늘 같았다 — 6 인이면 언제나
       40.9 / 19.4 / … % 였고, 한 번 보면 외워졌다. 그건 "미스터리"가 아니라 자리 뽑기다.
       같은 인원·같은 펀드로 여러 번 뽑아 결과가 달라지는지 본다. */
    {
      const seen = new Set<string>();
      for (let seed = 1; seed <= 30; seed++) {
        seen.add(T.mysteryEnvelopes(50_000, 5, mkRand(seed * 104729)).join(','));
      }
      ck('같은 인원·같은 펀드에서도 금액이 매번 다르다', seen.size >= 25, `${seen.size}/30`);
      const src = fsx.readFileSync('src/services/tournament.ts', 'utf8');
      ck('고정 가중치 표가 남아 있지 않다', !/ENVELOPE_WEIGHTS/.test(src));
      ck('1% 단위 100 칸으로 쪼갠다', /ENVELOPE_UNITS = 100/.test(src));
      ck('인원별 범위를 표로 둔다 (식이 아니라 눈으로 조절한다)',
        /const ENVELOPE_RANGE: Record<number/.test(src));
      ck('상한이 있다 (없으면 나머지가 껍데기가 된다)', /hi: 50/.test(src));
      /* 다항분포(한 칸씩 무작위로 나눠 주기)로 두면 큰 수의 법칙에 눌려 전부 비슷해진다.
         지수 가중치여야 한쪽에 크게 몰리는 판이 섞여 나온다. */
      ck('지수 가중치를 쓴다 (평평해지지 않게)', /-Math\.log\(u\)/.test(src));
      /* 실서버는 예측 불가능한 난수를 써야 한다 — 이 값이 곧 돈이다. */
      ck('실서버 배정은 crypto 를 쓴다',
        /randomInt\(0, 2 \*\* 32\) \/ 2 \*\* 32/.test(fsx.readFileSync('src/db/holdem.ts', 'utf8')));
    }

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
    /* 미스터리는 머리 위 명찰을 아예 그리지 않는다. 한동안 물음표를 띄워 뒀는데, 다섯
       자리에 똑같은 "?" 가 걸린 화면은 정보가 0 이면서 자리만 차지했다 — 금액이 공개되는
       자리는 상자 개봉 하나로 모았다.
       seatsSrc 는 뒤쪽 [8] 절에서 다시 읽으므로 여기서는 지역 변수로 따로 읽는다 —
       절 사이에 변수를 공유하면 순서를 바꿀 수 없다. */
    const seatsSrc2 = fsx.readFileSync('src/web/games/holdem-client/seats.ts', 'utf8');
    ck('미스터리는 명찰을 만들지 않는다',
      /var badgeOn = pko && !mystery/.test(seatsSrc2)
      && /\(badgeOn \? '<span class="ht-bounty" hidden><\/span>' : ''\)/.test(seatsSrc2));
    ck('물음표 명찰이 남아 있지 않다',
      !/bEl\.textContent = '\?'/.test(seatsSrc2) && !/classList\.add\('sealed'\)/.test(seatsSrc2));
    ck('물음표 명찰 CSS 도 걷어냈다',
      !/\.ht-bounty\.sealed\{/.test(fsx.readFileSync('src/web/assets/css/09-holdem.css', 'utf8')));
    /* 등수 표는 모드가 아니라 "순위 상금이 실제로 있는지"로 갈라야 한다 — 모드로 가르면
       순위 상금을 남긴 미스터리에서 상금표가 통째로 사라진다. */
    const sideSrc = fsx.readFileSync('src/web/games/holdem-client/side.ts', 'utf8');
    ck('등수 표는 순위 상금이 있을 때만 그린다',
      /var hasRank = t\.prizePool > 0/.test(sideSrc)
      && /hasRank\s*\n?\s*\? '<div class="ht-pz-rsec">/.test(sideSrc));
    ck('모드로 등수 표를 가르지 않는다', !/mystery \? '' : '<div class="ht-pz-list">/
      .test(sideSrc));
    /* 갈래 줄(순위 + 바운티)은 바운티 판이면 늘 그린다 — 전액 바운티일 때 "순위 상금 0P"
       라고 적히는 것도 정보다. 등수 표와 달리 거짓이 되지 않는다. */
    ck('갈래 줄은 바운티 판이면 그린다', /\(isPko\s*\n?\s*\? '<div class="ht-pz-split">/
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
    /* 독식 규칙은 몫과 무관하고, 이제 두 모드가 함께 쓴다 — 잡으면 전액이고 내 머리는
       오르지 않는다. 정산 함수에 머리를 올리는 UPDATE 가 남아 있으면 프로그레시브가
       되살아난 것이다. */
    const hdSrc = fsx.readFileSync('src/db/holdem.ts', 'utf8');
    const koBody = hdSrc.slice(hdSrc.indexOf('function settleBounty'),
      hdSrc.indexOf('function finishTournament'));
    ck('KO 정산이 잡은 사람 머리를 올리지 않는다',
      !/SET bounty = bounty \+ \?/.test(koBody));
    ck('KO 정산이 확보액에 전액을 얹는다',
      /splitBounty\(bounty, killers\.length\)[\s\S]{0,200}?bounty_won = bounty_won \+ \?/
        .test(koBody));
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
  section('[4] KO — 잡은 사람이 전액을 확보하고, 자기 머리 값은 오르지 않는다');
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

    /* 머리 값 두 개(각 share)를 전액 가져갔다. 잡은 사람 머리는 그대로여야 한다 —
       여기가 오르면 프로그레시브가 되살아난 것이고, 그러면 우승자 쏠림이 다시 커진다
       (6인 100회 실측: 우승자가 바운티 갈래의 78.6% → 89.5%). */
    ck('잡은 사람 머리 값이 오르지 않았다',
      k1.bounty === (before.get('k1') ?? 0),
      `${k1.bounty} vs ${before.get('k1') ?? 0}`);
    ck('확보 누계가 잡은 값 전액이다', k1.bounty_won === share * 2,
      `${k1.bounty_won} vs ${share * 2}`);
    /* 판 도중에는 지갑이 움직이지 않아야 한다. 바운티가 나가는 자리는 마감 정산 한 곳뿐이다 —
       한동안 여기서 곧바로 지급했고, 그래서 "상금은 대회가 끝날 때만 나간다"를 전제로 짜인
       중단 환불과 대회 삭제가 조용히 새고 있었다([9]·[10]). 나가는 자리를 늘리지 않는 것이
       계산을 맞추는 것보다 안전하다는 판단이고, 그 판단을 여기서 못 박는다. */
    const balAfter = (db.prepare(`SELECT balance FROM users WHERE id = 'k1'`)
      .get() as { balance: number }).balance;
    ck('판 도중에는 잔액이 움직이지 않는다', balAfter - balBefore === 0,
      String(balAfter - balBefore));
    ck('판 도중에는 원장에 바운티 항목이 없다',
      (db.prepare(
        `SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = 'k1' AND reason LIKE 'game:holdem:bounty%'`)
        .get() as { n: number }).n === 0);
    ck('아직 지급 표시가 서지 않았다', k1.bounty_paid === 0, String(k1.bounty_paid));

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
      /* 예정액(bounty_won)과 실제 지급액(bounty_paid)이 마감 뒤에는 같아야 한다.
         두 칸을 두는 이유는 판 도중에 갈리기 때문이다 — 그때는 예정만 있고 지급은 0 이다.
         끝난 뒤에도 갈려 있으면 화면이 가리키는 숫자와 지갑에 들어간 돈이 다르다는 뜻이다. */
      ck(`${tag}: 지급액 = 예정액 (화면 숫자와 지갑이 같다)`,
        rows.reduce((s, r) => s + r.bounty_paid, 0) === rows.reduce((s, r) => s + r.bounty_won, 0),
        `${rows.reduce((s, r) => s + r.bounty_paid, 0)} vs ${rows.reduce((s, r) => s + r.bounty_won, 0)}`);
      ck(`${tag}: 지급액 합 = 원장에 찍힌 금액`,
        rows.reduce((s, r) => s + r.bounty_paid, 0) === paidAll,
        `${rows.reduce((s, r) => s + r.bounty_paid, 0)} vs ${paidAll}`);
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
      /* 명찰만 badgeOn(= pko && !mystery)으로 한 겹 더 좁다 — 미스터리에는 적을 숫자가
         없다. 나머지(확보 표시·총자국·섬광)는 두 모드 공통이라 pko 그대로다. */
      ck(`${cls} 는 바운티 판에서만 만들어진다`,
        at >= 0 && /\((pko|badgeOn) \?/.test(block),
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
    for (const need of ['.ht-bounty', '.ht-hole-shot', 'htShot',
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
      /* 단위는 붙여 쓴다 — 숫자만 있으면 칩인지 포인트인지 알 수 없다.
         그리고 그 단위는 표기 토글(칩/BB)과 무관하게 언제나 P 다. 예전에는 stackText 로
         그려서 BB 표기를 켠 사람 화면에 "12.5BBP" 가 찍혔다 — stackText 가 'BB' 를 붙이는데
         여기서 'P' 를 한 번 더 붙였기 때문이다. 바운티는 대회가 끝나면 그대로 계좌에
         들어오는 진짜 포인트라 애초에 환산 대상이 아니다. */
      ck('금액에 P 단위를 붙인다', /bEl\.textContent = pointText\(bv\);/.test(seatsSrc));
      ck('명찰이 BB 로 환산되지 않는다', !/bEl\.textContent = stackText/.test(seatsSrc));

      /* 상승 펄스(.ht-bounty.up · @keyframes htBountyUp)는 없앴다. 잡은 사람이 전액을
         가져가고 자기 머리는 오르지 않으므로 명찰 숫자가 대회 내내 고정이다 — 올라가는
         일이 없으니 올라갈 때의 연출도 없다. 절대 실행되지 않는 애니메이션을 남겨 두면
         다음에 읽는 사람이 "왜 안 보이나"를 쫓게 된다. */
      ck('명찰에 상승 펄스가 남아 있지 않다',
        !/\.ht-bounty\.up\{/.test(cssSrc) && !/@keyframes htBountyUp\{/.test(cssSrc));
      ck('화면도 up 클래스를 붙이지 않는다', !/bEl\.classList\.add\('up'\)/.test(seatsSrc));
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
        /__SFX_NEED__[\s\S]{0,700}?'gunshot'/.test(holdemSrc));
      /* 전광판 소리와 획득 소리도 함께 받는다 — 처형이 끝나자마자 이어지므로 그때
         받으러 가면 소리가 그림보다 늦게 도착한다. */
      ck('전광판·획득 소리를 미리 받는다',
        /'gunshot', 'reelroll', 'reelstop', 'bountyearn'/.test(holdemSrc));
      /* named 는 SFX_SETS 의 키(부르는 이름)다. 파일명은 SFX_EXT 쪽에 있으므로 따로 본다 —
         한쪽만 올려 두면 playSample 이 조용히 실패한다(총성이 그렇게 안 나갔다). */
      ck('전광판·획득 소리가 SFX_SETS 에 있다',
        named.has('reelroll') && named.has('reelstop') && named.has('bountyearn'));
      ck('음원 파일명이 SFX_EXT 에 있다',
        /'reel-roll':'mp3'/.test(appSrc) && /'reel-stop':'mp3'/.test(appSrc)
        && /'bounty-earn':'mp3'/.test(appSrc));
      /* 파일이 실제로 있어야 한다 — SFX_EXT 에만 올리고 파일을 안 넣으면 조용히
         합성음으로 떨어진다(그 함정으로 총성이 한 번도 안 나갔다). */
      ck('음원 파일이 실제로 있다',
        ['reel-roll', 'reel-stop', 'bounty-earn']
          .every(f => fsx.existsSync(`public/sfx/${f}.mp3`)));
      /* 음량 보정이 없으면 획득 소리 하나가 나머지를 다 덮는다 — 실측 RMS 가
         -29.2 / -24.3 / -15.5dB 로 13.7dB 벌어져 있다. */
      ck('음량 보정값이 있다',
        /'reel-roll': 0\.610, 'reel-stop': 0\.437, 'bounty-earn': 0\.158/.test(appSrc));
      // 화이트리스트에 없으면 파일이 있어도 404 가 된다 (서버가 이름으로만 받는다)
      {
        const srvSrc = fsx.readFileSync('src/web/server.ts', 'utf8');
        ck('음원이 서빙 화이트리스트에 있다',
          /'reel-roll\.mp3', 'reel-stop\.mp3'/.test(srvSrc)
          && /'bounty-earn\.mp3'/.test(srvSrc));
      }
      /* 음원이 들어와도 합성음 대체는 남겨 둔다 — 나중에 음원을 교체하는 사이에도
         조용해지지 않아야 한다. */
      ck('합성음 대체가 남아 있다',
        /reelRoll: function\(\)\{[\s\S]{0,300}?playSample\('reelroll'/.test(appSrc)
        && /reelStop: function\(\)\{[\s\S]{0,300}?playSample\('reelstop'/.test(appSrc)
        && /bountyUp: function\(\)\{[\s\S]{0,300}?playSample\('bountyearn'/.test(appSrc));
      /* 딸깍 소리는 걷어냈다 — 회전 음원이 그 구간을 통째로 덮으므로 숫자마다 소리를
         낼 필요가 없어졌다. 상자 소리도 마찬가지로 가리킬 물건이 없다. */
      ck('딸깍·상자 소리가 남아 있지 않다',
        !/reelTick/.test(appSrc) && !/boxShake|boxOpen|box-shake|box-open/.test(appSrc));
      /* 화면 구간이 음원 길이에 맞아야 한다 — 소리가 먼저 끝나면 무음이 생기고,
         늦게 끝나면 멈춘 뒤에도 돌아가는 소리가 남는다. */
      ck('굴리는 구간이 회전 음원 길이(2.05초)에 맞다',
        /MYS_ROLL_MS = 2000/.test(fsx.readFileSync(
          'src/web/games/holdem-client/seats.ts', 'utf8')));
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
      ck('탈락이 있을 때만 미룬다',
        /koExecution: isPko\(t\) && bustedNow\.busted > 0/.test(hdSrc));
    }
    /* (5-h) 우승 팝업이 처형·바운티 상승보다 먼저 뜨면 화면을 덮어 마지막 연출을 못 본다 */
    {
      const celSrc = fsx.readFileSync('src/web/games/holdem-client/celebrate.ts', 'utf8');
      ck('우승 팝업이 처형이 끝날 때까지 기다린다',
        /koBurstEndsAt \+ KO_GAIN_HOLD_MS/.test(celSrc));
      ck('오른 바운티가 떠 있는 시간까지 기다린다',
        /KO_GAIN_HOLD_MS = \d+/.test(seatsSrc));
    }
    /* 명찰 숫자가 대회 내내 고정이 되면서(잡은 사람이 전액 독식) "얼마를 벌었나"를
       명찰 상승으로 보여줄 수 없게 됐다. 그래서 확보 누계(bountyWon)의 증가분을 띄운다 —
       이 연출이 없으면 잡아도 화면에 남는 것이 총자국뿐이다. */
    ck('확보한 만큼을 따로 띄운다', /\.ht-bgain\{/.test(cssSrc)
      && /htBGain/.test(cssSrc)
      && /wonShown\[s\.seat\]/.test(seatsSrc)
      /* 두 모드가 같은 함수를 쓴다 — 미스터리는 상자가 닫힌 뒤, 프로그레시브는 처형이
         끝난 뒤 곧바로. 부르는 자리만 다르고 연출은 같아야 한다(갈라 두면 한쪽만
         고쳐진다). */
      && /function floatBGain\(seatEl, amount\)/.test(seatsSrc)
      /* 명찰과 같은 이유로 여기도 pointText 다 — BB 표기를 켜면 "+12.5BBP" 가 떠올랐다. */
      && /'\+' \+ pointText\(amount\)/.test(seatsSrc));
    ck('명찰 상승에 기대지 않는다 (숫자가 고정이라 안 오른다)',
      !/stackText\(prev === null \? bv : bv - prev\)/.test(seatsSrc));
    /* 처형이 끝날 때까지 기다리는 규칙은 명찰과 같아야 한다 — 처형과 같은 순간에 터지면
       무엇 때문에 들어온 돈인지 안 읽힌다. */
    ck('확보 표시도 처형이 끝날 때까지 기다린다',
      /settleDone\(tb\) && Date\.now\(\) >= koBurstEndsAt/.test(seatsSrc));
    ck('처음 본 값에는 띄우지 않는다',
      /if \(wPrev === undefined\) wonShown\[s\.seat\] = wv;/.test(seatsSrc));
    // 서버가 좌석마다 확보 누계를 실어 줘야 화면이 증가를 볼 수 있다
    const stSrc2 = fsx.readFileSync('src/web/games/holdem.ts', 'utf8');
    ck('좌석에 확보 누계를 싣는다',
      /bountyWon: pkoOn \? \(wonBySeat\.get\(s\.user_id\) \?\? 0\) : undefined/.test(stSrc2));
    ck('일반 대회 좌석에는 싣지 않는다', /pkoOn \? \(wonBySeat/.test(stSrc2));

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
      const accrued = (db.prepare(`SELECT COALESCE(SUM(bounty_won), 0) AS s FROM holdem_entries
                                    WHERE tournament_id = ?`).get(mk.id) as { s: number }).s;
      /* 검사가 성립하려면 KO 가 실제로 났어야 한다 — 확보액으로 확인한다.
         그리고 그 확보액이 지갑으로는 나가지 않았다는 것이 이 절의 전제다. */
      ck(`${mode}: 검사 전제 — KO 로 확보된 금액이 있다`, accrued > 0, String(accrued));
      ck(`${mode}: 판 도중에는 지갑으로 나간 것이 없다`, cashOut === 0, String(cashOut));
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

  /* ── 11. 나가는 자리 ────────────────────────────────────────────
     이 절은 금액을 세지 않는다. 지키려는 것은 구조다 — **바운티가 지갑으로 나가는 자리는
     하나여야 한다.** 자리가 둘이 되는 순간 "상금은 대회가 끝날 때만 나간다"를 전제로 짜인
     자리들(중단 환불, 대회 삭제, 삭제 가능 판정)이 하나씩 어긋나기 시작하고, 그 어긋남은
     총액 검사가 아니라 그 경로를 일부러 태워 봐야 드러난다. 실제로 그렇게 새고 있었다.
     그래서 자리 수 자체를 검사해 둔다. */
  section('[11] 구조 — 바운티가 지갑으로 나가는 자리는 한 곳뿐이다');
  {
    const hdSrc = fsx.readFileSync('src/db/holdem.ts', 'utf8');
    const spots = hdSrc.match(/adjustBalance\([^)]*game:holdem:bounty/g) ?? [];
    ck('adjustBalance 로 바운티를 내보내는 자리가 하나다', spots.length === 1,
      `${spots.length} 곳`);
    /* KO 정산 함수 본문에 지급이 없어야 한다 — 위 검사는 개수만 보므로 그 하나가
       어디에 있는지도 못 박는다. */
    const koBody = hdSrc.slice(hdSrc.indexOf('function settleBounty'),
      hdSrc.indexOf('function finishTournament'));
    ck('KO 정산(settleBounty)에는 지급이 없다', !/adjustBalance\(/.test(koBody));
    ck('KO 정산은 확보액만 적는다', /bounty_won = bounty_won \+ \?/.test(koBody));
    const payBody = hdSrc.slice(hdSrc.indexOf('function payBounties'),
      hdSrc.indexOf('/* ── 유저 동작'));
    ck('마감 정산(payBounties)이 그 하나를 가진다',
      /adjustBalance\([^)]*game:holdem:bounty/.test(payBody));
    /* 이중 지급 자물쇠는 조건부 UPDATE + changes() 여야 한다. 값을 다시 읽어 비교하면
       "내가 방금 넣었다"와 "원래 그 값이었다"를 구분하지 못한다. */
    ck('지급 표시가 조건부 UPDATE 로 선다',
      /bounty_paid = \?\s*\n?\s*WHERE id = \? AND bounty_paid = 0/.test(payBody));
    ck('changes() 로 확인한 뒤에 지급한다',
      /changes\(\) AS n[\s\S]{0,120}?adjustBalance/.test(payBody));
    /* 환불은 상계하지 않는다 — 나간 것이 없으므로 상계할 것도 없다. 상계가 되살아나면
       삭제 경로와 겹쳐 과다 회수가 된다(실측 15,000P). */
    ck('환불이 참가비를 그대로 돌려준다',
      /adjustBalance\(r\.user_id, r\.paid_in, reasonPrefix/.test(hdSrc));
    ck('환불에 바운티 상계가 없다', !/netBounty/.test(hdSrc));
    // 되돌리는 쪽은 예정액이 아니라 지급액을 근거로 삼는다
    const admSrc3 = fsx.readFileSync('src/db/admin.ts', 'utf8');
    ck('회수는 bounty_paid 를 근거로 한다',
      /SUM\(prize\) \+ SUM\(bounty_paid\)/.test(admSrc3));
    ck('회수가 예정액(bounty_won)을 걷지 않는다', !/SUM\(bounty_won\)/.test(admSrc3));
    ck('흔적 없는 판 판정도 bounty_paid 를 본다',
      /SUM\(bounty_paid\), 0\) AS bounty/.test(admSrc3));
    /* 상금 탭은 숫자만 보여준다. 규칙 문단을 좁은 칸에 넣었더니 라벨이 줄바꿈되고
       ("바운티 상 / 금") 정작 금액이 안 보였다 — 규칙은 공지가 맡는다.
       다만 "언제 들어오나"는 남긴다: 확보액이 지갑에 없으면 버그로 읽힌다. */
    const sideSrc3 = fsx.readFileSync('src/web/games/holdem-client/side.ts', 'utf8');
    ck('언제 지급되는지 한 줄로 적는다', /대회가 끝날 때 한 번에 지급됩니다/.test(sideSrc3));
    ck('규칙 문단이 남아 있지 않다',
      !/즉시 받습니다/.test(sideSrc3) && !/ht-pz-bty-b/.test(sideSrc3));
    /* 프로그레시브 흔적이 문구에 남으면 화면이 거짓을 적는 것이 된다 */
    ck('"절반" 설명이 남아 있지 않다', !/절반/.test(sideSrc3));
    /* 누가 얼마 벌었나 — 이 표가 규칙 문단을 대신한다. 시작 전 0 도 그려야 한다:
       줄을 빼면 "표에 없는 사람"이 생겨 몇 명이 남았는지가 안 읽힌다. */
    ck('바운티 획득 표를 그린다', /class="ht-pz-brow/.test(sideSrc3)
      && /바운티 획득/.test(sideSrc3));
    ck('0 인 줄도 그린다 (0 을 걸러내지 않는다)',
      !/board\.filter\([^)]*won\s*>\s*0/.test(sideSrc3));
    ck('많이 번 순으로 서버가 정렬한다',
      /sort\(\(a, b\) => b\.won - a\.won \|\| a\.i - b\.i\)/
        .test(fsx.readFileSync('src/web/games/holdem.ts', 'utf8')));
    ck('한 푼이라도 번 줄만 밝게 둔다', /r\.won > 0 \? ' has' : ''/.test(sideSrc3));
    /* 표가 살아 있는 값이므로 탭이 열려 있는 동안 다시 그려야 한다. 예전에는 탭을 누를
       때 한 번만 그렸고(등수 표는 고정이라 그래도 됐다) 그래서 KO 가 나도 끝까지 전원
       0P 로 보였다(제보). 매 폴링마다 갈아 끼우면 글자가 튀므로 서명으로 가른다. */
    ck('상금 탭이 값이 바뀔 때 다시 그려진다',
      /if \(!prizeTabEl\.hidden\)/.test(sideSrc3)
      && /sig !== prizeSig[\s\S]{0,60}?renderPrizeTab\(\)/.test(sideSrc3));
    /* 서명은 서버 값이 아니라 스포일러를 걸러 낸 값으로 만들어야 한다 — 서버 값으로
       만들면 표를 붙들어 놓고도 서명이 먼저 바뀌어 다시 그려진다(자세한 검사는 [12]). */
    ck('서명에 걸러진 바운티 획득 값이 들어간다',
      /\(prizeBoard \|\| \[\]\)\.map\(function\(r\)\{ return r\.name \+ ':' \+ r\.won/
        .test(sideSrc3));
    ck('제목 옆 내 바운티 문구를 걷어냈다', !/내 봉투' : '내 바운티/.test(sideSrc3));

    /* 결과 팝업은 순위 상금 + 바운티 합계를 적어야 한다. 순위 상금만 적으면 바운티로만
       번 사람이 0P 로 찍히고, 이 대회의 절반이 사라진 것으로 보인다(제보). */
    const celSrc2 = fsx.readFileSync('src/web/games/holdem-client/celebrate.ts', 'utf8');
    ck('결과 팝업이 순위 상금 + 바운티를 합쳐 적는다',
      /function tookOf\(r\)\{ return \(r\.prize \|\| 0\) \+ \(r\.bounty \|\| 0\); \}/.test(celSrc2));
    ck('우승자 금액도 합계다', /tookOf\(first\)/.test(celSrc2));
    ck('나머지 줄도 합계다', /num\(tookOf\(r\)\)/.test(celSrc2)
      && !/num\(r\.prize\) \+ 'P'/.test(celSrc2));
    ck('입상 여부도 합계로 가른다', /var itm = tookOf\(r\) > 0/.test(celSrc2));
    ck('서버가 결과에 지급된 바운티를 싣는다',
      /bounty: e\.bounty_paid/.test(fsx.readFileSync('src/web/games/holdem.ts', 'utf8')));
    /* 로비의 대회 결과 표도 같은 규칙이어야 한다 — 두 곳이 같은 사람에게 다른 금액을
       적으면 어느 쪽이 맞는지 알 방법이 없다. */
    ck('로비 결과 표도 순위 상금 + 바운티를 합쳐 적는다',
      /res \? \(res\.prize \|\| 0\) \+ \(res\.bounty \|\| 0\) : \(prizeList\[pi\] \|\| 0\)/
        .test(fsx.readFileSync('src/web/games/holdem-client/lobby.ts', 'utf8')));

    /* 이름. progressive 가 없어졌으므로 PKO 라는 표기가 화면에 남으면 안 된다 —
       모드 값(PKO_BOUNTY)은 DB 에 이미 쓰인 값이라 그대로 두고 라벨만 바꿨다. */
    const admSrc4 = fsx.readFileSync('src/web/admin.ts', 'utf8');
    ck('대회 종류 라벨이 "바운티 헌터" 다', /바운티 헌터 \(순위 상금 \+ 바운티\)/.test(admSrc4));
    ck('목록 태그에 PKO 표기가 없다', !/ad-tag pko">PKO/.test(admSrc4));
    ck('모드 값 자체는 그대로다 (이미 저장된 행이 있다)',
      /value="PKO_BOUNTY"/.test(admSrc4)
      && /b\?\.mode === 'PKO_BOUNTY' \? 'PKO_BOUNTY'/.test(admSrc4));

    /* 프리롤 바운티 판은 상금 팟과 참가비가 모두 0 이라, 예전 기준으로는 "경제에 흔적이
       없는 판"으로 읽혀 그냥 지워졌다. 마감에서 펀드가 실제로 나갔으므로 거절해야 한다. */
    wipe();
    for (const p of ['z1', 'z2', 'z3']) mkUser(p, 100_000);
    const mkz = AD.createTournament({
      title: '프리롤 바운티', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: 0, prizeMultiplier: 10_000, mode: 'PKO_BOUNTY', bountyPct: 100,
      startingStack: 5_000, levelMin: 2, lateRegMin: 1, graceMin: 30,
    });
    if (mkz.ok) {
      for (const p of ['z1', 'z2', 'z3']) HD.registerHoldem(p, p);
      db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
      HD.advanceHoldem();
      const tbz = HD.getTable(mkz.id)!;
      for (let step = 0; step < 4_000; step++) {
        const fin = (db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
          .get(mkz.id) as { finished_at: number | null }).finished_at;
        if (fin != null) break;
        const h = HD.getCurrentHand(tbz.id);
        if (!h || h.ended_at != null || h.to_act_seat == null) {
          db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(now() - 1, tbz.id);
          HD.advanceHoldem();
          continue;
        }
        const s = HD.getSeats(tbz.id).find(x => x.seat === h.to_act_seat && x.presence !== 'OUT');
        if (!s) break;
        db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`)
          .run(now() + HD.ACTION_SEC, h.id);
        if (!HD.holdemAction(s.user_id, 'allin', 0).ok
          && !HD.holdemAction(s.user_id, 'call', 0).ok) HD.holdemAction(s.user_id, 'check', 0);
      }
      const bp = entriesOf(mkz.id).reduce((n, r) => n + r.bounty_paid, 0);
      ck('검사 전제 — 프리롤 바운티에서 펀드가 나갔다', bp === 30_000, String(bp));
      ck('상금 0 · 참가비 0 이라도 바운티가 나간 판은 그냥 지울 수 없다',
        AD.purgeTournament(mkz.id).ok === false);
    } else ck('프리롤 바운티 대회가 열린다', false, mkz.error);
  }

  /* ── 12. 미스터리 개봉 ───────────────────────────────────────────
     미스터리는 머리 위에 금액이 없다. 그래서 "얼마짜리를 잡았나"가 공개되는 자리가
     화면에 상자 하나뿐이고, 그 하나가 없어지면 모드가 성립하지 않는다. 여기서 보는 것은
     그 자리가 실제로 열리는가와, 다른 연출이 그것을 덮지 않는가다. */
  section('[12] 미스터리 개봉 — 상자가 열리고, 아무것도 그것을 덮지 않는다');
  {
    const seatsSrc = fsx.readFileSync('src/web/games/holdem-client/seats.ts', 'utf8');
    const cssSrc = fsx.readFileSync('src/web/assets/css/09-holdem.css', 'utf8');
    const htmlSrc = fsx.readFileSync('src/web/games/holdem.ts', 'utf8');
    const stateSrc2 = htmlSrc;        // 골격과 상태 응답이 같은 파일에 있다
    const hdSrcAll = fsx.readFileSync('src/db/holdem.ts', 'utf8');

    // 골격이 미리 있어야 한다 — 그때 만들면 레이아웃이 없어 첫 프레임이 튄다
    ck('상자 골격이 화면에 미리 있다', /id="htMysBox"/.test(htmlSrc)
      && /id="htMysAmt"/.test(htmlSrc) && /id="htMysWho"/.test(htmlSrc));
    ck('세 줄로 읽힌다 (누구 봉투 → 얼마 → 누가 가져갔나)',
      /id="htMysOf"/.test(htmlSrc) && /id="htMysAmt"/.test(htmlSrc)
      && /id="htMysWho"/.test(htmlSrc));
    ck('숫자가 굴러가는 창이 따로 있다', /class="ht-mysbox-reel"/.test(htmlSrc));
    ck('좌석보다 앞에 둔다 (좌석이 전광판을 덮지 않게)',
      htmlSrc.indexOf('id="htMysBox"') < htmlSrc.indexOf('id="htSeats"'));
    /* 상자 그림은 걷어냈다. CSS 로 그린 뚜껑·몸통이 조악했고, 연출의 내용은 "숫자가
       굴러가다 멈춘다"이지 상자가 아니다 — 그림 솜씨에 기대는 틀을 남겨 두면 다시 쓰인다. */
    ck('상자 그림이 남아 있지 않다',
      !/ht-mysbox-chest/.test(htmlSrc) && !/ht-mysbox-lid/.test(htmlSrc)
      && !/ht-mysbox-chest/.test(cssSrc) && !/mysShake/.test(cssSrc));

    /* 네 박자. 등장 → 굴림 → 멈춤 → 내려감. 굴리는 구간이 가장 길어야 한다 —
       기다리게 하는 것이 이 연출의 목적이고, 멈춤은 짧고 세게 지나가야 한다. */
    const num1 = (re: RegExp): number => Number(re.exec(seatsSrc)?.[1] ?? -1);
    const inMs = num1(/MYS_IN_MS = (\d+)/);
    const roll = num1(/MYS_ROLL_MS = (\d+)/);
    const land = num1(/MYS_LAND_MS = (\d+)/);
    const outMs = num1(/MYS_OUT_MS = (\d+)/);
    const tick = num1(/MYS_TICK_MS = (\d+)/);
    ck('네 박자가 모두 있다', inMs > 0 && roll > 0 && land > 0 && outMs > 0,
      `${inMs}/${roll}/${land}/${outMs}`);
    ck('굴리는 구간이 가장 길다 (긴장을 만드는 자리다)',
      roll > inMs && roll > land, `${roll} vs ${inMs}·${land}`);
    ck('금액을 읽을 시간이 등장보다 길다', land > inMs, `${land} vs ${inMs}`);
    /* 숫자가 바뀌는 간격이 너무 느리면 "굴러간다"가 아니라 "하나씩 바뀐다"로 보이고,
       너무 빠르면 잔상만 남아 아무것도 안 읽힌다. */
    ck('숫자가 바뀌는 간격이 30~90ms 다', tick >= 30 && tick <= 90, String(tick));
    ck('구간마다 클래스를 갈아 끼운다 (좌표를 손으로 옮기지 않는다)',
      /'ht-mysbox in'/.test(seatsSrc) && /'ht-mysbox in roll'/.test(seatsSrc)
      && /'ht-mysbox in land'/.test(seatsSrc) && /'ht-mysbox out'/.test(seatsSrc));
    for (const need of ['.ht-mysbox{', '.ht-mysbox-glow{', '.ht-mysbox-panel{',
      '.ht-mysbox-reel{', '.ht-mysbox-amt{', 'mysRoll', 'mysHit', 'mysLand']) {
      ck(`CSS 에 ${need} 가 있다`, cssSrc.includes(need));
    }
    /* 굴러가는 동안 숫자 폭이 흔들리면 판이 좌우로 떨려서 "덜컹거린다"로 보인다 */
    ck('숫자 창 폭이 고정이다', /\.ht-mysbox-reel\{[^}]*min-width:/.test(cssSrc));
    ck('등폭 숫자를 쓴다', /\.ht-mysbox-amt\{[^}]*font-variant-numeric:tabular-nums/.test(cssSrc));
    ck('굴러가는 동안은 읽히지 않게 둔다',
      /\.ht-mysbox\.roll \.ht-mysbox-amt\{[^}]*filter:blur/.test(cssSrc));
    ck('멈추는 순간 한 번 튄다', /\.ht-mysbox\.land \.ht-mysbox-panel\{animation:mysLand/
      .test(cssSrc));
    ck('멈출 때 빛이 커진다', /\.ht-mysbox\.land \.ht-mysbox-glow\{opacity:1/.test(cssSrc));
    /* z-index 는 레벨업 알림(60)보다 위여야 한다 — 개봉 중에 레벨이 오르는 일이
       실제로 있고, 그때 알림이 덮으면 이 모드의 유일한 공개 장면이 사라진다. */
    const zBox = Number(/\.ht-mysbox\{[^}]*z-index:(\d+)/.exec(cssSrc)?.[1] ?? -1);
    const zLv = Number(/\.ht-lvup\{[^}]*z-index:(\d+)/.exec(cssSrc)?.[1] ?? -1);
    ck('전광판이 레벨업 알림보다 위에 온다', zBox > zLv && zLv > 0, `${zBox} vs ${zLv}`);
    ck('움직임을 원치 않는 사람에게는 흔들림만 뺀다 (숫자는 남는다)',
      /prefers-reduced-motion[\s\S]{0,300}?\.ht-mysbox\.roll \.ht-mysbox-amt\{animation:none/
        .test(cssSrc));

    // 소리는 각 박자에 붙는다
    /* 회전음은 굴리는 구간과 같은 길이의 음원이라 한 번만 재생한다 — 숫자마다 딸깍
       소리를 내던 방식은 음원이 오면서 필요가 없어졌다. */
    ck('굴러갈 때 회전음이 한 번 난다',
      /'ht-mysbox in roll';[\s\S]{0,260}?casinoSfx\.reelRoll\(\)/.test(seatsSrc));
    ck('멈출 때 소리가 난다',
      /'ht-mysbox in land'[\s\S]{0,180}?casinoSfx\.reelStop\(\)/.test(seatsSrc));

    /* ── 봉투마다 하나씩 ──────────────────────────────────────────
       이것이 이 절의 핵심이다. 예전에는 확보 누계의 증가분으로 연출을 걸었는데, 한 사람이
       둘을 동시에 잡으면 두 봉투가 한 숫자로 합쳐져서 "누구 봉투가 얼마였나"가 화면에서
       사라졌다(제보). 그래서 서버가 판마다 [탈락자 · 금액 · 가져간 사람] 목록을 준다. */
    ck('서버가 봉투별 개봉 기록을 남긴다',
      /reveals\.push\(\{ v: victim\?\.username \?\? bustedUserId, a: bounty, k: names \}\)/
        .test(hdSrcAll)
      && /UPDATE holdem_hands SET bounty_reveals = \?/.test(hdSrcAll));
    ck('개봉 기록을 판에 붙인다 (연출이 필요한 범위가 그 판이다)',
      /ALTER TABLE holdem_hands ADD COLUMN bounty_reveals TEXT/
        .test(fsx.readFileSync('src/db/schema.ts', 'utf8')));
    ck('액면가를 따로 남긴다 (bounty 는 열리면 0 이 된다)',
      /bounty_face INTEGER NOT NULL DEFAULT 0/
        .test(fsx.readFileSync('src/db/schema.ts', 'utf8')));
    ck('미스터리에서만 목록을 내려보낸다',
      /bountyReveals: isMystery\(t\) && hand\?\.bounty_reveals/.test(stateSrc2));
    ck('깨진 JSON 이 연출을 멈추게 하지 않는다',
      /try \{ return JSON\.parse\(hand\.bounty_reveals\)[\s\S]{0,80}?catch \{ return null; \}/
        .test(stateSrc2));
    ck('화면이 목록으로 연출을 건다 (증가분이 아니다)',
      /tb\.bountyReveals && tb\.bountyReveals\.length/.test(seatsSrc)
      && /!mysPlayed\[tb\.handNo\]/.test(seatsSrc));
    ck('미스터리는 증가분 경로를 쓰지 않는다',
      /else if \(mystery\) wonShown\[s\.seat\] = wv;/.test(seatsSrc));
    ck('봉투마다 큐에 하나씩 넣는다',
      /rv\.forEach\(function\(r, i\)\{[\s\S]{0,220}?mysQueue\.push/.test(seatsSrc));
    ck('몇 번째 봉투인지 점으로 알려준다',
      /id="htMysDots"/.test(htmlSrc) && /job\.total > 1/.test(seatsSrc)
      && /\.ht-mysbox-dots i\.on\{/.test(cssSrc));
    /* 굴러가는 숫자로 실제 봉투 금액을 돌리면, 굴러가는 것만 보고도 다른 봉투가 얼마인지
       다 알 수 있다 — 미스터리의 뜻이 사라진다(실측 로그에 남의 봉투 금액이 그대로 찍혔다).
       자릿수마다 0~9 를 마구 뽑고, 자릿수만 당첨 금액과 같게 고정한다(폭이 흔들리지 않게). */
    ck('굴러가는 숫자를 마구잡이로 뽑는다 (다른 봉투가 새지 않게)',
      /Math\.floor\(Math\.random\(\) \* 10\)/.test(seatsSrc)
      && /var digits = String\(Math\.max\(1, job\.amount\)\)\.length/.test(seatsSrc));
    ck('실제 봉투 금액을 돌리지 않는다', !/job\.pool/.test(seatsSrc));
    ck('맨 앞자리는 0 이 아니다 (폭이 흔들리지 않게)',
      /1 \+ Math\.floor\(Math\.random\(\) \* 9\)/.test(seatsSrc));
    /* 판에 한 번만 재생해야 한다 — 폴링마다 같은 목록이 오고, 창을 다시 열어도 온다 */
    ck('같은 판을 두 번 재생하지 않는다',
      /mysPlayed\[tb\.handNo\] = 1;/.test(seatsSrc));
    ck('전광판은 한 번에 하나만 돈다 (줄을 세운다)',
      /if \(mysBusy \|\| !mysQueue\.length\) return;/.test(seatsSrc)
      && /mysBusy = false;\s*\n\s*mysPump\(\);/.test(seatsSrc));
    /* 공동 KO 면 몫을 나눠 각자에게 띄운다. 남는 1P 는 서버의 splitBounty 와 같은 방향으로
       앞사람에게 — 반대로 두면 화면 합계가 실제 지급액과 1P 어긋난다. */
    ck('공동 KO 면 몫을 나눠 각자에게 띄운다',
      /var each = Math\.floor\(job\.amount \/ n\)/.test(seatsSrc)
      && /i < job\.amount - each \* n \? 1 : 0/.test(seatsSrc));
    ck('전광판이 내려간 뒤에 +N P 가 뜬다',
      /function mysFinish\(job\)[\s\S]{0,700}?floatBGain\(seatEl, each/.test(seatsSrc));
    ck('이름으로 자리를 찾는다 (탈락자는 좌석 목록에서 사라진다)',
      /function mysSeatOf\(name\)/.test(seatsSrc));

    // 우승 팝업이 개봉을 덮지 않아야 한다
    const celSrc = fsx.readFileSync('src/web/games/holdem-client/celebrate.ts', 'utf8');
    ck('우승 팝업이 개봉이 끝날 때까지 기다린다',
      /mysBoxEndsAt[\s\S]{0,80}?Date\.now\(\) < mysBoxEndsAt \+ KO_GAIN_HOLD_MS\) return/
        .test(celSrc));
    ck('개봉 끝 시각을 첫 봉투가 돌기 전에 잡는다 (좌석 순서에 걸리지 않게)',
      /mEnds > mysBoxEndsAt\) mysBoxEndsAt = mEnds;[\s\S]{0,60}?mysPump\(\)/.test(seatsSrc));
    /* ── 스포일러 ──────────────────────────────────────────────────
       상금 탭의 바운티 획득 표가 서버 값을 그대로 그리면, 카드가 열리기도 전에 누가
       이겼는지가 오른쪽에서 새어 나간다(제보). 명찰·확보 표시가 쓰는 것과 같은 규칙을
       걸어야 한다. */
    const sideSrc4 = fsx.readFileSync('src/web/games/holdem-client/side.ts', 'utf8');
    ck('상금 탭이 연출이 끝날 때까지 직전 값을 붙든다',
      /var showBty = settleDone\(tb\) && Date\.now\(\) >= koBurstEndsAt[\s\S]{0,60}?mysBoxEndsAt/
        .test(sideSrc4)
      && /if \(showBty\) prizeBoard = t\.bountyBoard \|\| null;/.test(sideSrc4));
    ck('표를 그릴 때 서버 값이 아니라 걸러진 값을 쓴다',
      /var board = prizeBoard \|\| t\.bountyBoard \|\| \[\]/.test(sideSrc4));
    ck('서명도 걸러진 값으로 만든다 (안 그러면 붙들어도 다시 그린다)',
      /\(prizeBoard \|\| \[\]\)\.map\(function\(r\)\{ return r\.name \+ ':' \+ r\.won/
        .test(sideSrc4));

    /* 서버도 개봉 길이를 알아야 한다. 모르면 다음 판이 먼저 시작되면서 탈락한 자리가
       화면에서 사라지고, 그러면 개봉이 통째로 생략된다(처형에서 실제로 그랬다). */
    ck('다음 판이 개봉이 끝날 때까지 미뤄진다',
      /MYSTERY_REVEAL_SEC = 4\.6/.test(hdSrcAll)
      && /mysteryReveals: isMystery\(t\) \? bustedNow\.reveals : 0/.test(hdSrcAll));
    ck('개봉 개수를 열린 봉투 수로 센다',
      /return \{ busted: busted\.length, earners: earners\.size, reveals: reveals\.length \}/
        .test(hdSrcAll));
    ck('처형 시간은 탈락자 유무로 가른다 (개봉과 별개다)',
      /koExecution: isPko\(t\) && bustedNow\.busted > 0/.test(hdSrcAll));
    /* 화면 구간의 합과 서버 상수가 어긋나면 한쪽이 먼저 끝난다. 내려가는 시간까지 세야
       한다 — 다음 봉투는 그것이 끝난 뒤에 시작한다. */
    ck('서버 상수가 화면 구간의 합을 덮는다',
      4.6 * 1000 >= inMs + roll + land + outMs,
      `4600 vs ${inMs + roll + land + outMs}`);
    /* 정리가 끝난 뒤에 다음 봉투로 넘겨야 한다. 요소가 하나뿐이라, 겹쳐 시작하면 앞
       봉투의 정리 타이머가 새 전광판을 감춘다 — 실측으로 두 번째가 사라졌다. */
    ck('정리가 끝난 뒤에 다음 봉투로 넘긴다',
      /box\.className = 'ht-mysbox';\s*\n\s*mysFinish\(job\);/.test(seatsSrc));
    ck('대기 시각도 내려가는 시간을 센다', /mysBoxTotal\(\) \* mysQueue\.length/.test(seatsSrc));
    /* 봉투 단위로 재생하게 되면서 "합쳐진 금액"이라는 문제가 사라졌다 — 각 봉투는
       탈락자 한 명의 액면가이고, 우승자가 회수하는 자기 봉투는 개봉 대상이 아니다.
       그래서 마지막 판 예외 문구(job.over)도 필요 없어졌다. */
    ck('합쳐진 금액을 위한 예외 문구가 남아 있지 않다',
      !/최종 정산/.test(seatsSrc) && !/over: !!tb\.tournamentOver/.test(seatsSrc));
    ck('전광판이 탈락자 이름을 적는다',
      /job\.victim \+ ' 님의 바운티'/.test(seatsSrc));
    const delayMys = HD.nextHandDelaySec({
      showdown: false, boardAtEnd: 5, liveCount: 1, extraPots: 0,
      koExecution: true, mysteryReveals: 1,
    });
    const delayPko = HD.nextHandDelaySec({
      showdown: false, boardAtEnd: 5, liveCount: 1, extraPots: 0, koExecution: true,
    });
    ck('미스터리가 프로그레시브보다 더 미뤄진다', delayMys > delayPko,
      `${delayMys} vs ${delayPko}`);
    /* 총합을 한 번만 초 단위로 반올림하므로 4.6 이 4 초나 5 초로 잡힐 수 있다 —
       정확한 값이 아니라 "상자 하나를 덮는다"를 본다. */
    ck('상자 하나 길이(4.6초)를 덮는다',
      delayMys - delayPko >= 4 && delayMys - delayPko <= 5,
      String(delayMys - delayPko));
    // 둘이 동시에 털리면 상자도 둘이라 시간도 두 배다
    const delayTwo = HD.nextHandDelaySec({
      showdown: false, boardAtEnd: 5, liveCount: 1, extraPots: 0,
      koExecution: true, mysteryReveals: 2,
    });
    /* 총합을 한 번만 반올림하므로(초 단위 정수) 4.2 × 2 = 8.4 가 9 로 올라갈 수 있다.
       그래서 정확한 값이 아니라 "상자 하나만큼 더 미뤄졌다"를 본다. */
    ck('두 명이 털리면 상자 하나만큼 더 미뤄진다',
      delayTwo - delayMys >= 4 && delayTwo - delayMys <= 5,
      `${delayTwo} - ${delayMys}`);
    ck('두 상자 길이(8.4초)를 덮는다', delayTwo - delayPko >= 8,
      String(delayTwo - delayPko));
    ck('미스터리가 아니면 예전과 같다',
      HD.nextHandDelaySec({
        showdown: false, boardAtEnd: 5, liveCount: 1, extraPots: 0,
        koExecution: true, mysteryReveals: 0,
      }) === delayPko);
  }

  /* ── 13. 봉투 배분의 성질 ────────────────────────────────────────
     정밀 오딧에서 나온 두 결함을 못 박는다. 둘 다 아주 작은 펀드에서만 나왔지만,
     그 구간에서 연출이 통째로 생략되거나(0P 봉투) 범위표가 거짓이 됐다. */
  section('[13] 봉투 배분 — 빈 봉투도 없고 범위표도 지킨다');
  {
    const mkRand2 = (seed: number): (() => number) => {
      let s = seed >>> 0;
      return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
    };
    let sumBad = 0, zeroBad = 0, overBad = 0, underBad = 0, n = 0;
    const bad: string[] = [];
    for (const fund of [1, 3, 6, 8, 9, 12, 15, 19, 33, 99, 199, 499, 699, 1_001, 25_000, 100_000]) {
      for (const cnt of [2, 3, 4, 5, 6, 7, 8, 9, 12, 20]) {
        const r = T.envelopeRange(cnt);
        const loP = Math.floor(fund * r.lo / 100), hiP = Math.floor(fund * r.hi / 100);
        for (let seed = 1; seed <= 60; seed++) {
          const e = T.mysteryEnvelopes(fund, cnt, mkRand2(seed * 6151 + fund));
          n++;
          if (e.reduce((a, b) => a + b, 0) !== fund || e.some(x => x < 0) || e.length !== cnt) {
            sumBad++; if (bad.length < 4) bad.push(`합 ${fund}P·${cnt}인 ${JSON.stringify(e)}`);
          }
          /* 0P 봉투는 열리는 순간이 허탕이고, 그보다 나쁘게는 settleBounty 가 bounty<=0
             에서 조기 반환해 개봉 연출이 통째로 생략된다(실측 3P·3인 → [2,1,0]). */
          if (fund >= cnt && e.some(x => x === 0)) {
            zeroBad++; if (bad.length < 4) bad.push(`빈봉투 ${fund}P·${cnt}인 ${JSON.stringify(e)}`);
          }
          /* 범위는 P 단위로 잰다 — 칸(%)은 정수지만 P 환산에서 내림이 물리므로,
             퍼센트로 비교하면 lo 칸을 정확히 받은 봉투도 미달로 보인다. */
          if (hiP >= 1 && e.some(x => x > hiP)) {
            overBad++; if (bad.length < 4) bad.push(`상한 ${fund}P·${cnt}인 hi=${hiP}P ${JSON.stringify(e)}`);
          }
          if (fund >= cnt && e.some(x => x < loP)) {
            underBad++; if (bad.length < 4) bad.push(`하한 ${fund}P·${cnt}인 lo=${loP}P ${JSON.stringify(e)}`);
          }
        }
      }
    }
    ck(`합·개수·음수가 언제나 옳다 (${n.toLocaleString('ko-KR')}회)`, sumBad === 0, String(sumBad));
    ck('빈 봉투가 없다 (펀드 ≥ 인원)', zeroBad === 0, String(zeroBad));
    ck('상한을 넘지 않는다', overBad === 0, String(overBad));
    ck('하한 아래로 내려가지 않는다', underBad === 0, String(underBad));
    for (const b of bad) console.log('        ' + b);
    /* 범위표 폴백이 자기 모순이면 안 된다 — 상한이 "나머지 전원의 하한" 자리를 남겨야
       한 봉투가 상한까지 갔을 때 누군가 하한 아래로 내려가지 않는다(2인에서 실측). */
    for (const cnt of [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 20]) {
      const r = T.envelopeRange(cnt);
      ck(`${cnt}인 범위가 자기 모순이 아니다 (lo×(n-1)+hi ≤ 100)`,
        r.lo * (cnt - 1) + r.hi <= 100 || r.hi === Math.ceil(100 / cnt),
        `lo=${r.lo} hi=${r.hi} → ${r.lo * (cnt - 1) + r.hi}`);
    }
    /* 마감 정리가 0P 봉투도 열어야 한다. `bounty > 0` 으로 걸러 두면 대회가 끝났는데도
       그 사람 응답에 myBounty: null 이 실려 자기 봉투가 "?" 로 남는다(실측). */
    ck('마감 정리가 0P 봉투도 연다',
      /UPDATE holdem_entries SET bounty = 0, bounty_revealed = 1\s*\r?\n\s*WHERE tournament_id = \?`, t\.id\)/
        .test(fsx.readFileSync('src/db/holdem.ts', 'utf8')));
  }

  section('[14] 도전과제 — 두 장르 모두에서 깨진다');
  {
    /* 랭킹을 장르로 가르고 나니 "과제도 갈렸나"가 따라온다. 갈리면 안 된다 — 홀덤
       과제는 홀덤에서 깨져야지, 그날 열린 대회가 어느 방식이었느냐로 달라질 이유가 없다.

       판정 자리가 둘인데 둘 다 mode 를 보지 않는다는 것을 실행으로 확인한다:
         ho-bounty-4      finishTournament → awardBounty (ko_count ≥ 4 + 우승)
         ho-straight-flush endHand → awardStraightFlush (쇼다운 공개)
       특히 ko_count 는 isPko(t) 바깥에서 오르는지가 관건이다. 안쪽으로 들어가면
       일반 대회에서는 KO 가 세어지지 않아 이 과제가 바운티 전용이 된다. */
    const AC = require('../src/db/achievements') as typeof import('../src/db/achievements');
    const fs14 = require('node:fs') as typeof import('node:fs');
    const src = fs14.readFileSync('src/db/holdem.ts', 'utf8');

    /* 운영과 같은 과제 목록을 넣는다. 직접 upsert 로 만들어 넣으면 내가 적은 값을
       내가 확인하는 꼴이라 아무것도 검증하지 못한다 — 실제 시드 스크립트를 돌려
       운영에 들어가는 그 정의로 판정한다. */
    process.env.QUIET = '1';
    require('./seed-achievements');

    /* 프리롤은 참가비가 0 이라, 두 과제의 최소 베팅이 0 이 아니면 어느 모드에서도
       영영 안 깨진다(awardIfBet 이 bet < min 에서 막는다). */
    for (const id of ['ho-bounty-4', 'ho-straight-flush']) {
      const a = AC.listAchievements().find(x => x.id === id);
      ck(`${id} — 최소 베팅이 0 이라 프리롤에서도 판정된다`, a != null && a.min_bet === 0,
        a ? String(a.min_bet) : '없음');
    }

    /* KO 세는 자리가 isPko 바깥이어야 한다. 위치를 글자로 확인한다 —
       "일반 대회에서도 KO 가 세어진다"는 아래에서 실제 대회를 돌려 확인한다. */
    const iKo = src.indexOf('UPDATE holdem_entries SET ko_count = ko_count + 1');
    const iPko = src.indexOf('if (isPko(t) && killers.length)');
    ck('KO 세기가 바운티 판정보다 앞에 있다 (모드와 무관하게 센다)',
      iKo > 0 && iPko > iKo, `ko@${iKo} pko@${iPko}`);

    // ── 일반(CLASSIC) 대회에서 KO 넷 + 우승 → 과제가 열린다
    wipe();
    db.exec(`DELETE FROM user_achievements`);   // 과제 정의는 남기고 달성 기록만 비운다
    const P5 = ['a1', 'a2', 'a3', 'a4', 'a5'];
    for (const p of P5) mkUser(p, 100_000);
    const made = AD.createTournament({
      title: '일반 대회 과제 검사', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: 0, prizeMultiplier: 10_000, mode: 'CLASSIC',
    });
    if (!made.ok) { console.log('대회 실패: ' + made.error); process.exit(1); }
    for (const p of P5) HD.registerHoldem(p, p);
    db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
    HD.advanceHoldem();
    const table = HD.getTable(made.id)!;
    ck('검사 전제: 일반 대회다', HD.isPko(
      db.prepare(`SELECT * FROM holdem_tournaments WHERE id=?`).get(made.id) as never) === false);

    /* a1 에게 AA, 나머지는 짧은 스택으로 두고 한 판에 다 털리게 한다.
       확률에 맡기면 감사가 이따금 실패하므로 카드와 스택을 못 박는다. */
    const hand = HD.getCurrentHand(table.id)!;
    const hole: Record<string, number[]> = {
      a1: [c(12, 0), c(12, 1)], a2: [c(0, 0), c(0, 1)], a3: [c(1, 0), c(1, 1)],
      a4: [c(2, 0), c(2, 1)], a5: [c(3, 0), c(3, 1)],
    };
    for (const s of HD.getSeats(table.id)) {
      db.prepare(`UPDATE holdem_hand_seats SET hole_json = ? WHERE hand_id = ? AND seat = ?`)
        .run(JSON.stringify(hole[s.user_id]), hand.id, s.seat);
    }
    db.prepare(`UPDATE holdem_hands SET board_json = ? WHERE id = ?`)
      .run(JSON.stringify([c(5, 2), c(7, 3), c(9, 0), c(10, 1), c(11, 3)]), hand.id);
    for (const uid of ['a2', 'a3', 'a4', 'a5']) {
      db.prepare(`UPDATE holdem_hand_seats SET stack = 300 WHERE hand_id = ? AND user_id = ?`)
        .run(hand.id, uid);
      db.prepare(`UPDATE holdem_seats SET stack = 300 WHERE table_id = ? AND user_id = ?`)
        .run(table.id, uid);
    }
    for (let i = 0; i < 80; i++) {
      const h = HD.getCurrentHand(table.id);
      if (!h || h.ended_at != null || h.to_act_seat == null) break;
      const seat = HD.getSeats(table.id).find(x => x.seat === h.to_act_seat)!;
      db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`)
        .run(now() + HD.ACTION_SEC, h.id);
      if (!HD.holdemAction(seat.user_id, 'allin', 0).ok) HD.holdemAction(seat.user_id, 'call', 0);
    }
    const a1 = entriesOf(made.id).find(r => r.user_id === 'a1')!;
    ck('일반 대회에서도 KO 가 세어진다', a1.ko_count === 4, String(a1.ko_count));
    // 대회를 끝까지 밀어 마감 정산(awardBounty)이 돌게 한다
    for (let i = 0; i < 40; i++) {
      const st = HD.advanceHoldem();
      if (st.status === 'FINISHED' || st.status === 'NONE') break;
      db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE tournament_id = ?`)
        .run(now() - 1, made.id);
    }
    ck('검사 전제: a1 이 우승했다',
      entriesOf(made.id).find(r => r.user_id === 'a1')!.finish_place === 1);
    ck('일반 대회에서 [죽음의 바운티 헌터]가 열린다',
      AC.hasAchievement('a1', 'ho-bounty-4'));

    /* 스트레이트 플러시는 endHand 에서 판정한다 — 그 자리도 mode 를 보지 않는다.
       카드를 짜서 실제로 한 판을 돌려 확인하는 것이 가장 확실하지만, 그러려면 쇼다운까지
       가는 판을 또 세워야 한다. 여기서는 판정 함수가 대회 모드를 인자로도, 조건으로도
       쓰지 않는다는 것을 글자로 못 박는다. */
    const sf = src.slice(src.indexOf('function awardStraightFlush'),
      src.indexOf('/** 핸드 종료'));
    ck('스트레이트 플러시 판정이 모드를 보지 않는다',
      sf.length > 0 && !/isPko|isMystery|mode/.test(sf));
    ck('그 판정이 endHand 에서 불린다', /awardStraightFlush\(t, /.test(src));
    /* 바운티 판정도 마찬가지다 — awardBounty 는 finishTournament 에서 무조건 불린다. */
    ck('바운티 헌터 판정도 모드를 보지 않는다',
      !/isPko|isMystery/.test(src.slice(src.indexOf('function awardBounty'),
        src.indexOf('function announceWinner'))));
  }

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

void bountyPaid;
main().catch(e => { console.error(e); process.exit(1); });
