(async () => {
// A valódi processQueue-t futtatja egy szimulált TaskQueue ellen.
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

// --- A játék TaskQueue-jának hű mása: szinkron push, limitnél néma elutasítás ---
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
                if (this.queue.length >= limit) break;   // néma elutasítás, mint az igazi
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
let scheduled = null;
const rand = (a) => a;
const saveExtraQueueToStorage = () => {};
const updateUI = () => {};
const updateExtraList = () => {};
const updateUIStatus = () => {};
const updateQueueBadge = () => {};
const updateExtraEtas = () => {};
const renderPendingInGameQueue = () => {};
const observePendingHost = () => {};
const ensureMenuButton = () => {};
const ensureProcessing = () => {};
const scheduleNextJob = (ms) => { scheduled = ms; nextJobTimer = 1; };
const generateId = (() => { let n = 0; return () => 'id' + (++n); })();
const quiet = () => {};
const real = console.log;
console.log = quiet; console.warn = quiet; console.error = quiet;

eval([
    'gameReady', 'gameQueueLength', 'gameQueueLimit', 'freeSlots', 'nextFreeAtMs',
    'waitUntilFreeSlotMs', 'startJobsViaGame', 'addExtraJobs', 'formatDuration',
].map(extract).join('\n'));
eval(extract('processQueue'));
console.log = real;

const mkJobs = n => Array.from({ length: n }, (_, i) => ({
    id: 'j' + i, jobId: 100 + i, x: 1, y: 2, duration: 600, taskType: 'job',
    jobName: 'Munka ' + (i + 1), retries: 0, deferrals: 0 }));

let pass = 0, fail = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w);
    ok ? pass++ : fail++; console.log(`${ok?'ok  ':'FAIL'} ${l.padEnd(52)} ${ok?'':`got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`); };

// --- A bejelentett hibaeset: 7 munka, üres sor, limit 4 ---
async function scenario(limit, initial, jobCount, rounds) {
    window.TaskQueue = makeGame(limit, initial);
    extraJobs = mkJobs(jobCount); processing = false; nextJobTimer = null; scheduled = null;
    for (let r = 0; r < rounds; r++) { processing = false; await processQueue(); }
    return { left: extraJobs.length, inGame: window.TaskQueue.queue.length, addCalls: window.TaskQueue.addCalls };
}

console.log('=== A bejelentett eset: 7 munka indítása üres sorra (limit 4) ===');
let r = await scenario(4, 0, 7, 1);
eq('1 kör: 4 a játékba, 3 marad a listán', [r.inGame, r.left], [4, 3]);
eq('egyetlen kérés megy ki a kötegre', r.addCalls, 1);

r = await scenario(4, 0, 7, 5);
eq('tele sorra tovább próbálva SEMMI nem vész el', [r.inGame, r.left], [4, 3]);

console.log('\n=== Az eltűnés szerkezetileg lehetetlen ===');
r = await scenario(0, 0, 3, 6);                      // a játék soha nem fogad el
eq('limit 0: mind a 3 megmarad', [r.inGame, r.left], [0, 3]);
window.TaskQueue = { queue: [], limit: { normal: 4 }, add() { throw new Error('boom'); } };
extraJobs = mkJobs(3); processing = false;
await processQueue();
eq('TaskQueue.add kivétel: a lista érintetlen', extraJobs.length, 3);
window.TaskQueue = undefined;
extraJobs = mkJobs(3); processing = false;
await processQueue();
eq('nincs TaskQueue: a lista érintetlen', extraJobs.length, 3);

console.log('\n=== Részben tele sor ===');
r = await scenario(4, 2, 5, 1);
eq('2 foglalt + 5 kért -> 2 indul, 3 marad', [r.inGame, r.left], [4, 3]);
r = await scenario(4, 4, 5, 1);
eq('tele sor -> 0 indul, 5 marad', [r.inGame, r.left], [4, 5]);
eq('tele sornál el sem küldjük a kérést', window.TaskQueue.addCalls, 0);

console.log('\n=== Prémium sorméret ===');
window.Premium.hasBonus = () => true;
r = await scenario(9, 0, 12, 1);
eq('prémium: 9 fér be', [r.inGame, r.left], [9, 3]);
window.Premium.hasBonus = () => false;

console.log('\n=== Sorok felszabadulásával minden elindul ===');
window.TaskQueue = makeGame(4, 0);
extraJobs = mkJobs(10);
for (let r2 = 0; r2 < 3; r2++) { processing = false; await processQueue(); window.TaskQueue.queue.length = 0; }
eq('3 kör, közben ürül: 10-ből 10 elindult', extraJobs.length, 0);



// ============================================================
//  Időtartam-értelmezés (a játék tömör alakot használ: "15mp")
// ============================================================
console.log('\n=== parseDurationText ===');
eval(extract('parseDurationText'));
for (const [txt, want] of [['15mp',15],['45mp',45],['10p',600],['30p',1800],['1ó',3600],
                           ['1ó30p',5400],['1 ó 30 p',5400],['15 mp',15],['1óra',3600],
                           ['',null],['???',null]])
    eq(`parseDurationText(${JSON.stringify(txt)})`, parseDurationText(txt), want);

// ============================================================
//  Tárolás: verziózás, migráció, sérült adat
// ============================================================
console.log('\n=== Tárolás ===');
const store = {};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k,v) => { store[k]=v; }, removeItem: k => { delete store[k]; } };
CONFIG.STORAGE_VERSION = 2;
CONFIG.MAX_HISTORY = 60;
eval([extract('saveStore'), extract('loadStore'), extract('sanitizeJobs')].join('\n'));
const K = 'lisa_extra_queue', LEG = 'lisa_extra_params_v1020';

saveStore(K, [{ jobId: 1 }]);
eq('mentés/olvasás körbejár', loadStore(K), [{ jobId: 1 }]);
eq('a burkolat hordozza a verziót', JSON.parse(store[K]).v, 2);
store[K] = JSON.stringify([{ jobId: 9 }]);
eq('verziózatlan tömb is olvasható', loadStore(K), [{ jobId: 9 }]);
delete store[K];
store[LEG] = JSON.stringify([{ jobId: 42, jobName: 'Régi' }]);
eq('migráció a régi kulcsról', loadStore(K, LEG), [{ jobId: 42, jobName: 'Régi' }]);
store[K] = '{{{nem json';
eq('sérült JSON nem dob', loadStore(K), null);
eq('hiányzó kulcs -> null', loadStore('nincs_ilyen'), null);
eq('szemét kiszűrve', sanitizeJobs([{jobId:5}, null, {}, {jobId:'abc'}]).length, 1);
const sj = sanitizeJobs([{ jobId: '7', x: '3', duration: 'xx' }])[0];
eq('számmá alakít', [sj.jobId, sj.x], [7, 3]);
eq('rossz duration -> default', sj.duration, 900);
eq('hiányzó név pótolva', sj.jobName, 'Job #7');
eq('felső korlát', sanitizeJobs(new Array(900).fill({ jobId: 1 })).length, 500);


// ============================================================
//  Vezetőválasztás: a látható fül soha ne maradjon némán passzív
// ============================================================
console.log('\n=== Vezetőválasztás ===');
CONFIG.STORAGE_LEADER = 'lisa_leader_tab';
CONFIG.LEADER_TTL = 15000;
let TAB_ID = 'engem';
let visibility = 'visible';
global.document = { visibilityState: 'visible' };
Object.defineProperty(global.document, 'visibilityState', { get: () => visibility });
eval([extract('isVisible'), extract('refreshLeadership'), extract('releaseLeadership')].join('\n'));

const setLeader = o => { store[CONFIG.STORAGE_LEADER] = JSON.stringify(o); };
const getLeader = () => JSON.parse(store[CONFIG.STORAGE_LEADER] || 'null');

delete store[CONFIG.STORAGE_LEADER];
isLeaderTab = false; refreshLeadership();
eq('egyedüli fül vezető lesz', isLeaderTab, true);

// Háttérben lévő vezető + látható fül -> a látható elveszi (ez volt a hiba)
setLeader({ id: 'masik', ts: Date.now(), visible: false });
isLeaderTab = false; visibility = 'visible'; refreshLeadership();
eq('látható fül elveszi a háttérfültől', isLeaderTab, true);
eq('a bejegyzés a miénk lesz', getLeader().id, 'engem');

// Látható vezető + látható fül -> nem vesszük el (duplikálás elleni védelem marad)
setLeader({ id: 'masik', ts: Date.now(), visible: true });
isLeaderTab = true; refreshLeadership();
eq('látható vezetőt nem előzünk meg', isLeaderTab, false);

// Rejtett fül nem veszi el a látható vezetőtől
setLeader({ id: 'masik', ts: Date.now(), visible: false });
isLeaderTab = false; visibility = 'hidden'; refreshLeadership();
eq('rejtett fül nem vesz át', isLeaderTab, false);
visibility = 'visible';

// Lejárt bejegyzést bárki átvehet
setLeader({ id: 'masik', ts: Date.now() - 60000, visible: true });
isLeaderTab = false; refreshLeadership();
eq('lejárt vezetés átvehető', isLeaderTab, true);

// Bezáráskor elengedjük -> a következő fül azonnal átveheti
setLeader({ id: 'engem', ts: Date.now(), visible: true });
releaseLeadership();
eq('bezáráskor elengedi a sajátját', getLeader(), null);
setLeader({ id: 'masik', ts: Date.now(), visible: true });
releaseLeadership();
eq('másét nem törli', getLeader().id, 'masik');



// ============================================================
//  Várható kezdés/befejezés láncolása
// ============================================================
console.log('\n=== Időpontbecslés ===');
// A játékban mérve: az idő pontosan lineáris az euklideszi távolsággal,
// 0.017647 mp/egység. A calcWayTo az AKTUÁLIS pozícióból számol.
const SEC_PER_UNIT = 0.017647;
let charPos = { x: 0, y: 0 };
global.Character = {
    getPosition: () => charPos,
    calcWayTo: (x, y) => Math.hypot(x - charPos.x, y - charPos.y) * SEC_PER_UNIT,
};
window.Character = global.Character;
eval(['secondsPerDistanceUnit','currentPosition','queueTailAnchor','computeEtas','clockHM','dayOffset','formatEta']
     .map(extract).join('\n'));

eq('mp/egység a calcWayTo-ból származik', +secondsPerDistanceUnit().toFixed(6), SEC_PER_UNIT);

// Üres játéksor: a lánc mostantól és a karakter pozíciójától indul
window.TaskQueue = { queue: [], limit: { normal: 4, premium: 9 } };
charPos = { x: 0, y: 0 };
const t0 = Date.now();
let etas = computeEtas([
    { id: 'a', x: 1000, y: 0, duration: 60 },     // 17.647 mp út, 60 mp munka
    { id: 'b', x: 1000, y: 0, duration: 30 },     // ugyanott: 0 út
]);
eq('1. munka utazási ideje', Math.round(etas[0].travelMs / 1000), 18);
eq('1. munka hossza', Math.round((etas[0].finish - etas[0].start) / 1000), 60);
eq('2. munka az 1. után indul (nincs út)', Math.round((etas[1].start - etas[0].finish) / 1000), 0);
eq('2. munka hossza', Math.round((etas[1].finish - etas[1].start) / 1000), 30);

// A távolság az ELŐZŐ munkától számít, nem a karaktertől
etas = computeEtas([
    { id: 'a', x: 1000, y: 0, duration: 0 },
    { id: 'b', x: 3000, y: 0, duration: 0 },      // 2000 egység az előzőtől
]);
eq('a 2. utazása az előző helyszínétől', Math.round(etas[1].travelMs / 1000), Math.round(2000 * SEC_PER_UNIT));

// Nem üres játéksor: a lánc a LEGKÉSŐBB végző munka után és onnan indul
const future = Date.now() + 600000;
window.TaskQueue.queue = [
    { data: { date_done: Date.now() + 60000 }, post: { x: 500, y: 0 } },
    { data: { date_done: future },             post: { x: 2000, y: 0 } },   // ez a "farok"
    { data: { date_done: Date.now() + 120000 }, post: { x: 900, y: 0 } },
];
etas = computeEtas([{ id: 'a', x: 2000, y: 0, duration: 120 }]);
eq('a lánc a legkésőbbi végénél kezdődik', Math.round((etas[0].start - future) / 1000), 0);
etas = computeEtas([{ id: 'a', x: 4000, y: 0, duration: 0 }]);
eq('utazás a farok helyszínéről', Math.round(etas[0].travelMs / 1000), Math.round(2000 * SEC_PER_UNIT));

// Lejárt sor: a múltbeli date_done nem tolja vissza a becslést
window.TaskQueue.queue = [{ data: { date_done: Date.now() - 999999 }, post: { x: 0, y: 0 } }];
etas = computeEtas([{ id: 'a', x: 0, y: 0, duration: 60 }]);
eq('múltbeli befejezés nem húz vissza', etas[0].start >= Date.now() - 1000, true);

// calcWayTo nélkül is ad becslést, csak utazás nélkül
const savedChar = global.Character;
global.Character = undefined; window.Character = undefined;
window.TaskQueue.queue = [];
etas = computeEtas([{ id: 'a', x: 9999, y: 9999, duration: 60 }]);
eq('calcWayTo nélkül nincs utazás', etas[0].travelMs, 0);
eq('és jelezzük, hogy nem teljes a becslés', etas[0].estimated, false);
global.Character = savedChar; window.Character = savedChar;

// Formázás
const base = new Date(); base.setHours(9, 5, 0, 0);
eq('rövid óra:perc alak', formatEta({ start: base.getTime(), finish: base.getTime() + 3600000 }), '09:05→10:05');
const tomorrow = base.getTime() + 26 * 3600000;
eq('másnapi vég jelölve', formatEta({ start: base.getTime(), finish: tomorrow }).endsWith('+1'), true);


// ============================================================
//  Külső megszakításra gyors reagálás
// ============================================================
console.log('\n=== Slot-figyelő ===');
CONFIG.SLOT_FREED_DELAY = 1500;
const updateKeepAwake = () => {};   // ébrentartás: böngészőfüggő, itt nem mérhető
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

eq('sor rövidült -> hamarosan indít', watchCase({ len: 3, lastSeen: 4, waiting: 2 }), 1500);
eq('változatlan sor -> nem piszkál', watchCase({ len: 4, lastSeen: 4, waiting: 2 }), null);
eq('növekvő sor -> nem piszkál', watchCase({ len: 4, lastSeen: 3, waiting: 2 }), null);
eq('nincs várakozó munka -> nem indít', watchCase({ len: 3, lastSeen: 4, waiting: 0 }), null);
eq('tele a sor -> nem indít', watchCase({ len: 4, lastSeen: 5, waiting: 2 }), null);
eq('szüneteltetve -> nem indít', watchCase({ len: 3, lastSeen: 4, waiting: 2, paused: true }), null);
eq('passzív fül -> nem indít', watchCase({ len: 3, lastSeen: 4, waiting: 2, leader: false }), null);
eq('épp fut egy kör -> nem indít', watchCase({ len: 3, lastSeen: 4, waiting: 2, processing: true }), null);
eq('hosszú várakozást megelőz', watchCase({ len: 3, lastSeen: 4, waiting: 2, pendingTimer: true, deadlineInMs: 300000 }), 1500);
eq('közelebbi időzítőt nem tol el', watchCase({ len: 3, lastSeen: 4, waiting: 2, pendingTimer: true, deadlineInMs: 500 }), null);
// Elutasítás után ne kezdjen kétmásodpercenként próbálkozni: második hívás már nem indít
watchCase({ len: 3, lastSeen: 4, waiting: 2 });
eq('ismételt hívás új csökkenés nélkül csendes', (scheduled = null, watchGameQueue(), scheduled), null);
paused = false; isLeaderTab = true; processing = false;


// ============================================================
//  Időtartam a MEGNYOMOTT sávból (magas szintű fiókok)
// ============================================================
console.log('\n=== Időtartamsávok ===');
global.JobList = { getDurations: () => ({ short:{duration:15,requirement:1},
                                          middle:{duration:600,requirement:10},
                                          long:{duration:3600,requirement:20} }) };
window.JobList = global.JobList;
jobHistory = [];
eval([extract('durationFromBar'), extract('parseJobWindow')].join('\n'));

// Minimális DOM-utánzat: csak amit a parseJobWindow használ
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
eq('short gomb -> 15 mp', parseJobWindow(winHigh, mkBtn(barsHigh[0])).duration, 15);
eq('middle gomb -> 600 mp', parseJobWindow(winHigh, mkBtn(barsHigh[1])).duration, 600);
eq('long gomb -> 3600 mp', parseJobWindow(winHigh, mkBtn(barsHigh[2])).duration, 3600);
eq('koordináták a class-ból', (j => [j.jobId, j.x, j.y])(parseJobWindow(winHigh, mkBtn(barsHigh[2]))), [7, 43879, 17869]);

// Alacsony szint: csak a short aktív, a többi letiltott gomb nélkül
const barsLow = [mkBar('short', false, '15mp'), mkBar('middle', true), mkBar('long', true)];
eq('alacsony szint -> 15 mp', parseJobWindow(mkWindow(barsLow, CLS), mkBtn(barsLow[0])).duration, 15);

// Ismeretlen data-base esetén a szöveg a tartalék
const oddBar = mkBar(undefined, false, '10p');
eq('data-base nélkül a szövegből', parseJobWindow(mkWindow([oddBar], CLS), mkBtn(oddBar)).duration, 600);

// Se base, se szöveg -> előzmény, majd default
const blank = mkBar(undefined, false, null);
jobHistory = [{ jobId: 7, duration: 1234 }];
eq('előzményből pótolva', parseJobWindow(mkWindow([blank], CLS), mkBtn(blank)).duration, 1234);
jobHistory = [];
eq('végső tartalék a default', parseJobWindow(mkWindow([blank], CLS), mkBtn(blank)).duration, CONFIG.DEFAULT_DURATION);

// Gomb nélkül (nem elkapott kattintás) az első aktív sávra esik vissza
eq('gomb nélkül az első aktív sáv', parseJobWindow(winHigh, null).duration, 15);
eq('nem munkaablak -> null', parseJobWindow(mkWindow(barsHigh, 'tw2gui_window valami'), null), null);

// ============================================================
//  A játék sorában az utazás beleszámít az időbe
// ============================================================
console.log('\n=== Utazás a sorelem idejében ===');
eval(extract('formatClock'));
eq('0 mp út -> csak a munkaidő', formatClock(0 + 15), '00:00:15');
eq('5 mp út + 15 mp munka', formatClock(5 + 15), '00:00:20');
eq('29 mp út + 15 mp munka', formatClock(29 + 15), '00:00:44');
eq('10 perces munka', formatClock(0 + 600), '00:10:00');
eq('1 órás munka úttal', formatClock(120 + 3600), '01:02:00');


// ============================================================
//  Gyorsindító nyilak: helyszín a legközelebbi munkacsoportból
// ============================================================
console.log('\n=== Gyorsindítás ===');
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

// Élesben mért elrendezés: a csoport a szétnyílt kör közepén, a következő 528 px-re
groups = [mkGroup(41966, 16411, 816, 464), mkGroup(40224, 16507, 816 - 528, 464)];
eq('a kör közepi csoport nyer', (g => [g.x, g.y])(nearestJobGroup(rectOf(816, 389))), [41966, 16411]);
eq('szélső ikonnál is ugyanaz', (g => [g.x, g.y])(nearestJobGroup(rectOf(886, 504))), [41966, 16411]);

// Túl messze -> nincs találat, a kattintás a játéké marad
groups = [mkGroup(41966, 16411, 100, 100)];
eq('távoli csoportot nem fogadunk el', nearestJobGroup(rectOf(816, 389)), null);
groups = [];
eq('csoport nélkül null', nearestJobGroup(rectOf(816, 389)), null);

// A jobId/base kiolvasás osztálynevekből (a valódi osztályokkal)
const idOf  = cls => (cls.match(/\bjob-(\d+)\b/) || [])[1];
const baseOf = cls => (cls.match(/instantwork-(short|middle|long)/) || [])[1];
eq('jobId a .job-128-ból', idOf('job job-128 hasMousePopup'), '128');
eq('jobgroup nem ad jobId-t', idOf('image x-157 y-64 posx-40224 posy-16507 jobgroup jobgroup-12'), undefined);
eq('short nyíl', baseOf('instantwork-short'), 'short');
eq('middle nyíl', baseOf('instantwork-middle'), 'middle');
eq('long nyíl', baseOf('instantwork-long'), 'long');
eq('a base időtartamra képez', JobList.getDurations()[baseOf('instantwork-long')].duration, 3600);

// ============================================================
//  "Összes törlése" csak megerősítés után ürít
// ============================================================
console.log('\n=== Összes törlése ===');
let statusText = '';
const updateUIStatusReal = (t) => { statusText = t; };
eval(extract('clearExtraAfterCancelAll').replace('updateUIStatus(', 'updateUIStatusReal('));
extraJobs = mkJobs(5);
clearExtraAfterCancelAll();
eq('megerősítés után ürül a lista', extraJobs.length, 0);
eq('a státusz megmondja, mennyit törölt', /5 várakozó/.test(statusText), true);
statusText = '';
clearExtraAfterCancelAll();
eq('üres listánál nincs üzenet', statusText, '');

// ============================================================
//  Barátságos időkiírás (a státuszsor korábban "~400 mp"-et mutatott)
// ============================================================
console.log('\n=== Időtartam-formázás ===');
// A formatDuration-t a processQueue miatt már fent kiemeltük.
eq('egy perc alatt másodperc marad', formatDuration(45), '45 mp');
eq('pont egy perc', formatDuration(60), '1 p');
eq('400 mp -> felfelé kerekített perc', formatDuration(400), '7 p');
eq('59 mp-cel több perc is felkerekít', formatDuration(61), '2 p');
eq('59 perc még perc', formatDuration(3540), '59 p');
eq('pont egy óra', formatDuration(3600), '1 ó');
eq('óra és perc', formatDuration(3600 + 400), '1 ó 7 p');
eq('kerek óra nem ír 0 percet', formatDuration(7200), '2 ó');
eq('hosszú lista összege', formatDuration(24 * 900), '6 ó');
eq('nulla', formatDuration(0), '0 mp');

// ============================================================
//  A "+N" csempe az utolsó munkahelyre ül (nem külön sorba)
// ============================================================
console.log('\n=== Játékbeli előnézet felosztása ===');
eval(extract('previewSplit'));
eq('kevesebb, mint a keret: minden látszik', previewSplit(3, 6), { shown: 3, hidden: 0 });
eq('pont annyi: még mindig nincs csempe', previewSplit(6, 6), { shown: 6, hidden: 0 });
eq('eggyel több: 5 munka + "+2"', previewSplit(7, 6), { shown: 5, hidden: 2 });
eq('sok munka: 5 munka + "+20"', previewSplit(25, 6), { shown: 5, hidden: 20 });
eq('a csempe mindig a maradékot mondja',
   (s => s.shown + s.hidden)(previewSplit(25, 6)), 25);

// ============================================================
//  A szerver utólagos elutasítása nem veszejtheti el a munkát
// ============================================================
// Élesben mért eset: a TaskQueue.add szinkron push-ol, a script elfogadottnak
// veszi őket, majd a szerver visszautasítja (szintkövetelmény), a játék kiveszi
// a sorból -- és a munkák a listáról már eltűntek. 8 munka veszett így el.
console.log('\n=== Szerveroldali elutasítás ===');
eval([extract('parseBodyParams'), extract('extractTasksFromBody'),
      extract('rejectedFromAddResponse'), extract('addResponseMatchesBatch')].join('\n'));
global.URLSearchParams = require('url').URLSearchParams;

const body3 = 'tasks[0][jobId]=129&tasks[0][x]=1&tasks[0][y]=2&tasks[0][duration]=15&tasks[0][taskType]=job'
            + '&tasks[1][jobId]=127&tasks[1][x]=3&tasks[1][y]=4&tasks[1][duration]=600&tasks[1][taskType]=job'
            + '&tasks[2][jobId]=60&tasks[2][x]=5&tasks[2][y]=6&tasks[2][duration]=3600&tasks[2][taskType]=job';
const parsed3 = extractTasksFromBody(body3);
eq('a kérés minden munkája kijön', parsed3.length, 3);
eq('sorrendhelyesen', parsed3.map(t => t.jobId), [129, 127, 60]);
eq('az időtartam is megvan', parsed3.map(t => t.duration), [15, 600, 3600]);
eq('egyetlen munkás kérés is jó', extractTasksFromBody('tasks[0][jobId]=7&tasks[0][duration]=15').length, 1);
eq('munka nélküli test -> üres', extractTasksFromBody('window=task&action=add').length, 0);

const b3 = [{ jobId: 129, duration: 15 }, { jobId: 127, duration: 600 }, { jobId: 60, duration: 3600 }];
eq('a saját kötegünk felismerhető', addResponseMatchesBatch(parsed3, b3), true);
eq('más hosszúságú köteg nem a miénk', addResponseMatchesBatch(parsed3, b3.slice(0, 2)), false);
eq('más munka nem a miénk',
   addResponseMatchesBatch(parsed3, [{ jobId: 1, duration: 15 }, b3[1], b3[2]]), false);
eq('köteg nélkül nincs párosítás', addResponseMatchesBatch(parsed3, null), false);

// Az élesben mért válaszalak: tasks[i] vagy {task:{...}}, vagy {error,msg}
const okEntry = { task: { queue_id: 1, date_done: 1785828704.77 } };
eq('csupa siker -> nincs visszautasított',
   rejectedFromAddResponse(b3, { tasks: [okEntry, okEntry, okEntry] }).length, 0);
const mixed = rejectedFromAddResponse(b3, {
    tasks: [okEntry, { error: true, msg: 'Legalább a 53 szintet kell elérned' }, okEntry] });
eq('a hibás elem indexre párosít', mixed.length, 1);
eq('a megfelelő munka bukott el', mixed[0].job.jobId, 127);
eq('a szerver üzenete megmarad', /53 szintet/.test(mixed[0].msg), true);
eq('felső szintű hiba -> az EGÉSZ köteg elbukott',
   rejectedFromAddResponse(b3, { error: true, msg: 'Nincs elég energiád' }).length, 3);
eq('hiba nélküli, tasks nélküli válasz nem bukás',
   rejectedFromAddResponse(b3, { energy: 97 }).length, 0);
eq('a válasznál rövidebb köteg nem indexel túl',
   rejectedFromAddResponse([b3[0]], { tasks: [okEntry, { error: true, msg: 'x' }] }).length, 0);
eq('üres kötegre üres', rejectedFromAddResponse([], { tasks: [{ error: true }] }).length, 0);

// A visszatartás duplázódik: az energiahiány órás nagyságrendű, fix 20 mp-es
// újrapróbálással a munka percek alatt elfogyasztaná a próbálkozásait.
CONFIG.REJECT_BACKOFF_MS = 20000; CONFIG.REJECT_BACKOFF_MAX = 600000; CONFIG.MAX_REJECTIONS = 10;
eval(extract('rejectBackoffMs'));
eq('első elutasítás után 20 mp', rejectBackoffMs(1), 20000);
eq('másodszor duplázva', rejectBackoffMs(2), 40000);
eq('ötödször 5 perc 20', rejectBackoffMs(5), 320000);
eq('a felső korlát 10 perc', rejectBackoffMs(9), 600000);
eq('nulla/hiányzó érték is legalább egy kör', rejectBackoffMs(0), 20000);
// A tíz próbálkozás összesen több mint egy órát fed le -- egy energiahiányos
// munka (3 energia/óra regeneráció) így kivárja, amíg indíthatóvá válik.
const totalWait = Array.from({length: CONFIG.MAX_REJECTIONS}, (_, i) => rejectBackoffMs(i + 1))
    .reduce((a, b) => a + b, 0);
eq('a próbálkozások együtt > 1 óra', totalWait > 3600000, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
