import {
  buildPushPayload,
  type PushSubscription,
  type VapidKeys,
} from '@block65/webcrypto-web-push';

interface Task {
  id: number;
  text: string;
  done: boolean;
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM
}

interface DeviceRecord {
  subscription: PushSubscription;
  tasks: Task[];
  notified: number[];
}

export interface Env {
  PUSH_KV: KVNamespace;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  ALLOWED_ORIGIN: string;
}

function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function todayStr(): string {
  const d = new Date();
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function curTime(): string {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function handleSync(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    deviceId: string;
    subscription: PushSubscription;
    tasks: Task[];
  }>();

  if (!body.deviceId || !body.subscription) {
    return new Response('deviceId and subscription are required', { status: 400 });
  }

  const key = `device:${body.deviceId}`;
  const existingRaw = await env.PUSH_KV.get(key);
  const existing: DeviceRecord | null = existingRaw ? JSON.parse(existingRaw) : null;

  const record: DeviceRecord = {
    subscription: body.subscription,
    tasks: body.tasks ?? [],
    notified: existing?.notified ?? [],
  };

  // Drop notified ids for tasks that no longer exist or were reopened, so they can alert again.
  const liveIds = new Set(record.tasks.map((t) => t.id));
  record.notified = record.notified.filter((id) => liveIds.has(id));

  await env.PUSH_KV.put(key, JSON.stringify(record));

  return new Response('ok', { status: 200, headers: corsHeaders(env) });
}

async function sendPush(
  env: Env,
  subscription: PushSubscription,
  title: string,
  body: string,
  tag: string,
): Promise<boolean> {
  const vapid: VapidKeys = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  const payload = await buildPushPayload(
    {
      data: JSON.stringify({ title, body, tag }),
      options: { ttl: 3600, urgency: 'high' },
    },
    subscription,
    vapid,
  );

  const res = await fetch(subscription.endpoint, payload);
  return res.ok;
}

async function checkDueTasks(env: Env): Promise<void> {
  const today = todayStr();
  const now = curTime();

  const list = await env.PUSH_KV.list({ prefix: 'device:' });
  for (const item of list.keys) {
    const raw = await env.PUSH_KV.get(item.name);
    if (!raw) continue;
    const record: DeviceRecord = JSON.parse(raw);

    const due = record.tasks.filter(
      (t) =>
        !t.done &&
        t.time &&
        t.date <= today &&
        (t.date < today || t.time <= now) &&
        !record.notified.includes(t.id),
    );

    if (due.length === 0) continue;

    let changed = false;
    for (const t of due) {
      try {
        const title = t.date < today ? 'Geciken görev' : 'Görev zamanı geçti';
        const ok = await sendPush(env, record.subscription, title, t.text, `task-${t.id}`);
        if (ok) {
          record.notified.push(t.id);
          changed = true;
        }
      } catch (err) {
        // Subscription likely expired/invalid; drop the device record.
        await env.PUSH_KV.delete(item.name);
        changed = false;
        break;
      }
    }

    if (changed) {
      await env.PUSH_KV.put(item.name, JSON.stringify(record));
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname === '/sync' && request.method === 'POST') {
      try {
        return await handleSync(request, env);
      } catch (err) {
        return new Response('bad request', { status: 400, headers: corsHeaders(env) });
      }
    }

    return new Response('not found', { status: 404, headers: corsHeaders(env) });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await checkDueTasks(env);
  },
};
