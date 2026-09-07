// XMBL Explorer — a live, educational visualizer of the cube-curve ledger.
//
// It renders the real geometry of the chain: raw transactions become blocks, exactly
// 9 blocks seal a FACE, exactly 3 faces seal a CUBE. It reads a running XMBL node's
// status endpoint when connected, and otherwise runs a deterministic demo so the
// mechanism is teachable with no node at all. Nothing here fabricates chain state it
// did not read — the "demo" pill makes the difference explicit.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const FACE_SIZE = 9;   // blocks per face  (xclt/cubic-ledger)
const CUBE_FACES = 3;  // faces per cube

const COL = { raw: 0x47506b, block: 0x4f8cff, face: 0x35d0a5, cube: 0xffb454 };

// ---------- scene ----------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);
scene.fog = new THREE.FogExp2(0x05070d, 0.012);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
camera.position.set(26, 20, 34);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.5;

scene.add(new THREE.AmbientLight(0x8899cc, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(20, 40, 20);
scene.add(key);
const grid = new THREE.GridHelper(120, 40, 0x1b2440, 0x101830);
grid.position.y = -0.5;
scene.add(grid);

const world = new THREE.Group();
scene.add(world);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- geometry builder ----------
// A cube is a 3×3×3 lattice of 27 unit cells (3 faces × 9 blocks). We lay sealed cubes
// out along a gentle curve (the "cube curve"), so the chain grows as a readable ribbon.
const cellGeo = new THREE.BoxGeometry(0.82, 0.82, 0.82);
const mats = Object.fromEntries(Object.entries(COL).map(([k, c]) =>
  [k, new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.2,
    emissive: c, emissiveIntensity: 0.12 })]));

let cells = [];         // flat list of block meshes, in placement order
let cubeAnchors = [];   // group per cube for curve layout

function cubePosition(cubeIndex) {
  // place cubes along an arc so the ledger reads as a curve, not a wall
  const t = cubeIndex * 0.7;
  return new THREE.Vector3(Math.sin(t) * (6 + cubeIndex * 2.2), 0, -t * 3.2 + cubeIndex * 0.4);
}

function ensureBlocks(nBlocks) {
  while (cells.length < nBlocks) {
    const i = cells.length;
    const cubeIndex = Math.floor(i / (FACE_SIZE * CUBE_FACES));
    const within = i % (FACE_SIZE * CUBE_FACES);      // 0..26 inside a cube
    if (!cubeAnchors[cubeIndex]) {
      const g = new THREE.Group();
      g.position.copy(cubePosition(cubeIndex));
      world.add(g);
      cubeAnchors[cubeIndex] = g;
    }
    const x = within % 3, y = Math.floor(within / 3) % 3, z = Math.floor(within / 9); // 3×3×3
    const m = new THREE.Mesh(cellGeo, mats.raw);
    m.position.set((x - 1) * 0.95, (y - 1) * 0.95, (z - 1) * 0.95);
    m.scale.setScalar(0.01);
    cubeAnchors[cubeIndex].add(m);
    cells.push(m);
  }
  // recentre camera target on the leading edge as it grows
  const lead = cubeAnchors[cubeAnchors.length - 1];
  if (lead) controls.target.lerp(lead.position, 0.02);
}

// paint each block by the highest structure it belongs to
function paint(nBlocks) {
  const fullFaces = Math.floor(nBlocks / FACE_SIZE);
  const fullCubes = Math.floor(fullFaces / CUBE_FACES);
  for (let i = 0; i < cells.length; i++) {
    const faceIdx = Math.floor(i / FACE_SIZE);
    const cubeIdx = Math.floor(faceIdx / CUBE_FACES);
    let mat = mats.raw;
    if (i < nBlocks) mat = mats.block;
    if (faceIdx < fullFaces) mat = mats.face;
    if (cubeIdx < fullCubes) mat = mats.cube;
    cells[i].material = mat;
  }
}

// ---------- data sources ----------
const el = (id) => document.getElementById(id);
const statusPill = el('status');
let state = { blocks: 0, faces: 0, cubes: 0, txs: 0, root: '—' };

function render(s) {
  ensureBlocks(s.blocks);
  paint(s.blocks);
  el('s-blocks').textContent = s.blocks;
  el('s-faces').textContent = s.faces ?? Math.floor(s.blocks / FACE_SIZE);
  el('s-cubes').textContent = s.cubes ?? Math.floor(s.blocks / (FACE_SIZE * CUBE_FACES));
  el('s-txs').textContent = s.txs ?? 0;
  el('s-root').textContent = s.root ? String(s.root).slice(0, 8) : '—';
}

