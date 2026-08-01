// 로컬 테스트용 더미 플레이어 봇.
// "다른 사람이 같이 플레이하는 화면"을 만들어 보기 위한 도구로, 실서버와 무관하다.
// 계정·세션·잔액을 스스로 준비하므로 DB를 지우고 다시 시작해도 그냥 돌아간다.
//
//   npm run bots                       # 포커 플립에서 2명이 베팅 (기본 20분)
//   BOT_GAME=ladder npm run bots       # 사다리게임
//   BOT_GAME=crash  npm run bots       # 그래프게임
//   BOT_GAME=mines  npm run bots       # 지뢰찾기
//   BOT_MINUTES=60 BOT_GAME=poker npm run bots
//
// 새 게임을 붙일 때는 아래 GAMES에 { wait, act } 한 벌만 추가하면 된다.
import { upsertUser, createSession, getWebUser, adjustBalance } from './src/db/queries';
import { getDb } from './src/db/schema';

const BASE = process.env.BOT_BASE ?? 'http://localhost:8080';
const GAME = (process.env.BOT_GAME ?? 'poker').toLowerCase();
const RUN_MIN = Number(process.env.BOT_MINUTES ?? 20);
const REFILL_AT = 500_000;   // 이 아래로 떨어지면 채워 준다
const REFILL_TO = 5_000_000;

interface Bot { id: string; name: string; token: string; cookie: string; style: 'whale' | 'spread' }

const BOTS: Bot[] = [
  { id: 'preview-bot-2', name: '두번째유저', token: 'previewbottoken2', cookie: '', style: 'whale' },
  { id: 'preview-bot-3', name: '타짜김씨', token: 'previewbottoken3', cookie: '', style: 'spread' },
];
BOTS.forEach(b => { b.cookie = `sid=${b.token}`; });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const rand = (n: number) => Math.floor(Math.random() * n);

// ── 계정 준비 ────────────────────────────────────────────────
// 예전 실행에서 쓰던 계정이 있어도 이름/세션/잔액을 다시 맞춰 준다.
function seedBots(): void {
  const db = getDb();
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  for (const b of BOTS) {
    upsertUser(b.id, b.name, null);
    db.prepare(`DELETE FROM web_sessions WHERE token = ?`).run(b.token);
    createSession(b.token, b.id, exp);
    const bal = getWebUser(b.id)?.balance ?? 0;
    if (bal < REFILL_TO) adjustBalance(b.id, REFILL_TO - bal, 'preview_bot_seed');
  }
  console.log(`봇 계정 준비: ${BOTS.map(b => `${b.name}(${b.id})`).join(', ')}`);
}

function refill(): void {
  for (const b of BOTS) {
    const bal = getWebUser(b.id)?.balance ?? 0;
    if (bal < REFILL_AT) adjustBalance(b.id, REFILL_TO - bal, 'preview_bot_refill');
  }
}

