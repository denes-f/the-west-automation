# The-West Modular Job Queue (Lisa)

Tampermonkey userscript for the browser game **The West** (Hungarian servers, `*.the-west.hu`).
The game's own job queue holds 4 tasks (9 with premium). This script keeps an **extra queue** of
jobs beyond that limit and feeds them in as slots free up.

- `the-west-automation.js` — the whole userscript, single IIFE, no build step.
- `test-queue.js` — `node test-queue.js`. Extracts the real functions out of the userscript by
  name and runs them against stubs. 125 assertions, no dependencies.

The user installs the script by pasting it into Tampermonkey. There is no deploy step, so after
any change ask them to reinstall before testing live.

**Current release: v12.1.** Feature-complete and in daily use. The behaviour below is all verified;
treat it as the baseline rather than something to redesign.

## Picking up a new session

0. The test account for `hu27` is in `local-notes.md` (**gitignored** — the repo has a GitHub
   remote, so no credentials in tracked files). The browser session is usually still signed in,
   so entering the world needs no password.
1. Read this file first — the game facts below cost many live browser sessions to establish.
2. `node test-queue.js` should print `125 passed, 0 failed`.
3. For anything touching the game, open one tab and measure. Do not reason from the code alone;
   the code is right *because* of these measurements, not the other way round.
4. Close your tab when finished and say what energy you spent.

## What the script does

- Intercepts **both** ways to start a job — the job window's start buttons and the map's quick-start
  arrows — and puts the whole batch at the end of its own `extraJobs` list.
- Feeds jobs into the game's queue as slots free, always in FIFO order.
- Shows waiting jobs in **two places**: its own game-style window (top right, scrollable) and as
  extra rows in the game's bottom-right queue widget, under a separator (6 shown, then `+N`).
- Shows predicted start→finish times per job, chaining travel between locations.
- Clears the waiting list when the user confirms the game's "cancel all".

## Ground rules learned the hard way

**Never guess the game's API or DOM — go and look.** Two separate bugs shipped because a response
format was assumed rather than observed, and both silently destroyed the user's queued jobs. Every
game-facing fact below was measured in a live browser session. If you need a new one, measure it too.

**Never remove a job from `extraJobs` before the game has accepted it.** `processQueue` peeks at
the head of the list and only splices after `TaskQueue.queue.length` actually grew. This is what
structurally prevents the "jobs vanished" class of bug — keep it that way.

**Energy is a real cost.** Every started job spends the character's energy. Test with 15-second
jobs, cancel afterwards (cancelling refunds part of it), and prefer read-only probing. Say what
you spent.

**Only one game tab.** A second tab holding the leader lock is what made v11.0 look completely
broken. Close your own tab when finished.

## Verified facts about the game

Measured on `hu27.the-west.hu` (Red Rock), character level 8.

### Queue and starting jobs

- `TaskQueue.queue` — live array of queued tasks. **Authoritative**; never model it separately.
- `TaskQueue.limit` — `{normal: 4, premium: 9}`. Which one applies: `Premium.hasBonus('automation')`.
- `TaskQueue.add(tasks)` — accepts a **single task or an array**, updates `queue` **synchronously**,
  and when full it **refuses silently and sends no request**. So "how many were accepted" is just
  the change in `queue.length`.
