/**
 * Dashboard Server — serves the interactive code intelligence dashboard.
 *
 * Tiny HTTP server that:
 * 1. Serves the single-page dashboard HTML
 * 2. Exposes /api/* endpoints that query the code graph
 * 3. Auto-opens the browser
 *
 * All data comes from the local SQLite graph — no external services.
 * The dashboard HTML uses textContent for safe DOM rendering.
 */

import { createServer } from "node:http";
import type { CodeGraph } from "../graph.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("dashboard");

export interface DashboardOptions {
  graph: CodeGraph;
  port?: number;
  open?: boolean;
}

export function startDashboard(opts: DashboardOptions): {
  port: number;
  close: () => void;
} {
  const { graph } = opts;
  const port = opts.port ?? 3737;
  const db = graph.getDb();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/api/stats") {
      const stats = graph.extendedStats();
      const languages = db
        .prepare(
          "SELECT language, COUNT(*) AS count FROM nodes WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC",
        )
        .all();
      json(res, { stats, languages });
      return;
    }

    if (url.pathname === "/api/communities") {
      const communities = graph.getCommunities();
      const enriched = communities.map((c: any) => {
        let tier = "standard",
          keywords: string[] = [];
        try {
          const meta = db
            .prepare("SELECT metadata_json FROM communities WHERE id = ?")
            .get(c.id) as any;
          if (meta?.metadata_json) {
            const p = JSON.parse(meta.metadata_json);
            tier = p.tier ?? "standard";
            keywords = p.keywords ?? [];
          }
        } catch {}
        return { ...c, tier, keywords };
      });
      json(res, enriched);
      return;
    }

    if (url.pathname === "/api/hotspots") {
      const limit = parseInt(url.searchParams.get("limit") ?? "30");
      json(
        res,
        db
          .prepare(
            `
        SELECT ce.callee AS name, COUNT(*) AS callerCount, f.file,
               (f.end_line - f.start_line) AS lineCount
        FROM call_edges ce JOIN functions f ON f.name = ce.callee
        GROUP BY ce.callee, f.file ORDER BY callerCount DESC LIMIT ?
      `,
          )
          .all(limit),
      );
      return;
    }

    if (url.pathname === "/api/graph") {
      const limit = parseInt(url.searchParams.get("limit") ?? "200");
      const nodes = db
        .prepare(
          `
        SELECT id, name, kind, file, community_id AS communityId
        FROM nodes WHERE kind != 'file'
        ORDER BY (SELECT COUNT(*) FROM edges WHERE target_id = nodes.id) DESC LIMIT ?
      `,
        )
        .all(limit) as any[];
      const edges =
        nodes.length > 0
          ? db
              .prepare(
                `
        SELECT source_id AS source, target_id AS target, kind FROM edges
        WHERE source_id IN (${nodes.map(() => "?").join(",")})
          AND target_id IN (${nodes.map(() => "?").join(",")})
      `,
              )
              .all(
                ...nodes.map((n: any) => n.id),
                ...nodes.map((n: any) => n.id),
              )
          : [];
      json(res, { nodes, edges });
      return;
    }

    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      if (!q) {
        json(res, []);
        return;
      }
      try {
        json(
          res,
          db
            .prepare(
              `
          SELECT node_id, file_path, symbol_name, kind, bm25(search_fts) AS score
          FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts) LIMIT 20
        `,
            )
            .all(q),
        );
      } catch {
        json(
          res,
          db
            .prepare(
              "SELECT id AS node_id, file AS file_path, name AS symbol_name, kind FROM nodes WHERE name LIKE ? LIMIT 20",
            )
            .all("%" + q + "%"),
        );
      }
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(DASHBOARD_HTML);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    log.info({ port }, "Dashboard running");
    console.log(`\n  🧠 Brainstorm Dashboard: http://localhost:${port}\n`);
  });

  if (opts.open !== false) {
    import("node:child_process")
      .then(({ execFile: ef }) => {
        ef("open", [`http://localhost:${port}`]);
      })
      .catch(() => {});
  }

  return { port, close: () => server.close() };
}

