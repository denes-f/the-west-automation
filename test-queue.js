(async () => {
// Runs the real processQueue against a simulated TaskQueue.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'the-west-automation.js'), 'utf8');
function extract(name) {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) { const a = src.indexOf(`async function ${name}(`); if (a === -1) throw new Error(name); return extractAt(a); }
    return extractAt(start);
}
function extractAt(start) {
    let i = src.indexOf('{', start), depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
}

const CONFIG = { FALLBACK_QUEUE_LIMIT: 4, DEFAULT_DURATION: 900, SAFETY_MARGIN_MS: 3000,
    FULL_QUEUE_POLL_MIN: 15000, FULL_QUEUE_POLL_MAX: 25000, MIN_SEND_GAP: 2000,
    MAX_WAIT_MS: 3600000, IDLE_RESCHEDULE: 5000, MAX_RETRIES: 5, MAX_DEFERRALS: 2, MAX_AMOUNT: 99, MAX_EXTRA_QUEUE: 500 };

// --- A faithful copy of the game's TaskQueue: synchronous push, silent refusal at the limit ---
function makeGame(limit, initial = 0) {
    const q = [];
    for (let i = 0; i < initial; i++) q.push({ data: { date_done: Date.now() + 60000 * (i + 1) } });
    return {
        queue: q,
        limit: { normal: limit, premium: 9 },
        addCalls: 0,
        add(tasks) {
            this.addCalls++;
            const list = Array.isArray(tasks) ? tasks : [tasks];
            for (const t of list) {
                if (this.queue.length >= limit) break;   // silent refusal, like the real one
                this.queue.push({ data: { date_done: Date.now() + 60000 * (this.queue.length + 1) }, post: t });
            }
        },
    };
}
global.window = {};
global.TaskJob = function(jobId, x, y, duration) { Object.assign(this, { jobId, x, y, duration }); };
window.TaskJob = global.TaskJob;
global.Premium = { hasBonus: () => false };
window.Premium = global.Premium;

let extraJobs = [], paused = false, processing = false, nextJobTimer = null, isLeaderTab = true;
// Sleep/energy: by default there is no sleep and every job is affordable; the
// scenarios override these where it matters.
let isSleeping = () => false;
let jobEnergyCost = () => null;
let maybeOfferSleep = () => {};
let scheduled = null;
const rand = (a) => a;
const saveExtraQueueToStorage = () => {};
const updateUI = () => {};
const updateExtraList = () => {};
const updateUIStatus = () => {};
const updateQueueBadge = () => {};
const updateExtraEtas = () => {};
const refreshForecast = () => [];          // forecast: needs live game state
const updateEnergyForecastBar = () => {};  // the character box's bar likewise
const offerSleepIfForecastRunsOut = () => {};
const renderPendingInGameQueue = () => {};
const observePendingHost = () => {};
const ensureMenuButton = () => {};
const scheduleNextJob = (ms) => { scheduled = ms; nextJobTimer = 1; };
const generateId = (() => { let n = 0; return () => 'id' + (++n); })();
const quiet = () => {};
const real = console.log;
console.log = quiet; console.warn = quiet; console.error = quiet;

eval([
    'gameReady', 'gameQueueLength', 'gameQueueLimit', 'freeSlots', 'nextFreeAtMs',
    'waitUntilFreeSlotMs', 'startJobsViaGame', 'addExtraJobs', 'formatDuration', 'ensureProcessing',
].map(extract).join('\n'));
eval(extract('processQueue'));
console.log = real;

const mkJobs = n => Array.from({ length: n }, (_, i) => ({
    id: 'j' + i, jobId: 100 + i, x: 1, y: 2, duration: 600, taskType: 'job',
    jobName: 'Job ' + (i + 1), retries: 0, deferrals: 0 }));

let pass = 0, fail = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w);
    ok ? pass++ : fail++; console.log(`${ok?'ok  ':'FAIL'} ${l.padEnd(52)} ${ok?'':`got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`); };

// --- The reported failure case: 7 jobs, empty queue, limit 4 ---
async function scenario(limit, initial, jobCount, rounds) {
    window.TaskQueue = makeGame(limit, initial);
    extraJobs = mkJobs(jobCount); processing = false; nextJobTimer = null; scheduled = null;
    for (let r = 0; r < rounds; r++) { processing = false; await processQueue(); }
    return { left: extraJobs.length, inGame: window.TaskQueue.queue.length, addCalls: window.TaskQueue.addCalls };
}

console.log('=== The reported case: 7 jobs started on an empty queue (limit 4) ===');
let r = await scenario(4, 0, 7, 1);
eq('1 round: 4 into the game, 3 stay on the list', [r.inGame, r.left], [4, 3]);
eq('a single request goes out for the batch', r.addCalls, 1);

r = await scenario(4, 0, 7, 5);
eq('retrying against a full queue loses NOTHING', [r.inGame, r.left], [4, 3]);

console.log('\n=== Vanishing is structurally impossible ===');
r = await scenario(0, 0, 3, 6);                      // the game never accepts
eq('limit 0: all 3 stay', [r.inGame, r.left], [0, 3]);
window.TaskQueue = { queue: [], limit: { normal: 4 }, add() { throw new Error('boom'); } };
extraJobs = mkJobs(3); processing = false;
await processQueue();
eq('TaskQueue.add throws: the list is untouched', extraJobs.length, 3);
window.TaskQueue = undefined;
extraJobs = mkJobs(3); processing = false;
await processQueue();
eq('no TaskQueue: the list is untouched', extraJobs.length, 3);

console.log('\n=== Partly full queue ===');
r = await scenario(4, 2, 5, 1);
eq('2 taken + 5 asked -> 2 start, 3 stay', [r.inGame, r.left], [4, 3]);
r = await scenario(4, 4, 5, 1);
eq('full queue -> 0 start, 5 stay', [r.inGame, r.left], [4, 5]);
eq('with a full queue we do not even send the request', window.TaskQueue.addCalls, 0);

console.log('\n=== Premium queue size ===');
window.Premium.hasBonus = () => true;
r = await scenario(9, 0, 12, 1);
eq('premium: 9 fit', [r.inGame, r.left], [9, 3]);
window.Premium.hasBonus = () => false;

console.log('\n=== Everything starts as slots free up ===');
window.TaskQueue = makeGame(4, 0);
extraJobs = mkJobs(10);
for (let r2 = 0; r2 < 3; r2++) { processing = false; await processQueue(); window.TaskQueue.queue.length = 0; }
eq('3 rounds, emptying meanwhile: 10 of 10 started', extraJobs.length, 0);



// ============================================================
//  Duration parsing (the game uses a compact form: "15mp")
// ============================================================
console.log('\n=== parseDurationText ===');
eval(extract('parseDurationText'));
for (const [txt, want] of [['15mp',15],['45mp',45],['10p',600],['30p',1800],['1ó',3600],
                           ['1ó30p',5400],['1 ó 30 p',5400],['15 mp',15],['1óra',3600],
                           ['',null],['???',null]])
    eq(`parseDurationText(${JSON.stringify(txt)})`, parseDurationText(txt), want);

// ============================================================
//  Storage: versioning, migration, corrupt data
// ============================================================
console.log('\n=== Storage ===');
const store = {};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k,v) => { store[k]=v; }, removeItem: k => { delete store[k]; } };
CONFIG.STORAGE_VERSION = 2;
CONFIG.MAX_HISTORY = 60;
eval([extract('saveStore'), extract('loadStore'), extract('sanitizeJobs')].join('\n'));
const K = 'lisa_extra_queue', LEG = 'lisa_extra_params_v1020';

saveStore(K, [{ jobId: 1 }]);
eq('save/load round-trips', loadStore(K), [{ jobId: 1 }]);
eq('the wrapper carries the version', JSON.parse(store[K]).v, 2);
store[K] = JSON.stringify([{ jobId: 9 }]);
eq('an unversioned array is readable too', loadStore(K), [{ jobId: 9 }]);
delete store[K];
store[LEG] = JSON.stringify([{ jobId: 42, jobName: 'Old' }]);
eq('migration from the old key', loadStore(K, LEG), [{ jobId: 42, jobName: 'Old' }]);
store[K] = '{{{not json';
eq('corrupt JSON does not throw', loadStore(K), null);
eq('missing key -> null', loadStore('no_such_key'), null);
eq('junk filtered out', sanitizeJobs([{jobId:5}, null, {}, {jobId:'abc'}]).length, 1);
const sj = sanitizeJobs([{ jobId: '7', x: '3', duration: 'xx' }])[0];
eq('coerced to numbers', [sj.jobId, sj.x], [7, 3]);
eq('bad duration -> default', sj.duration, 900);
eq('missing name filled in', sj.jobName, 'Job #7');
eq('upper bound', sanitizeJobs(new Array(900).fill({ jobId: 1 })).length, 500);


// ============================================================
//  Leader election: a visible tab must never stay silently passive
// ============================================================
console.log('\n=== Leader election ===');
CONFIG.STORAGE_LEADER = 'lisa_leader_tab';
CONFIG.LEADER_TTL = 15000;
let TAB_ID = 'me';
let visibility = 'visible';
global.document = { visibilityState: 'visible' };
Object.defineProperty(global.document, 'visibilityState', { get: () => visibility });
eval([extract('isVisible'), extract('refreshLeadership'), extract('releaseLeadership')].join('\n'));

const setLeader = o => { store[CONFIG.STORAGE_LEADER] = JSON.stringify(o); };
const getLeader = () => JSON.parse(store[CONFIG.STORAGE_LEADER] || 'null');

delete store[CONFIG.STORAGE_LEADER];
isLeaderTab = false; refreshLeadership();
eq('a lone tab becomes the leader', isLeaderTab, true);

// Background leader + visible tab -> the visible one takes over (this was the bug)
setLeader({ id: 'other', ts: Date.now(), visible: false });
isLeaderTab = false; visibility = 'visible'; refreshLeadership();
eq('a visible tab takes it from a background one', isLeaderTab, true);
eq('the entry becomes ours', getLeader().id, 'me');

// Visible leader + visible tab -> we don't take it (the anti-duplication guard stays)
setLeader({ id: 'other', ts: Date.now(), visible: true });
isLeaderTab = true; refreshLeadership();
eq('we do not overtake a visible leader', isLeaderTab, false);

// A hidden tab does not take it from a visible leader
setLeader({ id: 'other', ts: Date.now(), visible: false });
isLeaderTab = false; visibility = 'hidden'; refreshLeadership();
eq('a hidden tab does not take over', isLeaderTab, false);
visibility = 'visible';

// A stale entry can be taken over by anyone
setLeader({ id: 'other', ts: Date.now() - 60000, visible: true });
isLeaderTab = false; refreshLeadership();
eq('a stale leadership can be taken over', isLeaderTab, true);

// We release it on close -> the next tab can take over at once
setLeader({ id: 'me', ts: Date.now(), visible: true });
releaseLeadership();
eq('on close it releases its own', getLeader(), null);
setLeader({ id: 'other', ts: Date.now(), visible: true });
releaseLeadership();
eq("it does not delete another tab's entry", getLeader().id, 'other');



// ============================================================
//  Chaining the predicted start/finish times
// ============================================================
console.log('\n=== Time estimation ===');
// Measured in the game: the time is exactly linear in euclidean distance,
// 0.017647 s/unit. calcWayTo computes from the CURRENT position.
const SEC_PER_UNIT = 0.017647;
let charPos = { x: 0, y: 0 };
global.Character = {
    getPosition: () => charPos,
    calcWayTo: (x, y) => Math.hypot(x - charPos.x, y - charPos.y) * SEC_PER_UNIT,
};
window.Character = global.Character;
// A sleep's length is computed live; a job's comes from the stored value.
const estimateSleepSeconds = () => 3600;
const sleepGoalForTask = () => 100;
const sleepPerHour = () => 0;
eval(['secondsPerDistanceUnit','currentPosition','queueTailAnchor','computeEtas','clockHM','dayOffset','formatEta',
      'jobDurationSeconds','msUntilEnergyAtRate'].map(extract).join('\n'));

eq('seconds per unit comes from calcWayTo', +secondsPerDistanceUnit().toFixed(6), SEC_PER_UNIT);

// Empty game queue: the chain starts from now and from the character's position
window.TaskQueue = { queue: [], limit: { normal: 4, premium: 9 } };
charPos = { x: 0, y: 0 };
const t0 = Date.now();
let etas = computeEtas([
    { id: 'a', x: 1000, y: 0, duration: 60 },     // 17.647 s travel, 60 s of work
    { id: 'b', x: 1000, y: 0, duration: 30 },     // same spot: no travel
]);
eq('travel time of job 1', Math.round(etas[0].travelMs / 1000), 18);
eq('length of job 1', Math.round((etas[0].finish - etas[0].start) / 1000), 60);
eq('job 2 starts after job 1 (no travel)', Math.round((etas[1].start - etas[0].finish) / 1000), 0);
eq('length of job 2', Math.round((etas[1].finish - etas[1].start) / 1000), 30);

// Distance counts from the PREVIOUS job, not from the character
etas = computeEtas([
    { id: 'a', x: 1000, y: 0, duration: 0 },
    { id: 'b', x: 3000, y: 0, duration: 0 },      // 2000 units from the previous one
]);
eq('job 2 travels from the previous location', Math.round(etas[1].travelMs / 1000), Math.round(2000 * SEC_PER_UNIT));

// Non-empty game queue: the chain starts after -- and from -- the job finishing LAST
const future = Date.now() + 600000;
window.TaskQueue.queue = [
    { data: { date_done: Date.now() + 60000 }, post: { x: 500, y: 0 } },
    { data: { date_done: future },             post: { x: 2000, y: 0 } },   // this is the "tail"
    { data: { date_done: Date.now() + 120000 }, post: { x: 900, y: 0 } },
];
etas = computeEtas([{ id: 'a', x: 2000, y: 0, duration: 120 }]);
eq('the chain starts at the latest finish', Math.round((etas[0].start - future) / 1000), 0);
etas = computeEtas([{ id: 'a', x: 4000, y: 0, duration: 0 }]);
eq('travel from the tail location', Math.round(etas[0].travelMs / 1000), Math.round(2000 * SEC_PER_UNIT));

// Expired queue: a date_done in the past does not pull the estimate back
window.TaskQueue.queue = [{ data: { date_done: Date.now() - 999999 }, post: { x: 0, y: 0 } }];
etas = computeEtas([{ id: 'a', x: 0, y: 0, duration: 60 }]);
eq('a finish in the past does not pull it back', etas[0].start >= Date.now() - 1000, true);

// It still gives an estimate without calcWayTo, just with no travel
const savedChar = global.Character;
global.Character = undefined; window.Character = undefined;
window.TaskQueue.queue = [];
etas = computeEtas([{ id: 'a', x: 9999, y: 9999, duration: 60 }]);
eq('without calcWayTo there is no travel', etas[0].travelMs, 0);
eq('and we flag the estimate as incomplete', etas[0].estimated, false);
global.Character = savedChar; window.Character = savedChar;

// Formatting
const base = new Date(); base.setHours(9, 5, 0, 0);
eq('short hh:mm form', formatEta({ start: base.getTime(), finish: base.getTime() + 3600000 }), '09:05→10:05');
const tomorrow = base.getTime() + 26 * 3600000;
eq('a next-day finish is marked', formatEta({ start: base.getTime(), finish: tomorrow }).endsWith('+1'), true);


// ============================================================
//  Fast reaction to an external cancellation
// ============================================================
console.log('\n=== Slot watcher ===');
CONFIG.SLOT_FREED_DELAY = 1500;
const updateKeepAwake = () => {};     // keep-awake: browser-dependent, not measurable here
const cancelSleepIfFull = () => {};   // cancelling a sleep needs live game state
const askRunningSleepMode = () => {}; // needs a dialog
const patchHotelStart = () => {};     // the hotel window only exists in the game
eval(extract('watchGameQueue'));

function watchCase(o) {
    window.TaskQueue = { queue: new Array(o.len).fill(0).map(() => ({ data: { date_done: Date.now() + 60000 } })),
                         limit: { normal: 4, premium: 9 } };
    lastSeenQueueLen = o.lastSeen;
    extraJobs = o.waiting ? mkJobs(o.waiting) : [];
    paused = !!o.paused; isLeaderTab = o.leader !== false; processing = !!o.processing;
    nextJobTimer = o.pendingTimer ? 1 : null;
    nextJobDeadline = o.deadlineInMs ? Date.now() + o.deadlineInMs : 0;
    scheduled = null;
    watchGameQueue();
    return scheduled;
}

eq('queue shrank -> starts shortly', watchCase({ len: 3, lastSeen: 4, waiting: 2 }), 1500);
eq('unchanged queue -> leaves it alone', watchCase({ len: 4, lastSeen: 4, waiting: 2 }), null);
eq('growing queue -> leaves it alone', watchCase({ len: 4, lastSeen: 3, waiting: 2 }), null);
eq('no waiting job -> starts nothing', watchCase({ len: 3, lastSeen: 4, waiting: 0 }), null);
eq('full queue -> starts nothing', watchCase({ len: 4, lastSeen: 5, waiting: 2 }), null);
eq('paused -> starts nothing', watchCase({ len: 3, lastSeen: 4, waiting: 2, paused: true }), null);
eq('passive tab -> starts nothing', watchCase({ len: 3, lastSeen: 4, waiting: 2, leader: false }), null);
eq('a round already running -> starts nothing', watchCase({ len: 3, lastSeen: 4, waiting: 2, processing: true }), null);
eq('pulls a long wait forward', watchCase({ len: 3, lastSeen: 4, waiting: 2, pendingTimer: true, deadlineInMs: 300000 }), 1500);
eq('does not push out a nearer timer', watchCase({ len: 3, lastSeen: 4, waiting: 2, pendingTimer: true, deadlineInMs: 500 }), null);
// After a rejection it must not retry every two seconds: the second call starts nothing
watchCase({ len: 3, lastSeen: 4, waiting: 2 });
eq('a repeat call without a new decrease stays quiet', (scheduled = null, watchGameQueue(), scheduled), null);
paused = false; isLeaderTab = true; processing = false;


// ============================================================
//  Duration from the CLICKED bar (high-level accounts)
// ============================================================
console.log('\n=== Duration bars ===');
global.JobList = { getDurations: () => ({ short:{duration:15,requirement:1},
                                          middle:{duration:600,requirement:10},
                                          long:{duration:3600,requirement:20} }) };
window.JobList = global.JobList;
jobHistory = [];
eval([extract('durationFromBar'), extract('parseJobWindow')].join('\n'));

// Minimal DOM imitation: only what parseJobWindow uses
function mkBar(base, disabled, durText) {
    const bar = { dataset: { base }, disabled,
        querySelector: sel => (sel === '.job_value_duration' && durText) ? { textContent: durText } : null };
    bar.closestTarget = bar;
    return bar;
}
function mkWindow(bars, className) {
    return { className, querySelector: sel => sel === '.job_durationbar:not(.disabled)'
        ? (bars.find(b => !b.disabled) || null) : null };
}
const mkBtn = bar => ({ closest: sel => sel === '.job_durationbar' ? bar : null });
const CLS = 'tw2gui_window job-43879-17869-7';

const barsHigh = [mkBar('short', false, '15mp'), mkBar('middle', false, '10p'), mkBar('long', false, '1ó')];
const winHigh = mkWindow(barsHigh, CLS);
eq('short button -> 15 s', parseJobWindow(winHigh, mkBtn(barsHigh[0])).duration, 15);
eq('middle button -> 600 s', parseJobWindow(winHigh, mkBtn(barsHigh[1])).duration, 600);
eq('long button -> 3600 s', parseJobWindow(winHigh, mkBtn(barsHigh[2])).duration, 3600);
eq('coordinates from the class name', (j => [j.jobId, j.x, j.y])(parseJobWindow(winHigh, mkBtn(barsHigh[2]))), [7, 43879, 17869]);

// Low level: only short is active, the others have no disabled button
const barsLow = [mkBar('short', false, '15mp'), mkBar('middle', true), mkBar('long', true)];
eq('low level -> 15 s', parseJobWindow(mkWindow(barsLow, CLS), mkBtn(barsLow[0])).duration, 15);

// With an unknown data-base the text is the fallback
const oddBar = mkBar(undefined, false, '10p');
eq('no data-base -> from the text', parseJobWindow(mkWindow([oddBar], CLS), mkBtn(oddBar)).duration, 600);

// Neither base nor text -> history, then the default
const blank = mkBar(undefined, false, null);
jobHistory = [{ jobId: 7, duration: 1234 }];
eq('filled in from the history', parseJobWindow(mkWindow([blank], CLS), mkBtn(blank)).duration, 1234);
jobHistory = [];
eq('last resort is the default', parseJobWindow(mkWindow([blank], CLS), mkBtn(blank)).duration, CONFIG.DEFAULT_DURATION);

// With no button (an uncaught click) it falls back to the first active bar
eq('with no button, the first active bar', parseJobWindow(winHigh, null).duration, 15);
eq('not a job window -> null', parseJobWindow(mkWindow(barsHigh, 'tw2gui_window something'), null), null);

// ============================================================
//  In the game's queue the travel is folded into the time
// ============================================================
console.log('\n=== Travel folded into the row time ===');
eval(extract('formatClock'));
eq('0 s travel -> just the work time', formatClock(0 + 15), '00:00:15');
eq('5 s travel + 15 s work', formatClock(5 + 15), '00:00:20');
eq('29 s travel + 15 s work', formatClock(29 + 15), '00:00:44');
eq('a 10-minute job', formatClock(0 + 600), '00:10:00');
eq('a 1-hour job with travel', formatClock(120 + 3600), '01:02:00');


// ============================================================
//  Quick-start arrows: location from the nearest job group
// ============================================================
console.log('\n=== Quick start ===');
CONFIG.JOBGROUP_MAX_DIST = 200;
function rectOf(x, y, w = 54, h = 54) {
    return { getBoundingClientRect: () => ({ x: x - w/2, y: y - h/2, width: w, height: h }) };
}
function mkGroup(posx, posy, sx, sy) {
    return Object.assign(rectOf(sx, sy, 120, 65), { className: `image x-1 y-2 posx-${posx} posy-${posy} jobgroup jobgroup-7` });
}
let groups = [];
global.document = { querySelectorAll: sel => (sel === '.jobgroup' ? groups : []) };
eval(extract('nearestJobGroup'));

// Layout measured live: the group at the fanned-out circle's centre, the next one 528 px away
groups = [mkGroup(41966, 16411, 816, 464), mkGroup(40224, 16507, 816 - 528, 464)];
eq('the group at the circle centre wins', (g => [g.x, g.y])(nearestJobGroup(rectOf(816, 389))), [41966, 16411]);
eq('the same for an outer icon', (g => [g.x, g.y])(nearestJobGroup(rectOf(886, 504))), [41966, 16411]);

// Too far -> no match, the click stays the game's
groups = [mkGroup(41966, 16411, 100, 100)];
eq('a distant group is not accepted', nearestJobGroup(rectOf(816, 389)), null);
groups = [];
eq('no group -> null', nearestJobGroup(rectOf(816, 389)), null);

// Reading the jobId/base out of class names (with the real classes)
const idOf  = cls => (cls.match(/\bjob-(\d+)\b/) || [])[1];
const baseOf = cls => (cls.match(/instantwork-(short|middle|long)/) || [])[1];
eq('jobId out of .job-128', idOf('job job-128 hasMousePopup'), '128');
eq('a jobgroup yields no jobId', idOf('image x-157 y-64 posx-40224 posy-16507 jobgroup jobgroup-12'), undefined);
eq('short arrow', baseOf('instantwork-short'), 'short');
eq('middle arrow', baseOf('instantwork-middle'), 'middle');
eq('long arrow', baseOf('instantwork-long'), 'long');
eq('the base maps to a duration', JobList.getDurations()[baseOf('instantwork-long')].duration, 3600);

// ============================================================
//  "Cancel all" only empties after a confirmation
// ============================================================
console.log('\n=== Cancel all ===');
let statusText = '';
const updateUIStatusReal = (t) => { statusText = t; };
eval(extract('clearExtraAfterCancelAll').replace('updateUIStatus(', 'updateUIStatusReal('));
extraJobs = mkJobs(5);
clearExtraAfterCancelAll();
eq('the list empties after the confirmation', extraJobs.length, 0);
eq('the status says how many were discarded', /5 várakozó/.test(statusText), true);
statusText = '';
clearExtraAfterCancelAll();
eq('no message for an empty list', statusText, '');

// ============================================================
//  Friendly time formatting (the status line used to show "~400 mp")
// ============================================================
console.log('\n=== Duration formatting ===');
// formatDuration was already extracted above, for processQueue.
eq('under a minute stays in seconds', formatDuration(45), '45 mp');
eq('exactly one minute', formatDuration(60), '1 p');
eq('400 s -> minutes, rounded up', formatDuration(400), '7 p');
eq('61 s rounds up to 2 minutes', formatDuration(61), '2 p');
eq('59 minutes is still minutes', formatDuration(3540), '59 p');
eq('exactly one hour', formatDuration(3600), '1 ó');
eq('hours and minutes', formatDuration(3600 + 400), '1 ó 7 p');
eq('a whole hour prints no 0 minutes', formatDuration(7200), '2 ó');
eq('the sum of a long list', formatDuration(24 * 900), '6 ó');
eq('zero', formatDuration(0), '0 mp');

// ============================================================
//  The "+N" tile sits on the last job slot (not on a row of its own)
// ============================================================
console.log('\n=== In-game preview split ===');
eval(extract('previewSplit'));
eq('fewer than the frame: everything shows', previewSplit(3, 6), { shown: 3, hidden: 0 });
eq('exactly as many: still no tile', previewSplit(6, 6), { shown: 6, hidden: 0 });
eq('one more: 5 jobs + "+2"', previewSplit(7, 6), { shown: 5, hidden: 2 });
eq('many jobs: 5 jobs + "+20"', previewSplit(25, 6), { shown: 5, hidden: 20 });
eq('the tile always reports the remainder',
   (s => s.shown + s.hidden)(previewSplit(25, 6)), 25);

// ============================================================
//  A later rejection by the server must not lose the job
// ============================================================
// Case measured live: TaskQueue.add pushes synchronously, the script counts them
// as accepted, then the server rejects them (level requirement) and the game
// removes them from the queue -- and they are already gone from the list. 8 jobs were lost this way.
console.log('\n=== Server-side rejection ===');
eval([extract('parseBodyParams'), extract('extractTasksFromBody'),
      extract('rejectedFromAddResponse'), extract('addResponseMatchesBatch')].join('\n'));
global.URLSearchParams = require('url').URLSearchParams;

const body3 = 'tasks[0][jobId]=129&tasks[0][x]=1&tasks[0][y]=2&tasks[0][duration]=15&tasks[0][taskType]=job'
            + '&tasks[1][jobId]=127&tasks[1][x]=3&tasks[1][y]=4&tasks[1][duration]=600&tasks[1][taskType]=job'
            + '&tasks[2][jobId]=60&tasks[2][x]=5&tasks[2][y]=6&tasks[2][duration]=3600&tasks[2][taskType]=job';
const parsed3 = extractTasksFromBody(body3);
eq('every job of the request comes out', parsed3.length, 3);
eq('in the right order', parsed3.map(t => t.jobId), [129, 127, 60]);
eq('the duration is there too', parsed3.map(t => t.duration), [15, 600, 3600]);
eq('a single-job request works too', extractTasksFromBody('tasks[0][jobId]=7&tasks[0][duration]=15').length, 1);
eq('a body with no job -> empty', extractTasksFromBody('window=task&action=add').length, 0);

const b3 = [{ jobId: 129, duration: 15 }, { jobId: 127, duration: 600 }, { jobId: 60, duration: 3600 }];
eq('our own batch is recognised', addResponseMatchesBatch(parsed3, b3), true);
eq('a batch of a different length is not ours', addResponseMatchesBatch(parsed3, b3.slice(0, 2)), false);
eq('a different job is not ours',
   addResponseMatchesBatch(parsed3, [{ jobId: 1, duration: 15 }, b3[1], b3[2]]), false);
eq('no batch -> no match', addResponseMatchesBatch(parsed3, null), false);

// The response shape measured live: tasks[i] is either {task:{...}} or {error,msg}
const okEntry = { task: { queue_id: 1, date_done: 1785828704.77 } };
eq('all successes -> nothing rejected',
   rejectedFromAddResponse(b3, { tasks: [okEntry, okEntry, okEntry] }).length, 0);
const mixed = rejectedFromAddResponse(b3, {
    tasks: [okEntry, { error: true, msg: 'Legalább a 53 szintet kell elérned' }, okEntry] });
eq('the failing element matches by index', mixed.length, 1);
eq('the right job is the one that failed', mixed[0].job.jobId, 127);
eq('the server message is kept', /53 szintet/.test(mixed[0].msg), true);
eq('a top-level error -> the WHOLE batch failed',
   rejectedFromAddResponse(b3, { error: true, msg: 'Nincs elég energiád' }).length, 3);
eq('no error and no tasks is not a failure',
   rejectedFromAddResponse(b3, { energy: 97 }).length, 0);
eq('a batch shorter than the response does not overrun',
   rejectedFromAddResponse([b3[0]], { tasks: [okEntry, { error: true, msg: 'x' }] }).length, 0);
eq('an empty batch yields empty', rejectedFromAddResponse([], { tasks: [{ error: true }] }).length, 0);

// The backoff doubles: low energy is an hours-long problem, and with a fixed
// 20 s retry the job would burn through its attempts in minutes.
CONFIG.REJECT_BACKOFF_MS = 20000; CONFIG.REJECT_BACKOFF_MAX = 600000; CONFIG.MAX_REJECTIONS = 10;
eval(extract('rejectBackoffMs'));
eq('20 s after the first rejection', rejectBackoffMs(1), 20000);
eq('doubled the second time', rejectBackoffMs(2), 40000);
eq('5 min 20 s the fifth time', rejectBackoffMs(5), 320000);
eq('the cap is 10 minutes', rejectBackoffMs(9), 600000);
eq('a zero/missing value still waits one round', rejectBackoffMs(0), 20000);
// The ten attempts span more than an hour in total -- so a job short on energy
// (3 energy/hour regen) waits until it becomes startable.
const totalWait = Array.from({length: CONFIG.MAX_REJECTIONS}, (_, i) => rejectBackoffMs(i + 1))
    .reduce((a, b) => a + b, 0);
eq('the attempts together span > 1 hour', totalWait > 3600000, true);

// ============================================================
//  Energy and motivation forecast
// ============================================================
// Measured game data: a 15 s job costs 1 energy, motivation drops by the same
// amount when the job COMPLETES, whereas the energy is deducted already when it
// enters the queue. Regeneration is maxEnergy * energyRegen per hour.
console.log('\n=== Energy and motivation ===');
CONFIG.MOTIVATION_WARN = 75;
eval(extract('computeForecast'));

const mkEtas = (n, stepMs) => Array.from({length: n}, (_, i) => ({ start: 1000 + i * stepMs }));
const flat = (energy) => () => energy;

// Energy: every job deducts; the case without regeneration is the simplest
let fc = computeForecast(mkJobs(3), mkEtas(3, 0), {
    costOf: () => 5, motivationOf: () => 1, energyAt: flat(12),
    priorMotivationCost: {}, motivationWarn: 75 });
eq('7 left after the first job', [fc[0].energyBefore, fc[0].energyAfter], [12, 7]);
eq('the second starts from what is left', [fc[1].energyBefore, fc[1].energyAfter], [7, 2]);
eq('the third is no longer covered', fc[2].notEnoughEnergy, true);
eq('no flag on the covered ones', [fc[0].notEnoughEnergy, fc[1].notEnoughEnergy], [false, false]);

// Regeneration counts: if the forecast says it recovers meanwhile, it is enough
fc = computeForecast(mkJobs(2), mkEtas(2, 60000), {
    costOf: () => 5, motivationOf: () => 1,
    energyAt: (t) => (t === 1000 ? 5 : 10),          // recovers by the second start
    priorMotivationCost: {}, motivationWarn: 75 });
eq('regenerated energy counts too', fc[1].notEnoughEnergy, false);

// Motivation: every COMPLETED instance of the same job lowers it by its own energy cost
const same = Array.from({length: 4}, (_, i) => ({ ...mkJobs(1)[0], id: 'm' + i, jobId: 42 }));
fc = computeForecast(same, mkEtas(4, 0), {
    costOf: () => 1, motivationOf: () => 1, energyAt: flat(100),
    priorMotivationCost: {}, motivationWarn: 75 });
eq('the first still starts at full motivation', fc[0].motivation, 100);
eq('the fourth starts three lower', fc[3].motivation, 97);
eq('no warning at 100%', fc.some(f => f.lowMotivation), false);

// Jobs in the game's queue lower it too, before ours get their turn
fc = computeForecast(same, mkEtas(4, 0), {
    costOf: () => 1, motivationOf: () => 0.78, energyAt: flat(100),
    priorMotivationCost: { 42: 2 }, motivationWarn: 75 });
eq("the game's queue counts too", fc[0].motivation, 76);
eq('we warn below the threshold', [fc[0].lowMotivation, fc[1].lowMotivation], [false, true]);
eq('we warn exactly at the threshold too', fc[1].motivation, 75);

// While we don't know the cost/motivation, we do NOT guess
fc = computeForecast(mkJobs(2), mkEtas(2, 0), {
    costOf: () => null, motivationOf: () => null, energyAt: flat(3),
    priorMotivationCost: {}, motivationWarn: 75 });
eq('unknown cost -> no energy forecast', [fc[0].energyAfter, fc[0].cost], [null, null]);
eq('unknown motivation -> no flag', [fc[0].motivation, fc[0].lowMotivation], [null, false]);
eq('with an unknown cost we do not claim a shortage', fc[0].notEnoughEnergy, false);

// A sleep does not consume but REFILLS: the calculation continues from the room's
// target level, otherwise the end-of-list forecast would stay negative forever.
eval(extract('forecastShortageIndex'));
const withSleep = [
    { ...mkJobs(1)[0], id: 'a' },
    { id: 'zzz', taskType: 'sleep', room: 'luxurious_apartment' },
    { ...mkJobs(1)[0], id: 'b' },
    { ...mkJobs(1)[0], id: 'c' },
];
fc = computeForecast(withSleep, mkEtas(4, 0), {
    costOf: (j) => (j.taskType === 'sleep' ? null : 8), motivationOf: () => 1,
    energyAt: flat(10), sleepTargetOf: () => 100,
    priorMotivationCost: {}, motivationWarn: 75 });
eq('the first job still fits', [fc[0].energyBefore, fc[0].energyAfter], [10, 2]);
eq("the sleep fills up to the room's level", [fc[1].isSleep, fc[1].energyAfter], [true, 100]);
eq('it carries on from there', [fc[2].energyBefore, fc[2].energyAfter], [100, 92]);
eq('and so does the next', fc[3].energyAfter, 84);
eq('no energy shortage after the sleep', fc.some(f => f.notEnoughEnergy), false);
eq('no warning on the sleep itself', [fc[1].lowMotivation, fc[1].notEnoughEnergy], [false, false]);

// If the sleep is in the GAME's queue (started by hand), our jobs start after
// it: by then energy has filled to the room's level. This was missing live
// -- we predicted 48 out of 8 energy instead of 150, because we dragged the
// awake rate across the whole eight-hour sleep.
fc = computeForecast(mkJobs(3), mkEtas(3, 0), {
    initialCarry: 150,                       // the running sleep fills to the maximum
    costOf: () => 1, motivationOf: () => 1,
    energyAt: flat(48),                      // what plain regeneration would say
    priorMotivationCost: {}, motivationWarn: 75 });
eq('we start from the post-sleep level', fc[0].energyBefore, 150);
eq('not from the regeneration-based value', fc[0].energyBefore === 48, false);
eq('it drains normally afterwards', [fc[1].energyBefore, fc[2].energyBefore], [149, 148]);
eq('a worse room fills only partially', computeForecast(mkJobs(1), mkEtas(1, 0), {
    initialCarry: 64, costOf: () => 1, motivationOf: () => 1, energyAt: flat(5),
    priorMotivationCost: {}, motivationWarn: 75 })[0].energyBefore, 64);
eq('with no sleep the regeneration forecast stands', computeForecast(mkJobs(1), mkEtas(1, 0), {
    initialCarry: null, costOf: () => 1, motivationOf: () => 1, energyAt: flat(48),
    priorMotivationCost: {}, motivationWarn: 75 })[0].energyBefore, 48);

// The sleep goes exactly WHERE the energy runs out -- up to there the list runs fine
fc = computeForecast(mkJobs(4), mkEtas(4, 0), {
    costOf: () => 4, motivationOf: () => 1, energyAt: flat(10),
    priorMotivationCost: {}, motivationWarn: 75 });
eq('it runs out at the third job', forecastShortageIndex(fc), 2);
eq('no shortage with plenty of energy', forecastShortageIndex(
    computeForecast(mkJobs(2), mkEtas(2, 0), { costOf: () => 1, motivationOf: () => 1,
        energyAt: flat(100), priorMotivationCost: {}, motivationWarn: 75 })), -1);

// A sleep that has NOT started yet must not have its length estimated with the
// awake rate: on the main character an 8-hour sleep "never ended" that way, and
// the jobs behind it slipped eight hours out.
// (the function was already extracted above, with the ETA calculations)
window.Character = { energy: 8, maxEnergy: 150 };
const hours = (ms) => Math.round(ms / 3600000 * 10) / 10;
eq('awake 5/h: 8 to 150 takes ~28.4 h', hours(msUntilEnergyAtRate(150, 5)), 28.4);
eq('asleep 18.75/h: ~7.6 h', hours(msUntilEnergyAtRate(150, 18.75)), 7.6);
eq('we never wait for more than the maximum', msUntilEnergyAtRate(999, 5), msUntilEnergyAtRate(150, 5));
eq('no wait for a level already reached', msUntilEnergyAtRate(8, 5), 0);
eq('a zero rate does not spin', msUntilEnergyAtRate(150, 0), CONFIG.MAX_WAIT_MS);
delete window.Character;

// ============================================================
//  Sleeping: how long should we sleep?
// ============================================================
// Two modes, decided per sleep: 'full' up to the room's level, 'enough' only
// until enough energy has built up for the jobs BEHIND it. 'enough' is computed
// live, so work added during the sleep pushes the goal up.
console.log('\n=== How long should we sleep ===');
let costTable = {};
jobEnergyCost = (job) => (job.taskType === 'sleep' ? null
    : (costTable[job.jobId] !== undefined ? costTable[job.jobId] : 5));
const sleepTargetEnergy = () => 150;      // luxurious apartment, maximum 150
eval([extract('energyNeededFrom'), extract('sleepGoalEnergy'), extract('sleepGoalForEntry')].join('\n'));

extraJobs = mkJobs(3);                                     // 3 jobs, 5 energy each
eq('the total cost of the remaining jobs', energyNeededFrom(0), 15);
eq('less is needed from the second position', energyNeededFrom(1), 10);
eq('nothing at the end of the list', energyNeededFrom(3), 0);
eq("a full sleep targets the room's level", sleepGoalEnergy('full', 'x', 0), 150);
eq('"enough" only covers the jobs', sleepGoalEnergy('enough', 'x', 0), 15);
eq("the room's level is the ceiling", sleepGoalEnergy('enough', 'x', 0) <= 150, true);

// More jobs in the queue -> a higher goal (live recalculation during the sleep)
extraJobs = mkJobs(40);
eq("with many jobs the room's level caps it", sleepGoalEnergy('enough', 'x', 0), 150);

// With an unknown cost we don't guess: sleep the full length
extraJobs = mkJobs(2);
costTable = { 100: undefined };
jobEnergyCost = (job) => (job.jobId === 100 ? null : 5);
eq('unknown cost -> no estimate', energyNeededFrom(0), null);
eq('unknown cost -> full sleep', sleepGoalEnergy('enough', 'x', 0), 150);
jobEnergyCost = (job) => (job.taskType === 'sleep' ? null : 5);

// We sum up to the next sleep: that one will refill anyway
extraJobs = [mkJobs(1)[0], mkJobs(1)[0], { taskType: 'sleep', room: 'x' }, mkJobs(1)[0]];
eq('we sum up to the next sleep', energyNeededFrom(0), 10);

// An entry's goal comes from what stands BEHIND it (hence index+1)
extraJobs = [{ taskType: 'sleep', room: 'x', sleepMode: 'enough' }, mkJobs(1)[0], mkJobs(1)[0]];
eq('the sleep collects for what stands behind it', sleepGoalForEntry(extraJobs[0], 0), 10);
extraJobs[0].sleepMode = 'full';
eq("in full mode, up to the room's level", sleepGoalForEntry(extraJobs[0], 0), 150);

// With no work behind it (e.g. the user removed it meanwhile) the 'enough'
// goal would be 0 -- but then there is no reason to wake up, so we fall back
// to the full sleep. Without that the goal is 0 and the script wakes at once.
extraJobs = [{ taskType: 'sleep', room: 'x', sleepMode: 'enough' }];
eq('nothing behind it -> a full sleep after all', sleepGoalForEntry(extraJobs[0], 0), 150);
eq("the room's level for an empty list too", sleepGoalEnergy('enough', 'x', 5), 150);
extraJobs = [];

// ============================================================
//  A sleep's mode is only inherited when it was genuinely CHOSEN
// ============================================================
// Live: after a manually started sleep the script never asked how long to
// sleep and took it as full -- because it mistook the manual sleep's default
// 'full' mode for a decision, and carried it over to the next sleep as well.
console.log('\n=== Inheriting the sleep mode ===');
eval(extract('makeSleepEntry'));
const estimateSleepSecondsOrig = estimateSleepSeconds;
eq('a mode picked from the offer is a decision',
   (e => [e.sleepMode, e.modeChosen])(makeSleepEntry(1, 'cubby', 'Kamra', 0, 0, 'enough')), ['enough', true]);
eq('choosing the full sleep is a decision too',
   (e => [e.sleepMode, e.modeChosen])(makeSleepEntry(1, 'cubby', 'Kamra', 0, 0, 'full')), ['full', true]);
eq('a manual sleep has no decision, only a default',
   (e => [e.sleepMode, e.modeChosen])(makeSleepEntry(1, 'cubby', 'Kamra', 0, 0, undefined)), ['full', false]);
eq('a mode with no decision stays out of the name',
   makeSleepEntry(1, 'cubby', 'Kamra', 0, 0, undefined).jobName, 'Alvás – Kamra');
eq('"enough" does show up in the name',
   makeSleepEntry(1, 'cubby', 'Kamra', 0, 0, 'enough').jobName, 'Alvás – Kamra (amennyi kell)');

// The save also preserves whether there was a decision
eq('the decision survives saving', sanitizeJobs([
    { taskType: 'sleep', townId: 4206, room: 'cubby', sleepMode: 'enough', modeChosen: true },
])[0].modeChosen, true);
eq('the absence of a decision survives too', sanitizeJobs([
    { taskType: 'sleep', townId: 4206, room: 'cubby', sleepMode: 'full' },
])[0].modeChosen, false);

// ============================================================
//  New work pulls the next round forward
// ============================================================
// Live: a sleep added to the queue "did nothing" and only a page reload brought
// it to life -- because ensureProcessing did not reschedule during a long
// backoff.
console.log('\n=== New work and a running wait ===');
CONFIG.NEW_WORK_DELAY = 500;
const armed = (deadlineInMs) => { nextJobTimer = 1; nextJobDeadline = Date.now() + deadlineInMs; scheduled = null; };

extraJobs = mkJobs(1); processing = false; paused = false;
armed(600000);                                   // a ten-minute backoff is running
ensureProcessing();                              // heartbeat: must NOT touch it
eq('the heartbeat does not upset the backoff', scheduled, null);
ensureProcessing(CONFIG.NEW_WORK_DELAY);         // new work arrived
eq('new work does pull it forward', scheduled, 500);

armed(200);                                      // it is about to start anyway
ensureProcessing(CONFIG.NEW_WORK_DELAY);
eq('it does not push out the nearer deadline', scheduled, null);

nextJobTimer = null; scheduled = null;
ensureProcessing(CONFIG.NEW_WORK_DELAY);
eq('with no timer it schedules', scheduled, 500);

paused = true; scheduled = null; nextJobTimer = null;
ensureProcessing(CONFIG.NEW_WORK_DELAY);
eq('paused, it does not start', scheduled, null);
paused = false;
extraJobs = []; scheduled = null;
ensureProcessing(CONFIG.NEW_WORK_DELAY);
eq('it does not schedule for an empty list', scheduled, null);

// ============================================================
//  Sleeping: room choice and goal level
// ============================================================
// Hotel data measured live: a room's "energy" field is the level it fills up to
// (cubby 64 ... luxurious apartment 100), and every room is free in one's own town.
console.log('\n=== Sleeping ===');
eval(extract('bestFreeRoom'));
const rooms = {
    cubby: { level: 1, energy: 64, name: 'Kamra', available: true, free: true },
    bedroom: { level: 2, energy: 72, name: 'Hálószoba', available: true, free: true },
    luxurious_apartment: { level: 5, energy: 100, name: 'Luxusapartman', available: true, free: true },
};
eq('the best free room wins', bestFreeRoom(rooms).key, 'luxurious_apartment');
eq('we never pick a paid room on our own',
   bestFreeRoom({ ...rooms, luxurious_apartment: { ...rooms.luxurious_apartment, free: false } }).key, 'bedroom');
eq('nor an unavailable one',
   bestFreeRoom({ cubby: { ...rooms.cubby, available: false }, bedroom: rooms.bedroom }).key, 'bedroom');
eq('if none is free there is no choice',
   bestFreeRoom({ cubby: { ...rooms.cubby, free: false } }), null);
eq('an empty hotel -> no choice', bestFreeRoom({}), null);

// Surviving storage: a sleep has no jobId, but its town and room are required
eval(extract('sanitizeJobs'));
const stored = sanitizeJobs([
    { taskType: 'sleep', townId: 4206, room: 'luxurious_apartment', jobName: 'Alvás', x: 1, y: 2, duration: 900 },
    { taskType: 'sleep', townId: 0, room: 'cubby' },          // meaningless without a town
    { taskType: 'sleep', townId: 4206 },                      // and without a room too
    { jobId: 129, x: 1, y: 2, duration: 15 },
]);
eq('the sleep survives saving', stored.length, 2);
eq('the town and the room are kept', [stored[0].townId, stored[0].room], [4206, 'luxurious_apartment']);
eq('incomplete sleep entries are dropped', stored[1].jobId, 129);

// A sleeping character cannot be challenged to a duel, so with no work we do NOT
// wake up -- not even at full energy. Only when there is something to do.
eval([extract('hasWorkWaiting'), extract('countWorkWaiting')].join('\n'));
const setState = (extra, queue) => {
    extraJobs = extra;
    window.TaskQueue = { queue, limit: { normal: 4, premium: 9 } };
};
setState([], [{ type: 'sleep' }]);
eq('empty queue + sleep -> let it sleep', hasWorkWaiting(), false);
eq('empty queue + sleep -> 0 jobs', countWorkWaiting(), 0);
setState([{ taskType: 'sleep' }], [{ type: 'sleep' }]);
eq('only another sleep waits -> no wake-up', hasWorkWaiting(), false);
setState(mkJobs(1), [{ type: 'sleep' }]);
eq('a waiting job -> we wake up', hasWorkWaiting(), true);
setState([], [{ type: 'sleep' }, { type: 'job', post: { jobId: 7 } }]);
eq("a job in the game's queue counts too", hasWorkWaiting(), true);
// In the game's queue "not a sleep" is not enough on its own: we don't wake for
// travel and other housekeeping entries, and we don't raise the question either.
setState([], [{ type: 'sleep' }, { type: 'walk', post: { taskType: 'walk' } }]);
eq('travel is not work -> we do not ask', hasWorkWaiting(), false);
setState(mkJobs(2), [{ type: 'sleep' }, { type: 'job', post: { jobId: 7 } }]);
eq('the two sources add up', countWorkWaiting(), 3);

// Jobs running BEFORE the sleep don't count: they finish before the sleep, so
// waking early does nothing for them. Live, this is what raised the "how long
// should I sleep?" question for a sleep that had no job after it at all.
const sleepTask = { type: 'sleep', queuePos: 3 };
setState([], [
    { type: 'job', post: { jobId: 7 } },
    { type: 'job', post: { jobId: 7 } },
    { type: 'job', post: { jobId: 7 } },
    sleepTask,
]);
eq('jobs BEFORE the sleep do not count', countWorkWaiting(sleepTask), 0);
eq('...so there is no reason to wake up', hasWorkWaiting(sleepTask), false);
eq('without naming a sleep, there is', hasWorkWaiting(), true);
// What stands BEHIND it still counts.
window.TaskQueue.queue.push({ type: 'job', post: { jobId: 9 } });
eq('a job BEHIND the sleep counts', countWorkWaiting(sleepTask), 1);
// Our own list is always behind the sleep.
setState(mkJobs(2), [{ type: 'job', post: { jobId: 7 } }, sleepTask]);
eq('our own list is always behind it', countWorkWaiting(sleepTask), 2);
extraJobs = [];

// ============================================================
//  Pumping the game client (the background tab's real bug)
// ============================================================
// TaskQueueUi.tick retires ONE finished task per call, and in a hidden tab it
// runs once a minute. So the queue sticks at its pre-freeze length, and
// TaskQueue.add gates its OWN limit on that length -- meaning we can start
// nothing at all. So we call the game's tick once per finished task.
console.log('\n=== Pumping the game client ===');
eval([extract('gameReady'), extract('gameQueueLength'), extract('gameQueueLimit'),
      extract('pumpGameClient')].join('\n'));

// Four jobs in the queue, all finished: a single tick must bring them all out.
const mkGameQueue = (n) => {
    const q = [];
    for (let i = 0; i < n; i++) q.push({ type: 'job', queueId: 100 + i, post: { jobId: 7 } });
    return q;
};
let energyPumps = 0;
window.Character = { tick4Character: () => { energyPumps++; } };
window.TaskQueue = { queue: mkGameQueue(4), limit: { normal: 4, premium: 9 }, busy: false };
// The game's tick: one call retires one finished task.
let expired = 4;
window.TaskQueueUi = { tick: () => { if (expired > 0) { expired--; window.TaskQueue.queue.shift(); } } };

eq('the pump ran', pumpGameClient(), true);
eq('all four finished jobs came out', window.TaskQueue.queue.length, 0);
eq('the energy was recomputed too', energyPumps, 1);

// If nothing finished, a single (normal) tick runs and the queue stays untouched.
window.TaskQueue.queue = mkGameQueue(3);
expired = 0;
let tickCalls = 0;
window.TaskQueueUi = { tick: () => { tickCalls++; } };
eq('a round runs even with nothing finished', pumpGameClient(), true);
eq('...but only one', tickCalls, 1);
eq('and the queue is untouched', window.TaskQueue.queue.length, 3);

// We don't touch the queue while a batch is in flight.
window.TaskQueue.busy = true;
tickCalls = 0;
eq('we do not pump during a batch', pumpGameClient(), true);
eq("...nor do we call the game's tick", tickCalls, 0);
window.TaskQueue.busy = false;

// Old client (no TaskQueueUi): report that we couldn't pump.
delete window.TaskQueueUi;
eq('no TaskQueueUi -> no pump', pumpGameClient(), false);

// A failing tick must not stall the ticker.
window.TaskQueueUi = { tick: () => { throw new Error('boom'); } };
eq('a throwing tick does not propagate', pumpGameClient(), true);
delete window.TaskQueueUi;
delete window.Character;

// ============================================================
//  A declined sleep offer stays available
// ============================================================
// Saying "no" used to throw the offer away and go quiet for half an hour, so the
// only way back to a sleep was the hotel window. Now the decline silences the
// game's DIALOG only: the panel row stays, collapsed to a single button, and
// keeps its numbers up to date until the shortage itself is gone.
console.log('\n=== The declined sleep offer ===');
CONFIG.AUTO_SLEEP = true;
CONFIG.SLEEP_DECLINE_MS = 1800000;
let sleepOffer = null, sleepDeclinedUntil = 0, lastForecast = [];
let renders = 0, dialogs = 0;
const renderSleepOffer = () => { renders++; };
const showSleepDialog = () => { dialogs++; return true; };
const canSleep = () => true;
isSleeping = () => false;
jobEnergyCost = (job) => (job.taskType === 'sleep' ? null : 5);
// These three are `let`/`const` stubs above, so they cannot be redeclared by an
// eval'd function declaration -- take them as expressions instead.
const asFn = (name) => eval('(' + extract(name) + ')');
maybeOfferSleep = asFn('maybeOfferSleep');
const offerSleepReal = asFn('offerSleepIfForecastRunsOut');
eval([extract('dismissSleepOffer'), extract('reopenSleepOffer'),
      extract('clearDeclinedSleepOffer')].join('\n'));

extraJobs = mkJobs(3);
maybeOfferSleep(5, 1);
eq('the offer comes up with the dialog', [!!sleepOffer, dialogs], [true, 1]);
eq('it knows where the energy runs out', [sleepOffer.at, sleepOffer.total], [1, 10]);
eq('and it is not collapsed yet', !!sleepOffer.declined, false);

// "No": the dialog goes quiet, the row does not go away
dismissSleepOffer(true);
eq('a "no" keeps the offer', !!sleepOffer, true);
eq('...but collapses it', sleepOffer.declined, true);
eq('...and arms the quiet window', sleepDeclinedUntil > Date.now(), true);

// While declined we neither raise the dialog again nor lose the row
dialogs = 0;
maybeOfferSleep(5, 1);
eq('we do not nag with the dialog again', dialogs, 0);
eq('the row survives the next round', !!sleepOffer, true);

// The numbers keep following the list, so a reopen is never stale
extraJobs = mkJobs(6);
maybeOfferSleep(5, 2);
eq('a declined offer stays up to date', [sleepOffer.at, sleepOffer.total], [2, 20]);

// Changing their mind: the choices come back and the quiet window ends
reopenSleepOffer();
eq('reopening expands the offer', sleepOffer.declined, false);
eq('...and ends the quiet window', sleepDeclinedUntil, 0);

// Accepting clears it outright
dismissSleepOffer(false);
eq('an accepted offer is cleared', sleepOffer, null);

// A new offer raised inside the quiet window is born collapsed: the row is
// there, the dialog is not.
sleepDeclinedUntil = Date.now() + CONFIG.SLEEP_DECLINE_MS;
dialogs = 0;
maybeOfferSleep(5, 0);
eq('inside the quiet window it is born collapsed', sleepOffer.declined, true);
eq('...with no dialog', dialogs, 0);

// The shortage passing is what finally clears it
lastForecast = [{ notEnoughEnergy: false, cost: 5 }];
offerSleepReal();
eq('no shortage -> the collapsed row goes', sleepOffer, null);

// A PENDING offer is left alone: its dialog is on screen, the user is answering
sleepDeclinedUntil = 0;
maybeOfferSleep(5, 0);
offerSleepReal();
eq('a pending offer is not cleared behind the dialog', !!sleepOffer, true);
dismissSleepOffer(false);

// A queued sleep takes the offer's job away
sleepDeclinedUntil = Date.now() + CONFIG.SLEEP_DECLINE_MS;
maybeOfferSleep(5, 0);
eq('collapsed again', sleepOffer.declined, true);
extraJobs = [{ taskType: 'sleep', room: 'x' }, ...mkJobs(2)];
maybeOfferSleep(5, 0);
eq('a queued sleep clears the collapsed row', sleepOffer, null);
eq('and the panel was told to repaint', renders > 0, true);
extraJobs = [];

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
