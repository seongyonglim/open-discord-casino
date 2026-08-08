/* 공지사항 질의.
 *
 * 글은 원래 코드(web/notices.ts)에 있었다. 그 파일은 이제 "처음 한 번 심는 씨앗"으로만
 * 남는다 — 빈 DB 로 서버가 뜨면 그 글들이 그대로 들어가고, 그 뒤로는 DB 가 진짜다.
 * 씨앗을 다시 심지 않는 이유: 운영자가 지운 글이 서버를 다시 띄울 때마다 되살아나면
 * 지우기가 지우기가 아니게 된다. 그래서 표가 비어 있을 때만 심는다.
 *
 * id 는 URL 이다. 한 번 정하면 바꾸지 않는다 — 링크를 공유한 사람의 주소가 깨진다.
 * 그래서 '숨김'(active=0)을 따로 둔다. 지우는 것과 내리는 것은 다른 일이다.
 */
import { one, all, run, tx } from './queries';
import { notifyAll } from './notifications';
import { NOTICES as SEED, type Notice, type NoticeSection } from '../web/notices';

export type { Notice, NoticeSection };

interface Row {
  id: string; date: string; kind: string; title: string; summary: string;
  sections_json: string; active: number; sort_at: number;
}

function toNotice(r: Row): Notice {
  let sections: NoticeSection[] = [];
  try {
    const parsed = JSON.parse(r.sections_json) as unknown;
    if (Array.isArray(parsed)) sections = parsed as NoticeSection[];
  } catch { /* 깨진 본문은 빈 글로 본다 — 목록 전체가 죽는 것보다 낫다 */ }
  return {
    id: r.id, date: r.date, kind: r.kind as Notice['kind'],
    title: r.title, summary: r.summary, sections,
  };
}

/** 표가 비어 있을 때만 코드의 글을 심는다. 서버가 뜰 때 한 번 불린다. */
/**
 * 없앤 태그를 쓰는 글을 옮긴다. 서버가 뜰 때마다 돌지만, 옮길 글이 없으면 아무 일도 없다.
 *
 * 제목에도 태그가 들어간다("[밸런스] …"). 분류만 바꾸고 제목을 두면 목록에서 [업데이트]인데
 * 제목은 [밸런스]인 글이 되므로 함께 고친다. 운영자가 제목에서 태그를 뺀 글이면 바뀔 것이
 * 없어 그대로 지나간다.
 */
export function migrateNoticeKinds(): void {
  for (const [from, to] of Object.entries(MERGED_KINDS)) {
    run(`UPDATE notices SET kind = ?, title = REPLACE(title, ?, ?) WHERE kind = ?`,
      to, `[${from}]`, `[${to}]`, from);
  }
}

