'use strict';

const fs_mod            = require('fs').promises;
const path              = require('path');
const { google }        = require('googleapis');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode            = require('qrcode-terminal');
const QRCode            = require('qrcode');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH       = path.join(__dirname, 'token.json');
const QR_IMAGE_PATH    = path.join(__dirname, 'qr.png');

const IGNORED_CLASSES  = [];
const DONE_STATES      = new Set(['TURNED_IN', 'RETURNED']);
const STALE_DAYS       = 7;

async function authorize() {
  let creds;
  if (process.env.GOOGLE_CREDENTIALS) {
    creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } else {
    creds = JSON.parse(await fs_mod.readFile(CREDENTIALS_PATH, 'utf8'));
  }
  const { client_secret, client_id, redirect_uris } = creds.installed ?? creds.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  let tok;
  if (process.env.GOOGLE_TOKEN) {
    tok = JSON.parse(process.env.GOOGLE_TOKEN);
  } else {
    tok = JSON.parse(await fs_mod.readFile(TOKEN_PATH, 'utf8'));
  }
  oAuth2Client.setCredentials(tok);
  return oAuth2Client;
}

function buildDueDeadline(dueDate) {
  return new Date(dueDate.year, dueDate.month - 1, dueDate.day, 23, 59, 59, 999);
}

function parseDueDateTime(dueDate, dueTime) {
  if (!dueDate) return null;
  const h = dueTime ? dueTime.hours   : 23;
  const m = dueTime ? dueTime.minutes : 59;
  return new Date(Date.UTC(dueDate.year, dueDate.month - 1, dueDate.day, h, m, 0));
}

function getMinutesUntilDue(dueDate, dueTime) {
  const dt = parseDueDateTime(dueDate, dueTime);
  if (!dt) return null;
  return Math.floor((dt.getTime() - Date.now()) / 60000);
}

function formatDueDate(dueDate, dueTime) {
  if (!dueDate) return 'No Due Date';
  const day = String(dueDate.day).padStart(2, '0');
  const mon = String(dueDate.month).padStart(2, '0');
  if (!dueTime) return `${day}/${mon}/${dueDate.year} 23:59 UTC`;
  const hh = String(dueTime.hours   || 0).padStart(2, '0');
  const mm = String(dueTime.minutes || 0).padStart(2, '0');
  return `${day}/${mon}/${dueDate.year} ${hh}:${mm} UTC`;
}

function formatAssignmentMsg(work) {
  return (
    `?? *Course:* ${work.courseName}\n` +
    `?? *Assignment:* ${work.assignmentTitle}\n` +
    `?? *Due:* ${formatDueDate(work.dueDate, work.dueTime)}\n` +
    `?? *Link:* ${work.url}`
  );
}

async function getPendingAssignments(classroom) {
  const ignoredSet = new Set(IGNORED_CLASSES.map(n => n.trim().toLowerCase()));
  const now = new Date();
  const coursesRes = await classroom.courses.list({ courseStates: ['ACTIVE'] });
  const courses    = coursesRes.data.courses ?? [];
  console.log(`[COURSES] ${courses.length} active course(s).`);
  const results = [];

  for (const course of courses) {
    const courseName = (course.name || '').trim() || '(unnamed)';
    if (ignoredSet.has(courseName.toLowerCase())) {
      console.log(`[SKIP-IGNORED] ${courseName}`);
      continue;
    }
    console.log(`[COURSE] ${courseName}`);

    let works;
    try {
      const wRes = await classroom.courses.courseWork.list({ courseId: course.id });
      works = wRes.data.courseWork ?? [];
    } catch (err) {
      console.warn(`[WARN] courseWork list for "${courseName}": ${err.message}`);
      continue;
    }

    for (const work of works) {
      const title = (work.title || '').trim() || '(no title)';

      if (work.dueDate) {
        const deadline = buildDueDeadline(work.dueDate);
        if (deadline < now) { console.log(`  [SKIP-OVERDUE] ${title}`); continue; }
      } else if (work.creationTime) {
        const created = new Date(work.creationTime);
        const cutoff  = new Date(Date.now() - STALE_DAYS * 86400000);
        if (created < cutoff) { console.log(`  [SKIP-STALE] ${title}`); continue; }
      }

      let subState;
      try {
        const subRes = await classroom.courses.courseWork.studentSubmissions.list({
          courseId: course.id, courseWorkId: work.id, userId: 'me',
        });
        const subs = subRes.data.studentSubmissions ?? [];
        subState = subs.length > 0 ? subs[0].state : 'CREATED';
      } catch (err) {
        console.warn(`  [WARN] submission for ${work.id}: ${err.message}`);
        continue;
      }

      if (DONE_STATES.has(subState)) {
        console.log(`  [SKIP-DONE] ${title} (${subState})`);
        continue;
      }

      let dueLabel = 'No due date';
      if (work.dueDate) {
        const d = buildDueDeadline(work.dueDate);
        dueLabel = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      }

      console.log(`  [INCLUDE] ${title} | due: ${dueLabel}`);
      results.push({
        courseName:      courseName,
        assignmentTitle: title,
        dueDate:  work.dueDate  ?? null,
        dueTime:  work.dueTime  ?? null,
        url:      work.alternateLink ?? `https://classroom.google.com/c/${course.id}`,
        due:      dueLabel,
      });
    }
  }
  console.log(`[RESULT] ${results.length} pending assignment(s).`);
  return results;
}

