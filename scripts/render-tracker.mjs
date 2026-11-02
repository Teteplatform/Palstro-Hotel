// render-tracker.mjs - renderer for the Palstro Hotels build sequence.
// Usage: node scripts/render-tracker.mjs --data docs/build-tracker.json --out docs/build-tracker.html
// Dependency-free, no npm install. Never hand-edit the HTML: edit the JSON and re-run this.
// The renderer REFUSES to build a page that would mislead - see the validation block below.
import { readFileSync, writeFileSync } from 'node:fs';

const CSS = `:root{color-scheme:light}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}
:root{color-scheme:light}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}

  :root{
    --terracotta:#b5532a; --cream:#faf5ee; --ink:#2a2320; --muted:#7a6f66;
    --line:#e7ddd1; --card:#fffdf9; --green:#276749; --amber:#b7791f; --red:#9b2226;
    --chip:#f0e7db; --grey:#9a8f83; --blue:#2c5282;
  }
  *{box-sizing:border-box;}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--cream);color:var(--ink);line-height:1.5;-webkit-font-smoothing:antialiased;}
  header{padding:1.3rem 1.25rem 1rem;border-bottom:1px solid var(--line);background:var(--cream);}
  .wrap{max-width:980px;margin:0 auto;}
  h1{margin:0;font-size:1.35rem;letter-spacing:-.01em;}
  .sub{color:var(--muted);font-size:.85rem;margin-top:.25rem;}
  main{padding:1.25rem;max-width:980px;margin:0 auto;}

  .goals{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-top:1rem;}
  .goal{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.7rem .85rem;}
  .goal .gt{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;}
  .goal .gp{font-size:1.4rem;font-weight:700;line-height:1.2;margin:.1rem 0;}
  .goal .gd{font-size:.75rem;color:var(--muted);}
  .bar{height:.45rem;background:#ece2d5;border-radius:99px;overflow:hidden;margin:.3rem 0 .35rem;}
  .bar i{display:block;height:100%;background:var(--green);}
  .bar.b2 i{background:var(--terracotta);}
  .bar.b3 i{background:var(--blue);}
  @media(max-width:700px){.goals{grid-template-columns:1fr;}}

  .upnext{background:#fff8ef;border:1px solid #f0e2cd;border-left:4px solid var(--terracotta);border-radius:12px;padding:.9rem 1.05rem;margin:1.25rem 0;}
  .upnext h3{margin:0 0 .45rem;font-size:.95rem;color:var(--terracotta);}
  .upnext ol{margin:0;padding-left:1.15rem;}
  .upnext li{font-size:.88rem;margin:.3rem 0;}
  .upnext .n{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;}

  .navrow{display:flex;gap:.35rem;flex-wrap:wrap;margin:1rem 0 .25rem;}
  .navrow a{font-size:.75rem;color:var(--muted);text-decoration:none;border:1px solid var(--line);background:var(--card);border-radius:99px;padding:.24rem .6rem;}
  .navrow a:hover{border-color:var(--terracotta);color:var(--ink);}

  .filters{display:flex;gap:.4rem;flex-wrap:wrap;margin:.9rem 0 .3rem;align-items:center;}
  .flabel{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;margin-right:.2rem;}
  .f{border:1px solid var(--line);background:var(--card);color:var(--muted);font:inherit;font-size:.78rem;
     padding:.26rem .68rem;border-radius:99px;cursor:pointer;}
  .f:hover{border-color:var(--terracotta);color:var(--ink);}
  .f[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:#fff;}
  .showing{font-size:.78rem;color:var(--muted);margin:.1rem 0 1.1rem;}

  /* --- the sequence table: sticky header, Excel-style --- */
  .tablewrap{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:visible;margin-bottom:1.75rem;}
  table#seq{width:100%;border-collapse:separate;border-spacing:0;font-size:.86rem;}
  table#seq thead th{
    position:sticky;top:0;z-index:5;
    background:#f2e8da;color:var(--muted);
    font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
    text-align:left;padding:.55rem .7rem;
    border-bottom:1px solid var(--line);
    box-shadow:0 1px 0 var(--line);
  }
  table#seq thead th:first-child{border-top-left-radius:12px;}
  table#seq thead th:last-child{border-top-right-radius:12px;}
  table#seq td{padding:.6rem .7rem;border-bottom:1px solid var(--line);vertical-align:top;}
  table#seq tbody tr.ship:hover td{background:#fdf9f3;}

  .c-num{width:4.5rem;} .c-proof{width:29%;} .c-st{width:6.5rem;} .c-ms{width:6.5rem;} .c-size{width:3.2rem;} .c-mig{width:7rem;}

  /* stage divider rows, sticky just under the header */
  tr.grow th{
    position:sticky;top:2.05rem;z-index:4;
    background:#efe4d4;text-align:left;padding:.5rem .7rem;
    border-top:1px solid var(--line);border-bottom:1px solid var(--line);
    scroll-margin-top:2.05rem;
  }
  .gnum{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;font-size:.72rem;color:#fff;background:var(--terracotta);
        border-radius:5px;padding:.1rem .4rem;margin-right:.5rem;}
  .gtitle{font-size:.85rem;font-weight:700;color:var(--ink);margin-right:.5rem;}
  .gwhy{font-size:.78rem;font-weight:400;color:var(--muted);}
  .gtick{float:right;font-size:.74rem;font-weight:600;color:var(--muted);white-space:nowrap;padding-left:.75rem;}
  tr.grow[id]{scroll-margin-top:2.05rem;}

  td.num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;font-size:.82rem;color:var(--terracotta);white-space:nowrap;}
  td.what .t{font-weight:600;font-size:.88rem;}
  td.proof{font-size:.81rem;color:var(--muted);}
  td.size{font-weight:700;font-size:.78rem;color:var(--muted);text-align:center;}
  .chip{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:.12rem .42rem;border-radius:5px;white-space:nowrap;}
  .chip.st.done{background:#e8f0e9;color:var(--green);}
  .chip.st.wip{background:#fdf3e2;color:var(--amber);}
  .chip.st.next{background:#fbe9e9;color:var(--red);}
  .chip.st.later{background:#f2ede6;color:var(--grey);}
  .chip.ms.golive{background:#eef3ee;color:var(--green);}
  .chip.ms.market{background:#e9eef5;color:var(--blue);}
  .chip.ms.world{background:var(--chip);color:var(--grey);}
  td.mig{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.76rem;color:var(--muted);}
  .ships{margin:.3rem 0 0;padding-left:1rem;}
  .ships li{font-size:.79rem;color:var(--muted);margin:.12rem 0;}
  .snote{font-size:.78rem;color:var(--muted);margin:.35rem 0 0;padding-left:.55rem;border-left:2px solid var(--chip);}

  .callout{background:#fff8ef;border:1px solid #f0e2cd;border-radius:12px;padding:1rem 1.1rem;margin-bottom:1.5rem;}
  .callout h3{margin:0 0 .5rem;font-size:.95rem;}
  .callout p{margin:.35rem 0 0;font-size:.88rem;color:var(--muted);}
  .callout ul{margin:.4rem 0 0;padding-left:1.1rem;}
  .callout li{margin:.35rem 0;font-size:.86rem;}
  code{background:var(--chip);padding:.05rem .3rem;border-radius:4px;font-size:.82em;}
  footer{max-width:980px;margin:0 auto;padding:0 1.25rem 2.5rem;color:var(--muted);font-size:.78rem;}
  @media(max-width:900px){
    .c-mig,td.mig{display:none;}
    .c-size,td.size{display:none;}
  }
  @media(max-width:700px){
    .c-proof,td.proof{display:none;}
    .c-ms,td:nth-child(5){display:none;}
    main{padding:1rem .75rem;}
    .gtick{float:none;display:block;padding-left:0;}
  }
  @media print{
    .filters,.navrow{display:none;}
    body{background:#fff;}
    table#seq thead th, tr.grow th{position:static;}
    tr.ship,.callout{break-inside:avoid;}
  }
`;
const PRE = `<div class="callout">
    <h3>How a shipment works</h3>
    <ul>
      <li>A shipment is DONE only when its proof has been run on the live DB. Code review is not proof.</li>
      <li>Every shipment ends with two updates: docs/USER-GUIDE.md and this file, then npm run tracker.</li>
      <li>Talk the shipment through before building it. No code until the shape is clear.</li>
      <li>One shipment at a time. Do not start the next until the current one is proven.</li>
      <li>If a shipment turns out to be two shipments, split it here rather than letting it sprawl.</li>
    </ul>
    <p><strong>Go-live</strong> means Heledon go-live: the hotel runs end to end without Excel. <strong>Sellable</strong> means Sellable: any Nigerian hotel or restaurant can buy it and run it. <strong>Anywhere</strong> means Anywhere: currency, locale, tax, payments and integrations for any market.</p>
  </div>

  <div class="callout">
    <h3>Two products, one codebase</h3>
    <p>The restaurant is a <strong>standalone product</strong>. A restaurant-only tenant runs the same app with the room and hotel modules switched off via <code>enabled_modules</code>. The guest is the universal customer, so a restaurant customer is just a guest with no stay, and F&amp;B posts to a pay-now sale or a standalone folio tab instead of a room folio. Shipment 6.4 is the moment that becomes true rather than intended.</p>
  </div>


  <div class="tablewrap">
    `;
