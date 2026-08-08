/* 알림.
 *
 * 세 곳에서 만들어진다 — 새 공지, 도전과제 달성, 운영자 포인트 지급. 종류가 늘어도
 * 만드는 함수만 늘고 읽는 쪽은 그대로다.
 *
 * 전체 알림(user_id = NULL)의 읽음 표시가 이 파일의 유일한 까다로운 부분이다.
 * 한 줄을 모두가 보는데 is_read 는 그 줄에 하나뿐이라, 그것만 쓰면 한 사람이 읽는
 * 순간 모두가 읽은 것이 된다. 그래서 개인 알림의 읽음만 줄에 두고, 전체 알림은
 * notification_reads 에 사람마다 적는다. 읽지 않은 개수는 두 가지를 합쳐 센다.
 */
import { one, all, run, tx } from './queries';

export const NOTI_TYPES = ['ANNOUNCEMENT', 'ACHIEVEMENT', 'POINT_GIFT', 'SYSTEM'] as const;
export type NotiType = typeof NOTI_TYPES[number];

export interface NotiRow {
  id: number; user_id: string | null; type: string;
  title: string; message: string; link: string | null;
  is_read: number; created_at: number;
}

export interface NotiView {
  id: number; type: string; title: string; message: string;
  link: string | null; read: boolean; createdAt: number;
}

/* 목록에 얼마나 거슬러 올라가 보여줄지. 알림은 쌓이기만 하고 지우지 않으므로
   상한이 없으면 오래된 계정일수록 응답이 무거워진다. */
const LIST_LIMIT = 30;

/**
 * 사람이 만들어지기 전의 전체 알림은 보여주지 않는다.
 *
 * 그러지 않으면 오늘 처음 들어온 사람의 종에 지난 반년치 공지가 전부 안 읽음으로
 * 달린다 — 새 소식을 알리려고 만든 것이 새 사람에게는 청소해야 할 목록이 된다.
 */
function joinedAt(userId: string): number {
  const u = one<{ n: number }>(`SELECT created_at AS n FROM users WHERE id = ?`, userId);
  return u?.n ?? 0;
}

export function listNotifications(userId: string, limit = LIST_LIMIT): NotiView[] {
  const since = joinedAt(userId);
  /* 치운 것은 안 보여 준다. 지우는 것이 아니라 이 사람 목록에서만 빼는 것이라
     줄은 그대로 남는다 — 전체 알림은 한 줄을 여럿이 보므로 지울 수가 없고,
     개인 알림도 기록은 남겨 두는 편이 낫다. */
  return all<NotiRow & { read_at: number | null }>(
    `SELECT n.*, r.read_at
       FROM notifications n
       LEFT JOIN notification_reads r
         ON r.notification_id = n.id AND r.user_id = ?
      WHERE (n.user_id = ? OR (n.user_id IS NULL AND n.created_at >= ?))
        AND r.dismissed_at IS NULL
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ?`, userId, userId, since, Math.min(100, Math.max(1, limit)))
    .map(n => ({
      id: n.id, type: n.type, title: n.title, message: n.message, link: n.link,
      // 개인 알림은 줄의 is_read, 전체 알림은 사람별 기록으로 판단한다
      read: n.user_id == null ? n.read_at != null : n.is_read === 1,
      createdAt: n.created_at,
    }));
}

