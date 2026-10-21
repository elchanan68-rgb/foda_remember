import { createClient } from 'npm:@supabase/supabase-js@2';

const BUCKET = 'family-memories';
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS = 10;
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const PHOTO_STORAGE_LIMIT_BYTES = 800_000_000;
const categories = new Set(['family', 'food', 'wisdom', 'celebration', 'photos']);
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';

function getServiceKey(): string {
  const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      if (typeof parsed.default === 'string') return parsed.default;
    } catch {
      // Fall through to the compatibility variables below.
    }
  }
  return Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

const serviceKey = getServiceKey();
const admin = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

function allowedOrigins(): string[] {
  return (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
}

function corsHeaders(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-turnstile-token, x-manager-code, x-family-code',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
}

function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

function cleanField(value: FormDataEntryValue | null, maxLength: number): string {
  return typeof value === 'string' ? value.normalize('NFC').trim().slice(0, maxLength) : '';
}

function detectImage(bytes: Uint8Array): { mime: string; extension: string; width: number; height: number } | null {
  let image: { mime: string; extension: string; width: number; height: number } | null = null;
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    image = { mime: 'image/png', extension: 'png', width: view.getUint32(16, false), height: view.getUint32(20, false) };
  } else if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    const u24 = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
    if (kind === 'VP8X') image = { mime: 'image/webp', extension: 'webp', width: u24(24) + 1, height: u24(27) + 1 };
    else if (kind === 'VP8L' && bytes[20] === 0x2f) {
      image = {
        mime: 'image/webp', extension: 'webp',
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height: 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10)
      };
    } else if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      image = { mime: 'image/webp', extension: 'webp', width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 1 >= bytes.length) break;
      const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (startOfFrame.has(marker) && segmentLength >= 7) {
        image = {
          mime: 'image/jpeg', extension: 'jpg',
          height: (bytes[offset + 3] << 8) | bytes[offset + 4],
          width: (bytes[offset + 5] << 8) | bytes[offset + 6]
        };
        break;
      }
      offset += segmentLength;
    }
  }
  if (!image || image.width < 1 || image.height < 1 || image.width > 4000 || image.height > 4000 || image.width * image.height > 8_000_000) return null;
  return image;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sameSecret(candidate: string, expected: string): Promise<boolean> {
  if (!candidate || !expected || candidate.length > 128 || expected.length > 128) return false;
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(candidate)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected))
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function readLimitedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const value = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip') ?? forwarded?.split(',').at(-1)?.trim() ?? '';
  return value.slice(0, 100);
}

async function verifyTurnstile(token: string, origin: string): Promise<boolean> {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY');
  if (!secret || !token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token });
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) return false;
  const result = await response.json();
  if (result.success !== true) return false;
  try {
    const expectedHost = new URL(origin).hostname;
    return result.hostname === expectedHost;
  } catch {
    return false;
  }
}

async function managerAuth(request: Request, headers: HeadersInit, requireCode = false): Promise<{ authorized: boolean; error?: Response }> {
  const suppliedCode = request.headers.get('x-manager-code') ?? '';
  if (!suppliedCode) return { authorized: false, ...(requireCode ? { error: json({ error: 'נדרש קוד מנהל.' }, 403, headers) } : {}) };
  const ip = clientIp(request);
  if (!ip) return { authorized: false, error: json({ error: 'לא ניתן לזהות את החיבור. נסו שוב.' }, 400, headers) };
  const { data: rateData, error: rateError } = await admin!.rpc('take_family_bio_edit_slot', {
    p_ip_hash: await sha256Hex(ip), p_limit: 30, p_window_seconds: 3600
  });
  if (rateError) return { authorized: false, error: json({ error: 'לא ניתן לאמת מנהל כרגע.' }, 503, headers) };
  const rate = Array.isArray(rateData) ? rateData[0] : rateData;
  if (!rate?.allowed) return { authorized: false, error: json({ error: 'יותר מדי ניסיונות מנהל. נסו שוב מאוחר יותר.' }, 429, { ...headers, 'Retry-After': String(rate?.retry_after_seconds ?? 3600) }) };
  const configuredCode = Deno.env.get('FAMILY_DELETE_CODE') ?? '';
  const authorized = await sameSecret(suppliedCode, configuredCode);
  if (!authorized && requireCode) return { authorized, error: json({ error: 'קוד המנהל שגוי.' }, 403, headers) };
  return { authorized };
}