const POST = `
  </div>

  <div class="callout">
    <h3>Palstro-ERP learnings carried in, so we don't repeat them</h3>
    <ul>
      <li><strong>Lock every RPC down.</strong> New <code>SECURITY DEFINER</code> functions default-grant EXECUTE to PUBLIC, which includes anon, and an internal <code>auth.uid() IS NOT NULL</code> check null-bypasses for anon. Revoke, grant to authenticated, assert in-migration. This bit the ERP twice, which is why it is shipment 1.3 and not an afterthought.</li>
      <li><strong>Fail open, never closed.</strong> A transient error means "couldn't check", not "closed". A live shop once went dark on a network blip.</li>
      <li><strong>No full DELETE + INSERT saves.</strong> Delta saves with a server-side empty guard. One blind full replace wiped a plan's pages and walled every tenant on it.</li>
      <li><strong>Gated features default in.</strong> A key missing from an allow-list is invisible to everyone.</li>
      <li><strong>Derive display from what enforces.</strong> Hand-typed pricing bullets drifted from the real access config.</li>
      <li><strong>Don't touch tested code, and visibility is not deletion.</strong> A nav link repoint once read as catastrophic data loss.</li>
      <li><strong>Keep auth machinery off public surfaces.</strong> A staff-auth poll on the public storefront looped errors until Sentry 429'd. Applies directly to shipment 10.2.</li>
      <li><strong>Financial cards must foot and label.</strong> Every line visible, no two figures sharing a bare label.</li>
      <li><strong>Lists must paginate properly.</strong> Server pagination, count, page-of-N, jump, page size, filtered totals, export-all.</li>
      <li><strong>Stock is movement-sourced, never a stored number.</strong> Same rule as the folio balance.</li>
      <li><strong>Imports validate then commit,</strong> and stay idempotent on re-upload.</li>
      <li><strong>Duplicate-name protection.</strong> Exact blocked, fuzzy warned, whitespace collapsed.</li>
      <li><strong>Browser-made xlsx opens read-only</strong> where Purview labelling is enforced. Lead with CSV, offer xlsx.</li>
      <li><strong>Moving-average cost</strong> folds by business date, not insertion time.</li>
      <li><strong>Multi-location from day one.</strong> Every movement carries a <code>location_id</code>.</li>
      <li><strong>Never hardcode infra values.</strong> A retired Vercel apex IP once took a live shop down.</li>
      <li><strong>Review the deliverable against the intent.</strong> "Done" is not "matches the spec".</li>
      <li><strong>Migration trap:</strong> <code>TG_OP</code> and <code>OLD</code> cannot be used in a trigger's <code>WHEN</code> clause.</li>
      <li><strong>Port the design, not the database.</strong> Never wire two Supabase projects together.</li>
    </ul>
  </div>
`;
const SCRIPT = `<script>
(function(){
  var rows = Array.prototype.slice.call(document.querySelectorAll('tr.ship'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('tr.grow'));
  var state = { s: 'all', m: 'all' };
  var showing = document.getElementById('showing');

  function apply(){
    var visible = 0;
    rows.forEach(function(r){
      var ok = (state.s === 'all' || r.getAttribute('data-s') === state.s) &&
               (state.m === 'all' || r.getAttribute('data-m') === state.m);
      r.style.display = ok ? '' : 'none';
      if (ok) visible++;
    });
    groups.forEach(function(g){
      var stage = g.getAttribute('data-stage');
      var n = rows.filter(function(r){
        return r.getAttribute('data-stage') === stage && r.style.display !== 'none';
      }).length;
      g.style.display = n ? '' : 'none';
    });
    showing.textContent = visible === rows.length
      ? ('Showing all ' + rows.length + ' shipments.')
      : ('Showing ' + visible + ' of ' + rows.length + ' shipments.');
  }

  Array.prototype.forEach.call(document.querySelectorAll('.f'), function(btn){
    btn.addEventListener('click', function(){
      var k = btn.getAttribute('data-k');
      state[k] = btn.getAttribute('data-v');
      Array.prototype.forEach.call(document.querySelectorAll('.f[data-k="' + k + '"]'), function(b){
        b.setAttribute('aria-pressed', String(b === btn));
      });
      apply();
    });
  });

  apply();
})();
</script>`;
const THEAD = `<table id="seq">
      <thead>
        <tr>
          <th class="c-num">#</th>
          <th class="c-what">Shipment</th>
          <th class="c-proof">Proven by</th>
          <th class="c-st">Status</th>
          <th class="c-ms">Milestone</th>
          <th class="c-size">Size</th>
          <th class="c-mig">Ref</th>
        </tr>
      </thead>
      
      `;