// -- WhatsApp client ------------------------------------------------------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

let seenAssignmentIds    = new Set();
let alarmedAssignmentIds = new Set();
let myWhatsAppNumber     = null;
let classroomClient      = null;

client.on('qr', async qr => {
  console.log('\n==================================================');
  console.log('  QR CODE READY � Two ways to scan:');
  console.log('==================================================');
  console.log('\n[Option 1] Open this image file and scan it:');
  console.log(`  ${QR_IMAGE_PATH}`);
  console.log('\n[Option 2] Terminal QR (run directly, not via pm2):');
  qrcode.generate(qr, { small: true });

  // Save QR as PNG image so it always fully visible
  try {
    await QRCode.toFile(QR_IMAGE_PATH, qr, { width: 400, margin: 2 });
    console.log(`\n? QR saved as image: ${QR_IMAGE_PATH}`);
    console.log('   ? Open it with: explorer.exe qr.png');
  } catch (err) {
    console.error('Could not save QR image:', err.message);
  }
  console.log('\n==================================================\n');
});

client.on('auth_failure', msg => {
  console.error('[WhatsApp] Auth failure:', msg);
});

client.on('ready', async () => {
  console.log('\n? WhatsApp connected!');

  // Delete QR image now that we're authenticated
  try {
    await fs_mod.unlink(QR_IMAGE_PATH);
  } catch (_) {}

  try {
    const auth      = await authorize();
    classroomClient = google.classroom({ version: 'v1', auth });
    myWhatsAppNumber = client.info.wid._serialized;
    console.log('? Google Classroom authenticated.');
    console.log(`?? Bot number: ${myWhatsAppNumber}`);
  } catch (error) {
    console.error('? Google auth failed:', error.message);
    return;
  }
  await checkAndNotifyAssignments();
  setInterval(checkAndNotifyAssignments, 10 * 60 * 1000);
  console.log('?? Polling for assignments every 10 minutes...');
});

async function checkAndNotifyAssignments() {
  if (!classroomClient || !myWhatsAppNumber) return;
  try {
    const pendingWork = await getPendingAssignments(classroomClient);
    if (!pendingWork || pendingWork.length === 0) return;

    for (const work of pendingWork) {
      const assignmentId = `${work.courseName}::${work.assignmentTitle}`;

      if (!seenAssignmentIds.has(assignmentId)) {
        seenAssignmentIds.add(assignmentId);
        const msg = `?? *NEW ASSIGNMENT POSTED*\n\n${formatAssignmentMsg(work)}`;
        await client.sendMessage(myWhatsAppNumber, msg);
        console.log(`? New assignment notified: ${work.assignmentTitle}`);
      }

      const minutesUntilDue = getMinutesUntilDue(work.dueDate, work.dueTime);
      if (minutesUntilDue !== null && minutesUntilDue <= 60 && minutesUntilDue > 0) {
        if (!alarmedAssignmentIds.has(assignmentId)) {
          alarmedAssignmentIds.add(assignmentId);
          const urgentMsg = `?? *URGENT: "${work.assignmentTitle}" DUE IN ${minutesUntilDue} MINUTES!*\n\n${formatAssignmentMsg(work)}`;
          await client.sendMessage(myWhatsAppNumber, urgentMsg);
          console.log(`??  Urgent alarm sent: ${work.assignmentTitle}`);
        }
      }
    }
  } catch (error) {
    console.error('? Error during assignment check:', error);
  }
}

client.on('message_create', async msg => {
  if (!msg.fromMe) return;
  const body = msg.body.trim().toLowerCase();

  if (body === '!myclass') {
    console.log('[Bot] !myclass command received');
    try {
      await msg.reply('Fetching your pending assignments...');
      const pendingWork = await getPendingAssignments(classroomClient);

      if (!pendingWork || pendingWork.length === 0) {
        await msg.reply('You are all caught up! No pending assignments.');
        return;
      }

      let message = '?? *PENDING ASSIGNMENTS:*\n\n';
      pendingWork.forEach((work, index) => {
        message += `${index + 1}. ${formatAssignmentMsg(work)}\n\n`;
      });
      await msg.reply(message);
      console.log('Assignment list sent via !myclass command');
    } catch (error) {
      console.error('Error handling !myclass command:', error);
      await msg.reply('Error fetching assignments. Please try again later.');
    }
  }
});

console.log('Initializing WhatsApp Bot... Please wait.');
client.initialize();