async function listApproved(request: Request, headers: HeadersInit): Promise<Response> {
  if (!admin) return json({ error: 'השירות לא הוגדר.' }, 503, headers);
  const managerCheck = await managerAuth(request, headers);
  if (managerCheck.error) return managerCheck.error;
  const { data, error } = await admin
    .from('family_memories')
    .select('id,title,author,story,category,photo_path,created_at')
    .in('status', managerCheck.authorized ? ['approved', 'pending'] : ['approved'])
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return json({ error: 'לא ניתן לטעון את הזיכרונות כרגע.' }, 503, headers);

  const ids = (data ?? []).map((row) => row.id);
  type PhotoEntry = { id: string; path: string; thumbnailPath: string | null };
  const photosByMemory = new Map<string, PhotoEntry[]>();
  if (ids.length) {
    const { data: photoRows } = await admin.from('family_memory_photos').select('id,memory_id,photo_path,thumbnail_path,position').in('memory_id', ids).order('position', { ascending: true });
    for (const item of photoRows ?? []) {
      if (typeof item.photo_path !== 'string' || item.photo_path.length > 300) continue;
      const list = photosByMemory.get(item.memory_id) ?? [];
      list.push({ id: item.id, path: item.photo_path, thumbnailPath: typeof item.thumbnail_path === 'string' && item.thumbnail_path.length <= 300 ? item.thumbnail_path : null });
      photosByMemory.set(item.memory_id, list);
    }
  }
  const entriesFor = (row: { id: string; photo_path: string | null }): PhotoEntry[] => {
    const entries = photosByMemory.get(row.id) ?? (row.photo_path ? [{ id: '', path: row.photo_path, thumbnailPath: null }] : []);
    return row.photo_path ? [...entries].sort((a, b) => Number(b.path === row.photo_path) - Number(a.path === row.photo_path)) : entries;
  };
  const paths = [...new Set((data ?? []).flatMap((row) => entriesFor(row).flatMap((photo) => [photo.path, ...(photo.thumbnailPath ? [photo.thumbnailPath] : [])])))];
  const signedByPath = new Map<string, string>();
  if (paths.length) {
    // A longer URL lifetime helps photos load when the page is left open,
    // especially on mobile where lazy-loaded album items may load later.
    const { data: signed } = await admin.storage.from(BUCKET).createSignedUrls(paths, 86400);
    for (const item of signed ?? []) {
      if (item.path && item.signedUrl) signedByPath.set(item.path, new URL(item.signedUrl, supabaseUrl).href);
    }
  }

  const memories = (data ?? []).map((row) => {
    const photoList = entriesFor(row).map((photo) => ({
      id: photo.id || null,
      url: signedByPath.get(photo.path) ?? null,
      thumbnailUrl: (photo.thumbnailPath && signedByPath.get(photo.thumbnailPath)) || signedByPath.get(photo.path) || null
    })).filter((photo): photo is { id: string | null; url: string; thumbnailUrl: string } => Boolean(photo.url && photo.thumbnailUrl));
    return {
      id: row.id,
      title: row.title,
      author: row.author,
      story: row.story,
      category: row.category,
      status: row.status,
      createdAt: row.created_at,
      photoUrl: photoList[0]?.url ?? null,
      photoUrls: photoList.map((photo) => photo.url),
      thumbnailUrls: photoList.map((photo) => photo.thumbnailUrl),
      photoIds: photoList.map((photo) => photo.id)
    };
  });
  const { data: usageData, error: usageError } = await admin.rpc('family_memory_storage_status');
  const usage = usageError ? null : (Array.isArray(usageData) ? usageData[0] : usageData);
  const usedBytes = usage ? Number(usage.used_bytes ?? 0) + Number(usage.reserved_bytes ?? 0) : 0;
  const { data: biography } = await admin.from('family_biography').select('summary,birthplace,childhood,parents,aliyah,full_story').eq('id', true).maybeSingle();
  return json({ memories, storage: {
    warning: Boolean(usage) && usedBytes >= PHOTO_STORAGE_LIMIT_BYTES,
    percent: Math.min(100, Math.floor(usedBytes / PHOTO_STORAGE_LIMIT_BYTES * 100))
  }, biography: biography ? {
    summary: biography.summary,
    birthplace: biography.birthplace,
    childhood: biography.childhood,
    parents: biography.parents,
    aliyah: biography.aliyah,
    fullStory: biography.full_story
  } : null, manager: managerCheck.authorized }, 200, headers);
}