const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const DATA = arg('--data', 'docs/build-tracker.json');
const OUT  = arg('--out',  'docs/build-tracker.html');

const STATUS = { done: 'Done', wip: 'In progress', next: 'Next', later: 'Not started' };
const MILE   = { golive: 'Go-live', market: 'Sellable', world: 'Anywhere' };
const SIZES  = ['S', 'M', 'L'];
const RANK   = { golive: ['golive'], market: ['golive', 'market'], world: ['golive', 'market', 'world'] };

const e = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const data = JSON.parse(readFileSync(DATA, 'utf8'));
const stages = data.stages ?? [];
const all = stages.flatMap((st) => (st.shipments ?? []).map((s) => ({ ...s, stage: st.id })));

const fail = [];
const seen = new Set();
for (const s of all) {
  if (!s.id) fail.push('a shipment has no id');
  if (seen.has(s.id)) fail.push('duplicate shipment id ' + s.id);
  seen.add(s.id);
  if (!STATUS[s.s]) fail.push(s.id + ': unknown status ' + s.s);
  if (!MILE[s.m]) fail.push(s.id + ': unknown milestone ' + s.m);
  if (!SIZES.includes(s.size)) fail.push(s.id + ': unknown size ' + s.size);
  if (!s.proof || !String(s.proof).trim()) fail.push(s.id + ': no proof line - a shipment with no proof cannot be called done by anyone');
  if (!Array.isArray(s.ships) || !s.ships.length) fail.push(s.id + ': nothing listed under what it ships');
}
if (fail.length) { console.error('Refusing to render:\n  ' + fail.join('\n  ')); process.exit(1); }

