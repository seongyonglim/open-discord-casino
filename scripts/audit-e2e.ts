// 엔드투엔드 감사 — 실제 세션으로 네 게임을 라운드 끝까지 플레이한다.
// 특히 "아직 공개되면 안 되는 정보가 응답에 새지 않는가"를 본다. 이게 새면 게임이 성립하지 않는다.

// 감사는 항상 일회용 DB에서 돈다. DB_PATH를 지정하지 않고 실행해도 로컬/운영 데이터를 건드리지 않게
// 여기서 임시 경로로 못 박는다(첫 import보다 먼저 실행되어야 하므로 파일 맨 위에 둔다).
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
  process.env.DB_PATH = dir;
}

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { getDb } from '../src/db/schema';
import { upsertUser, adjustBalance, getWebUser, createSession } from '../src/db/queries';
// 최소 액션 간격을 "지난 것으로" 만들 때 쓴다 (아래 openNow)
import { ACTION_SEC } from '../src/db/holdem';

const PORT = Number(process.env.AUDIT_PORT ?? 8213);
let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Res { status: number; body: any; text: string }
function req(method: string, path: string, cookie: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: { cookie, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, res => {
      const c: Buffer[] = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode ?? 0, body: parsed, text });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function mkSession(id: string, start: number): string {
  upsertUser(id, 'E2E' + id, null);
  const cur = getWebUser(id)?.balance ?? 0;
  if (cur !== start) adjustBalance(id, start - cur, 'test:seed');
  const t = randomBytes(16).toString('hex');
  createSession(t, id, Math.floor(Date.now() / 1000) + 3600);
  return 'sid=' + t;
}
const bal = (id: string) => getWebUser(id)!.balance;
const db = getDb();

// 특정 phase가 될 때까지 폴링 (최대 maxMs)
async function waitPhase(path: string, cookie: string, want: string | ((p: string) => boolean), maxMs = 45000) {
  const test = typeof want === 'string' ? (p: string) => p === want : want;
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < maxMs) {
    const r = await req('GET', path, cookie);
    last = r.body;
    if (last?.round?.phase && test(last.round.phase)) return last;
    await sleep(200);
  }
  return last;
}

