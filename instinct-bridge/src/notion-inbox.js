/* ============================================================
   NOTION INBOX — a stand-in for writes, while Instinct can only read the bridge

   Instinct can write to Notion but can't send POST to us, so it leaves each
   change as a row in a Notion database ("Monthly Plan inbox"):
     Request (title)   what was asked, in words — "water +500, gym done"
     Action  (select)  day · note · edit note · delete note · deadline · edit deadline · delete deadline
                       · mind map · edit mind map · delete mind map · undo
     Body    (text)    the JSON the matching API endpoint takes
     Status  (select)  empty or New → Working → Done / Failed   (set by the bridge)
     Result  (text)    what happened, for Instinct to read back
   Every minute the Worker picks up new rows, oldest first, claims each one
   (Working) before applying it so a hiccup can't apply it twice, runs it
   through the same actions as the API — same rules, change log and undo —
   then writes Done or Failed with the reason.

   Temporary: to remove it, delete this file, its import and `scheduled` in
   index.js, the [triggers] block in wrangler.toml, and the NOTION_* secrets.
   ============================================================ */
const NOTION_VERSION = '2022-06-28';
const ACTIONS = {
  'day': ['POST', '/api/day'],
  'note': ['POST', '/api/note'], 'edit note': ['PATCH', '/api/note'], 'delete note': ['DELETE', '/api/note'],
  'deadline': ['POST', '/api/deadline'], 'edit deadline': ['PATCH', '/api/deadline'], 'delete deadline': ['DELETE', '/api/deadline'],
  'mind map': ['POST', '/api/mindmap'], 'edit mind map': ['PATCH', '/api/mindmap'], 'delete mind map': ['DELETE', '/api/mindmap'],
  'undo': ['POST', '/api/undo'],
};
export const INBOX_ACTIONS = Object.keys(ACTIONS);

async function notion(env, method, path, body){
  const res = await fetch('https://api.notion.com/v1' + path, {
    method, headers: { Authorization: 'Bearer ' + env.NOTION_TOKEN, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion ${res.status}: ${data.message || data.code || ''}`);
  return data;
}
const plain = prop => (prop && (prop.rich_text || prop.title) || []).map(t => t.plain_text || (t.text && t.text.content) || '').join('');
const chosen = prop => prop && prop.select ? prop.select.name : '';
const textProp = s => ({ rich_text: s ? [{ type: 'text', text: { content: s.slice(0, 1900) } }] : [] });
function mark(env, id, status, result){
  return notion(env, 'PATCH', `/pages/${id}`, { properties: { Status: { select: { name: status } }, ...(result != null ? { Result: textProp(result) } : {}) } });
}

/** Instinct writes JSON by hand: forgive curly quotes and a code fence around it. */
function readBody(s){
  const t = String(s || '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/^\s*```(?:json)?|```\s*$/g, '').trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch { throw new Error('Body isn\'t valid JSON: ' + t.slice(0, 80)); }
}

/** One line for the Result column — what was saved, or what went wrong. */
function said(action, r){
  if (!r.ok) return '✗ ' + r.error + (r.did_you_mean ? ' Did you mean: ' + r.did_you_mean.join(', ') + '?' : '')
                           + (r.options ? ' Options: ' + r.options.map(o => o.text || o).join(', ') : '');
  if (r.day) return `✓ ${r.changed.join(' · ')} — ${r.day.date}: score ${r.day.score}/${r.day.max}, water ${r.day.water_ml}/${r.day.water_target_ml} ml`;
  if (r.note) return `✓ Note: ${r.note.text.slice(0, 120)}`;
  if (r.deadline) return `✓ Deadline: ${r.deadline.title}, ${r.deadline.due} (${r.deadline.when})`;
  if (r.mind_map) return `✓ Mind map: ${r.mind_map.title}\n${r.mind_map.outline}`.slice(0, 1500);
  if (r.deleted) return `✓ Deleted: ${r.deleted}`;
  if (r.undid) return `✓ Undid: ${r.undid}`;
  return '✓ Done';
}

/** Apply the inbox's new rows, oldest first. `handle` is the Worker's own request handler. */
export async function runInbox(env, handle){
  if (!env.NOTION_TOKEN || !env.NOTION_DATABASE_ID) return { skipped: 'no Notion inbox set up' };
  const q = await notion(env, 'POST', `/databases/${env.NOTION_DATABASE_ID}/query`, {
    filter: { or: [{ property: 'Status', select: { is_empty: true } }, { property: 'Status', select: { equals: 'New' } }] },
    sorts: [{ timestamp: 'created_time', direction: 'ascending' }], page_size: 20,
  });
  const done = [];
  for (const row of q.results || []){
    const p = row.properties || {};
    await mark(env, row.id, 'Working', null);                       // claimed: never picked up again
    let status = 'Failed', result;
    try {
      const action = chosen(p.Action).trim().toLowerCase();
      const route = ACTIONS[action];
      if (!route) throw new Error(`Unknown Action "${chosen(p.Action)}". Use one of: ${INBOX_ACTIONS.join(', ')}.`);
      const body = readBody(plain(p.Body));
      const res = await handle(new Request('https://inbox.internal' + route[1], {
        method: route[0], headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }), env, { internal: true });
      const r = await res.json();
      status = r.ok ? 'Done' : 'Failed';
      result = said(action, r);
    } catch (err){ result = '✗ ' + (err && err.message || err); }
    await mark(env, row.id, status, result);
    done.push({ request: plain(p.Request), status, result });
  }
  return { applied: done.length, rows: done };
}
