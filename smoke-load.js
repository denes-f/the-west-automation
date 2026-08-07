// Load smoke test: `node smoke-load.js`.
//
// test-queue.js pulls the individual functions out BY NAME, so it cannot notice when
// the script as a WHOLE fails to load -- a typo'd global, a const in the temporal dead
// zone, or a missing browser API would only show up live, as an empty panel.
// This test runs the entire IIFE in a stubbed browser and checks that lisaDiag() came
// up. It does not replace test-queue.js, it just runs before it.
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, 'the-west-automation.js'), 'utf8');

const listeners = {};
const el = () => ({
  style: {}, classList: { add(){}, remove(){}, contains(){return false} },
  addEventListener(){}, removeEventListener(){}, appendChild(){}, remove(){},
  setAttribute(){}, getAttribute(){return null}, querySelector(){return null},
  querySelectorAll(){return []}, children: [], textContent: '', title: '', isConnected: true,
});
const timers = [];
const sandbox = {
  console,
  setTimeout: (f, ms) => { timers.push({f, ms}); return timers.length; },
  clearTimeout: () => {},
  setInterval: (f, ms) => { timers.push({f, ms, repeat: true}); return timers.length; },
  clearInterval: () => {},
  Date, Math, JSON, Object, Array, String, Number, Boolean, Error, Promise, RegExp,
  ArrayBuffer, DataView, Uint8Array, Int16Array, URL,
  Blob: class { constructor(p, o) { this.parts = p; this.type = o && o.type; } },
  Worker: class { constructor(u) { this.url = u; } terminate(){} },
  Audio: class { constructor(u){ this.src=u; this.paused=true; this.currentTime=0; }
    play(){ this.paused=false; return Promise.resolve(); } pause(){ this.paused=true; }
    addEventListener(){} setAttribute(){} },
  localStorage: { store: {}, getItem(k){return this.store[k]||null}, setItem(k,v){this.store[k]=v},
                  removeItem(k){delete this.store[k]} },
  navigator: { wakeLock: undefined, userAgent: 'node' },
  XMLHttpRequest: class { open(){} send(){} setRequestHeader(){} addEventListener(){} },
  document: {
    readyState: 'complete', visibilityState: 'visible', hasFocus: () => true,
    addEventListener(t, f){ (listeners[t] = listeners[t] || []).push(f); },
    createElement: el, querySelector(){ return null; }, querySelectorAll(){ return []; },
    body: el(), head: el(), documentElement: el(),
  },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.URL.createObjectURL = () => 'blob:stub';
sandbox.URL.revokeObjectURL = () => {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'the-west-automation.js' });

if (typeof sandbox.window.lisaDiag !== 'function') throw new Error('lisaDiag is missing');
const d = sandbox.window.lisaDiag();
console.log('lisaDiag ->', JSON.stringify(d));
console.log(`timers registered: ${timers.length}`);
console.log('SMOKE TEST OK');