async function saveBiography(request: Request, headers: HeadersInit): Promise<Response> {
  if (!admin) return json({ error: 'השירות לא הוגדר.' }, 503, headers);
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > 20_000) return json({ error: 'טופס קורות החיים גדול מדי.' }, 413, headers);
  const body = await readLimitedBody(request, 20_000);
  if (!body) return json({ error: 'טופס קורות החיים גדול מדי.' }, 413, headers);
  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ error: 'פרטי הטופס אינם תקינים.' }, 400, headers);
    input = parsed;
  } catch {
    return json({ error: 'פרטי הטופס אינם תקינים.' }, 400, headers);
  }

  const ip = clientIp(request);
  if (!ip) return json({ error: 'לא ניתן לזהות את החיבור. נסו שוב.' }, 400, headers);
  const ipHash = await sha256Hex(ip);
  const { data: rateData, error: rateError } = await admin.rpc('take_family_bio_edit_slot', {
    p_ip_hash: ipHash,
    p_limit: 20,
    p_window_seconds: 3600
  });
  if (rateError) return json({ error: 'לא ניתן לבצע עריכה כרגע.' }, 503, headers);
  const rate = Array.isArray(rateData) ? rateData[0] : rateData;
  if (!rate?.allowed) return json({ error: 'בוצעו יותר מדי ניסיונות. נסו שוב מאוחר יותר.' }, 429, headers);

  const { data: codeState, error: codeStateError } = await admin.rpc('family_code_attempt_allowed', { p_ip_hash: ipHash });
  if (codeStateError) return json({ error: 'לא ניתן לבדוק כרגע את מגבלת ניסיונות הקוד.' }, 503, headers);
  const codeLimit = Array.isArray(codeState) ? codeState[0] : codeState;
  if (!codeLimit?.allowed) return json({ error: 'הקוד נחסם זמנית אחרי ניסיונות שגויים. נסו שוב בעוד שעה.' }, 429, { ...headers, 'Retry-After': String(codeLimit?.retry_after_seconds ?? 3600) });

  // Editing the biography requires the family code, so a stranger cannot overwrite it.
  const familyCode = Deno.env.get('FAMILY_AUTO_APPROVE_CODE') ?? '';
  if (!familyCode) return json({ error: 'עריכת קורות החיים עדיין לא הוגדרה. יש להגדיר קוד משפחתי במערכת.' }, 503, headers);
  if (!await sameSecret(request.headers.get('x-family-code') ?? '', familyCode)) {
    const { data: failureData, error: failureError } = await admin.rpc('record_family_code_failure', { p_ip_hash: ipHash });
    if (failureError) return json({ error: 'לא ניתן לרשום ניסיון קוד שגוי. נסו שוב.' }, 503, headers);
    const failure = Array.isArray(failureData) ? failureData[0] : failureData;
    if (!failure?.allowed) return json({ error: 'הקוד נחסם זמנית אחרי 5 ניסיונות שגויים. נסו שוב בעוד שעה.' }, 429, { ...headers, 'Retry-After': String(failure?.retry_after_seconds ?? 3600) });
    return json({ error: 'הקוד המשפחתי שגוי.' }, 403, headers);
  }
  const { error: clearCodeFailuresError } = await admin.rpc('clear_family_code_failures', { p_ip_hash: ipHash });
  if (clearCodeFailuresError) return json({ error: 'לא ניתן לאפס את מונה ניסיונות הקוד.' }, 503, headers);

  const fields: Record<string, [string, number]> = {
    summary: ['summary', 1200],
    birthplace: ['birthplace', 240],
    childhood: ['childhood', 1200],
    parents: ['parents', 1200],
    aliyah: ['aliyah', 1800],
    fullStory: ['full_story', 12000]
  };
  const record: Record<string, string | boolean> = { id: true, updated_at: new Date().toISOString() };
  for (const [key, [column, maxLength]] of Object.entries(fields)) {
    const value = input[key];
    if (typeof value !== 'string' || value.length > maxLength) return json({ error: 'אחד משדות הסיפור ארוך מהמותר או אינו תקין.' }, 400, headers);
    record[column] = value.trim();
  }
  if (!record.summary || !record.full_story) return json({ error: 'יש למלא תקציר וסיפור מלא.' }, 400, headers);

  // Keep the previous version so any edit can be restored from the family_biography_history table.
  const { data: previous, error: previousError } = await admin.from('family_biography').select('summary,birthplace,childhood,parents,aliyah,full_story,updated_at').eq('id', true).maybeSingle();
  if (previousError) return json({ error: 'לא הצלחנו לטעון את הגרסה הקודמת. לא בוצעו שינויים.' }, 503, headers);
  if (previous?.summary || previous?.full_story) {
    const { error: historyError } = await admin.from('family_biography_history').insert(previous);
    if (historyError) return json({ error: 'לא הצלחנו לשמור גיבוי של קורות החיים. לא בוצעו שינויים.' }, 503, headers);
  }

  const { data, error } = await admin.from('family_biography').upsert(record).select('summary,birthplace,childhood,parents,aliyah,full_story').single();
  if (error || !data) return json({ error: 'לא הצלחנו לשמור את קורות החיים.' }, 503, headers);
  return json({ ok: true, biography: {
    summary: data.summary,
    birthplace: data.birthplace,
    childhood: data.childhood,
    parents: data.parents,
    aliyah: data.aliyah,
    fullStory: data.full_story
  } }, 200, headers);
}