const goal = (key, label, cls) => {
  const set = all.filter((s) => RANK[key].includes(s.m));
  const done = set.filter((s) => s.s === 'done').length;
  const pct = set.length ? Math.round((done / set.length) * 100) : 0;
  return { key, label, cls, done, total: set.length, pct };
};
const goals = [goal('golive', 'Heledon go-live', ''), goal('market', 'Sellable product', 'b2'), goal('world', 'Anywhere in the world', 'b3')];
const upnext = [...all.filter((s) => s.s === 'wip'), ...all.filter((s) => s.s === 'next')].slice(0, 3);
const count = (k) => all.filter((s) => s.s === k).length;

const rows = stages.map((st) => {
  const ships = st.shipments ?? [];
  const done = ships.filter((s) => s.s === 'done').length;
  const head = '<tr class="grow" data-stage="' + st.id + '" id="stage-' + st.id + '">\n'
    + '          <th colspan="7" scope="colgroup">\n'
    + '            <span class="gnum">Stage ' + st.id + '</span>\n'
    + '            <span class="gtitle">' + e(st.title) + '</span>\n'
    + '            <span class="gwhy">' + e(st.why) + '</span>\n'
    + '            <span class="gtick">' + done + ' of ' + ships.length + ' shipped</span>\n'
    + '          </th>\n        </tr>';
  const body = ships.map((s) => '<tr class="ship" data-s="' + s.s + '" data-m="' + s.m + '" data-stage="' + st.id + '">\n'
    + '          <td class="num">' + e(s.id) + '</td>\n'
    + '          <td class="what">\n'
    + '            <div class="t">' + e(s.t) + '</div>\n'
    + '            <ul class="ships">' + s.ships.map((x) => '<li>' + e(x) + '</li>').join('') + '</ul>\n'
    + '            ' + (s.note ? '<div class="snote">' + e(s.note) + '</div>' : '') + '\n'
    + '          </td>\n'
    + '          <td class="proof">' + e(s.proof) + '</td>\n'
    + '          <td><span class="chip st ' + s.s + '">' + STATUS[s.s] + '</span></td>\n'
    + '          <td><span class="chip ms ' + s.m + '">' + MILE[s.m] + '</span></td>\n'
    + '          <td class="size">' + e(s.size) + '</td>\n'
    + '          <td class="mig">' + e(s.r || '—') + '</td>\n'
    + '        </tr>').join('\n        ');
  return head + '\n        ' + body;
}).join('\n        ');