// Normalize whatever a node's status endpoint returns into our shape. XMBL status
// payloads vary by version; read defensively and never invent fields.
function normalize(j) {
  const blocks = j.blocks ?? j.block_count ?? j.chain?.blocks ?? j.total_blocks ?? 0;
  const faces = j.faces ?? j.face_count ?? j.chain?.faces;
  const cubes = j.cubes ?? j.cube_count ?? j.chain?.cubes;
  const txs = j.txs_per_min ?? j.tx_rate ?? j.mempool?.raw ?? j.txs ?? 0;
  const root = j.state_root ?? j.root ?? j.chain?.state_root ?? '—';
  return { blocks: Number(blocks) || 0, faces, cubes, txs, root };
}

let live = null;       // {url} when connected
let pollTimer = null;

async function pollOnce() {
  if (!live) return;
  const paths = ['/xmbl/status', '/api/v1/xmbl/status'];
  for (const p of paths) {
    try {
      const r = await fetch(live.url.replace(/\/$/, '') + p, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      state = normalize(j);
      render(state);
      statusPill.textContent = 'live';
      statusPill.className = 'pill live';
      return;
    } catch { /* try next path */ }
  }
  statusPill.textContent = 'unreachable';
  statusPill.className = 'pill err';
}

function connect(url) {
  live = { url };
  clearInterval(pollTimer);
  stopDemo();
  pollOnce();
  pollTimer = setInterval(pollOnce, 2000);
}

// deterministic demo: a chain that fills at a steady, reproducible rate
let demoTimer = null, demoT = 0;
function startDemo() {
  statusPill.textContent = 'demo';
  statusPill.className = 'pill idle';
  demoTimer = setInterval(() => {
    demoT += 1;
    // ~1 block/tick, easing so faces/cubes visibly seal
    const blocks = Math.floor(demoT * 1.0);
    state = {
      blocks,
      faces: Math.floor(blocks / FACE_SIZE),
      cubes: Math.floor(blocks / (FACE_SIZE * CUBE_FACES)),
      txs: 12 + (demoT % 7),
      root: 'demo' + (blocks % 9973).toString(16).padStart(4, '0'),
    };
    render(state);
  }, 220);
}
function stopDemo() { clearInterval(demoTimer); demoTimer = null; }

el('connect').addEventListener('click', () => {
  const url = el('endpoint').value.trim();
  if (url) connect(url);
});
el('endpoint').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('connect').click(); });

// ---------- education panel ----------
const LESSONS = [
  ['No miners — you validate your own tx', 'The <b>user</b> of a transaction completes its validation tasks. There is no miner or staking cartel. A tx whose user cannot be resolved never advances — it is finished, not pending.'],
  ['Blocks, not a line', 'Every transaction is hashed into a block. Membership in the ledger is a pure function of the block <b>set</b>, never arrival order — so every node holding the same set builds the identical structure.'],
  ['9 blocks seal a <span class="k">face</span>', 'Sort the pool by block hash and chunk into groups of 9. Any remainder under 9 stays unsealed. Watch the lattice turn <span class="k">green</span> as each group of nine locks.'],
  ['3 faces seal a <span class="k">cube</span>', 'Three sealed faces merkle-root together into a cube (3×3×3 = 27 blocks). Cubes turn <b>amber</b>. The chain of cubes laid along the arc is the “cube curve.”'],
  ['State lives in a Verkle tree', 'A moving <b>state root</b> is the chain applying transactions — that is health, not drift. The state machine (xvsm) keeps sparse Verkle diffs assembled on demand.'],
  ['Signatures are post-quantum', 'Identities sign with MAYO (NIST PQC). The cube-curve cryptography seam derives parameters from the ledger geometry itself — experimental, and clearly marked so.'],
];
const ol = el('lessons');
ol.innerHTML = LESSONS.map(([h, b]) => `<li><b>${h}</b><br>${b}</li>`).join('');
el('explainToggle').addEventListener('click', () => { el('explain').hidden = false; });
el('explainClose').addEventListener('click', () => { el('explain').hidden = true; });

// ---------- loop ----------
function tick() {
  requestAnimationFrame(tick);
  controls.update();
  const t = performance.now() * 0.001;
  for (const c of cells) { // grow-in animation
    if (c.scale.x < 1) c.scale.setScalar(Math.min(1, c.scale.x + 0.08));
    c.material.emissiveIntensity = 0.12 + Math.sin(t * 2 + c.id) * 0.03;
  }
  renderer.render(scene, camera);
}
tick();

// prefill endpoint from ?node= and autostart demo
const q = new URLSearchParams(location.search).get('node');
if (q) { el('endpoint').value = q; connect(q); } else { startDemo(); }
