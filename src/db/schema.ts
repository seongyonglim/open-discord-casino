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
  `);

  // 기존 DB에도 컬럼을 비파괴적으로 추가 (discord-lol과 동일한 additive 마이그레이션 방식)
  try { d.exec(`ALTER TABLE crash_bets ADD COLUMN auto_cashout REAL`); } catch {}
  // 사다리: 두 번째 예측을 도착 좌/우 → 줄수 홀/짝('ODD'|'EVEN')으로 변경. 의미가 다르므로 새 컬럼을 쓴다.
  try { d.exec(`ALTER TABLE ladder_bets ADD COLUMN parity_guess TEXT`); } catch {}
}
