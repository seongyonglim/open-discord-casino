/* 대회 반복 개최 규칙.
 *
 * 예전에는 "하루 한 판"이 코드에 박혀 있었다. 요청이 들어올 때마다 오늘 날짜의 행이
 * 없으면 만드는 방식이었는데, 그래서 운영자가 지운 대회가 1초 만에 되살아났다.
 * 지금은 반대다 — 아무것도 저절로 생기지 않고, 운영자가 직접 열거나 여기 규칙을
 * 켜 두었을 때만 생긴다.
 *
 * 되살아남을 막는 장치가 이 파일의 핵심이다. "만들었는가"를 행의 존재로 판단하면
 * 지우는 순간 다시 만들어진다. 그래서 마지막으로 만든 차례의 시작 시각을 따로 적어
 * 두고(recurLastAt), 그보다 뒤의 차례만 만든다. 지워도 그 차례는 이미 지나간
 * 것으로 남아 다시 만들어지지 않는다.
 *
 * 만드는 일 자체는 createTournament 에 맡긴다. 진행 중인 판이 있으면 거절하고
 * 다음 판 시작까지 두 시간은 비워 두는 규칙이 거기 있는데, 여기서 따로 구현하면
 * 두 벌이 되고 언젠가 갈라진다.
 */
import { one, all, run } from './queries';
import * as T from '../services/tournament';
import { getConfig } from './settings';

export type RecurMode = 'manual' | 'daily' | 'weekly' | 'monthly';

export interface Recurrence {
  /** 마스터 스위치. 꺼져 있으면 무엇을 설정해 뒀든 아무것도 만들지 않는다. */
  enabled: boolean;
  mode: RecurMode;
  /** 주간일 때의 요일 (0=일 … 6=토) */
  weekday: number;
  /** 월간일 때의 날짜 (1~31). 그 달에 없는 날이면 그 달은 건너뛴다. */
  day: number;
}

export const MODE_LABEL: Record<RecurMode, string> = {
  manual: '수동 개최',
  daily: '매일',
  weekly: '매주',
  monthly: '매월',
};

export const WEEKDAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];

export function defaultRecurrence(): Recurrence {
  return { enabled: false, mode: 'manual', weekday: 0, day: 1 };
}

