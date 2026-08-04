# The-West Modular Job Queue (Lisa)

Tampermonkey userscript for the browser game **The West** (Hungarian servers, `*.the-west.hu`).
The game's own job queue holds 4 tasks (9 with premium). This script keeps an **extra queue** of
jobs beyond that limit and feeds them in as slots free up.

- `the-west-automation.js` — the whole userscript, single IIFE, no build step.
- `test-queue.js` — `node test-queue.js`. Extracts the real functions out of the userscript by
  name and runs them against stubs. 93 assertions, no dependencies.

The user installs the script by pasting it into Tampermonkey. There is no deploy step.

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

### Durations

`JobList.getDurations()` → `{short:{duration:15,requirement:1}, middle:{duration:600,requirement:10},
long:{duration:3600,requirement:20}}`. So 15 s, 10 min, 1 hour, unlocked at levels 1/10/20.

The job window has **three duration bars**, each `.job_durationbar` with `data-base="short|middle|long"`,
and **each holds its own `.job_startbutton`**. At low level only the short bar has one, which hides
the trap: taking "the first non-disabled bar" silently returns 15 s for every job on a high-level
account. Read the duration from the bar containing the **clicked** button, mapping `data-base`
through `getDurations()`. The amount selector (`.job-amount-num`) is **outside** the bars and shared.

Bar duration text is compact — `15mp`, `10p`, `1ó` — but prefer `data-base`; text parsing is fallback only.

### Travel time

- `Character.calcWayTo(x, y)` → seconds, **from the character's current position only**.
- Travel is **exactly linear in Euclidean distance** (measured 0.017647 s/unit across seven offsets,
  identical in all directions; Manhattan ruled out). For point-to-point, derive the rate at runtime:
  `calcWayTo(here.x + 1000, here.y) / 1000`. That picks up horse and speed buffs automatically —
  don't hardcode the constant.
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
- **`.middle` has a direct click handler** reacting to `taskAbort` / `taskHalveway` /
  `taskInstantFinish` / `centermap` / `icon` and parsing the queueId out of the class name.
  Injected rows reusing those classes **must** `stopImmediatePropagation()`, or clicking them
  cancels a real job. Verified: with the guard the game handler fires 0 times; an identical
  control element without it fires once.
- The game **rebuilds `#queuedTasks` when the queue changes** (not on every tick), so injected rows
  must be re-added — the 2 s watcher does this.
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
- **`watchGameQueue`** every 2 s: refreshes the badge and ETAs, re-injects in-game rows, and on a
  **decrease** in queue length starts the next job within 1.5 s. Keying on the decrease (not on
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