- `new TaskJob(jobId, x, y, duration)` — the constructor signature. Duration in seconds.
- Queue entries: `.post = {jobId, x, y, duration, taskType}`, `.data.date_done` in **milliseconds**
  (the add *response* uses seconds — don't mix them up), `.queueId`, `.queuePos`.
  `.post` is set by the `Task` base class, so every entry has it whatever created it.
- An **unqueued** `new TaskJob(...)` already answers `getIcon()` (an image URL) and `getTitle()`.

Always start jobs through `TaskQueue.add`, never raw XHR. Raw XHR reaches the server but leaves the
game client unaware — the job runs but never appears in the bottom-right queue UI.

### Add response shape

```json
{"tasks":[{"task":{"queue_id":…,"date_done":1785828704.77,"data_obj":{…}}}],"energy":91.78,…}
```

`tasks[i].task.date_done` — note the wrapper. `tasks` holds the tasks **added by this request**,
not the whole queue. Errors are `{"error":true,"msg":"…"}`. A bare `msg` with no `error` is **not**
a success — assuming it was is what ate three jobs.

**`tasks[]` is per-task and mixed**: the i-th element answers the i-th task of the request, and is
either `{"task":{…}}` or `{"error":true,"msg":"…"}`. Measured rejection (job requiring level 53
started at level 9):

```json
{"tasks":[{"error":true,"msg":"Legalább a 53 szintet kell elérned…"}],"energy":97.2,…}
```

**This is a live data-loss hazard.** `TaskQueue.add` pushes **synchronously**, so `queue.length`
grows and the script counts the jobs as accepted — but a few seconds later the server rejects them,
the game removes them from the queue, and the jobs are already gone from `extraJobs`. Verified:
8 seeded jobs, all silently lost, with the panel reporting "all started". The synchronous
length check alone is **not** proof of acceptance; only the response is.

### Durations

`JobList.getDurations()` → `{short:{duration:15,requirement:1}, middle:{duration:600,requirement:10},
long:{duration:3600,requirement:20}}`. So 15 s, 10 min, 1 hour, unlocked at levels 1/10/20.

The job window has **three duration bars**, each `.job_durationbar` with `data-base="short|middle|long"`,
and **each holds its own `.job_startbutton`**. At low level only the short bar has one, which hides
the trap: taking "the first non-disabled bar" silently returns 15 s for every job on a high-level
account. Read the duration from the bar containing the **clicked** button, mapping `data-base`
through `getDurations()`. The amount selector (`.job-amount-num`) is **outside** the bars and shared.

Bar duration text is compact — `15mp`, `10p`, `1ó` — but prefer `data-base`; text parsing is fallback only.

### Motivation and energy cost per job (read-only, no energy spent)

One call answers both, for a given job at a given place:

```js
Ajax.remoteCallMode("job", "job", {jobId, x, y}, json => …)
```

- `json.motivation` — **0…1**, so ×100 for percent. The job window itself does
  `parseInt(json.motivation * 100)`. Measured 1 → 0.9 after ~10 completed 15 s jobs of that job.
- `json.durations[]` — one entry **per unlocked duration**, each `{duration, cost, money, xp, luck,
  items}`. **`cost` is the energy cost** (1 for the 15 s bar at level 9; the 5 / 12 of the 10 min and
  1 h bars only appear once those are unlocked). This is the authoritative source — don't hardcode.
- Motivation drops by the job's energy cost when the job **completes**; energy is deducted when the
  job **enters the game's queue** and refunded if it is cancelled before completing.
- `EventHandler.signal('jobmotivation_change')` fires when motivation changes.

### Energy regeneration — exact formula from the game

`Game.tick4Character` computes, verbatim:

```js
energy = min(maxEnergy, floor(energy + maxEnergy * energyRegen * (serverTime - energyDate) / 3600))
```

- `Character.energy`, `Character.maxEnergy` (100; 150 with the bonus), `Character.energyRegen`
  (measured **0.03**), `Character.energyDate` (server time in **seconds**, the anchor of the above),
  `Game.getServerTime()` → seconds.
- So the rate is `maxEnergy * energyRegen` per hour = **3/h at 100 max**, and it scales by itself
  with a 150 max — never hardcode 2 or 3.
- `Character.levelEnergyFillup` is `true`: **levelling up refills energy completely**, which will
  make any forecast jump. Confirmed live (96 → 97 mid-test).

### Sleeping

- `TaskQueue.add(new TaskSleep(townId, room))` — same path as jobs; this is exactly what the
  hotel window's start button does (`HotelWindow.start`).
- `room` ∈ `['cubby','bedroom','hotel_room','apartment','luxurious_apartment']` (ordered worst→best,
  the index picks the icon).
- `sleep.onCancel(extra)` applies `extra.energy` — cancelling a sleep syncs the real energy back,
  so "cancel when full and move on" is supported by the game itself.
- `Character.homeTown` → `{town_id, x, y, town_name, alliance_id}`; `town_id` is **0** when the
  character has joined no town. The test account (`monkey`) has **no town**, so the sleep path
  cannot be exercised there — it needs an account that is a member of a town.

### Travel time

- `Character.calcWayTo(x, y)` → seconds, **from the character's current position only**.
- The implementation was read out of the bundle and is **exactly**:
  `GameMap.calcWayTime(from, to) = hypot(dx, dy) * Game.travelSpeed * Character.speed`.
  Both functions are **pure** — no DOM writes, no state changes, safe to call in a loop.
- So the seconds-per-unit rate is simply `Game.travelSpeed * Character.speed`; read it directly
  rather than probing (`calcWayTo(here.x + 1000, here.y) / 1000` is kept only as a fallback).
  Either way the horse and speed buffs are included — don't hardcode the constant.
- `Character.getPosition()` → `{x, y}`.
- The game folds travel **into** a queued row's displayed time (5 s travel + 15 s job → `00:00:20`).
  A separate travel row with the footprints icon exists only on the *currently running* task.

### DOM around the queue widget

```
#ui_bottomright > #ui_workcontainer > .middle > (#currentTask, #queuedTasks)
```

- `#queuedTasks` holds `<span class="task task-queuePos-N">` with `.taskTime > p`, `.taskBtns >
  (.taskHalveway, .taskAbort)`, `.icon` (background-image). Items are `inline-block` 112×67,
  wrapping 2 per row.
- The game also injects a **premium advert tile** of its own into that container
  (`getPremiumTask()`, appended when `showPremiumTask(queuePos)`) — a `span.task.hasMousePopup`
  with no text. Expect it when counting children; it is not one of ours.
- The **running** task (`#currentTask`) always carries a travel row: `.icon_taskway` +
  `.value` (title `Menetidő`), showing `00:00:00` once the character has arrived. It shows a
  **time**, never a distance — the game has no miles unit anywhere (see below).
- There is **no "mi" (miles) string in the game bundle at all** — searched the whole
  `cache/tw2game.hu_HU.js` (2.4 MB) for the token in every quoting/concatenation form, plus all
  CSS `content:` rules. Every distance the game displays is converted to a **duration** first
  (`getDistance2Town` = `calcWayTime(...).formatDuration()`), and `Number.prototype.formatDuration`
  renders `hh:mm:ss`. So a `1.000mi` on screen comes from neither the game nor this script.
- **`.middle` has a direct click handler** reacting to `taskAbort` / `taskHalveway` /
  `taskInstantFinish` / `centermap` / `icon` and parsing the queueId out of the class name.
  Injected rows reusing those classes **must** `stopImmediatePropagation()`, or clicking them
  cancels a real job. Verified: with the guard the game handler fires 0 times; an identical
  control element without it fires once.
- The game **rebuilds `#queuedTasks` when the queue changes** (not on every tick), so injected rows
  must be re-added. A `MutationObserver` does this immediately; relying on the poll made the rows
  visibly blink out and back on every completion.
- `.task`/`.icon` CSS is **scoped to `#queuedTasks`**. Rows placed in a sibling container lose all
  styling (collapse to `display:inline`, zero-height icon). They must live inside it, appended
  after the real ones so the game's index mapping is untouched.
- `#queuedTasks` is `display:none` when nothing is queued beyond the running task, and
  `#ui_workcontainer` is `display:none` when the queue is empty — injected rows are then invisible.
  Accepted limitation; forcing it visible would fight the game's own show/hide.
- The queue background is **light parchment**, so overlay text must be dark (`#4a3b28`), not cream.

### Map quick-start arrows

Clicking a `.jobgroup` on the map fans out individual `.job.job-{jobId}` icons in a circle; hovering
one reveals `.instantwork-short|-middle|-long` (all three exist in the CSS). This bypasses the job
window entirely.

- `.job-{id}` is a direct child of `#map` and carries **no coordinates**. The `.jobgroup` stays
  rendered underneath at the circle's centre — measured 0 px from it, next group 528 px away — so
  resolve the location by nearest group, with a distance guard.
- `#map` has a **delegated** click handler covering `.job` and `.instantwork`, so interception needs
  `stopImmediatePropagation()`.
- `JobList.getJobById(id).name` gives the display name.

### Window manager (`wman`) — the script's own panel

`wman.open(uid, title, windowclass, notanimated, noDrag, minimize_if_open)` creates a **real game
window** — frame, title bar, minimize/close buttons, dragging. The returned object has
`getContentPane()`, `appendToContentPane()`, `clearContentPane()`, `setSize`, `setMinSize/MaxSize`,
`setTitle`, `setResizeable`, `center`, `bringToTop`, `doLayout`, `saveAppearance`/`restoreAppearance`,
`destroy`. `wman.getById(uid)` retrieves it; `wman.close(uid)` closes it. `west.gui` also offers
`Scrollpane`, `Button`, `Table` etc. if native widgets are ever wanted.

Background layers, measured — these cap how tall a window can usefully be:

- `.tw2gui_window_inset` carries the **parchment field**: natural **721×420**, `no-repeat`, anchored
  bottom-left. Any window taller than ~454 px leaves the top bare.
- `.tw2gui_inner_window_bg2` is a **32×420** right-hand edge strip anchored bottom-right.

The script uses **320×210 at top-right (140 px down, 35 px in)** — deliberately short, about
4 visible rows, everything else by scrolling. Fixed chrome (title bar, status line, toolbar) eats
~134 px, so visible rows ≈ (height − 134) / 19.

**Keep the window under ~450 px and no override is needed** — the parchment covers it naturally and
the frame looks exactly like the game's. Stretching the layers to allow a taller window is possible
(`background-size: 100% 100%` on the inset, `auto 100%` on `bg2` — never both axes on `bg2`, it
smears the dark edge into a wide band) but it isn't worth it: the panel scrolls instead.

The frame has dark edge decorations on **both sides** that intrude into the content pane (the right
strip reaches ~21 px in). Inset the content (`margin: 0 20px 0 2px`) so the remove ✕ doesn't sit on
them.

`wman.close(uid)` **destroys** the window — `getById` then returns nothing and reopening yields an
**empty** content pane. So the panel must be rebuilt on reopen, and there must be a way back:
a `.ui_menucontainer` + `.menulink` appended to `#ui_menubar` renders right under the gear icon.
(`#ui_scripts` exists and looks like the natural home, but the game keeps it `display:none`.)

### Cancel-all

`#cancelAllInQueue` opens a confirm dialog ("Az összes munka törlése", Igen/Nem) and only empties the
queue on confirm. Detect the **confirmation**, not the click: watch for the dialog, then after any of
its buttons is pressed poll briefly for the queue actually reaching zero. That is locale-independent
and "Nem" correctly does nothing.

## Script architecture

- **Live state, no modelling.** Queue length, limit and next-free-slot all read from `TaskQueue`.
  An earlier shadow counter drifted constantly and caused most of the early bugs.
- **Click takeover.** Job-window start buttons and map quick-start arrows are both intercepted; the
  whole batch goes to the end of `extraJobs` and the processor starts what fits. This keeps order
  FIFO — otherwise a new job would jump into a free slot ahead of jobs already waiting.
- **`processQueue`** peek → `TaskQueue.add(batch)` → splice only what was accepted. On refusal it
  backs off; after `MAX_RETRIES` a job moves to the back, after `MAX_DEFERRALS` it is dropped loudly.
- **The add *response* is the real verdict.** The synchronous queue growth only proves the game
  accepted the jobs, not the server. `startJobsViaGame` remembers the batch (`inFlightBatch`), the
  XHR interceptor pairs the response's `tasks[i]` with it — matching by jobId+duration so a
  concurrent user-initiated start can't be mistaken for ours — and puts rejected jobs back at the
  **front** of the list, in order. They are **not** dropped after a couple of tries: the most
  common cause (not enough energy) passes by itself, so it retries slowly (`REJECT_BACKOFF_MS`)
  and only gives up after `MAX_REJECTIONS`, always showing the server's own message.
- **Keep-awake** (`updateKeepAwake`, only while jobs are waiting): a Screen Wake Lock against the
  display/machine sleeping — re-requested on `visibilitychange`, since the browser releases it when
  the tab is hidden — plus an inaudible looping WAV, because Chrome does not freeze a tab that is
  playing audio. A fully silent track would not count as playing, hence amplitude ±1. Neither
  replaces the OS/browser settings (`caffeinate`, Chrome Memory Saver exclusion).
- **In-game rows are re-injected by a `MutationObserver`** on `#queuedTasks`, not just by the timer.
  The game rebuilds that container on every queue change and drops our rows with it; waiting for the
  poll made them visibly blink out and back. The observer only re-renders when our separator is
  *absent*, so our own writes don't loop.
- **`watchGameQueue`** every 1 s: refreshes the badge and ETAs, re-injects in-game rows, and on a
  **decrease** in queue length starts the next job within 0.4 s. Keying on the decrease (not on
  "free slots exist") is deliberate — otherwise a refusal would retry every 2 s forever.
- **Leader lock** in `localStorage`: only one tab processes. A **visible** tab always takes over from
  a background one, leadership is released on `pagehide`. Without the visibility rule a forgotten
  background tab silently paralyses the tab the user is looking at.
- **Storage** is versioned in the *content*, not the key, with one-time migration from the old keys.
  Never version the key — that orphans the user's saved queue on every release.
- `jobHistory` has no UI any more (the Előzmények tab was removed once starting was wired into the
  game's own UI). It is kept only as a duration fallback in `parseJobWindow`.

## Conventions

- Code comments and all user-facing strings are **Hungarian**. Commit messages are Hungarian too.
- Comments explain *why*, especially where a subtle game behaviour forced the design. Keep them.
- Bump `@name`, `@version` and the boot `console.log` together on every release.
- Run `node test-queue.js` before committing. Add cases for anything measured in-game so it does not
  have to be rediscovered.