function settings(): Record<string, string> {
  const rows = all<{ key: string; value: string }>(`SELECT key, value FROM holdem_settings`);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function put(key: string, value: string): void {
  run(`INSERT INTO holdem_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, value);
}

export function getRecurrence(): Recurrence {
  const v = settings();
  const d = defaultRecurrence();
  const mode = v.recurMode as RecurMode;
  return {
    /* 기본값은 꺼짐이다. 설정을 한 번도 건드리지 않은 서버가 갑자기 대회를 열기
       시작하면 안 된다 — 켜는 것은 사람의 결정이어야 한다. */
    enabled: v.recurEnabled === '1',
    mode: mode === 'daily' || mode === 'weekly' || mode === 'monthly' ? mode : d.mode,
    weekday: clampInt(v.recurWeekday, 0, 6, d.weekday),
    day: clampInt(v.recurDay, 1, 31, d.day),
  };
}

function clampInt(raw: string | undefined, lo: number, hi: number, fallback: number): number {
  const n = Number(raw);
  if (raw == null || !Number.isFinite(n) || Math.floor(n) !== n || n < lo || n > hi) return fallback;
  return n;
}

export function validateRecurrence(r: Recurrence): string[] {
  const bad: string[] = [];
  if (!['manual', 'daily', 'weekly', 'monthly'].includes(r.mode)) {
    bad.push('개최 방식이 올바르지 않습니다');
  }
  if (r.mode === 'weekly' && !(Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6)) {
    bad.push('요일이 올바르지 않습니다');
  }
  if (r.mode === 'monthly' && !(Number.isInteger(r.day) && r.day >= 1 && r.day <= 31)) {
    bad.push('날짜는 1일부터 31일 사이여야 합니다');
  }
  /* 수동인데 스위치가 켜져 있으면 아무 일도 일어나지 않는다. 조용히 넘기면
     운영자는 켰다고 믿고 기다리게 된다 — 그 침묵이 제일 나쁘다. */
  if (r.enabled && r.mode === 'manual') {
    bad.push('수동 개최에서는 자동 생성이 동작하지 않습니다 — 반복 주기를 고르거나 스위치를 꺼 주세요');
  }
  return bad;
}

export function saveRecurrence(r: Recurrence): { ok: true } | { ok: false; errors: string[] } {
  const errors = validateRecurrence(r);
  if (errors.length) return { ok: false, errors };
  put('recurEnabled', r.enabled ? '1' : '0');
  put('recurMode', r.mode);
  put('recurWeekday', String(r.weekday));
  put('recurDay', String(r.day));
  return { ok: true };
}

/* ── 다음 차례 계산 ──────────────────────────────────────────────── */

export interface Occurrence {
  /** 등록이 열리는 시각(unix초) */
  regOpenAt: number;
  /** 시작 예정 시각(unix초) */
  startAt: number;
  /** 그 차례가 속한 KST 날짜 'YYYY-MM-DD' */
  dateStr: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 규칙에 따라 `from` 이후에 오는 첫 차례를 찾는다. 없으면 null.
 *
 * 시각은 설정(regOpenMin / startMin)에서 온다 — 반복 규칙은 "어느 날"만 정하고
 * "몇 시"는 대회 설정이 정한다. 두 곳에 시각을 두면 어느 쪽이 이기는지 아무도 모른다.
 *
 * 날짜를 하루씩 밀어 보며 찾는다. 월간에서 31일을 골라 둔 달을 건너뛰는 경우가 있어
 * 규칙식으로 접는 것보다 이쪽이 확실하다. 최대 400일이면 어떤 규칙이든 한 번은 걸린다.
 */
export function nextOccurrence(r: Recurrence, from: number = Math.floor(Date.now() / 1000)): Occurrence | null {
  if (r.mode === 'manual') return null;
  const cfg = getConfig();
  const startH = Math.floor(cfg.startMin / 60), startM = cfg.startMin % 60;
  const regH = Math.floor(cfg.regOpenMin / 60), regM = cfg.regOpenMin % 60;

  for (let i = 0; i < 400; i++) {
    const ms = from * 1000 + i * DAY_MS;
    const dateStr = T.kstDateStr(ms);
    if (!matchesDay(r, ms, dateStr)) continue;
    const startAt = T.kstTimeToUnix(dateStr, startH, startM);
    if (startAt <= from) continue;   // 오늘이 해당일이어도 시각이 지났으면 다음으로
    return { regOpenAt: T.kstTimeToUnix(dateStr, regH, regM), startAt, dateStr };
  }
  return null;
}

function matchesDay(r: Recurrence, ms: number, dateStr: string): boolean {
  if (r.mode === 'daily') return true;
  if (r.mode === 'weekly') return T.kstWeekday(ms) === r.weekday;
  if (r.mode === 'monthly') return Number(dateStr.slice(8, 10)) === r.day;
  return false;
}

/* ── 자동 생성 ──────────────────────────────────────────────────── */

/** 시작 시각이 이만큼 앞으로 다가오면 행을 만든다. 그 전에는 규칙에서 계산해 안내만 한다. */
export const RECUR_LEAD_SEC = 12 * 60 * 60;

/**
 * 규칙에 따라 다음 판을 만들어 둔다. 요청마다 불리므로 값싸고 조용해야 한다.
 *
 * 만들지 않는 경우가 여럿이고, 전부 정상이다 — 스위치가 꺼졌거나, 차례가 아직 멀거나,
 * 이미 만들었거나, 지금 다른 판이 돌고 있거나. 실패해도 표시를 남기지 않으므로
 * 다음 요청에서 다시 시도한다. 서버가 몇 시간 죽어 있어도 깨어나는 순간 따라잡는다.
 *
 * 되살아남 방지: 만든 차례의 시작 시각을 recurLastAt 에 적는다. 그보다 뒤의 차례만
 * 만들므로, 운영자가 그 판을 지워도 같은 차례가 다시 생기지 않는다.
 */
export function ensureRecurring(now: number = Math.floor(Date.now() / 1000)): void {
  const r = getRecurrence();
  if (!r.enabled || r.mode === 'manual') return;

  const next = nextOccurrence(r, now);
  if (!next) return;
  if (next.startAt - now > RECUR_LEAD_SEC) return;

  const lastAt = Number(settings().recurLastAt ?? 0);
  if (Number.isFinite(lastAt) && next.startAt <= lastAt) return;

  /* 순환 참조를 피하려고 여기서 부른다 — admin 이 settings 를 읽고, 이 파일도 읽는다. */
  const { createTournament } = require('./admin') as typeof import('./admin');
  const made = createTournament({
    title: '홀덤 프리롤',
    regOpenAt: next.regOpenAt,
    startAt: next.startAt,
  });
  if (made.ok) put('recurLastAt', String(next.startAt));
}

/**
 * 로비가 "다음 대회"를 안내할 때 쓴다.
 *
 * 아직 행이 없는 차례도 알려 준다 — 주간·월간이면 행이 생기기 전이 대부분인데,
 * 그때 "예정 없음"이라고 하면 규칙을 켜 둔 의미가 없다.
 */
export function upcomingHint(now: number = Math.floor(Date.now() / 1000)): Occurrence | null {
  const pending = one<{ reg_open_at: number; scheduled_start_at: number; date_str: string }>(
    `SELECT reg_open_at, scheduled_start_at, date_str FROM holdem_tournaments
      WHERE started_at IS NULL AND finished_at IS NULL AND cancelled_at IS NULL
        AND scheduled_start_at > ?
      ORDER BY scheduled_start_at ASC LIMIT 1`, now);
  if (pending) {
    return {
      regOpenAt: pending.reg_open_at,
      startAt: pending.scheduled_start_at,
      dateStr: pending.date_str,
    };
  }
  const r = getRecurrence();
  return r.enabled ? nextOccurrence(r, now) : null;
}