export function seedNoticesOnce(): void {
  const n = one<{ n: number }>(`SELECT COUNT(*) AS n FROM notices`)!.n;
  /* 글이 이미 있어도 태그 이관은 해야 한다 — 없앤 태그를 쓰는 글이 남아 있으면
     운영자 화면의 분류 목록에 그 값이 없어서 수정할 때마다 다른 태그로 바뀐다. */
  if (n > 0) { migrateNoticeKinds(); return; }
  tx(() => {
    /* 배열 순서가 곧 최신순이다(맨 앞이 최신). 그 순서를 sort_at 으로 옮겨 둔다 —
       날짜만으로 정렬하면 같은 날 올라온 글의 앞뒤가 실행할 때마다 뒤집힌다. */
    SEED.forEach((x, i) => {
      run(`INSERT INTO notices (id, date, kind, title, summary, sections_json, active, sort_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        x.id, x.date, x.kind, x.title, x.summary,
        JSON.stringify(x.sections), SEED.length - i);
    });
  });
}

/** 사용자에게 보이는 목록 — 숨긴 글은 빠진다. */
export function listNotices(): Notice[] {
  return all<Row>(`SELECT * FROM notices WHERE active = 1 ORDER BY sort_at DESC`).map(toNotice);
}

/** 운영자 목록 — 숨긴 글도 함께. */
export function listNoticesAdmin(): (Notice & { active: boolean })[] {
  return all<Row>(`SELECT * FROM notices ORDER BY sort_at DESC`)
    .map(r => ({ ...toNotice(r), active: r.active === 1 }));
}

export function findNotice(id: string): Notice | undefined {
  const r = one<Row>(`SELECT * FROM notices WHERE id = ? AND active = 1`, id);
  return r ? toNotice(r) : undefined;
}

/** 앞뒤 글. 목록과 같은 순서를 써야 상세에서 넘길 때 어긋나지 않는다. */
export function noticeNeighbors(id: string): { prev: Notice | null; next: Notice | null } {
  const rows = listNotices();
  const i = rows.findIndex(x => x.id === id);
  if (i < 0) return { prev: null, next: null };
  return {
    prev: i + 1 < rows.length ? rows[i + 1] : null,   // 더 과거
    next: i > 0 ? rows[i - 1] : null,                 // 더 최신
  };
}

/* 태그는 넷이다. 예전에는 [밸런스]와 [버그 수정]이 따로 있었는데, 읽는 사람에게 그 셋은
   같은 것이다 — "있던 것이 바뀌었다". 쓰는 사람만 매번 어느 쪽인지 고민했고, 그래서
   비슷한 글에 다른 태그가 붙었다. 하나로 합친다.

     업데이트  있던 것이 바뀐다 (버그 수정 · 밸런스 조정 · 기능 개선)
     신규      없던 것이 생긴다
     시즌      시즌이 갈린다 (오픈 · 마감 · 보상 개편)
     점검      서비스가 멈춘다

   [이벤트] 대신 [시즌]을 둔다. 이 서비스에서 기간이 갈리는 일은 사실상 시즌 전환뿐이고,
   "이벤트"는 무엇이든 담기는 이름이라 붙여 놓아도 무슨 글인지 알려 주지 않는다.
   시즌은 포인트가 초기화되고 순위가 확정되는 사건이라 그 자체로 한 층이다.

   합치면서 이미 올라간 글의 태그도 옮긴다 — 아래 MERGED_KINDS 와 seedNoticesOnce. */
export const NOTICE_KINDS = ['업데이트', '신규', '시즌', '점검'] as const;

/** 없앤 태그 → 대신 쓸 태그. 지난 글을 옮기는 데 쓴다. */
export const MERGED_KINDS: Record<string, string> = {
  '밸런스': '업데이트',
  '버그 수정': '업데이트',
  '이벤트': '시즌',
};

/* ── 본문 글쓰기 ──────────────────────────────────────────────────
   sections 는 제목·문단·목록·표가 들어가는 구조라, 폼으로 만들면 칸이 끝없이 늘어난다.
   그래서 한 칸에 줄 규칙으로 쓰고 여기서 구조로 바꾼다:

     ## 제목        → 새 절이 시작된다
     - 항목         → 목록
     그 밖의 줄     → 문단
     빈 줄          → 무시 (문단은 줄 단위다)

   표는 이 문법으로 쓰지 않는다. 지금 있는 글의 표는 그대로 보존되지만(수정할 때 건드리지
   않으면 남는다), 새로 쓰는 표는 이 방식으로 만들 수 없다 — 줄 문법으로 표까지 넣으면
   규칙이 금방 외우기 어려워진다. 표가 필요한 글은 드물고, 그때는 코드로 넣는 편이 낫다. */
export function parseBody(text: string): NoticeSection[] {
  const out: NoticeSection[] = [];
  let cur: NoticeSection | null = null;
  const push = () => { if (cur && (cur.heading || cur.paras?.length || cur.bullets?.length)) out.push(cur); };
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('## ')) { push(); cur = { heading: line.slice(3).trim() }; continue; }
    if (!cur) cur = { heading: '' };
    if (line.startsWith('- ')) (cur.bullets ??= []).push(line.slice(2).trim());
    else (cur.paras ??= []).push(line);
  }
  push();
  return out;
}

/** 구조를 다시 줄 규칙으로 되돌린다 — 수정 화면에 원문처럼 보여 주기 위한 것이다. */
export function unparseBody(sections: NoticeSection[]): string {
  return sections.map(s => {
    const lines: string[] = [];
    if (s.heading) lines.push('## ' + s.heading);
    for (const p of s.paras ?? []) lines.push(p);
    for (const b of s.bullets ?? []) lines.push('- ' + b);
    /* 표는 줄 규칙으로 표현하지 않는다. 되돌릴 때 조용히 사라지면 수정 한 번에 표가
       날아가므로, 표가 있는 절은 그 사실을 적어 둔다(저장할 때 원래 표를 되살린다). */
    if (s.table) lines.push('[표 ' + s.table.head.length + '열 × ' + s.table.rows.length + '행 — 화면에 그대로 유지됩니다]');
    return lines.join('\n');
  }).join('\n\n');
}

/** 수정 저장 시, 예전 글에 있던 표를 절 순서대로 되살린다. */
export function keepTables(next: NoticeSection[], old: NoticeSection[]): NoticeSection[] {
  return next.map((s, i) => (old[i]?.table ? { ...s, table: old[i].table } : s));
}

export interface NoticeInput {
  id: string; date: string; kind: string; title: string; summary: string;
  sections: NoticeSection[]; active: boolean;
}

export type NoticeError = 'bad_id' | 'bad_date' | 'bad_kind' | 'no_title' | 'no_body' | 'duplicate' | 'not_found';

/* 검증은 여기서 한다. 화면에서만 막으면 API 를 직접 부르는 순간 뚫린다.
   id 는 URL 에 그대로 들어가므로 주소에 쓸 수 있는 글자만 받는다. */
export function validateNotice(n: NoticeInput): NoticeError | null {
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(n.id)) return 'bad_id';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(n.date)) return 'bad_date';
  if (!NOTICE_KINDS.includes(n.kind as typeof NOTICE_KINDS[number])) return 'bad_kind';
  if (n.title.trim() === '') return 'no_title';
  if (!n.sections.length || n.sections.every(s => !s.heading && !s.paras?.length && !s.bullets?.length)) {
    return 'no_body';
  }
  return null;
}

export function createNotice(n: NoticeInput): { ok: true } | { ok: false; error: NoticeError } {
  const bad = validateNotice(n);
  if (bad) return { ok: false, error: bad };
  return tx(() => {
    if (one<{ n: number }>(`SELECT COUNT(*) AS n FROM notices WHERE id = ?`, n.id)!.n > 0) {
      return { ok: false as const, error: 'duplicate' as const };
    }
    // 새 글은 항상 맨 위로. 기존 최대값 + 1 이면 날짜와 무관하게 위에 선다.
    const top = one<{ n: number }>(`SELECT COALESCE(MAX(sort_at), 0) AS n FROM notices`)!.n;
    run(`INSERT INTO notices (id, date, kind, title, summary, sections_json, active, sort_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      n.id, n.date, n.kind, n.title.trim(), n.summary.trim(),
      JSON.stringify(n.sections), n.active ? 1 : 0, top + 1);
    /* 전체 알림을 함께 만든다. 공지는 올려 두는 것만으로는 아무도 모른다 —
       공지 탭을 눌러 본 사람만 읽고, 그건 이미 찾아온 사람이다.
       숨김으로 올린 글은 알리지 않는다(아직 보여줄 준비가 안 된 글이다).
       한 줄만 넣는다 — 사람 수만큼 복사하면 사람이 늘 때마다 비용이 는다. */
    if (n.active) {
      notifyAll('ANNOUNCEMENT', '새 공지사항', `[${n.kind}] ${n.title.trim()}`, '/notices/' + n.id);
    }
    return { ok: true as const };
  });
}

export function updateNotice(id: string, n: Omit<NoticeInput, 'id'>):
  { ok: true } | { ok: false; error: NoticeError } {
  const bad = validateNotice({ ...n, id });
  if (bad) return { ok: false, error: bad };
  const found = one<{ id: string }>(`SELECT id FROM notices WHERE id = ?`, id);
  if (!found) return { ok: false, error: 'not_found' };
  run(`UPDATE notices SET date = ?, kind = ?, title = ?, summary = ?, sections_json = ?, active = ?
        WHERE id = ?`,
    n.date, n.kind, n.title.trim(), n.summary.trim(),
    JSON.stringify(n.sections), n.active ? 1 : 0, id);
  return { ok: true };
}

/** 숨김/보임만 뒤집는다. 글은 그대로 두므로 되돌리기가 쉽다. */
export function toggleNotice(id: string): { ok: true; active: boolean } | { ok: false; error: 'not_found' } {
  const r = one<{ active: number }>(`SELECT active FROM notices WHERE id = ?`, id);
  if (!r) return { ok: false, error: 'not_found' };
  const next = r.active === 1 ? 0 : 1;
  run(`UPDATE notices SET active = ? WHERE id = ?`, next, id);
  return { ok: true, active: next === 1 };
}

export function deleteNotice(id: string): { ok: true } | { ok: false; error: 'not_found' } {
  const r = one<{ id: string }>(`SELECT id FROM notices WHERE id = ?`, id);
  if (!r) return { ok: false, error: 'not_found' };
  run(`DELETE FROM notices WHERE id = ?`, id);
  return { ok: true };
}
