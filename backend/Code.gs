/**
 * carbonMICE Lucky Draw v2 — Backend (Google Apps Script Web App)
 * ─────────────────────────────────────────────────────────────
 * ฐานข้อมูลจับรางวัลออนไลน์ · รองรับหลาย event พร้อมกัน · หลายวันต่อ 1 event
 *
 *  โครงสร้าง (แยกคนละไฟล์กับ backend เกมบูท — ห้ามปน)
 *  ┌ Sheet "events"  : 1 แถว/event  [eventId, name, prizesJSON, daysJSON, updatedAt]
 *  │                    daysJSON = [{id,label,date,people:[{name,org}]}]
 *  ├ Sheet "winners" : 1 แถว/ผู้ได้รางวัล [eventId, dayId, dayLabel, rank, name, org, prize, ts]
 *  │                    (sync แบบ replace-per-day จากหน้าบ้าน — local-first)
 *  └ Drive file      : โลโก้ event เก็บแยกเป็นไฟล์ต่อ eventId (dataURL)
 *
 *  หน้าบ้านลูกค้า (index.html?event=<id>) : เรียกได้เฉพาะ getEvent (อ่าน config) + syncWinners (เขียนผู้ได้รางวัล)
 *  หน้า admin (admin.html, PIN 2468)     : ต้องแนบ ADMIN_KEY ทุก action ที่แก้/อ่านผล
 *
 *  Deploy: Web App · execute as Me · access: Anyone · เอา /exec URL ไปใส่ config.js
 *  ⚠️ เปลี่ยน ADMIN_KEY ก่อน deploy!
 */
const ADMIN_KEY   = 'cmLD-pea-2026-k7x9q3';
const EVENTS_SHEET  = 'events';
const WINNERS_SHEET = 'winners';
const LOGO_PREFIX   = 'cmld_logo_';   // + eventId + '.txt'

/* ═════════════ entry points ═════════════ */

function doGet(e) {
  const action = (e.parameter.action || '').trim();
  try {
    if (action === 'ping') return json({ ok: true, service: 'luckydraw' });
    // หน้าบ้านลูกค้าอ่าน config ของ event (public — ต้องมีลิงก์ที่มี event id ถึงจะรู้ id)
    if (action === 'getEvent') return json(getEvent(e.parameter.id || ''));
    return json({ error: 'unknown action' });
  } catch (err) {
    return json({ error: String(err) });
  }
}

function doPost(e) {
  // ทุกฝั่งส่งเป็น text/plain (เลี่ยง CORS preflight) → parse เอง
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  const action = body.action || '';
  try {
    // ── public (หน้าบ้านลูกค้า) ──
    if (action === 'getEvent')    return json(getEvent(body.id || ''));
    if (action === 'syncWinners') return json(syncWinners(body));

    // ── admin เท่านั้น (ต้องมี ADMIN_KEY) ──
    if (['listEvents','saveEvent','deleteEvent','getWinners'].indexOf(action) >= 0) {
      if (String(body.key || '') !== ADMIN_KEY) return json({ error: 'unauthorized' });
      if (action === 'listEvents')  return json(listEvents());
      if (action === 'saveEvent')   return json(saveEvent(body));
      if (action === 'deleteEvent') return json(deleteEvent(body));
      if (action === 'getWinners')  return json(getWinners(body.id || ''));
    }
    return json({ error: 'unknown action' });
  } catch (err) {
    return json({ error: String(err) });
  }
}

/* ═════════════ actions ═════════════ */

// อ่าน config ของ event (ชื่อ/โลโก้/รางวัล/วัน+รายชื่อ) — สำหรับหน้าบ้านลูกค้า
function getEvent(id) {
  id = String(id || '').trim();
  if (!id) return { error: 'no event id' };
  const row = findEventRow(id);
  if (!row) return { error: 'event not found' };
  return {
    ok: true,
    event: {
      id: id,
      name: row.name,
      prizes: safeParse(row.prizesJSON, []),
      days: safeParse(row.daysJSON, []),
      logo: readLogo(id)   // dataURL หรือ '' ถ้าไม่มี
    }
  };
}