export function unreadCount(userId: string): number {
  const since = joinedAt(userId);
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM notifications n
       LEFT JOIN notification_reads r
         ON r.notification_id = n.id AND r.user_id = ?
      WHERE r.dismissed_at IS NULL
        AND ((n.user_id = ? AND n.is_read = 0)
          OR (n.user_id IS NULL AND n.created_at >= ? AND r.read_at IS NULL))`,
    userId, userId, since)!.n;
}

/* 팝업으로 띄울 창. 이보다 오래된 공지는 종에만 남는다.
   하루로 잡는 이유: 공지는 올라온 그날 알아야 의미가 있는 정보다. 사흘 뒤에 들어온
   사람에게 튀어나오면 그건 새 소식이 아니라 방해가 된다. */
export const POPUP_WINDOW_SEC = 24 * 60 * 60;

/**
 * 접속하자마자 팝업으로 띄울 것들.
 *
 * 공지만 대상이다. 도전과제 달성은 그 순간에 이미 띄웠고, 포인트 지급은 받은 사실이
 * 잔액에 남아 있어 놓쳐도 사라지지 않는다. 공지는 안 보면 그냥 지나간다.
 *
 * "안 읽음"이 조건이다 — 종을 열어 본 사람에게 다시 튀어나오면 안 읽은 것을 알리는
 * 장치가 아니라 그냥 반복 재생이 된다.
 */
export function popupNotifications(userId: string, now = Math.floor(Date.now() / 1000)): NotiView[] {
  const since = Math.max(joinedAt(userId), now - POPUP_WINDOW_SEC);
  return all<NotiRow>(
    `SELECT n.* FROM notifications n
       LEFT JOIN notification_reads r
         ON r.notification_id = n.id AND r.user_id = ?
      WHERE n.type = 'ANNOUNCEMENT'
        AND n.created_at >= ?
        AND r.dismissed_at IS NULL
        AND ((n.user_id = ? AND n.is_read = 0)
          OR (n.user_id IS NULL AND r.read_at IS NULL))
      ORDER BY n.created_at ASC, n.id ASC`, userId, since, userId)
    .map(n => ({
      id: n.id, type: n.type, title: n.title, message: n.message, link: n.link,
      read: false, createdAt: n.created_at,
    }));
}

/**
 * 읽음으로 표시한다. 목록에서 치우지는 않는다.
 *
 * 종을 여는 것만으로 이것이 돈다 — 열어 봤으면 배지는 내려가야 한다. 여는 것과
 * 정리하는 것은 다른 동작이라, 열었다고 목록까지 비면 읽을 새도 없이 사라진다.
 */
export function markAllRead(userId: string): void {
  const since = joinedAt(userId);
  return tx(() => {
    run(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, userId);
    run(`INSERT INTO notification_reads (user_id, notification_id)
         SELECT ?, n.id FROM notifications n
          WHERE n.user_id IS NULL AND n.created_at >= ?
         ON CONFLICT(user_id, notification_id) DO NOTHING`, userId, since);
  });
}

/**
 * [모두 읽음] 버튼 — 읽음으로 표시하고 목록에서도 치운다.
 *
 * 표시만 지우고 목록에 남기면 "정리했는데 그대로 있다"로 읽힌다. 누른 사람이 기대하는
 * 것은 빈 목록이다. 대신 줄 자체는 지우지 않는다 — 전체 알림은 한 줄을 여럿이 보므로
 * 지울 수 없고, 개인 알림도 무슨 일이 있었는지는 남겨 두는 편이 낫다.
 * 그래서 "이 사람이 치웠다"만 사람별로 적는다.
 *
 * 새 알림은 당연히 다시 쌓인다 — 치움은 그때까지 온 것에만 붙는 표시다.
 */
export function dismissAll(userId: string): void {
  const since = joinedAt(userId);
  return tx(() => {
    markAllRead(userId);
    /* 개인 알림의 치움도 여기에 적는다 — 치움은 줄이 아니라 사람에게 달린 표시라
       한곳에 모아야 목록을 거를 때 한 번만 조인하면 된다. */
    run(`INSERT INTO notification_reads (user_id, notification_id, dismissed_at)
         SELECT ?, n.id, unixepoch() FROM notifications n
          WHERE (n.user_id = ? OR (n.user_id IS NULL AND n.created_at >= ?))
         ON CONFLICT(user_id, notification_id)
         DO UPDATE SET dismissed_at = COALESCE(notification_reads.dismissed_at, unixepoch())`,
      userId, userId, since);
  });
}

export function markRead(userId: string, id: number): void {
  return tx(() => {
    const n = one<{ user_id: string | null }>(`SELECT user_id FROM notifications WHERE id = ?`, id);
    if (!n) return;
    if (n.user_id == null) {
      run(`INSERT INTO notification_reads (user_id, notification_id) VALUES (?, ?)
           ON CONFLICT(user_id, notification_id) DO NOTHING`, userId, id);
      return;
    }
    // 남의 알림은 못 읽는다 — id 만 바꿔 가며 부르면 남의 줄이 읽음으로 바뀐다
    run(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, id, userId);
  });
}

/* ── 만들기 ───────────────────────────────────────────────────────── */

function insert(userId: string | null, type: NotiType, title: string, message: string,
  link: string | null): number {
  run(`INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, ?, ?, ?, ?)`,
    userId, type, title.slice(0, 120), message.slice(0, 400), link);
  return one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;
}

export function notifyUser(userId: string, type: NotiType, title: string, message: string,
  link: string | null = null): number {
  return insert(userId, type, title, message, link);
}

/** 전체 알림. 줄 하나만 넣는다 — 사람 수만큼 복사하면 사람이 늘 때마다 비용이 는다. */
export function notifyAll(type: NotiType, title: string, message: string,
  link: string | null = null): number {
  return insert(null, type, title, message, link);
}

/**
 * 여러 사람에게 같은 내용을 개인 알림으로. 운영자가 고른 사람들에게 포인트를 줄 때 쓴다.
 * 전체 알림과 다르다 — 받은 사람에게만 보여야 하므로 사람마다 한 줄씩 넣는다.
 */
export function notifyMany(userIds: string[], type: NotiType, title: string, message: string,
  link: string | null = null): number {
  return tx(() => {
    let n = 0;
    for (const u of userIds) { insert(u, type, title, message, link); n++; }
    return n;
  });
}
