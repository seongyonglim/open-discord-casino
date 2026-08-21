/* 미리보기 DB 에 «실제 규모» 의 랭킹 데이터를 붓는다.
 *
 * ── 왜 필요한가
 * 랭킹 화면을 폰에서 보려면 표가 실제로 차 있어야 한다. 미리보기 DB 는 유저가 스무 명
 * 남짓이고 대부분 0P 라, 표가 세 줄만 나오고 숫자는 다섯 자리다. 그 상태로는 어디가
 * 깨지는지 안 보인다 — 랭킹이 무너지는 것은 «긴 닉네임 + 아홉 자리 숫자 + 여섯 열» 이
 * 한 줄에 들어갈 때이고, 그건 데이터가 있어야 재현된다.
 *
 * 그래서 실제와 같은 «모양» 을 만든다. 값이 진짜일 필요는 없지만 분포는 진짜여야 한다:
 *   - 닉네임 길이가 2~13글자로 흩어져 있다 (한글·영문·이모지 섞임)
 *   - 포인트가 0 부터 억 단위까지 흩어져 있다 (자릿수가 다른 줄이 섞여야 한다)
 *   - 판수·승률·순수익이 게임마다 다르다 (열이 다섯 개인 표를 채운다)
 *   - 홀덤은 대회 결과로 집계되므로 대회와 참가 기록을 따로 만든다 (열이 여섯 개다)
 *
 * ── 안전
 * 미리보기 DB 만 건드린다. DB_PATH 가 casino-preview 로 끝나지 않으면 아무것도 안 하고
 * 멈춘다 — 운영 DB 나 개발 DB 에 표본 데이터를 붓는 일은 절대 없어야 한다.
 *
 * 쓰는 법:
 *   DB_PATH=%TMP%/casino-preview npx tsx scripts/seed-rank-preview.ts
 *   (미리보기 서버가 이미 그 경로를 쓴다 — _preview.tmp.ts 를 보라)
 */
import { getDb } from '../src/db/schema';

const path = process.env.DB_PATH ?? '';
if (!/casino-preview\/?$/.test(path.replace(/\\/g, '/'))) {
  console.error('DB_PATH 가 미리보기 DB(casino-preview)가 아니다 — 아무것도 안 한다.');
  console.error('  지금 값: ' + (path || '(없음)'));
  process.exit(1);
}

/* 닉네임. 길이가 흩어져 있어야 의미가 있다 — 짧은 것만 있으면 표가 안 깨지고,
   긴 것만 있으면 실제보다 나쁘게 보인다. 디스코드에서 실제로 보이는 모양을 섞었다. */
const NAMES = [
  /* 미리보기 계정(김딜러·타짜김씨·박콜·최레이즈·두번째유저)과 겹치는 이름은 쓰지 않는다 —
     랭킹에 같은 이름이 두 줄 나오면 데이터가 아니라 화면이 고장 난 것처럼 보인다. */
  '준', '하늘', '정올인', '한판만더', '조커', '레이즈장인', '올인장인', '슬픈고래',
  '도파민중독자', '칩쌓는사람', '운빨망령', '한강물차갑나요', '기도메타', '무지개빛깔조랑말',
  'OD_승부사', 'AllInAndy', 'luckyseven77', 'Mr.블러프', '킹크랩🦀', '대박기원🍀',
  '올림포스의불꽃', '조용한관찰자', '삼점슛', '흑우', '흑우아님', '레이크사냥꾼',
  '나는야포커왕', '점심값벌러옴', '퇴근길한판', '새벽의포커페이스', '반반무많이',
  '털린다', '털렸다', '털었다', '오늘만사는사람', '적립식투자자', '확률의노예',
  '스몰블라인드', '빅블라인드', '버튼', '언더더건', '컷오프', '하이잭',
  '딜러님사랑해요', '고니', '아귀', '평경장',
];

const GAMES = ['mines', 'ladder', 'graph', 'poker', 'baccarat', 'blackjack'] as const;

/* 흩어짐을 재현 가능하게 만든다 — 같은 씨앗이면 같은 화면이 나와야 비교를 할 수 있다.
   (Math.random 을 쓰면 잴 때마다 표가 달라져서 "고쳐졌나" 를 판단할 수 없다) */
let seed = 20260821;
function rnd(): number { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];

const db = getDb();
/* 미리보기 서버가 같은 파일을 열어 두고 폴링마다 쓴다 — 기다리지 않으면 그 순간에
   걸려 "database is locked" 로 죽는다(실제로 원장 붓는 도중에 그렇게 죽었다). */
db.exec('PRAGMA busy_timeout = 8000');
const now = Math.floor(Date.now() / 1000);

const season = db.prepare(
  `SELECT id, number, name FROM seasons ORDER BY id DESC LIMIT 1`).get() as
  { id: number; number: number; name: string } | undefined;