// ── HTTP 도우미 ──────────────────────────────────────────────
async function get(path: string, cookie: string): Promise<any> {
  const r = await fetch(BASE + path, { headers: { cookie } });
  return r.json();
}
async function post(path: string, cookie: string, body: unknown): Promise<any> {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ── 게임별 동작 ──────────────────────────────────────────────
// wait: 이번에 참여할 라운드가 열렸는지 (열렸으면 라운드 식별자 반환, 아니면 null)
// act : 봇 한 명이 그 라운드에 실제로 베팅하는 방식
interface GameBot {
  label: string;
  wait(): Promise<{ id: number | string; seconds: number } | null>;
  act(bot: Bot, seconds: number): Promise<void>;
}

const POKER_MARKETS = ['master', 'shark', 'b0', 'b1', 'b2', 'b3', 'b4'] as const;
const POKER_COINS = [100, 1000, 5000, 10000] as const;

const GAMES: Record<string, GameBot> = {
  poker: {
    label: '포커 플립',
    async wait() {
      const s = await get('/api/games/poker/state', BOTS[0].cookie);
      return (s?.round?.phase === 'betting' && s.round.secondsLeft >= 4)
        ? { id: s.round.id, seconds: s.round.secondsLeft } : null;
    },
    async act(bot, seconds) {
      const picks = bot.style === 'whale'
        ? Array.from({ length: 2 + rand(2) }, () => pick(POKER_MARKETS))
        : Array.from({ length: 4 + rand(3) }, () => pick(POKER_MARKETS));
      const window = Math.max(2000, (seconds - 2) * 1000);
      for (const market of picks) {
        const amount = bot.style === 'whale' ? pick([5000, 10000, 10000]) : pick(POKER_COINS);
        for (let i = 0, n = 1 + rand(bot.style === 'whale' ? 3 : 2); i < n; i++) {
          const r = await post('/api/games/poker/bet', bot.cookie, { market, amount });
          if (!r?.ok) return;                       // 마감되면 조용히 종료
          await sleep(120 + Math.random() * 260);   // 칩을 하나씩 얹는 느낌
        }
        await sleep(Math.random() * (window / picks.length));
      }
    },
  },

  ladder: {
    label: '사다리게임',
    async wait() {
      const s = await get('/api/games/ladder/state', BOTS[0].cookie);
      return (s?.round?.phase === 'betting' && s.round.secondsLeft >= 3)
        ? { id: s.round.id, seconds: s.round.secondsLeft } : null;
    },
    async act(bot, seconds) {
      await sleep(Math.random() * Math.max(500, (seconds - 2) * 700));
      const both = Math.random() < 0.35;            // 가끔 출발·홀짝 둘 다 예측
      await post('/api/games/ladder/bet', bot.cookie, {
        betAmount: bot.style === 'whale' ? pick([5000, 10000]) : pick([100, 1000]),
        startGuess: both || Math.random() < 0.5 ? pick(['L', 'R']) : null,
        parityGuess: both || Math.random() < 0.5 ? pick(['ODD', 'EVEN']) : null,
      });
    },
  },

  crash: {
    label: '그래프게임',
    async wait() {
      const s = await get('/api/games/crash/state', BOTS[0].cookie);
      return (s?.round?.phase === 'betting' && s.round.secondsLeft >= 2)
        ? { id: s.round.id, seconds: s.round.secondsLeft } : null;
    },
    async act(bot, seconds) {
      await sleep(Math.random() * Math.max(400, (seconds - 1) * 600));
      await post('/api/games/crash/bet', bot.cookie, {
        betAmount: bot.style === 'whale' ? pick([5000, 10000]) : pick([100, 1000]),
        // 자동 캐시아웃을 걸어두면 봇이 알아서 정산돼 캐시아웃 목록도 채워진다
        autoCashout: (1.2 + Math.random() * 3).toFixed(2),
      });
    },
  },

  mines: {
    label: '지뢰찾기',
    // 지뢰찾기는 1인 게임이라 공유 라운드가 없다 — 각자 계속 새 판을 돌린다
    async wait() { return { id: Date.now(), seconds: 0 }; },
    async act(bot) {
      const start = await post('/api/games/mines/start', bot.cookie, {
        betAmount: bot.style === 'whale' ? pick([5000, 10000]) : pick([100, 1000]),
        mineCount: pick([1, 3, 5, 10]),
      });
      if (!start?.ok) return;
      const opens = 1 + rand(4);
      for (let i = 0; i < opens; i++) {
        await sleep(400 + Math.random() * 600);
        const r = await post('/api/games/mines/reveal', bot.cookie, { tile: rand(25) });
        if (!r?.ok || r?.round?.status !== 'active') return;   // 지뢰를 밟았으면 끝
      }
      await sleep(400);
      await post('/api/games/mines/cashout', bot.cookie, {});
    },
  },
};

// ── 실행 ────────────────────────────────────────────────────
(async () => {
  const game = GAMES[GAME];
  if (!game) {
    console.error(`알 수 없는 게임: ${GAME} (가능: ${Object.keys(GAMES).join(', ')})`);
    process.exit(1);
  }
  seedBots();

  const until = Date.now() + RUN_MIN * 60 * 1000;
  let lastId: number | string | null = null;
  console.log(`${game.label} — 봇 ${BOTS.length}명 가동, ${RUN_MIN}분간`);
  console.log(`브라우저에서 ${BASE} 를 열어두면 실시간으로 보입니다.`);

  while (Date.now() < until) {
    try {
      const round = await game.wait();
      if (round && round.id !== lastId) {
        lastId = round.id;
        refill();
        console.log(`라운드 ${round.id} 참가${round.seconds ? ` (${round.seconds}초)` : ''}`);
        await Promise.all(BOTS.map(b => game.act(b, round.seconds)));
      }
    } catch {
      // 서버 재시작 등은 무시하고 계속 시도
    }
    await sleep(GAME === 'mines' ? 1500 : 600);
  }
  console.log('봇 종료');
})();
