/* ============================================================
   Monthly Plan — your settings
   ============================================================
   Copy this file to config.local.js and edit it. config.local.js is
   git-ignored, so your plan stays on your machine; without it the app
   runs on the examples built into index.html.

   Once you've logged some days, two rules keep your history honest —
   past scores are recomputed from the log every time:
   - keep task ids stable, and give a task you add later a since date
     (it's faded and unscored before that day);
   - don't change an existing task's points; add a new task instead. */
window.MONTHLY_PLAN_CONFIG = {
  START: { y: 2026, m: 0, d: 1 },        // day one — m is 0-based (January = 0)

  JOURNAL_SINCE: '',                     // journal's first page, 'YYYY-MM-DD' ('' = day one)
  HYG_SINCE: '',                         // only if you add the hygiene gates mid-run ('' = from day one)

  WEIGHT_START: 80, WEIGHT_TARGET: 72,   // kg — your starting weight and your goal
  MONEY_BUDGET: 1000,                    // daily spending reference line (currency: LKR)

  /* Groups: 'All day', 'Morning', 'Afternoon', 'Evening', 'Night'.
     pts   — added when done, SUBTRACTED when missed. That's the point.
     Special rows (keep these ids): weight, water (type 'counter', ml),
     money, sleep (type 'number', hours).
     gym / rest — the label (and points) change with the day's gym toggle;
                  set one to null and the task doesn't exist that kind of day.
     hygiene    — the A and S rank gates need all of these done.
     bonus + unscored — tracked only, worth nothing either way.
     since      — 'YYYY-MM-DD' for a task added after day one. */
  TASKS: [
    { id:'weight',    group:'All day',   icon:'⚖️', label:'Weigh-in',                     pts:0,  type:'weight', unscored:true },
    { id:'water',     group:'All day',   icon:'💧', label:'Water',                        pts:8,  type:'counter' },
    { id:'money',     group:'All day',   icon:'💵', label:'Money spent',                  pts:0,  type:'money', unscored:true },
    { id:'washam',    group:'Morning',   icon:'🧼', label:'Morning wash',                 pts:1,  hygiene:true },
    { id:'brusham',   group:'Morning',   icon:'🪥', label:'Brush teeth (morning)',        pts:1,  hygiene:true },
    { id:'breakfast', group:'Morning',   icon:'🥣', label:'Healthy breakfast',            pts:5,
      gym: { label:'Protein before the gym', pts:5 },
      rest:{ label:'Healthy breakfast',      pts:5 } },
    { id:'readam',    group:'Morning',   icon:'📖', label:'Read for 20 minutes',          pts:5  },
    { id:'nosugaram', group:'Morning',   icon:'🚫', label:'No sugary snacks (morning)',   pts:6  },
    { id:'coffee',    group:'Morning',   icon:'☕', label:'Coffee before noon only',      pts:0,  bonus:true, unscored:true },
    { id:'lunch',     group:'Afternoon', icon:'🥗', label:'Balanced lunch',               pts:5  },
    { id:'nosugarpm', group:'Afternoon', icon:'🙅', label:'No sugary snacks (afternoon)', pts:6  },
    { id:'walk',      group:'Afternoon', icon:'🚶', label:'Walk 8,000 steps',             pts:6  },
    { id:'dinner',    group:'Evening',   icon:'🍲', label:'Light dinner before 8 PM',     pts:6  },
    { id:'nojunk',    group:'Evening',   icon:'🍕', label:'No junk food',                 pts:8  },
    { id:'washpm',    group:'Night',     icon:'🧼', label:'Night wash',                   pts:1,  hygiene:true },
    { id:'brushpm',   group:'Night',     icon:'🪥', label:'Brush teeth (night)',          pts:1,  hygiene:true },
    { id:'nophone',   group:'Night',     icon:'📵', label:'No phone in bed',              pts:6  },
    { id:'sleep',     group:'Night',     icon:'😴', label:'Sleep 6–8 hours',              pts:12, type:'number' },
  ],
};