function json(res: any, data: unknown) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Brainstorm — Code Intelligence</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e0e0e0}
.hdr{padding:20px 32px;border-bottom:1px solid #1a1a2e;display:flex;align-items:center;gap:16px}
.hdr h1{font-size:20px;font-weight:600} .hdr h1 b{color:#6366f1}
.hdr input{flex:1;max-width:400px;margin-left:auto;padding:8px 14px;background:#12121e;border:1px solid #2a2a3e;border-radius:8px;color:#e0e0e0;font-size:14px;outline:none}
.hdr input:focus{border-color:#6366f1}
.stats{display:flex;gap:16px;flex-wrap:wrap;padding:20px 32px}
.st{background:#12121e;border-radius:10px;padding:16px 20px;min-width:110px}
.st .v{font-size:28px;font-weight:700;color:#fff} .st .l{font-size:12px;color:#606080;margin-top:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#1a1a2e}
.pnl{background:#0a0a0f;padding:24px;min-height:400px}
.pnl h2{font-size:14px;font-weight:600;margin-bottom:16px;color:#a0a0b0;text-transform:uppercase;letter-spacing:.5px}
.tb{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600}
.tc{background:#dc262622;color:#f87171;border:1px solid #dc262644}
.tx{background:#f9731622;color:#fb923c;border:1px solid #f9731644}
.ts{background:#eab30822;color:#fbbf24;border:1px solid #eab30844}
.tg{background:#22c55e22;color:#4ade80;border:1px solid #22c55e44}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 12px;color:#606080;border-bottom:1px solid #1a1a2e;font-weight:500}
td{padding:8px 12px;border-bottom:1px solid #12121e}
td code{background:#1a1a2e;padding:2px 6px;border-radius:4px;font-size:12px}
#gc{width:100%;height:380px} canvas{width:100%;height:100%}
.sl{max-height:340px;overflow-y:auto}
.si{padding:10px 14px;border-bottom:1px solid #12121e;display:flex;align-items:center;gap:12px}
.si:hover{background:#12121e} .sn{font-weight:500;flex:1} .sm{font-size:12px;color:#606080}
</style></head><body>
<div class="hdr"><h1><b>⬡</b> Brainstorm Code Intelligence</h1><input id="si" placeholder="Search functions, classes, files..."/></div>
<div class="stats" id="sr"></div>
<div class="grid">
<div class="pnl"><h2>Knowledge Graph</h2><div id="gc"><canvas id="cv"></canvas></div></div>
<div class="pnl"><h2>Code Sectors</h2><div class="sl" id="sl"></div></div>
<div class="pnl"><h2>Hotspots — Highest Blast Radius</h2><table><thead><tr><th>#</th><th>Function</th><th>Callers</th><th>File</th></tr></thead><tbody id="ht"></tbody></table></div>
<div class="pnl"><h2>Languages</h2><div id="lg"></div></div>
</div>
<script>
const F=u=>fetch(u).then(r=>r.json());
const E=(t,a)=>{const e=document.createElement(t);if(a)for(const[k,v]of Object.entries(a)){if(k==='text')e.textContent=v;else if(k==='html')e.insertAdjacentHTML('beforeend',v);else e.setAttribute(k,v)}return e};

async function init(){
const[S,C,H,G]=await Promise.all([F('/api/stats'),F('/api/communities'),F('/api/hotspots?limit=20'),F('/api/graph?limit=150')]);
// Stats
const sr=document.getElementById('sr');
[{v:S.stats.files,l:'Files'},{v:S.stats.nodes,l:'Nodes'},{v:S.stats.graphEdges.toLocaleString(),l:'Edges'},{v:S.stats.communities,l:'Sectors'},{v:S.stats.functions,l:'Functions'},{v:S.stats.classes,l:'Classes'},{v:S.stats.callEdges.toLocaleString(),l:'Call Edges'}].forEach(s=>{
const d=E('div',{class:'st'});d.appendChild(E('div',{class:'v',text:String(s.v)}));d.appendChild(E('div',{class:'l',text:s.l}));sr.appendChild(d);});

// Sectors
const sl=document.getElementById('sl');
C.sort((a,b)=>({critical:0,complex:1,standard:2,simple:3}[a.tier]||4)-({critical:0,complex:1,standard:2,simple:3}[b.tier]||4));
C.slice(0,50).forEach(c=>{
const d=E('div',{class:'si'});
const tc={critical:'tc',complex:'tx',standard:'ts',simple:'tg'}[c.tier]||'ts';
d.appendChild(E('span',{class:'tb '+tc,text:c.tier}));
d.appendChild(E('span',{class:'sn',text:c.name||c.id}));
d.appendChild(E('span',{class:'sm',text:c.nodeCount+' nodes · '+(c.complexityScore||0).toFixed(1)+'/10'}));
sl.appendChild(d);});

// Hotspots
const ht=document.getElementById('ht');
H.forEach((h,i)=>{const tr=E('tr');
[i+1,h.name,h.callerCount,h.file.split('/').slice(-2).join('/')].forEach((v,j)=>{
const td=E('td');if(j===1){const b=E('strong',{text:String(v)});td.appendChild(b)}else if(j===3){const c=E('code',{text:String(v)});td.appendChild(c)}else td.textContent=String(v);tr.appendChild(td)});
ht.appendChild(tr)});

// Languages
const lg=document.getElementById('lg');const tot=S.languages.reduce((s,l)=>s+l.count,0);
S.languages.forEach(l=>{const pct=((l.count/tot)*100).toFixed(1);const d=E('div',{style:'margin-bottom:12px'});
const h=E('div',{style:'display:flex;justify-content:space-between;margin-bottom:4px'});
h.appendChild(E('span',{text:l.language,style:'font-weight:500'}));
h.appendChild(E('span',{text:l.count+' nodes ('+pct+'%)',style:'color:#606080'}));d.appendChild(h);
const bar=E('div',{style:'background:#12121e;border-radius:4px;height:8px;overflow:hidden'});
bar.appendChild(E('div',{style:'background:#6366f1;height:100%;width:'+pct+'%;border-radius:4px'}));
d.appendChild(bar);lg.appendChild(d)});

// Graph
const cv=document.getElementById('cv'),cx=cv.getContext('2d'),gc=cv.parentElement.getBoundingClientRect();
cv.width=gc.width*2;cv.height=gc.height*2;cv.style.width=gc.width+'px';cv.style.height=gc.height+'px';cx.scale(2,2);
const W=gc.width,HH=gc.height,TC={critical:'#f87171',complex:'#fb923c',standard:'#fbbf24',simple:'#4ade80'};
const CT={};C.forEach(c=>CT[c.id]=c.tier);
const N=G.nodes.map(n=>({...n,x:W/2+(Math.random()-.5)*W*.8,y:HH/2+(Math.random()-.5)*HH*.8,vx:0,vy:0}));
const NI={};N.forEach((n,i)=>NI[n.id]=i);
const EE=G.edges.filter(e=>NI[e.source]!==undefined&&NI[e.target]!==undefined);
function tick(){for(let i=0;i<N.length;i++)for(let j=i+1;j<N.length;j++){let dx=N[j].x-N[i].x,dy=N[j].y-N[i].y,d=Math.sqrt(dx*dx+dy*dy)||1,f=800/(d*d);N[i].vx-=dx/d*f;N[i].vy-=dy/d*f;N[j].vx+=dx/d*f;N[j].vy+=dy/d*f}
for(const e of EE){const s=N[NI[e.source]],t=N[NI[e.target]];if(!s||!t)continue;let dx=t.x-s.x,dy=t.y-s.y,d=Math.sqrt(dx*dx+dy*dy)||1,f=(d-60)*.01;s.vx+=dx/d*f;s.vy+=dy/d*f;t.vx-=dx/d*f;t.vy-=dy/d*f}
for(const n of N){n.vx+=(W/2-n.x)*.001;n.vy+=(HH/2-n.y)*.001;n.vx*=.9;n.vy*=.9;n.x+=n.vx;n.y+=n.vy;n.x=Math.max(10,Math.min(W-10,n.x));n.y=Math.max(10,Math.min(HH-10,n.y))}}
function draw(){cx.clearRect(0,0,W,HH);cx.strokeStyle='#ffffff08';cx.lineWidth=.5;
for(const e of EE){const s=N[NI[e.source]],t=N[NI[e.target]];if(!s||!t)continue;cx.beginPath();cx.moveTo(s.x,s.y);cx.lineTo(t.x,t.y);cx.stroke()}
for(const n of N){cx.beginPath();cx.arc(n.x,n.y,n.kind==='class'?5:3,0,Math.PI*2);cx.fillStyle=TC[CT[n.communityId]]||'#6366f1';cx.fill()}}
let fr=0;(function anim(){tick();draw();if(++fr<200)requestAnimationFrame(anim)})();

// Search
let st;document.getElementById('si').addEventListener('input',function(){clearTimeout(st);st=setTimeout(async()=>{const q=this.value.trim();if(q.length<2)return;const r=await F('/api/search?q='+encodeURIComponent(q));console.log('Search:',r)},200)});
}
init();
</script></body></html>`;
