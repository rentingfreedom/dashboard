
function fmtDate(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso)); }
  catch (e) { return iso; }
}
function fmtTime(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)); }
  catch (e) { return iso; }
}
function classify(eventTypeId) {
  const id = Number(eventTypeId);
  if (id === 6483829) return 'walkthrough';
  if (id === 6483828) return 'consult';
  return 'showing';
}
function propertyAddressFromTitle(title) {
  return String(title ?? '').replace(/\s+Walk-Through$/i, '').trim();
}
function genToken() {
  const rand = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return rand + Date.now().toString(36);
}
function isTestBooking(personId, attendeeEmail) {
  return String(personId ?? '') === '2545' || String(attendeeEmail ?? '').toLowerCase() === 'merritt.andrewt@gmail.com';
}

const b = $('Classify & Build Row').first().json;
const settings = {};
$('Read Settings (Immediate)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });

const enabled = String(settings.cal_reminders_enabled ?? 'true').trim().toLowerCase() === 'true';
const catEnabled = String(settings['cal_' + b.category + '_enabled'] ?? 'true').trim().toLowerCase() === 'true';
const appliesToCategory = b.category === 'walkthrough' || b.category === 'showing';
const testGateOpen = true; // TEST GATE LIFTED (was: b.isTest)
const shouldSend = enabled && catEnabled && appliesToCategory && testGateOpen;

const dateStr = fmtDate(b.startTime);
const timeStr = fmtTime(b.startTime);
const nicoleEmail = settings.cal_nicole_email ?? '';

let subject, message;
if (b.category === 'walkthrough') {
  subject = `New ${b.eventTypeTitle} has been scheduled`;
  message = `Hello Nicole, ${b.attendeeName} has scheduled an event. Details are below.<br>`
    + `${dateStr} ${timeStr}<br>`
    + (b.notes ? `${b.notes}<br>` : '')
    + `${b.attendeeEmail} ${b.attendeePhone}<br>`
    + (b.location ? `${b.location}<br>` : '')
    + (b.description ? `${b.description}` : '');
} else {
  subject = 'New Self Guided Rental Showing has been Scheduled';
  message = `Hello Nicole, ${b.attendeeName} has scheduled a self guided tour. Details are below.<br>`
    + `${dateStr} ${timeStr}<br>`
    + `${b.attendeeEmail} ${b.attendeePhone}`;
}

return [{ json: { ...b, shouldSend, to: nicoleEmail, subject, message } }];
