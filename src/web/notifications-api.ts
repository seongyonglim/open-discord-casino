/* 알림 API — 머리의 종이 쓰는 세 가지.
   목록·개수는 한 번에 준다(종을 열면 둘 다 필요하다), 읽음은 두 갈래로 나눈다. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readJson } from './http';
import {
  listNotifications, unreadCount, markAllRead, markRead, popupNotifications, dismissAll,
} from '../db/notifications';

export async function handleNotifications(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  return sendJson(res, 200, {
    ok: true,
    unread: unreadCount(userId),
    items: listNotifications(userId),
    /* 접속하자마자 띄울 것. 화면이 다시 물어보지 않아도 되게 목록과 함께 준다 —
       종은 어차피 페이지를 열 때마다 한 번 받아 간다. */
    popup: popupNotifications(userId),
  });
}

/** 종을 열었을 때 — 배지만 내린다. 목록은 그대로 둔다(읽을 새도 없이 사라지면 안 된다). */
export async function handleNotificationsReadAll(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  markAllRead(userId);
  return sendJson(res, 200, { ok: true, unread: 0 });
}

/** [모두 읽음] 버튼 — 읽음 처리하고 목록에서도 치운다. */
export async function handleNotificationsDismissAll(
  _req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  dismissAll(userId);
  return sendJson(res, 200, { ok: true, unread: 0, items: [] });
}

export async function handleNotificationRead(
  req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  const b = await readJson(req) as { id?: unknown } | null;
  const id = Math.floor(Number(b?.id ?? 0));
  if (!Number.isFinite(id) || id <= 0) return sendJson(res, 400, { error: '잘못된 알림입니다' });
  markRead(userId, id);
  return sendJson(res, 200, { ok: true, unread: unreadCount(userId) });
}
