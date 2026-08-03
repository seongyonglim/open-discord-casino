import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'path';
import { env } from '../env';

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  if (!db) {
    // DB_PATH는 파일이 아니라 디렉터리다. 없으면 sqlite가 "unable to open database file"로
    // 기동 즉시 죽어버리므로(원인이 드러나지 않는 에러다) 직접 만들어 준다.
    const dbDir = env('DB_PATH') || process.cwd();
    mkdirSync(dbDir, { recursive: true });
    db = new DatabaseSync(path.join(dbDir, 'data.db'));
    initSchema();
  }
  return db;
}

function initSchema(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      avatar TEXT,
      balance INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0,
      last_checkin_date TEXT,
      role TEXT DEFAULT 'member',
      created_at INTEGER DEFAULT (unixepoch()),
      last_active INTEGER DEFAULT 0
    );

    -- 디스코드 채널에 고정해 두는 버튼 메시지(출석판·지원금판)의 위치.
    -- 신청 로그가 쌓이면 버튼이 위로 밀려 올라가므로, 로그를 남길 때마다 이전 메시지를 지우고
    -- 맨 아래에 다시 올린다. 그러려면 어떤 메시지를 지워야 하는지 기억해야 한다.
    CREATE TABLE IF NOT EXISTS discord_boards (
      kind TEXT PRIMARY KEY,        -- 'attendance' | 'relief'
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    -- 웹 세션 (재시작에도 유지)
    CREATE TABLE IF NOT EXISTS web_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );

    -- 포인트 증감 감사 로그 (출석/보너스/게임 결과 전부 여기 기록)
    CREATE TABLE IF NOT EXISTS points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      balance_after INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id, created_at);

    -- 게임 공통 라운드 테이블 (지뢰찾기/사다리/그래프/바카라/블랙잭 공용)
    CREATE TABLE IF NOT EXISTS game_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      game_type TEXT NOT NULL,
      bet_amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      state_json TEXT NOT NULL,
      payout INTEGER,
      multiplier REAL,
      created_at INTEGER DEFAULT (unixepoch()),
      settled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rounds_user_status ON game_rounds(user_id, status);

    -- 사다리게임: 여러 유저가 같은 라운드에 함께 베팅하는 실시간 공용 라운드 (지뢰찾기와 달리 1인 1라운드가 아님)
    CREATE TABLE IF NOT EXISTS ladder_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL DEFAULT 'betting', -- 'betting' | 'done'
      betting_ends_at INTEGER NOT NULL,
      start_side TEXT,
      end_side TEXT,
      rungs_json TEXT,
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS ladder_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      start_guess TEXT,   -- 'L' | 'R' (출발 좌/우)
      parity_guess TEXT,  -- 'ODD' | 'EVEN' (가로줄 개수의 홀짝)
      amount INTEGER NOT NULL,
      won INTEGER,
      payout INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ladder_bets_round ON ladder_bets(round_id);

    -- 그래프게임(크래시): 사다리처럼 여러 유저가 같은 라운드에 함께 베팅하고, 각자 원하는 시점에 캐시아웃한다.
    -- crash_point는 라운드 생성 시 미리 정해두되 크래시 이후에만 공개한다(진행 중엔 절대 클라이언트로 내리지 않음).
    CREATE TABLE IF NOT EXISTS crash_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL DEFAULT 'betting', -- 'betting' | 'running' | 'done'
      betting_ends_at INTEGER NOT NULL,      -- 초 단위
      started_at_ms INTEGER,                 -- 상승 시작 시각(ms) — 배율 계산 기준
      crash_point REAL NOT NULL,
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS crash_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      amount INTEGER NOT NULL,
      auto_cashout REAL,                     -- 자동 캐시아웃 목표 배율 (NULL이면 수동)
      cashout_multiplier REAL,               -- NULL이면 아직 캐시아웃 안 함
      payout INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_crash_bets_round ON crash_bets(round_id);

    -- 포커 플립: 홀카드 2장씩 공개 후 승자/등급 시장에 베팅, 플롭→턴→리버 순차 공개.
    -- 보드 5장은 라운드 생성 시 미리 정해두고 시간에 따라 공개 범위만 넓힌다(공개 전엔 절대 내려보내지 않음).
    CREATE TABLE IF NOT EXISTS poker_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL DEFAULT 'betting', -- 'betting' | 'flop' | 'turn' | 'river' | 'done'
      betting_ends_at INTEGER NOT NULL,      -- 초
      hole_json TEXT NOT NULL,               -- [master0, master1, shark0, shark1]
      board_json TEXT NOT NULL,              -- [b0..b4]
      odds_json TEXT NOT NULL,               -- 시장별 확률/배당 (배당 null = 비활성 시장)
      result_json TEXT,                      -- 정산 결과 (승자, 양쪽 등급 등)
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS poker_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      market TEXT NOT NULL,                  -- 'master'|'shark'|'tie'|'b0'..'b4'
      amount INTEGER NOT NULL,
      odds REAL NOT NULL,                    -- 베팅 시점 배당 고정
      won INTEGER,
      payout INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    -- 칩을 쌓는 방식이라 같은 시장에 여러 번 베팅하면 한 행의 amount가 누적된다
    CREATE UNIQUE INDEX IF NOT EXISTS idx_poker_bets_unique ON poker_bets(round_id, user_id, market);
    CREATE INDEX IF NOT EXISTS idx_poker_bets_round ON poker_bets(round_id);

    -- 바카라: 포커 플립과 같은 "다 같이 한 라운드" 구조지만 배당은 매 라운드 같다.
    -- 바카라에는 플레이어가 내리는 선택이 없어(드로우가 규칙 표로 고정) 확률이 항상 동일하기 때문이다.
    -- 카드는 라운드 생성 시 6장(최대치)을 미리 뽑아두고 시간에 따라 공개 범위만 넓힌다.
    CREATE TABLE IF NOT EXISTS baccarat_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL DEFAULT 'betting', -- 'betting' | 'deal' | 'third' | 'reveal' | 'done'
      betting_ends_at INTEGER NOT NULL,      -- 초
      cards_json TEXT NOT NULL,              -- 뽑아둔 6장 (P1,B1,P2,B2,P3,B3 순서로 소비)
      result_json TEXT,                      -- 정산 결과 (승자·양쪽 끗수·페어 등)
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS baccarat_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      market TEXT NOT NULL,                  -- 'player'|'banker'|'tie'|'ppair'|'bpair'
      amount INTEGER NOT NULL,
      odds REAL NOT NULL,                    -- 베팅 시점 배당 고정
      won INTEGER,
      payout INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_baccarat_bets_unique ON baccarat_bets(round_id, user_id, market);
    CREATE INDEX IF NOT EXISTS idx_baccarat_bets_round ON baccarat_bets(round_id);

    -- 블랙잭: 7석 공용 테이블. 결정은 전원이 같은 창에서 동시에 한다.
    -- 카드를 몇 장 쓸지 미리 알 수 없어(각자 원하는 만큼 힛한다) 슈를 통째로 섞어 저장하고
    -- 커서(shoe_pos)를 밀며 꺼내 쓴다. shoe_json에는 앞으로 나올 카드가 전부 들어 있으므로
    -- 절대 클라이언트로 내려보내면 안 된다 — 한 장이 아니라 남은 판 전체가 새는 셈이다.
    CREATE TABLE IF NOT EXISTS blackjack_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL DEFAULT 'betting', -- 'betting'|'deal'|'action'|'dealer'|'done'
      -- 아무도 앉지 않았으면 NULL이다. 빈 테이블에서 카드가 계속 돌면 볼 사람도 없이
      -- 슈만 축나고, 들어온 사람은 남의 라운드 끝나기를 기다려야 한다.
      -- 첫 사람이 앉는 순간 값이 채워지고 그때부터 카운트다운이 시작된다.
      betting_ends_at INTEGER,               -- 초
      -- 모두가 결정을 마치면 15초를 다 기다리지 않고 여기에 끝난 시각을 적어 바로 넘어간다
      action_ended_at INTEGER,
      shoe_json TEXT NOT NULL,
      shoe_pos INTEGER NOT NULL DEFAULT 0,
      dealer_json TEXT NOT NULL DEFAULT '[]',
      result_json TEXT,
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS blackjack_hands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      seat INTEGER NOT NULL,                 -- 0~6
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      bet INTEGER NOT NULL,
      cards_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'playing', -- 'playing'|'stand'|'bust'|'blackjack'
      outcome TEXT,
      payout INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    /* 한 사람은 한 자리만, 한 자리에는 한 사람만.
       이 두 유니크 인덱스가 "한 사람 = 한 손패"를 보장한다 — 스플릿을 넣지 않기로 한
       결정이 여기에 박혀 있다. 스플릿을 하려면 손패가 사람당 여러 개가 되어야 해서
       이 인덱스부터 정산 루프·액션 API·자리 UI까지 전제가 전부 깨진다.
       (기본 전략이 실제로 쪼개는 상황은 39판에 1번뿐이라 그 값어치가 없다고 판단했다) */
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bj_hand_user ON blackjack_hands(round_id, user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bj_hand_seat ON blackjack_hands(round_id, seat);

    /* ── 홀덤 프리롤 토너먼트 ────────────────────────────────────────
       구조는 스펙 9항의 Tournament → Tables → Seats → Players 를 그대로 따른다.
       지금은 한 테이블(STT)만 쓰지만 holdem_tables를 사이에 둬서 MTT로 늘릴 때
       스키마를 바꾸지 않아도 되게 했다.

       상태를 저장하는 원칙: "되돌릴 수 없는 사실"만 적는다.
       started_at / finished_at / cancelled_at 이 그 셋이고, 나머지(SCHEDULED·
       REGISTRATION_OPEN·WAITING_MIN_PLAYERS 같은 단계)는 시각에서 계산한다.
       서버가 절전에 들어가도 깨어나서 올바른 상태를 내려면 이래야 한다. */
    CREATE TABLE IF NOT EXISTS holdem_tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_str TEXT NOT NULL,              -- KST 'YYYY-MM-DD' — 하루 하나라는 규칙의 키
      title TEXT NOT NULL,
      reg_open_at INTEGER NOT NULL,
      scheduled_start_at INTEGER NOT NULL,
      grace_ends_at INTEGER NOT NULL,
      prize_multiplier INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      cancelled_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    -- 하루에 토너먼트 하나. 동시에 두 개가 생기는 것을 DB가 막는다.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ht_date ON holdem_tournaments(date_str);

    /* 등록자. 상금 풀의 근거는 "누적 참가자 수"이므로 탈락해도 행을 지우지 않는다.
       freezeout이라 재입장이 없으니 (tournament_id, user_id)가 유니크다 —
       마지막 자리를 두고 두 요청이 겹쳐도 DB가 한쪽만 받는다. */
    CREATE TABLE IF NOT EXISTS holdem_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      finish_place INTEGER,                -- 1 = 우승. 토너먼트가 끝날 때 확정한다
      /* 탈락 순서(1부터). 등수를 탈락 시점에 "남은 인원 + 1"로 매기면 늦은 등록으로
         참가자가 늘었을 때 번호가 어긋난다(이미 4등을 준 뒤 5번째가 등록되는 경우).
         그래서 순서만 기록해 두고 등수는 끝날 때 한꺼번에 계산한다. */
      elim_seq INTEGER,
      eliminated_at INTEGER,
      prize INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_he_user ON holdem_entries(tournament_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_he_place ON holdem_entries(tournament_id, finish_place);

    CREATE TABLE IF NOT EXISTS holdem_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      table_no INTEGER NOT NULL DEFAULT 0,
      button_seat INTEGER NOT NULL DEFAULT 0,
      hand_no INTEGER NOT NULL DEFAULT 0,
      -- 다음 핸드를 시작할 시각. 쇼다운을 보여주는 동안 비어 있다.
      next_hand_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_htb_no ON holdem_tables(tournament_id, table_no);

    /* 좌석. 토너먼트 칩(스택)이 사는 곳이다 — 포인트가 아니라 칩이라 원장과 무관하다.
       presence는 접속 상태다: ACTIVE / SIT_OUT / DISCONNECTED / OUT(탈락).
       스펙 8항대로 브라우저가 끊겨도 자리를 빼지 않는다. */
    CREATE TABLE IF NOT EXISTS holdem_seats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id INTEGER NOT NULL,
      seat INTEGER NOT NULL,               -- 0~8
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      stack INTEGER NOT NULL,
      presence TEXT NOT NULL DEFAULT 'ACTIVE',
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hs_seat ON holdem_seats(table_id, seat);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hs_user ON holdem_seats(table_id, user_id);

    /* 한 판(핸드). deck_json은 절대 클라이언트로 내보내지 않는다 —
       남은 카드가 새면 이후 모든 판이 무의미해진다. */
    CREATE TABLE IF NOT EXISTS holdem_hands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id INTEGER NOT NULL,
      hand_no INTEGER NOT NULL,
      level INTEGER NOT NULL,
      sb INTEGER NOT NULL,
      bb INTEGER NOT NULL,
      ante INTEGER NOT NULL,
      button_seat INTEGER NOT NULL,
      deck_json TEXT NOT NULL,
      deck_pos INTEGER NOT NULL DEFAULT 0,
      board_json TEXT NOT NULL DEFAULT '[]',
      street TEXT NOT NULL DEFAULT 'preflop',
      to_act_seat INTEGER,
      action_deadline INTEGER,
      last_raise_size INTEGER NOT NULL DEFAULT 0,
      ended_at INTEGER,
      result_json TEXT,                    -- 쇼다운 결과 (끝난 뒤에만 공개)
      started_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hh_no ON holdem_hands(table_id, hand_no);

    /* 핸드 안에서의 좌석 상태. hole_json은 본인에게만 내려보낸다.
       committed(핸드 총 투입액)가 사이드 팟 계산의 유일한 근거다 —
       스트리트별 bet만 들고 있으면 스트리트가 넘어갈 때 정보가 사라진다. */
    CREATE TABLE IF NOT EXISTS holdem_hand_seats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hand_id INTEGER NOT NULL,
      seat INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      hole_json TEXT NOT NULL DEFAULT '[]',
      stack INTEGER NOT NULL,              -- 핸드 진행 중 남은 스택
      bet INTEGER NOT NULL DEFAULT 0,      -- 이 스트리트에 낸 금액
      committed INTEGER NOT NULL DEFAULT 0,-- 이 핸드에 총 낸 금액
      state TEXT NOT NULL DEFAULT 'active',-- active|folded|allin|out
      acted INTEGER NOT NULL DEFAULT 0,
      won INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hhs_seat ON holdem_hand_seats(hand_id, seat);
  `);

  // 기존 DB에도 컬럼을 비파괴적으로 추가 (discord-lol과 동일한 additive 마이그레이션 방식)
  try { d.exec(`ALTER TABLE crash_bets ADD COLUMN auto_cashout REAL`); } catch {}
  // 사다리: 두 번째 예측을 도착 좌/우 → 줄수 홀/짝('ODD'|'EVEN')으로 변경. 의미가 다르므로 새 컬럼을 쓴다.
  try { d.exec(`ALTER TABLE ladder_bets ADD COLUMN parity_guess TEXT`); } catch {}
  // 개인회생 지원금(파산 구제)을 마지막으로 받은 시각(unix초). 쿨다운 판정에 쓴다.
  try { d.exec(`ALTER TABLE users ADD COLUMN last_relief_at INTEGER`); } catch {}
}