if (!season) { console.error('시즌이 없다 — 미리보기 서버를 한 번 띄워 시즌을 만들어야 한다.'); process.exit(1); }
console.log(`시즌 #${season.number} (${season.name}) 에 붓는다`);

const seasonStart0 = (db.prepare(`SELECT started_at FROM seasons WHERE id = ?`)
  .get(season.id) as { started_at: number }).started_at;

/* 다시 부어도 같은 화면이 나와야 한다 — 표본이 쌓이면 대회가 열여덟 개가 되고
   분포가 달라져서, 화면을 고친 효과와 데이터가 늘어난 효과를 구별할 수 없다.
   그래서 이 도구가 전에 부은 것만 먼저 지운다(sample- 로 시작하는 계정과 그 흔적). */
db.exec('BEGIN');
const oldTours = (db.prepare(
  `SELECT DISTINCT tournament_id AS id FROM holdem_entries WHERE user_id LIKE 'sample-%'`)
  .all() as { id: number }[]).map(r => r.id);
for (const id of oldTours) {
  db.prepare(`DELETE FROM holdem_entries WHERE tournament_id = ?`).run(id);
  db.prepare(`DELETE FROM holdem_tournaments WHERE id = ?`).run(id);
}
db.prepare(`DELETE FROM points_ledger WHERE user_id LIKE 'sample-%'`).run();
db.prepare(`DELETE FROM season_stats WHERE user_id LIKE 'sample-%'`).run();
db.exec('COMMIT');
if (oldTours.length) console.log(`전에 부은 대회 ${oldTours.length}개를 지웠다`);

const upUser = db.prepare(
  `INSERT INTO users (id, username, avatar, balance, created_at, last_active)
   VALUES (?, ?, NULL, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET username = excluded.username, balance = excluded.balance`);
const upStat = db.prepare(
  `INSERT INTO season_stats (season_id, user_id, game, rounds, rated, wins, pushes, staked, returned, profit, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(season_id, user_id, game) DO UPDATE SET
     rounds = excluded.rounds, rated = excluded.rated, wins = excluded.wins,
     pushes = excluded.pushes, staked = excluded.staked, returned = excluded.returned,
     profit = excluded.profit, updated_at = excluded.updated_at`);

let stats = 0;
db.exec('BEGIN');
NAMES.forEach((name, i) => {
  const uid = 'sample-' + (i + 1);
  /* 포인트 분포 — 위쪽 몇 명이 억 단위로 튀고 대부분은 백만 단위, 꼬리는 0 근처.
     실제 랭킹이 이 모양이고, 화면에서 «자릿수가 다른 줄» 이 섞이는 것이 중요하다. */
  const balance = i < 3 ? ri(60_000_000, 180_000_000)
    : i < 8 ? ri(8_000_000, 40_000_000)
      : i < 22 ? ri(400_000, 4_000_000)
        : i < 40 ? ri(10_000, 300_000)
          : ri(0, 4_000);
  upUser.run(uid, name, balance, now - ri(20, 300) * 86400, now - ri(0, 6) * 3600);

  /* 게임별 기록. 아무도 여섯 게임을 다 하지는 않는다 — 두세 개에 몰리는 것이 실제다. */
  const mine = GAMES.filter(() => rnd() < 0.45);
  for (const g of (mine.length ? mine : [pick(GAMES)])) {
    const rounds = ri(12, 4200);
    const rated = Math.floor(rounds * (g === 'blackjack' ? 0.96 : 1));
    const wins = Math.floor(rated * (0.28 + rnd() * 0.3));
    const pushes = g === 'blackjack' ? Math.floor(rated * 0.06) : 0;
    const staked = rounds * ri(120, 9000);
    /* 순수익은 대부분 마이너스다(하우스 엣지). 그래야 «+ 는 초록, - 는 빨강» 이 섞인
       실제 화면이 된다 — 전부 플러스면 색 대비를 못 본다. */
    const profit = Math.floor(staked * (rnd() < 0.32 ? rnd() * 0.35 : -rnd() * 0.22));
    upStat.run(season.id, uid, g, rounds, rated, wins, pushes, staked, staked + profit, profit, now);
    stats++;
  }
});
db.exec('COMMIT');
console.log(`유저 ${NAMES.length}명 · 게임 기록 ${stats}줄`);

/* ── 시즌에 «참가했다» 는 흔적 ─────────────────────────────────────
   통합 랭킹은 users.balance 순인데, 대상은 «그 시즌에 포인트가 움직인 사람» 뿐이다
   (season.ts 의 ACTIVE_IN_SEASON). 가입만 하고 안 들어온 사람이 시작 잔액 그대로
   위쪽에 앉는 것을 막는 규칙이다.
   그래서 원장에 줄이 없으면 47명이 통째로 랭킹에서 빠진다 — 처음에 이걸 빼먹고
   부었더니 통합 랭킹에 옛 계정 일곱 줄만 남아서, 데이터를 부은 것이 무효였다. */