async function submitMemory(request: Request, origin: string, headers: HeadersInit): Promise<Response> {
  if (!admin) return json({ error: 'השירות לא הוגדר.' }, 503, headers);
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader && Number(lengthHeader) > MAX_REQUEST_BYTES) return json({ error: 'הבקשה גדולה מדי.' }, 413, headers);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) return json({ error: 'מבנה הבקשה אינו תקין.' }, 415, headers);

  const token = request.headers.get('x-turnstile-token') ?? '';
  try {
    if (!await verifyTurnstile(token, origin)) return json({ error: 'בדיקת האבטחה נכשלה. נסו שוב.' }, 403, headers);
  } catch {
    return json({ error: 'לא ניתן להשלים את בדיקת האבטחה כרגע.' }, 503, headers);
  }

  const ip = clientIp(request);
  if (!ip) return json({ error: 'לא ניתן לזהות את החיבור. נסו שוב.' }, 400, headers);
  const ipHash = await sha256Hex(ip);
  const { data: rateData, error: rateError } = await admin.rpc('take_family_memory_submission_slot', {
    p_ip_hash: ipHash,
    p_limit: 60,
    p_window_seconds: 3600
  });
  if (rateError) return json({ error: 'לא ניתן לקבל שליחות חדשות כרגע.' }, 503, headers);
  const rate = Array.isArray(rateData) ? rateData[0] : rateData;
  if (!rate?.allowed) {
    const retryAfter = Math.max(1, Number(rate?.retry_after_seconds) || 3600);
    return json({ error: 'נשלחו יותר מדי זיכרונות. נסו שוב מאוחר יותר.' }, 429, { ...headers, 'Retry-After': String(retryAfter) });
  }

  const boundedBody = await readLimitedBody(request, MAX_REQUEST_BYTES);
  if (!boundedBody) return json({ error: 'הבקשה גדולה מדי.' }, 413, headers);
  let form: FormData;
  try {
    const formHeaders = new Headers({ 'Content-Type': request.headers.get('content-type') ?? '' });
    const boundedRequest = new Request(request.url, { method: 'POST', headers: formHeaders, body: boundedBody });
    form = await boundedRequest.formData();
  } catch {
    return json({ error: 'לא הצלחנו לקרוא את הטופס.' }, 400, headers);
  }

  // Quietly discard automated form fills without exposing the honeypot rule.
  if (cleanField(form.get('website'), 200)) return json({ ok: true, pending: true }, 202, headers);

  const rawTitle = form.get('title');
  const rawAuthor = form.get('author');
  const rawStory = form.get('story');
  const rawApprovalCode = form.get('approvalCode');
  if ((typeof rawTitle === 'string' && rawTitle.trim().length > 90) ||
      (typeof rawAuthor === 'string' && rawAuthor.trim().length > 50) ||
      (typeof rawStory === 'string' && rawStory.trim().length > 2500) ||
      (typeof rawApprovalCode === 'string' && rawApprovalCode.length > 128)) {
    return json({ error: 'אחד השדות ארוך מהמותר.' }, 400, headers);
  }
  if (rawApprovalCode !== null && typeof rawApprovalCode !== 'string') return json({ error: 'שדה הקוד אינו תקין.' }, 400, headers);
  const title = cleanField(rawTitle, 90);
  const author = cleanField(rawAuthor, 50);
  const story = cleanField(rawStory, 2500);
  const category = cleanField(form.get('category'), 30);
  const submittedApprovalCode = cleanField(form.get('approvalCode'), 128);
  const photoEntries = form.getAll('photo');
  const photoFiles = photoEntries.filter((value): value is File => value instanceof File && value.size > 0);
  const thumbnailEntries = form.getAll('thumbnail');
  const thumbnailFiles = thumbnailEntries.filter((value): value is File => value instanceof File && value.size > 0);
  const hasPhoto = photoFiles.length > 0;
  if ((!story && !hasPhoto) || !categories.has(category)) return json({ error: 'יש לצרף תמונה או לכתוב סיפור קצר ולבחור נושא.' }, 400, headers);
  const categoryLabels: Record<string, string> = { family: 'רגעים משפחתיים', food: 'מהמטבח של סבתא', wisdom: 'מילים של סבתא', celebration: 'שמחות וחגים', photos: 'אלבום תמונות' };
  const finalTitle = title || (hasPhoto ? `תמונה – ${categoryLabels[category]}` : 'זיכרון משפחתי');
  const finalAuthor = author || 'בן/בת משפחה';
  if (title.length > 90 || author.length > 50 || story.length > 2500) return json({ error: 'אחד השדות ארוך מהמותר.' }, 400, headers);

  const configuredApprovalCode = Deno.env.get('FAMILY_AUTO_APPROVE_CODE') ?? '';
  if (hasPhoto && !configuredApprovalCode) return json({ error: 'העלאת תמונות עדיין לא הוגדרה. יש להגדיר מילת קוד משפחתית במערכת.' }, 503, headers);
  let autoApprove = false;
  if (hasPhoto || submittedApprovalCode) {
    const { data: codeState, error: codeStateError } = await admin.rpc('family_code_attempt_allowed', { p_ip_hash: ipHash });
    if (codeStateError) return json({ error: 'לא ניתן לבדוק כרגע את מגבלת ניסיונות הקוד.' }, 503, headers);
    const codeLimit = Array.isArray(codeState) ? codeState[0] : codeState;
    if (!codeLimit?.allowed) return json({ error: 'הקוד נחסם זמנית אחרי ניסיונות שגויים. נסו שוב בעוד שעה.' }, 429, { ...headers, 'Retry-After': String(codeLimit?.retry_after_seconds ?? 3600) });
    const validFamilyCode = configuredApprovalCode && await sameSecret(submittedApprovalCode, configuredApprovalCode);
    if (!validFamilyCode) {
      const { data: failureData, error: failureError } = await admin.rpc('record_family_code_failure', { p_ip_hash: ipHash });
      if (failureError) return json({ error: 'לא ניתן לרשום ניסיון קוד שגוי. נסו שוב.' }, 503, headers);
      const failure = Array.isArray(failureData) ? failureData[0] : failureData;
      if (!failure?.allowed) return json({ error: 'הקוד נחסם זמנית אחרי 5 ניסיונות שגויים. נסו שוב בעוד שעה.' }, 429, { ...headers, 'Retry-After': String(failure?.retry_after_seconds ?? 3600) });
      return json({ error: hasPhoto ? 'כדי להעלות תמונה צריך להזין קוד משפחתי תקין.' : 'הקוד המשפחתי שגוי.' }, 403, headers);
    }
    const { error: clearCodeFailuresError } = await admin.rpc('clear_family_code_failures', { p_ip_hash: ipHash });
    if (clearCodeFailuresError) return json({ error: 'לא ניתן לאפס את מונה ניסיונות הקוד.' }, 503, headers);
    autoApprove = true;
  }

  if (photoEntries.some((value) => typeof value === 'string')) return json({ error: 'קובץ התמונה אינו תקין.' }, 400, headers);
  if (photoEntries.some((value) => value instanceof File && value.size === 0)) return json({ error: 'אחד מקובצי התמונה ריק.' }, 400, headers);
  if (thumbnailEntries.some((value) => typeof value === 'string') || (thumbnailFiles.length > 0 && thumbnailFiles.length !== photoFiles.length)) return json({ error: 'קובצי התמונות הממוזערות אינם תואמים לתמונות.' }, 400, headers);
  if (photoFiles.length > MAX_PHOTOS) return json({ error: `אפשר לצרף עד ${MAX_PHOTOS} תמונות לזיכרון.` }, 400, headers);

  const prepared: { bytes: Uint8Array; mime: string; extension: string; thumbnail: Uint8Array | null }[] = [];
  for (const [index, file] of photoFiles.entries()) {
    if (file.size > MAX_PHOTO_BYTES) return json({ error: 'תמונה גדולה מדי. המגבלה היא 8MB לכל תמונה.' }, 413, headers);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = detectImage(bytes);
    if (!image || file.type !== image.mime) return json({ error: 'אפשר להעלות תמונות JPG, PNG או WebP בלבד.' }, 415, headers);
    let thumbnail: Uint8Array | null = null;
    const thumbnailFile = thumbnailFiles[index];
    if (thumbnailFile) {
      if (thumbnailFile.size > 512_000) return json({ error: 'תמונה ממוזערת גדולה מהמותר.' }, 413, headers);
      const thumbnailBytes = new Uint8Array(await thumbnailFile.arrayBuffer());
      const thumbnailImage = detectImage(thumbnailBytes);
      if (!thumbnailImage || thumbnailFile.type !== thumbnailImage.mime) return json({ error: 'קובץ תמונה ממוזערת אינו תקין.' }, 415, headers);
      thumbnail = thumbnailBytes;
    }
    prepared.push({ bytes, mime: image.mime, extension: image.extension, thumbnail });
  }

  const uploadedPaths: string[] = [];
  const cleanupUploads = async () => { if (uploadedPaths.length) await admin.storage.from(BUCKET).remove(uploadedPaths); };
  const uploadedPhotos: { photo_path: string; thumbnail_path: string | null }[] = [];
  let storageNotice: { warning: boolean; percent: number } | undefined;
  for (const item of prepared) {
    const reservationId = crypto.randomUUID();
    const { data: reserveData, error: reserveError } = await admin.rpc('reserve_family_memory_photo', {
      p_id: reservationId,
      p_bytes: item.bytes.byteLength + (item.thumbnail?.byteLength ?? 0)
    });
    if (reserveError) {
      await cleanupUploads();
      return json({ error: 'לא ניתן לבדוק כרגע את מכסת התמונות. נסו שוב מאוחר יותר.' }, 503, headers);
    }
    const reservation = Array.isArray(reserveData) ? reserveData[0] : reserveData;
    const itemBytes = item.bytes.byteLength + (item.thumbnail?.byteLength ?? 0);
    const projectedBytes = Number(reservation?.used_bytes ?? 0) + Number(reservation?.reserved_bytes ?? 0) + itemBytes;
    storageNotice = {
      warning: projectedBytes >= PHOTO_STORAGE_LIMIT_BYTES,
      percent: Math.min(100, Math.floor(projectedBytes / PHOTO_STORAGE_LIMIT_BYTES * 100))
    };
    if (!reservation?.allowed) {
      await cleanupUploads();
      const used = Number(reservation?.used_bytes ?? 0) + Number(reservation?.reserved_bytes ?? 0);
      return json({
        error: 'אחסון התמונות הגיע לתקרה של 80%. אפשר לשלוח את הסיפור בלי תמונות.',
        storage: { warning: true, percent: Math.min(100, Math.floor(used / PHOTO_STORAGE_LIMIT_BYTES * 100)) }
      }, 507, headers);
    }
    const path = `${crypto.randomUUID()}.${item.extension}`;
    const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, item.bytes, {
      contentType: item.mime,
      cacheControl: '3600',
      upsert: false
    });
    if (uploadError) {
      await admin.rpc('release_family_memory_photo', { p_id: reservationId });
      await cleanupUploads();
      return json({ error: 'לא הצלחנו לשמור את התמונה.' }, 503, headers);
    }
    uploadedPaths.push(path);
    let thumbnailPath: string | null = null;
    if (item.thumbnail) {
      thumbnailPath = `${crypto.randomUUID()}.jpg`;
      const { error: thumbnailError } = await admin.storage.from(BUCKET).upload(thumbnailPath, item.thumbnail, {
        contentType: 'image/jpeg', cacheControl: '3600', upsert: false
      });
      if (thumbnailError) {
        await admin.rpc('release_family_memory_photo', { p_id: reservationId });
        await cleanupUploads();
        return json({ error: 'לא הצלחנו לשמור תמונה ממוזערת.' }, 503, headers);
      }
      uploadedPaths.push(thumbnailPath);
    }
    const { error: releaseError } = await admin.rpc('release_family_memory_photo', { p_id: reservationId });
    if (releaseError) {
      await cleanupUploads();
      return json({ error: 'לא הצלחנו לשחרר את שמירת מכסת האחסון.' }, 503, headers);
    }
    if (projectedBytes >= PHOTO_STORAGE_LIMIT_BYTES) storageNotice = {
      warning: true,
      percent: Math.min(100, Math.floor(projectedBytes / PHOTO_STORAGE_LIMIT_BYTES * 100))
    };
    uploadedPhotos.push({ photo_path: path, thumbnail_path: thumbnailPath });
  }

  const { data: inserted, error: insertError } = await admin.from('family_memories').insert({
    title: finalTitle,
    author: finalAuthor,
    story,
    category,
    photo_path: uploadedPhotos[0]?.photo_path ?? null,
    status: autoApprove ? 'approved' : 'pending'
  }).select('id').single();
  if (insertError || !inserted) {
    await cleanupUploads();
    return json({ error: 'לא הצלחנו לשמור את הזיכרון.' }, 503, headers);
  }
  if (uploadedPhotos.length) {
    const { error: photosError } = await admin.from('family_memory_photos').insert(
      uploadedPhotos.map((photo, position) => ({ memory_id: inserted.id, ...photo, position }))
    );
    if (photosError) {
      await admin.from('family_memories').delete().eq('id', inserted.id);
      await cleanupUploads();
      return json({ error: 'לא הצלחנו לשמור את התמונות.' }, 503, headers);
    }
  }
  return json({ ok: true, pending: !autoApprove, storage: storageNotice }, autoApprove ? 201 : 202, headers);
}