async function main(): Promise<void> {
  const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');
  process.env.PORT = String(PORT);
  startWebServer();
  await sleep(600);

  /* ── 사다리 한 라운드 완주 ─────────────────────────────────── */
  section('[1] 사다리 — 베팅부터 정산까지 한 라운드 완주');
  {
    const c = mkSession('e_lad', 5000);
    const st = await waitPhase('/api/games/ladder/state', c, 'betting');
    ck('베팅 단계 진입', st?.round?.phase === 'betting', String(st?.round?.phase));
    ck('베팅 중에는 결과가 응답에 없음',
      st.round.startSide == null && st.round.endSide == null,
      JSON.stringify({ s: st.round.startSide, e: st.round.endSide }));
    ck('베팅 중에는 가로줄(rungs)도 없음', st.round.rungs == null, JSON.stringify(st.round.rungs));

    const before = bal('e_lad');
    const bet = await req('POST', '/api/games/ladder/bet', c, { betAmount: 500, startGuess: 'L' });
    ck('베팅 수락', bet.body?.ok === true, JSON.stringify(bet.body));
    ck('응답 잔액 = DB 잔액', bet.body?.balance === bal('e_lad'), `${bet.body?.balance} vs ${bal('e_lad')}`);
    ck('정확히 500P 차감', before - bal('e_lad') === 500, String(before - bal('e_lad')));

    const done = await waitPhase('/api/games/ladder/state', c, 'done');
    ck('정산 단계 도달', done?.round?.phase === 'done', String(done?.round?.phase));
    ck('정산 후에는 결과가 공개됨', done.round.startSide != null && done.round.endSide != null);
    const myBet = done.myBet;
    ck('내 베팅 결과가 내려옴', myBet != null && (myBet.won === 0 || myBet.won === 1), JSON.stringify(myBet));
    const expected = before - 500 + (myBet?.payout ?? 0);
    ck(`지급 반영 정확 (적중=${myBet?.won}, 지급=${myBet?.payout})`, bal('e_lad') === expected,
      `${bal('e_lad')} vs ${expected}`);
    ck('적중 시 배당이 1.95배 내림', myBet?.won !== 1 || myBet.payout === Math.floor(500 * 1.95),
      String(myBet?.payout));
  }

  /* ── 그래프 한 라운드 완주 ─────────────────────────────────── */
  section('[2] 그래프 — 베팅→상승→캐시아웃');
  {
    const c = mkSession('e_crash', 5000);
    const st = await waitPhase('/api/games/crash/state', c, 'betting');
    ck('베팅 단계 진입', st?.round?.phase === 'betting', String(st?.round?.phase));
    ck('베팅 중 크래시 지점 비공개', st.round.crashPoint == null && st.round.crash_point == null,
      JSON.stringify(st.round));

    const before = bal('e_crash');
    const bet = await req('POST', '/api/games/crash/bet', c, { betAmount: 400 });
    ck('베팅 수락 + 차감', bet.body?.ok === true && before - bal('e_crash') === 400, String(before - bal('e_crash')));

    const running = await waitPhase('/api/games/crash/state', c, 'running');
    ck('상승 단계 진입', running?.round?.phase === 'running', String(running?.round?.phase));
    ck('상승 중에도 크래시 지점 비공개',
      running.round.crashPoint == null && running.round.crash_point == null, JSON.stringify(running.round));

    const out = await req('POST', '/api/games/crash/cashout', c, {});
    if (out.body?.ok) {
      ck('캐시아웃 지급 = floor(400 × 배율)', out.body.payout === Math.floor(400 * out.body.multiplier),
        `${out.body.payout} vs ${Math.floor(400 * out.body.multiplier)}`);
      ck('캐시아웃 후 잔액 정확', bal('e_crash') === before - 400 + out.body.payout, String(bal('e_crash')));
    } else {
      ck('캐시아웃 실패 시 이유가 명확 (이미 터짐)', typeof out.body?.error === 'string', JSON.stringify(out.body));
      ck('실패 시 잔액 변화 없음', bal('e_crash') === before - 400, String(bal('e_crash')));
    }

    /* 크래시 라운드는 최대 배율(10000배)까지 가면 95.9초까지 이어진다.
       기본 45초로 기다리면 15배를 넘는 라운드(확률 약 6.5%)에서 아직 running인 상태를
       done으로 잘못 판정해 간헐적으로 실패했다 — 제품 버그가 아니라 이 대기 시간 탓이다. */
    const done = await waitPhase('/api/games/crash/state', c, 'done', 110_000);
    ck('종료 후 크래시 지점 공개', (done.round.crashPoint ?? done.round.crash_point) != null, JSON.stringify(done.round));
  }

  /* ── 포커 한 라운드 완주 (카드 은닉이 핵심) ────────────────── */
  section('[3] 포커 — 보드 카드가 공개 전에 새지 않는가');
  {
    const c = mkSession('e_poker', 20000);
    const st = await waitPhase('/api/games/poker/state', c, 'betting');
    ck('베팅 단계 진입', st?.round?.phase === 'betting', String(st?.round?.phase));
    ck('베팅 중 보드 0장', Array.isArray(st.round.board) && st.round.board.length === 0,
      JSON.stringify(st.round.board));
    ck('홀카드 4장은 공개됨', Array.isArray(st.round.hole) && st.round.hole.length === 4,
      JSON.stringify(st.round.hole));
    ck('응답 어디에도 미공개 보드가 없음',
      !JSON.stringify(st).includes('board_json') && !JSON.stringify(st).includes('result_json'));

    const before = bal('e_poker');
    const b1 = await req('POST', '/api/games/poker/bet', c, { market: 'master', amount: 1000 });
    ck('칩 베팅 수락 + 차감', b1.body?.ok === true && before - bal('e_poker') === 1000, String(before - bal('e_poker')));

    const flop = await waitPhase('/api/games/poker/state', c, p => p === 'flop' || p === 'turn' || p === 'river' || p === 'done');
    if (flop?.round?.phase === 'flop') {
      ck('플롭에서 정확히 3장만 공개', flop.round.board.length === 3, String(flop.round.board.length));
    } else {
      ck('플롭 단계를 지나침(빠른 진행) — 공개 장수는 단계와 일치', [3, 4, 5].includes(flop.round.board.length),
        `${flop.round.phase}/${flop.round.board.length}`);
    }
    const turn = await waitPhase('/api/games/poker/state', c, p => p === 'turn' || p === 'river' || p === 'done');
    ck('턴 이후 4장 이상', turn.round.board.length >= 4, String(turn.round.board.length));

    const done = await waitPhase('/api/games/poker/state', c, 'done');
    ck('정산 단계 도달', done?.round?.phase === 'done', String(done?.round?.phase));
    ck('정산 시 보드 5장 전부 공개', done.round.board.length === 5, String(done.round.board.length));
    ck('결과에 승자가 있음', ['master', 'shark', 'tie'].includes(done.round.result?.winner), JSON.stringify(done.round.result));

    const myBets = db.prepare(`SELECT market, amount, odds, won, payout FROM poker_bets
      WHERE round_id = ? AND user_id = 'e_poker'`).all(done.round.id) as any[];
    if (myBets.length) {
      const m = myBets[0];
      const w = done.round.result.winner;
      const want = w === 'tie' ? m.amount : w === 'master' ? Math.floor(m.amount * m.odds) : 0;
      ck(`정산 지급 규칙 일치 (승자 ${w} → ${want})`, m.payout === want, `${m.payout} vs ${want}`);
      ck('잔액 반영 정확', bal('e_poker') === before - 1000 + m.payout, String(bal('e_poker')));
    } else {
      ck('내 베팅이 라운드에 남아 있음', false, '베팅 행 없음');
    }
  }

  /* ── 지뢰찾기: 지뢰 위치 은닉 ──────────────────────────────── */
  section('[4] 지뢰찾기 — 지뢰 위치가 새지 않는가');
  {
    const c = mkSession('e_mines', 5000);
    const before = bal('e_mines');
    const start = await req('POST', '/api/games/mines/start', c, { betAmount: 500, mineCount: 1 });
    ck('시작 + 차감', start.body?.ok === true && before - bal('e_mines') === 500, JSON.stringify(start.body?.error));
    const s = JSON.stringify(start.body);
    ck('시작 응답에 지뢰 위치 없음', !s.includes('mines"') || !/\"mines\":\[/.test(s), s.slice(0, 200));
    ck('시작 응답에 지뢰 배열이 통째로 없음', !/\[(\d+,){2,}\d+\]/.test(s.replace(/"revealed":\[[^\]]*\]/, '')), s.slice(0, 200));

    // 지뢰 1개짜리로 여러 칸을 열어 본다. 살아 있는 동안에는 절대 minePositions가 오면 안 되고,
    // 터진 뒤에 오는 건 정상이다(그 시점엔 이미 결과가 확정됐다).
    let busted = false, safeReveals = 0, leaked = false;
    for (let tile = 0; tile < 8 && !busted; tile++) {
      const rev = await req('POST', '/api/games/mines/reveal', c, { tile });
      if (rev.status !== 200) break;
      busted = rev.body?.busted === true || rev.body?.round?.status === 'settled';
      const hasPositions = rev.body?.round?.minePositions != null;
      if (!busted) { safeReveals++; if (hasPositions) leaked = true; }
      else ck('터진 뒤에는 지뢰 위치를 공개 (결과 확정 후이므로 정상)', hasPositions, JSON.stringify(rev.body?.round));
    }
    ck(`진행 중에는 지뢰 위치 비공개 (안전하게 연 칸 ${safeReveals}개)`, !leaked, '진행 중 유출');

    if (!busted) {
      const out = await req('POST', '/api/games/mines/cashout', c, {});
      ck('캐시아웃 성공', out.body?.ok === true, JSON.stringify(out.body));
      if (out.body?.ok) {
        // 지뢰찾기는 지급액을 round 안에 담아 보낸다 (다른 게임처럼 최상위가 아니다)
        const payout = out.body.round?.payout;
        ck('응답에 지급액이 들어 있음', typeof payout === 'number', JSON.stringify(out.body.round));
        ck('지급 후 잔액 = 시작잔액 - 500 + 지급',
          bal('e_mines') === before - 500 + (payout ?? -1), `${bal('e_mines')} vs ${before - 500 + (payout ?? -1)}`);
        ck('응답 잔액 = DB 잔액', out.body.balance === bal('e_mines'), `${out.body.balance} vs ${bal('e_mines')}`);
      }
    } else {
      ck('폭발 시 잔액은 베팅 차감분만 (추가 손실 없음)', bal('e_mines') === before - 500, String(bal('e_mines')));
      const out = await req('POST', '/api/games/mines/cashout', c, {});
      ck('폭발한 라운드는 캐시아웃 불가', out.body?.ok !== true, JSON.stringify(out.body));
      ck('캐시아웃 시도 후에도 잔액 그대로', bal('e_mines') === before - 500, String(bal('e_mines')));
    }
  }

  /* ── 원장 최종 확인 ────────────────────────────────────────── */

  /* ── 바카라: 카드 은닉과 정산 ──────────────────────────────── */
  section('[5] 바카라 — 카드가 공개 전에 새지 않는가');
  {
    const c = mkSession('e_bacc', 20000);
    const st = await waitPhase('/api/games/baccarat/state', c, 'betting');
    ck('베팅 단계 진입', st?.round?.phase === 'betting', String(st?.round?.phase));
    ck('베팅 중 양쪽 카드 0장',
      st.round.player.length === 0 && st.round.banker.length === 0,
      JSON.stringify([st.round.player, st.round.banker]));
    ck('베팅 중 끗수 비공개', st.round.playerTotal == null && st.round.bankerTotal == null,
      JSON.stringify([st.round.playerTotal, st.round.bankerTotal]));
    ck('응답에 원본 카드 배열이 없음',
      !JSON.stringify(st).includes('cards_json') && !JSON.stringify(st).includes('result_json'));

    const before = bal('e_bacc');
    const b1 = await req('POST', '/api/games/baccarat/bet', c, { market: 'banker', amount: 1000 });
    ck('칩 베팅 수락 + 차감', b1.body?.ok === true && before - bal('e_bacc') === 1000, JSON.stringify(b1.body));
    ck('응답 잔액 = DB 잔액', b1.body?.balance === bal('e_bacc'), `${b1.body?.balance} vs ${bal('e_bacc')}`);

    const deal = await waitPhase('/api/games/baccarat/state', c, p => p !== 'betting');
    if (deal?.round?.phase === 'deal') {
      ck('첫 공개는 양쪽 두 장씩', deal.round.player.length === 2 && deal.round.banker.length === 2,
        JSON.stringify([deal.round.player.length, deal.round.banker.length]));
      ck('첫 두 장 끗수는 바로 공개', deal.round.playerTotal != null && deal.round.bankerTotal != null);
      ck('첫 두 장 끗수는 0~9', deal.round.playerTotal >= 0 && deal.round.playerTotal <= 9);
    } else {
      ck('공개 단계 진입 (deal을 지나침)', ['third', 'done'].includes(deal.round.phase), String(deal.round.phase));
    }

    const done = await waitPhase('/api/games/baccarat/state', c, 'done');
    ck('정산 단계 도달', done?.round?.phase === 'done', String(done?.round?.phase));
    const r = done.round.result;
    ck('결과에 승자가 있음', ['player', 'banker', 'tie'].includes(r?.winner), JSON.stringify(r));
    ck('양쪽 카드는 2장 또는 3장',
      [2, 3].includes(done.round.player.length) && [2, 3].includes(done.round.banker.length),
      JSON.stringify([done.round.player.length, done.round.banker.length]));
    ck('내추럴이면 세 장이 될 수 없다',
      !r.natural || (done.round.player.length === 2 && done.round.banker.length === 2),
      `natural=${r.natural} ${done.round.player.length}/${done.round.banker.length}`);
    ck('승자와 끗수가 일치',
      (r.playerTotal > r.bankerTotal && r.winner === 'player') ||
      (r.bankerTotal > r.playerTotal && r.winner === 'banker') ||
      (r.playerTotal === r.bankerTotal && r.winner === 'tie'),
      `${r.playerTotal}:${r.bankerTotal} → ${r.winner}`);

    const myBets = db.prepare(`SELECT market, amount, odds, won, payout FROM baccarat_bets
      WHERE round_id = ? AND user_id = 'e_bacc'`).all(done.round.id) as any[];
    ck('내 베팅이 라운드에 남아 있음', myBets.length === 1, JSON.stringify(myBets));
    if (myBets.length) {
      const m = myBets[0];
      const want = r.winner === 'tie' ? m.amount
        : r.winner === 'banker' ? Math.floor(m.amount * m.odds) : 0;
      ck(`정산 지급 규칙 일치 (승자 ${r.winner} → ${want})`, m.payout === want, `${m.payout} vs ${want}`);
      ck('잔액 반영 정확', bal('e_bacc') === before - 1000 + m.payout, String(bal('e_bacc')));
    }
  }

  /* ── 홀덤 프리롤 ─────────────────────────────────────────────────
     HTTP 경로로 실제 토너먼트를 돌린다. 여기서 제일 중요한 것은 히든 정보다:
     남의 홀 카드와 남은 덱이 응답에 섞여 나오면 게임이 성립하지 않는다. */
  section('[5b] 홀덤 프리롤');
  {
    const sessions = ['h1', 'h2', 'h3'].map(id => ({ id, c: mkSession(id, 1000) }));
    const nowSec = () => Math.floor(Date.now() / 1000);
    const state = (c: string) => req('GET', '/api/games/holdem/state', c);

    // 페이지가 뜨는지
    const page = await req('GET', '/games/holdem', sessions[0].c);
    ck('홀덤 페이지 200', page.status === 200, String(page.status));
    ck('페이지에 덱이 섞여 나오지 않음',
      !/deck_json|deck_pos/.test(page.text));

    /* 대회가 없으면 없다고 답해야 한다 — 자동 생성을 없앤 뒤로는 이것이 기본 상태다.
       예전에는 이 요청 하나가 오늘 판을 만들어 냈고, 그래서 아래 검사들이 그냥 이어졌다. */
    const empty = (await state(sessions[0].c)).body;
    ck('대회가 없으면 tournament 가 null 이다',
      empty?.ok === true && empty.tournament === null, JSON.stringify(empty?.tournament));
    ck('그때도 안내할 것을 함께 준다 (recap · upcoming 자리)',
      empty != null && 'recap' in empty && 'upcoming' in empty);

    // 이제 운영자가 열어야 판이 생긴다
    const Adm = require('../src/db/admin') as typeof import('../src/db/admin');
    const made = Adm.createTournament({ title: 'e2e 프리롤', regOpenAt: nowSec() - 60, startAt: nowSec() + 600 });
    ck('운영자가 대회를 연다', made.ok, JSON.stringify(made));

    let s0 = (await state(sessions[0].c)).body;
    ck('상태 응답 정상', s0?.ok === true && s0.tournament != null, JSON.stringify(s0?.tournament?.status));

    /* 등록 창을 연다. cancelled_at·finished_at·started_at 도 같이 비워야 한다 —
       감사를 23:00(KST) 이후에 돌리면 첫 state() 호출에서 이미 인원 미달 취소가
       기록돼 버려서, 시각만 되돌려도 CANCELLED에 머문다. 실제로 이 검사가
       밤에만 실패했다. 검사는 하루 중 언제 돌려도 같아야 한다. */
    db.prepare(`UPDATE holdem_tournaments SET cancelled_at = NULL, finished_at = NULL,
      started_at = NULL, reg_open_at = ?, scheduled_start_at = ?, grace_ends_at = ?`)
      .run(nowSec() - 60, nowSec() + 600, nowSec() + 1800);
    for (const s of sessions) {
      const r = await req('POST', '/api/games/holdem/register', s.c, {});
      ck(`${s.id} 등록 수락`, r.body?.ok === true, JSON.stringify(r.body));
    }
    const dup = await req('POST', '/api/games/holdem/register', sessions[0].c, {});
    ck('중복 등록 거절', dup.status === 400, String(dup.status));

    s0 = (await state(sessions[0].c)).body;
    ck('참가자 3명 · 상금 풀 = 3 × 배수',
      s0.tournament.registered === 3
      && s0.tournament.prizePool === 3 * s0.tournament.multiplier,
      `${s0.tournament.registered}명 / ${s0.tournament.prizePool}P`);

    // 시작
    db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);
    s0 = (await state(sessions[0].c)).body;
    ck('RUNNING 전환', s0.tournament.status === 'RUNNING', s0.tournament.status);
    ck('테이블 정보가 내려온다', s0.table != null);
    ck('내 자리가 있다', s0.table?.mySeat != null, String(s0.table?.mySeat));
    ck('레벨 1 · 25/50', s0.table?.level?.sb === 25 && s0.table?.level?.bb === 50,
      JSON.stringify(s0.table?.level));

    // 히든 정보 — 여기가 핵심
    {
      const mine = s0.table.seats.filter((x: any) => x.userId === 'h1')[0];
      const others = s0.table.seats.filter((x: any) => x.userId !== 'h1');
      ck('내 홀 카드는 두 장 보인다', mine?.cards?.length === 2, JSON.stringify(mine?.cards));
      ck('남의 홀 카드는 안 보인다 (진행 중)',
        others.every((o: any) => !o.cards || o.cards.length === 0),
        JSON.stringify(others.map((o: any) => o.cards)));
      const raw = (await state(sessions[0].c)).text;
      ck('응답에 덱이 없다', !/"deck/.test(raw) && !/deck_json/.test(raw));
      ck('응답에 남의 hole_json이 없다', !/hole_json/.test(raw));
      // 다른 사람 시점에서도 같은지
      const s1 = (await state(sessions[1].c)).body;
      const mine1 = s1.table.seats.filter((x: any) => x.userId === 'h2')[0];
      const other1 = s1.table.seats.filter((x: any) => x.userId === 'h1')[0];
      ck('h2 시점에서 h2 카드만 보인다',
        mine1?.cards?.length === 2 && (!other1?.cards || other1.cards.length === 0));
      ck('두 사람의 홀 카드가 서로 다르다',
        JSON.stringify(mine?.cards) !== JSON.stringify(mine1?.cards));
    }

    // 액션 — 차례가 아닌 사람은 거절
    {
      const notMine = sessions.find(s => {
        const seat = s0.table.seats.filter((x: any) => x.userId === s.id)[0];
        return seat && seat.seat !== s0.table.toActSeat;
      })!;
      const bad = await req('POST', '/api/games/holdem/action', notMine.c, { action: 'fold' });
      ck('차례가 아니면 액션 거절', bad.status === 400, String(bad.status));
      const nonsense = await req('POST', '/api/games/holdem/action', sessions[0].c, { action: '??' });
      ck('알 수 없는 액션 거절', nonsense.status === 400);
    }

    /* 실제로 한 판을 끝까지 (차례인 사람이 콜 또는 체크).
       차례에는 최소 액션 간격이 붙는다(ACT_GAP_SEC · 스트리트 시작은 STREET_OPEN_SEC).
       실시간으로 기다리면 감사가 몇 분씩 늘어지므로, 마감을 now + ACTION_SEC로 맞춰
       "간격은 지났고 제한 시간은 온전히 남았다"로 만든다 — 시간이 흘렀다고 치는 것이다.
       이걸 안 하면 모든 액션이 too_soon으로 거절돼 acted가 0이 된다. */
    const openNow = (): void => {
      db.prepare(`UPDATE holdem_hands SET action_deadline = ?
                  WHERE ended_at IS NULL AND action_deadline IS NOT NULL`)
        .run(nowSec() + ACTION_SEC);
    };
    {
      let steps = 0, acted = 0;
      while (steps++ < 60) {
        const cur = (await state(sessions[0].c)).body;
        if (!cur.table || cur.table.ended) break;
        const seatNo = cur.table.toActSeat;
        if (seatNo == null) { db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE ended_at IS NULL`).run(nowSec() - 1); continue; }
        const who = cur.table.seats.filter((x: any) => x.seat === seatNo)[0];
        const s = sessions.find(x => x.id === who?.userId);
        if (!s) break;
        openNow();
        const la = (await state(s.c)).body.table.legal;
        const kind = la?.canCheck ? 'check' : la?.canCall ? 'call' : 'fold';
        const r = await req('POST', '/api/games/holdem/action', s.c, { action: kind });
        if (r.body?.ok) acted++;
        else db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE ended_at IS NULL`).run(nowSec() - 1);
      }
      ck('실제 액션이 처리됐다', acted > 0, String(acted));
      const done = (await state(sessions[0].c)).body;
      ck('핸드가 끝났다', done.table?.ended === true, JSON.stringify(done.table?.street));
      ck('끝난 뒤 결과가 내려온다', done.table?.result != null);
      const chips = done.table.seats.reduce((a: number, x: any) => a + x.stack, 0);
      ck('칩 총량 = 10,000 × 3', chips === 30000, String(chips));
    }

    // 자리 비움 → 복귀
    {
      db.prepare(`UPDATE holdem_seats SET presence = 'SIT_OUT'`).run();
      const before = (await state(sessions[0].c)).body;
      ck('자리 비움 상태가 내려온다', before.table?.myPresence === 'SIT_OUT', before.table?.myPresence);
      const r = await req('POST', '/api/games/holdem/sitin', sessions[0].c, {});
      ck('복귀 요청 수락', r.body?.ok === true);
      const after = (await state(sessions[0].c)).body;
      ck('복귀 후 ACTIVE', after.table?.myPresence === 'ACTIVE', after.table?.myPresence);
    }

    // 인증 없이는 못 쓴다
    {
      const anon = await req('GET', '/api/games/holdem/state', '');
      ck('비로그인 상태 조회 401', anon.status === 401, String(anon.status));
      const anonAct = await req('POST', '/api/games/holdem/action', '', { action: 'fold' });
      ck('비로그인 액션 401', anonAct.status === 401, String(anonAct.status));
    }
  }

  /* 운영자 화면은 왼쪽 메뉴로 나뉜다. 카드는 전부 그려 두고 보이기만 바꾸는 구조라,
     카드에 data-pane 을 안 붙이면 어느 메뉴에도 안 걸려 영영 안 보인다 — 화면에는
     아무 에러도 안 나고 그냥 없는 기능이 된다. 그런 실패는 눈으로 못 잡으므로 여기서 센다. */
  section('[5c] 운영자 화면 — 메뉴와 카드가 빠짐없이 짝지어졌는가');
  {
    const PANES = ['tour', 'season', 'user', 'sys'];
    const plain = mkSession('e_notadmin', 100);
    const r404 = await req('GET', '/admin', plain);
    ck('운영자가 아니면 못 본다', r404.status === 403 || r404.status === 404, String(r404.status));

    const { ensureSeedAdmin } = require('../src/db/queries') as typeof import('../src/db/queries');
    const admin = mkSession('e_admin', 100);
    ensureSeedAdmin('e_admin');
    const page = await req('GET', '/admin', admin);
    ck('운영자는 볼 수 있다', page.status === 200, String(page.status));

    const cards = [...page.text.matchAll(/<section class="ad-card"([^>]*)>/g)].map(m => m[1]);
    ck('카드가 여럿 있다', cards.length >= 7, String(cards.length));
    const noPane = cards.filter(a => !/data-pane="/.test(a)).length;
    ck('모든 카드가 메뉴에 걸려 있다 (없으면 영영 안 보인다)', noPane === 0, `${noPane}개 누락`);

    const used = [...page.text.matchAll(/<section class="ad-card" data-pane="([a-z]+)"/g)].map(m => m[1]);
    const unknown = used.filter(p => !PANES.includes(p));
    ck('없는 메뉴를 가리키는 카드가 없다', unknown.length === 0, unknown.join(','));
    const empty = PANES.filter(p => !used.includes(p));
    ck('빈 메뉴가 없다 (눌러도 아무것도 없는 자리)', empty.length === 0, empty.join(','));

    const navKeys = [...page.text.matchAll(/class="ad-nav-item" data-pane="([a-z]+)"/g)].map(m => m[1]);
    ck('메뉴 버튼이 넷이다', navKeys.length === 4, navKeys.join(','));
    ck('메뉴 버튼과 카드의 이름이 같다',
      navKeys.slice().sort().join(',') === PANES.slice().sort().join(','), navKeys.join(','));

    // 원장 — 읽기 전용이고 운영자 세션만 지난다
    const led = await req('GET', '/api/admin/ledger?id=e_admin', admin);
    ck('운영자는 원장을 읽는다', led.status === 200 && Array.isArray(led.body?.rows),
      String(led.status));
    ck('원장에 실제 기록이 있다', (led.body?.rows?.length ?? 0) > 0,
      String(led.body?.rows?.length));
    const ledDenied = await req('GET', '/api/admin/ledger?id=e_admin', plain);
    ck('운영자가 아니면 원장도 못 읽는다',
      ledDenied.status === 403 || ledDenied.status === 404, String(ledDenied.status));
  }

  section('[6] 최종 원장 정합성');
  {
    const users = db.prepare(`SELECT id, balance FROM users`).all() as any[];
    let bad = '';
    for (const u of users) {
      const s = (db.prepare(`SELECT COALESCE(SUM(delta),0) AS s FROM points_ledger WHERE user_id = ?`).get(u.id) as any).s;
      if (s !== u.balance) bad += `${u.id}(${s}≠${u.balance}) `;
    }
    ck(`잔액 = 원장 누적합 (${users.length}명)`, bad === '', bad);
    const neg = (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE balance < 0`).get() as any).n;
    ck('음수 잔액 없음', neg === 0, String(neg));
  }

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
