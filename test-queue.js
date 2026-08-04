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
const ensureProcessing = () => {};
const scheduleNextJob = (ms) => { scheduled = ms; nextJobTimer = 1; };
const generateId = (() => { let n = 0; return () => 'id' + (++n); })();
const quiet = () => {};
const real = console.log;
console.log = quiet; console.warn = quiet; console.error = quiet;

eval([
    'gameReady', 'gameQueueLength', 'gameQueueLimit', 'freeSlots', 'nextFreeAtMs',
    'waitUntilFreeSlotMs', 'startJobsViaGame', 'addExtraJobs',
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