// รายการ event ทั้งหมด (admin)
function listEvents() {
  const sh = eventsSheet();
  if (sh.getLastRow() < 2) return { ok: true, events: [] };
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  const events = rows.filter(r => r[0]).map(r => {
    const days = safeParse(r[3], []);
    const people = days.reduce((s, d) => s + ((d.people || []).length), 0);
    return {
      id: String(r[0]), name: String(r[1] || ''),
      days: days.length, people: people,
      prizes: safeParse(r[2], []).length,
      updatedAt: r[4] ? String(r[4]) : ''
    };
  }).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return { ok: true, events: events };
}

// สร้าง/แก้ event (admin). ไม่มี id = สร้างใหม่, มี id = อัปเดต
function saveEvent(body) {
  const ev = body.event || {};
  const name = String(ev.name || '').slice(0, 120).trim();
  if (!name) return { error: 'no event name' };
  const prizes = Array.isArray(ev.prizes) ? ev.prizes.map(p => String(p).slice(0, 120)).filter(String) : [];
  const days = normalizeDays(ev.days);
  if (!days.length) return { error: 'need at least 1 day' };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let id = String(ev.id || '').trim();
  try {
    const sh = eventsSheet();
    const prizesJSON = JSON.stringify(prizes);
    const daysJSON = JSON.stringify(days);
    if (daysJSON.length > 48000) return { error: 'ข้อมูลรายชื่อ/วัน ยาวเกิน (ลดจำนวนต่อ event หรือแยกงาน)' };
    const now = new Date().toISOString();

    if (id) {
      const r = findEventRowIndex(id);
      if (r < 0) return { error: 'event not found' };
      sh.getRange(r, 1, 1, 5).setValues([[id, name, prizesJSON, daysJSON, now]]);
    } else {
      id = 'ev' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      sh.appendRow([id, name, prizesJSON, daysJSON, now]);
    }
  } finally {
    lock.releaseLock();
  }
  // โลโก้ (dataURL) เก็บแยกเป็นไฟล์ต่อ eventId
  if (ev.logo !== undefined) saveLogo(id, String(ev.logo || ''));
  return { ok: true, id: id };
}

function deleteEvent(body) {
  const id = String(body.id || '').trim();
  if (!id) return { error: 'no id' };
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const r = findEventRowIndex(id);
    if (r > 0) eventsSheet().deleteRow(r);
    deleteWinnersFor(id);
    const files = DriveApp.getFilesByName(LOGO_PREFIX + id + '.txt');
    while (files.hasNext()) files.next().setTrashed(true);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

// หน้าบ้านลูกค้า sync ผู้ได้รางวัล "ของวันนั้นทั้งชุด" (replace-per-day) — local-first
function syncWinners(body) {
  const id = String(body.id || '').trim();
  const dayId = String(body.dayId || '').trim();
  if (!id || !dayId) return { error: 'missing id/day' };
  if (!findEventRow(id)) return { error: 'event not found' };
  const list = Array.isArray(body.winners) ? body.winners : [];

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = winnersSheet();
    // ลบของเดิมของ event+day นี้ (จากล่างขึ้นบน) แล้วเขียนชุดใหม่
    const last = sh.getLastRow();
    if (last > 1) {
      const key = sh.getRange(2, 1, last - 1, 2).getValues(); // [eventId, dayId]
      for (let i = key.length - 1; i >= 0; i--) {
        if (String(key[i][0]) === id && String(key[i][1]) === dayId) sh.deleteRow(i + 2);
      }
    }
    const dayLabel = String(body.dayLabel || '');
    const rows = list.map((w, i) => [
      id, dayId, dayLabel, i + 1,
      String(w.name || '').slice(0, 80),
      String(w.org || '').slice(0, 100),
      String(w.prize || '').slice(0, 120),
      String(w.ts || new Date().toISOString())
    ]);
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 8).setValues(rows);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, count: list.length };
}