async function deleteMemory(request: Request, headers: HeadersInit): Promise<Response> {
  if (!admin) return json({ error: 'השירות לא הוגדר.' }, 503, headers);
  const configuredCode = Deno.env.get('FAMILY_DELETE_CODE') ?? '';
  if (!configuredCode) return json({ error: 'מחיקת מנהל עדיין לא הוגדרה. יש להגדיר FAMILY_DELETE_CODE ב־Supabase.' }, 503, headers);
  const managerCheck = await managerAuth(request, headers, true);
  if (managerCheck.error) return managerCheck.error;
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 1000) return json({ error: 'הבקשה גדולה מדי.' }, 413, headers);
  let input: unknown;
  try { input = await request.json(); } catch { return json({ error: 'פרטי המחיקה אינם תקינים.' }, 400, headers); }
  const id = input && typeof input === 'object' && 'id' in input ? (input as { id?: unknown }).id : null;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return json({ error: 'מזהה הזיכרון אינו תקין.' }, 400, headers);
  }

  const { data: memory, error: lookupError } = await admin.from('family_memories').select('photo_path').eq('id', id).maybeSingle();
  if (lookupError) return json({ error: 'לא הצלחנו למצוא את הזיכרון למחיקה.' }, 503, headers);
  if (!memory) return json({ error: 'הזיכרון כבר נמחק או שאינו קיים.' }, 404, headers);
  const { data: photoRows } = await admin.from('family_memory_photos').select('photo_path,thumbnail_path').eq('memory_id', id);
  const photoPaths = [...new Set([memory.photo_path, ...(photoRows ?? []).flatMap((item) => [item.photo_path, item.thumbnail_path])].filter((path): path is string => typeof path === 'string' && path.length <= 300))];
  const { data: deleted, error: deleteError } = await admin.from('family_memories').delete().eq('id', id).select('id').maybeSingle();
  if (deleteError || !deleted) return json({ error: 'לא הצלחנו למחוק את הזיכרון.' }, 503, headers);

  if (photoPaths.length) {
    const { error: storageError } = await admin.storage.from(BUCKET).remove(photoPaths);
    if (storageError) return json({ ok: true, warning: 'הזיכרון נמחק, אך לא הצלחנו להסיר את קובץ התמונה מהאחסון.' }, 200, headers);
  }
  return json({ ok: true }, 200, headers);
}