const led = db.prepare(
  `INSERT INTO points_ledger (user_id, delta, reason, balance_after, created_at)
   VALUES (?, ?, ?, ?, ?)`);
db.exec('BEGIN');
let ledRows = 0;
NAMES.forEach((_, i) => {
  const uid = 'sample-' + (i + 1);
  const bal = (db.prepare(`SELECT balance FROM users WHERE id = ?`).get(uid) as { balance: number }).balance;
  /* 잔액과 원장 합을 맞춰 둔다 — 미리보기라도 «잔액 = 원장 합» 이 깨지면 다른 화면
     (내 기록·정산)에서 엉뚱한 값이 보인다. 큰 줄 하나 + 잔돈 몇 줄로 나눈다. */
  const small = ri(2, 5);
  let left = bal, after = 0;
  for (let k = 0; k < small; k++) {
    const d = k === small - 1 ? left : Math.floor(left / (small - k) * (0.4 + rnd() * 0.8));
    left -= d; after += d;
    led.run(uid, d, pick(['game:blackjack', 'game:poker', 'game:ladder', 'checkin', 'game:baccarat']),
      after, seasonStart0 + ri(60, Math.max(120, now - seasonStart0 - 60)));
    ledRows++;
  }
});
db.exec('COMMIT');
console.log(`원장 ${ledRows}줄`);

/* ── 홀덤 — 대회와 참가 기록 ────────────────────────────────────────
   홀덤 랭킹은 season_stats 가 아니라 끝난 대회의 참가 기록에서 온다. 열이 여섯 개라
   폰에서 가장 먼저 깨지는 표이므로 반드시 채워야 한다. 두 장르를 다 만든다. */
const tour = db.prepare(
  `INSERT INTO holdem_tournaments (date_str, title, reg_open_at, scheduled_start_at, grace_ends_at,
     prize_multiplier, started_at, finished_at, mode, buy_in, prize_fixed, bounty_pool, bounty_pct)
   VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 50)`);
const entry = db.prepare(
  `INSERT INTO holdem_entries (tournament_id, user_id, username, registered_at,
     finish_place, elim_seq, eliminated_at, prize, paid_in, ko_count, bounty, bounty_won, bounty_paid)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`);

const seasonStart = seasonStart0;

db.exec('BEGIN');
let tours = 0, entries = 0;
for (let t = 0; t < 9; t++) {
  const mode = t % 3 === 2 ? 'BOUNTY' : 'CLASSIC';
  const fin = Math.max(seasonStart + 3600, now - (9 - t) * 86400 - ri(0, 7200));
  const day = new Date(fin * 1000).toISOString().slice(0, 10);
  const buyIn = pick([10_000, 20_000, 50_000]);
  const n = ri(11, 27);
  const pool = buyIn * n;
  const r = tour.run(day, mode === 'BOUNTY' ? '미스터리 바운티' : '데일리 토너먼트',
    fin - 7200, fin - 5400, fin - 5000, fin - 5400, fin, mode, buyIn,
    mode === 'BOUNTY' ? Math.floor(pool * 0.5) : pool, mode === 'BOUNTY' ? Math.floor(pool * 0.5) : 0);
  const tid = Number(r.lastInsertRowid);
  tours++;

  /* 참가자를 뽑아 등수를 매긴다. 상금은 위 세 명에게 몰리고 나머지는 0 — 실제 지급표가
     그 모양이라, «상금 0P 인 줄» 이 표의 대부분이어야 한다. */
  const players: number[] = [];
  while (players.length < n) { const k = ri(0, NAMES.length - 1); if (!players.includes(k)) players.push(k); }
  players.forEach((k, place0) => {
    const place = place0 + 1;
    const prize = place === 1 ? Math.floor(pool * 0.45)
      : place === 2 ? Math.floor(pool * 0.27)
        : place === 3 ? Math.floor(pool * 0.16)
          : place <= Math.max(4, Math.floor(n * 0.2)) ? Math.floor(pool * 0.04) : 0;
    const ko = ri(0, 4);
    entry.run(tid, 'sample-' + (k + 1), NAMES[k], fin - 5600, place,
      place === 1 ? null : n - place + 1, place === 1 ? null : fin - ri(60, 4000),
      prize, buyIn, ko, mode === 'BOUNTY' ? ko * Math.floor(buyIn * 0.5) : 0,
      mode === 'BOUNTY' ? ko * Math.floor(buyIn * 0.5) : 0);
    entries++;
  });
}
db.exec('COMMIT');
console.log(`대회 ${tours}개 · 참가 기록 ${entries}줄`);
console.log('완료 — 미리보기 서버의 /leaderboard 를 새로 고치면 보인다.');