const page = '<!doctype html>\n<html lang="en">\n'
 + '<head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">\n'
 + '<title>Palstro Hotels — Build Sequence</title>\n'
 + '<style>' + CSS + '</style>\n</head>\n<body>\n'
 + '<header>\n  <div class="wrap">\n    <h1>Palstro Hotels — Build Sequence</h1>\n'
 + '    <div class="sub">' + e(data.meta.tagline) + ' &middot; ' + e(data.meta.firstCustomer) + '</div>\n'
 + '    <div class="goals">\n      '
 + goals.map((g) => '<div class="goal">\n        <div class="gt">' + g.label + '</div>\n'
     + '        <div class="gp">' + g.pct + '%</div>\n'
     + '        <div class="bar ' + g.cls + '"><i style="width:' + g.pct + '%"></i></div>\n'
     + '        <div class="gd">' + g.done + ' of ' + g.total + ' shipments</div>\n      </div>').join('\n      ')
 + '\n    </div>\n  </div>\n</header>\n\n<main>\n'
 + '  <div class="upnext">\n    <h3>Up next, in order</h3>\n    <ol>\n      '
 + upnext.map((s) => '<li><span class="n">' + e(s.id) + '</span> ' + e(s.t) + '</li>').join('\n      ')
 + '\n    </ol>\n  </div>\n\n'
 + '  <div class="navrow">' + stages.map((st) => '<a href="#stage-' + st.id + '">' + st.id + '. ' + e(st.title) + '</a>').join('') + '</div>\n\n'
 + '  <div class="filters" role="group" aria-label="Filter by status">\n    <span class="flabel">Status</span>\n'
 + '    <button class="f" data-k="s" data-v="all" aria-pressed="true">All</button>\n'
 + '    <button class="f" data-k="s" data-v="done" aria-pressed="false">Done (' + count('done') + ')</button>\n'
 + '    <button class="f" data-k="s" data-v="wip" aria-pressed="false">In progress (' + count('wip') + ')</button>\n'
 + '    <button class="f" data-k="s" data-v="next" aria-pressed="false">Next (' + count('next') + ')</button>\n'
 + '    <button class="f" data-k="s" data-v="later" aria-pressed="false">Not started (' + count('later') + ')</button>\n'
 + '  </div>\n'
 + '  <div class="filters" role="group" aria-label="Filter by milestone">\n    <span class="flabel">Milestone</span>\n'
 + '    <button class="f" data-k="m" data-v="all" aria-pressed="true">All</button>\n'
 + '    <button class="f" data-k="m" data-v="golive" aria-pressed="false">Go-live</button>\n'
 + '    <button class="f" data-k="m" data-v="market" aria-pressed="false">Sellable</button>\n'
 + '    <button class="f" data-k="m" data-v="world" aria-pressed="false">Anywhere</button>\n'
 + '  </div>\n  <p class="showing" id="showing"></p>\n\n'
 + PRE + THEAD + '\n      <tbody>\n        ' + rows + '\n      </tbody>\n    </table>' + POST + '</main>\n\n'
 + '<footer>\n  Generated from <code>build-tracker.json</code> on ' + e(data.meta.updated) + '. '
 + all.length + ' shipments across ' + stages.length + ' stages. Edit the JSON and re-run the renderer. Never hand-edit this page.\n</footer>\n\n'
 + SCRIPT + '\n</body>\n</html>\n';

writeFileSync(OUT, page);
console.log('Tracker rendered -> ' + OUT);
for (const g of goals) console.log('  ' + g.label.padEnd(22) + String(g.pct).padStart(3) + '%  (' + g.done + '/' + g.total + ')');
console.log('  Up next: ' + upnext.map((s) => s.id).join(' -> '));