// อ่านผู้ได้รางวัลทุกวันของ event (admin) — ไว้แสดง + export CSV
function getWinners(id) {
  id = String(id || '').trim();
  if (!id) return { error: 'no id' };
  const sh = winnersSheet();
  if (sh.getLastRow() < 2) return { ok: true, winners: [] };
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues();
  const winners = rows.filter(r => String(r[0]) === id).map(r => ({
    dayId: String(r[1]), dayLabel: String(r[2]), rank: Number(r[3]) || 0,
    name: String(r[4]), org: String(r[5]), prize: String(r[6]), ts: String(r[7])
  }));
  return { ok: true, winners: winners };
}

/* ═════════════ logo (Drive) ═════════════ */

function saveLogo(id, dataUrl) {
  const nm = LOGO_PREFIX + id + '.txt';
  if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) {
    // ล้างโลโก้
    const f0 = DriveApp.getFilesByName(nm);
    while (f0.hasNext()) f0.next().setTrashed(true);
    return;
  }
  if (dataUrl.length > 3 * 1024 * 1024) return; // กันไฟล์ใหญ่เกิน
  const files = DriveApp.getFilesByName(nm);
  if (files.hasNext()) files.next().setContent(dataUrl);
  else DriveApp.createFile(nm, dataUrl, MimeType.PLAIN_TEXT);
}
function readLogo(id) {
  const files = DriveApp.getFilesByName(LOGO_PREFIX + id + '.txt');
  return files.hasNext() ? files.next().getBlob().getDataAsString() : '';
}

/* ═════════════ helpers ═════════════ */

function normalizeDays(days) {
  if (!Array.isArray(days)) return [];
  return days.map((d, i) => {
    const people = Array.isArray(d.people) ? d.people
      .map(p => ({ name: String(p.name || '').slice(0, 80).trim(), org: String(p.org || '').slice(0, 100).trim() }))
      .filter(p => p.name) : [];
    return {
      id: String(d.id || ('d' + (i + 1))),
      label: String(d.label || ('วันที่ ' + (i + 1))).slice(0, 60),
      date: String(d.date || '').slice(0, 40),
      people: people
    };
  }).filter(d => d.people.length); // ต้องมีอย่างน้อย 1 คน
}

function eventsSheet() {
  const ss = ss_();
  let sh = ss.getSheetByName(EVENTS_SHEET);
  if (!sh) { sh = ss.insertSheet(EVENTS_SHEET); sh.appendRow(['eventId', 'name', 'prizesJSON', 'daysJSON', 'updatedAt']); }
  return sh;
}
function winnersSheet() {
  const ss = ss_();
  let sh = ss.getSheetByName(WINNERS_SHEET);
  if (!sh) { sh = ss.insertSheet(WINNERS_SHEET); sh.appendRow(['eventId', 'dayId', 'dayLabel', 'rank', 'name', 'org', 'prize', 'ts']); }
  return sh;
}
function ss_() {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    const id = getProp('SPREADSHEET_ID');
    if (id) ss = SpreadsheetApp.openById(id);
    else { ss = SpreadsheetApp.create('carbonMICE Lucky Draw DB'); setProp('SPREADSHEET_ID', ss.getId()); }
  }
  return ss;
}

function findEventRowIndex(id) {
  const sh = eventsSheet();
  if (sh.getLastRow() < 2) return -1;
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return -1;
}
function findEventRow(id) {
  const r = findEventRowIndex(id);
  if (r < 0) return null;
  const v = eventsSheet().getRange(r, 1, 1, 5).getValues()[0];
  return { id: String(v[0]), name: String(v[1] || ''), prizesJSON: v[2], daysJSON: v[3], updatedAt: v[4] };
}
function deleteWinnersFor(id) {
  const sh = winnersSheet();
  const last = sh.getLastRow();
  if (last < 2) return;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === id) sh.deleteRow(i + 2);
}

function safeParse(s, dflt) { try { const v = JSON.parse(s); return v == null ? dflt : v; } catch (e) { return dflt; } }
function getProp(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function setProp(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