async function moderateMemory(request: Request, headers: HeadersInit): Promise<Response> {
  if (!admin) return json({ error: 'השירות לא הוגדר.' }, 503, headers);
  const managerCheck = await managerAuth(request, headers, true);
  if (managerCheck.error) return managerCheck.error;
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 1000) return json({ error: 'הבקשה גדולה מדי.' }, 413, headers);
  let input: unknown;
  try { input = await request.json(); } catch { return json({ error: 'פרטי האישור אינם תקינים.' }, 400, headers); }
  const value = input && typeof input === 'object' ? input as { id?: unknown; status?: unknown; action?: unknown; photoId?: unknown } : {};
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof value.id !== 'string' || !uuidPattern.test(value.id)) return json({ error: 'מזהה הזיכרון אינו תקין.' }, 400, headers);
  if (value.action === 'approve' || value.action === 'reject') {
    const status = value.action === 'approve' ? 'approved' : 'rejected';
    const { data, error } = await admin.from('family_memories').update({ status }).eq('id', value.id).eq('status', 'pending').select('id,status').maybeSingle();
    if (error) return json({ error: 'לא הצלחנו לעדכן את מצב הזיכרון.' }, 503, headers);
    if (!data) return json({ error: 'הזיכרון אינו ממתין לאישור או שכבר טופל.' }, 404, headers);
    return json({ ok: true, status: data.status }, 200, headers);
  }
  if ((value.action !== 'delete_photo' && value.action !== 'set_cover') || typeof value.photoId !== 'string' || !uuidPattern.test(value.photoId)) {
    return json({ error: 'פעולת התמונה אינה תקינה.' }, 400, headers);
  }
  const { data: selected, error: selectedError } = await admin.from('family_memory_photos').select('id,photo_path,thumbnail_path').eq('id', value.photoId).eq('memory_id', value.id).maybeSingle();
  if (selectedError) return json({ error: 'לא הצלחנו לטעון את פרטי התמונה.' }, 503, headers);
  if (!selected) return json({ error: 'התמונה כבר נמחקה או אינה שייכת לזיכרון הזה.' }, 404, headers);
  const { data: memory, error: memoryError } = await admin.from('family_memories').select('photo_path').eq('id', value.id).maybeSingle();
  if (memoryError || !memory) return json({ error: 'לא הצלחנו לטעון את הזיכרון.' }, 503, headers);
  if (value.action === 'set_cover') {
    const { error } = await admin.from('family_memories').update({ photo_path: selected.photo_path }).eq('id', value.id);
    if (error) return json({ error: 'לא הצלחנו להחליף את תמונת השער.' }, 503, headers);
    return json({ ok: true }, 200, headers);
  }
  const { data: remaining, error: remainingError } = await admin.from('family_memory_photos').select('photo_path').eq('memory_id', value.id).neq('id', value.photoId).order('position', { ascending: true });
  if (remainingError) return json({ error: 'לא הצלחנו לטעון את התמונות הנותרות.' }, 503, headers);
  if (memory.photo_path === selected.photo_path) {
    const { error } = await admin.from('family_memories').update({ photo_path: remaining?.[0]?.photo_path ?? null }).eq('id', value.id);
    if (error) return json({ error: 'לא הצלחנו לעדכן את תמונת השער.' }, 503, headers);
  }
  const { data: removed, error: removeError } = await admin.from('family_memory_photos').delete().eq('id', value.photoId).eq('memory_id', value.id).select('id').maybeSingle();
  if (removeError || !removed) return json({ error: 'לא הצלחנו להסיר את התמונה.' }, 503, headers);
  const paths = [selected.photo_path, selected.thumbnail_path].filter((path): path is string => typeof path === 'string' && path.length <= 300);
  if (paths.length) {
    const { error } = await admin.storage.from(BUCKET).remove(paths);
    if (error) return json({ ok: true, warning: 'התמונה הוסרה מהזיכרון, אך קובץ כלשהו נשאר באחסון.' }, 200, headers);
  }
  return json({ ok: true }, 200, headers);
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('origin') ?? '';
  const origins = allowedOrigins();
  if (!origin || !origins.includes(origin)) return json({ error: 'המקור אינו מורשה.' }, 403);
  const headers = corsHeaders(origin);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method === 'GET') return await listApproved(request, headers);
  if (request.method === 'DELETE') return await deleteMemory(request, headers);
  if (request.method === 'PATCH') return await moderateMemory(request, headers);
  if (request.method === 'POST' && request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return await saveBiography(request, headers);
  if (request.method === 'POST') return await submitMemory(request, origin, headers);
  return json({ error: 'שיטת הבקשה אינה נתמכת.' }, 405, { ...headers, Allow: 'GET, POST, PATCH, DELETE, OPTIONS' });
});
