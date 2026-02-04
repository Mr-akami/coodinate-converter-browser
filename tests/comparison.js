import { initProjRuntime } from '../src/proj-runtime.js';
import { createProjApi } from '../src/proj-api.js';

// --- Tolerances ---
const TOL = {
  geo: 1e-6,       // ~0.1m for geographic degrees
  proj: 0.01,      // 0.01m for projected coords
  height: 0.01,    // 0.01m
  rtGeo: 1e-8,     // round-trip geographic (~0.001m)
  rtProj: 0.001,   // round-trip projected
  rtH: 0.001,      // round-trip height
};

function isGeographic(crs) {
  // Geographic, 3D geographic, compound with geographic horizontal, vertical-only
  return /^EPSG:(4258|4267|4269|4271|4272|4273|4275|4277|4283|4289|4312|4313|4314|4326|4612|4617|4150|4167|4171|4979|5773|6318|6319|6667|6668|6695|6697|7844)$/.test(crs)
    || /CZM:/.test(crs);
}

// ── CSV-based comparison ─────────────────────────────────────────────────────

async function loadCSV(url) {
  const res = await fetch(url);
  const text = await res.text();
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const row = {};
    header.forEach((h, i) => row[h] = cols[i]);
    return row;
  });
}

async function runCsvComparison(proj) {
  const rows = await loadCSV('./reference.csv');
  const results = [];

  for (const row of rows) {
    const inX = parseFloat(row.in_x);
    const inY = parseFloat(row.in_y);
    const inZ = parseFloat(row.in_z);
    const ex = parseFloat(row.expected_x);
    const ey = parseFloat(row.expected_y);
    const ez = parseFloat(row.expected_z);
    const tolXY = isGeographic(row.dst_crs) ? TOL.geo : TOL.proj;

    try {
      const r = await proj.transform(row.src_crs, row.dst_crs, inX, inY, inZ);
      const dx = r.x - ex;
      const dy = r.y - ey;
      const dz = r.z - ez;
      const pass = Math.abs(dx) <= tolXY
        && Math.abs(dy) <= tolXY
        && Math.abs(dz) <= TOL.height;

      results.push({
        label: row.label, src: row.src_crs, dst: row.dst_crs,
        ex, ey, ez, gx: r.x, gy: r.y, gz: r.z,
        dx, dy, dz, tolXY, pass,
      });
    } catch (e) {
      results.push({
        label: row.label, src: row.src_crs, dst: row.dst_crs,
        ex, ey, ez, gx: '-', gy: '-', gz: '-',
        dx: null, dy: null, dz: null, tolXY, pass: false, error: e.message,
      });
    }
  }
  return results;
}

function renderCsvTable(results) {
  const container = document.getElementById('csv-results');
  const passCount = results.filter(r => r.pass).length;
  const total = results.length;

  document.getElementById('csv-summary').innerHTML =
    `<span class="${passCount === total ? 'pass' : 'fail'}">${passCount}/${total} passed</span>`;

  let html = `<table>
    <tr>
      <th></th><th>Label</th><th>CRS</th>
      <th>Expected X</th><th>Got X</th><th>dX</th>
      <th>Expected Y</th><th>Got Y</th><th>dY</th>
      <th>Expected Z</th><th>Got Z</th><th>dZ</th>
    </tr>`;

  for (const r of results) {
    const cls = r.pass ? 'pass' : (r.error ? 'error' : 'fail');
    const status = r.pass ? 'PASS' : (r.error ? 'ERR' : 'FAIL');
    html += `<tr class="${cls}">
      <td class="status">${status}</td>
      <td>${r.label}</td>
      <td class="nowrap">${r.src}→${r.dst}</td>
      <td>${fmt(r.ex)}</td><td>${fmt(r.gx)}</td><td>${fmtDiff(r.dx, r.tolXY)}</td>
      <td>${fmt(r.ey)}</td><td>${fmt(r.gy)}</td><td>${fmtDiff(r.dy, r.tolXY)}</td>
      <td>${fmt(r.ez)}</td><td>${fmt(r.gz)}</td><td>${fmtDiff(r.dz, TOL.height)}</td>
    </tr>`;
  }
  html += '</table>';
  container.innerHTML = html;
}

// ── Round-trip tests ─────────────────────────────────────────────────────────

const ROUNDTRIP_CASES = [
  // === Japan: WGS84 ↔ Plane Rectangular ===
  { label: 'JP:Tokyo WGS84↔IX',     a: 'EPSG:4326', b: 'EPSG:6677', x: 139.7671, y: 35.6812, z: 0 },
  { label: 'JP:Osaka WGS84↔VI',     a: 'EPSG:4326', b: 'EPSG:6674', x: 135.5023, y: 34.6937, z: 0 },
  { label: 'JP:Sapporo WGS84↔XII',  a: 'EPSG:4326', b: 'EPSG:6680', x: 141.3469, y: 43.0621, z: 0 },
  { label: 'JP:Naha WGS84↔XV',      a: 'EPSG:4326', b: 'EPSG:6683', x: 127.6811, y: 26.2124, z: 0 },
  { label: 'JP:Yonaguni WGS84↔XVI', a: 'EPSG:4326', b: 'EPSG:6684', x: 122.9333, y: 24.4667, z: 0 },
  { label: 'JP:Etorofu WGS84↔XIII', a: 'EPSG:4326', b: 'EPSG:6681', x: 148.8,    y: 45.5,    z: 0 },
  { label: 'JP:MinamiT WGS84↔XIX',  a: 'EPSG:4326', b: 'EPSG:6687', x: 153.9811, y: 24.2867, z: 0 },
  { label: 'JP:Tokyo JGD2011↔IX',   a: 'EPSG:6668', b: 'EPSG:6677', x: 139.7671, y: 35.6812, z: 0 },
  { label: 'JP:Tokyo WGS84↔IX Z=50',a: 'EPSG:4326', b: 'EPSG:6677', x: 139.7671, y: 35.6812, z: 50 },
  { label: 'JP:Fujisan WGS84↔VIII', a: 'EPSG:4326', b: 'EPSG:6676', x: 138.7274, y: 35.3606, z: 3776 },

  // === Japan: Datum round-trips ===
  { label: 'JP:JGD2000↔JGD2011',    a: 'EPSG:4612', b: 'EPSG:6668', x: 139.7671, y: 35.6812, z: 0 },
  { label: 'JP:Tokyo↔JGD2011',      a: 'EPSG:4301', b: 'EPSG:6668', x: 139.7671, y: 35.6812, z: 0 },
  { label: 'JP:WGS84↔JGD2000',      a: 'EPSG:4326', b: 'EPSG:4612', x: 139.7671, y: 35.6812, z: 0 },
  { label: 'JP:4979↔4326 Z=50',     a: 'EPSG:4979', b: 'EPSG:4326', x: 139.7671, y: 35.6812, z: 50 },

  // === Japan: Geoid round-trip ===
  { label: 'JP:GSIGEO2011 RT',      a: 'EPSG:6667', b: 'EPSG:6697', x: 139.7671, y: 35.6812, z: 76 },
  { label: 'JP:JPGEO2024 RT',       a: 'EPSG:6667', b: 'EPSG:6695', x: 139.7671, y: 35.6812, z: 76 },
  { label: 'JP:WGS84→JGD2024 RT',   a: 'EPSG:4979', b: 'CZM:JGD2024', x: 139.7671, y: 35.6812, z: 76 },

  // === US: NAD multi-step round-trips ===
  { label: 'US:NYC NAD27↔NAD83(2011)',   a: 'EPSG:4267', b: 'EPSG:6318', x: -74.0060, y: 40.7128, z: 0 },
  { label: 'US:NYC NAD83↔NAD83(2011)',   a: 'EPSG:4269', b: 'EPSG:6318', x: -74.0060, y: 40.7128, z: 0 },
  { label: 'US:NYC WGS84↔UTM18N',       a: 'EPSG:4326', b: 'EPSG:32618', x: -74.0060, y: 40.7128, z: 0 },
  { label: 'US:SF WGS84↔UTM10N',        a: 'EPSG:4326', b: 'EPSG:32610', x: -122.4194, y: 37.7749, z: 0 },
  { label: 'US:NYC NAD83↔StatePlane',   a: 'EPSG:4269', b: 'EPSG:2260', x: -74.0060, y: 40.7128, z: 0 },

  // === Europe: multi-step datum round-trips ===
  { label: 'BE:Brussels BD72↔ETRS89',    a: 'EPSG:4313', b: 'EPSG:4258', x: 4.3517,   y: 50.8503, z: 0 },
  { label: 'BE:Brussels BL72↔BL2008',    a: 'EPSG:31370', b: 'EPSG:3812', x: 150327,  y: 170563,  z: 0 },
  { label: 'UK:London OSGB36↔ETRS89',    a: 'EPSG:4277', b: 'EPSG:4258', x: -0.1278,  y: 51.5074, z: 0 },
  { label: 'UK:London BNG↔WGS84',        a: 'EPSG:27700', b: 'EPSG:4326', x: 530000,  y: 180000,  z: 0 },
  { label: 'FR:Paris NTF↔RGF93',         a: 'EPSG:4275', b: 'EPSG:4171', x: 2.3522,   y: 48.8566, z: 0 },
  { label: 'DE:Berlin DHDN↔ETRS89',      a: 'EPSG:4314', b: 'EPSG:4258', x: 13.4050,  y: 52.5200, z: 0 },
  { label: 'DE:Berlin GK4↔UTM32',        a: 'EPSG:31468', b: 'EPSG:25832', x: 4587442, y: 5822377, z: 0 },
  { label: 'CH:Bern CH1903+↔ETRS89',     a: 'EPSG:4150', b: 'EPSG:4258', x: 7.4474,   y: 46.9481, z: 0 },
  { label: 'NL:Amsterdam RD↔ETRS89',     a: 'EPSG:4289', b: 'EPSG:4258', x: 4.9041,   y: 52.3676, z: 0 },
  { label: 'AT:Vienna MGI↔ETRS89',       a: 'EPSG:4312', b: 'EPSG:4258', x: 16.3738,  y: 48.2082, z: 0 },
  { label: 'NO:Oslo NGO48↔ETRS89',       a: 'EPSG:4273', b: 'EPSG:4258', x: 10.7522,  y: 59.9139, z: 0 },

  // === Oceania ===
  { label: 'NZ:Wellington NZGD49↔2000',  a: 'EPSG:4272', b: 'EPSG:4167', x: 174.7762, y: -41.2865, z: 0 },
  { label: 'NZ:Wellington WGS84↔NZTM',   a: 'EPSG:4326', b: 'EPSG:2193', x: 174.7762, y: -41.2865, z: 0 },
  { label: 'AU:Sydney GDA94↔GDA2020',    a: 'EPSG:4283', b: 'EPSG:7844', x: 151.2093, y: -33.8688, z: 0 },
  { label: 'AU:Sydney WGS84↔MGA56',      a: 'EPSG:4326', b: 'EPSG:28356', x: 151.2093, y: -33.8688, z: 0 },

  // === Global: EGM96 geoid ===
  { label: 'GL:NYC WGS84↔EGM96',        a: 'EPSG:4979', b: 'EPSG:5773', x: -74.0060, y: 40.7128, z: 30 },
  { label: 'GL:London WGS84↔EGM96',     a: 'EPSG:4979', b: 'EPSG:5773', x: -0.1278,  y: 51.5074, z: 80 },
];

async function runRoundTrips(proj) {
  const results = [];

  for (const c of ROUNDTRIP_CASES) {
    try {
      const fwd = await proj.transform(c.a, c.b, c.x, c.y, c.z);
      const inv = await proj.transform(c.b, c.a, fwd.x, fwd.y, fwd.z);
      const dx = inv.x - c.x;
      const dy = inv.y - c.y;
      const dz = inv.z - c.z;

      // tolerance depends on whether origin CRS is geographic
      const tolXY = isGeographic(c.a) ? TOL.rtGeo : TOL.rtProj;

      const pass = Math.abs(dx) <= tolXY
        && Math.abs(dy) <= tolXY
        && Math.abs(dz) <= TOL.rtH;

      results.push({
        label: c.label, a: c.a, b: c.b,
        origX: c.x, origY: c.y, origZ: c.z,
        fwdX: fwd.x, fwdY: fwd.y, fwdZ: fwd.z,
        retX: inv.x, retY: inv.y, retZ: inv.z,
        dx, dy, dz, tolXY, pass,
      });
    } catch (e) {
      results.push({
        label: c.label, a: c.a, b: c.b,
        origX: c.x, origY: c.y, origZ: c.z,
        pass: false, error: e.message,
      });
    }
  }
  return results;
}

function renderRoundTrips(results) {
  const container = document.getElementById('rt-results');
  const passCount = results.filter(r => r.pass).length;
  const total = results.length;

  document.getElementById('rt-summary').innerHTML =
    `<span class="${passCount === total ? 'pass' : 'fail'}">${passCount}/${total} passed</span>`;

  let html = `<table>
    <tr><th></th><th>Label</th><th>Route</th>
    <th>Original</th><th>Forward</th><th>Return</th>
    <th>dX</th><th>dY</th><th>dZ</th></tr>`;

  for (const r of results) {
    const cls = r.pass ? 'pass' : (r.error ? 'error' : 'fail');
    const status = r.pass ? 'PASS' : (r.error ? 'ERR' : 'FAIL');
    html += `<tr class="${cls}">
      <td class="status">${status}</td>
      <td>${r.label}</td>
      <td class="nowrap">${r.a}↔${r.b}</td>
      <td class="nowrap">(${fmt(r.origX)}, ${fmt(r.origY)}, ${fmt(r.origZ)})</td>
      <td class="nowrap">${r.fwdX !== undefined ? `(${fmt(r.fwdX)}, ${fmt(r.fwdY)}, ${fmt(r.fwdZ)})` : '-'}</td>
      <td class="nowrap">${r.retX !== undefined ? `(${fmt(r.retX)}, ${fmt(r.retY)}, ${fmt(r.retZ)})` : '-'}</td>
      <td>${fmtDiff(r.dx, r.tolXY)}</td>
      <td>${fmtDiff(r.dy, r.tolXY)}</td>
      <td>${fmtDiff(r.dz, TOL.rtH)}</td>
    </tr>`;
  }
  html += '</table>';
  container.innerHTML = html;
}

// ── Axis-order mismatch detection ────────────────────────────────────────────
// Verify that swapping input lon,lat produces clearly wrong results.
// This proves the API consistently expects lon,lat order.

const AXIS_CASES = [
  { label: 'Tokyo IX correct',     src: 'EPSG:4326', dst: 'EPSG:6677', x: 139.7671, y: 35.6812, swapped: false },
  { label: 'Tokyo IX SWAPPED',     src: 'EPSG:4326', dst: 'EPSG:6677', x: 35.6812, y: 139.7671, swapped: true },
  { label: 'Tokyo→JGD2011 correct', src: 'EPSG:4301', dst: 'EPSG:6668', x: 139.7671, y: 35.6812, swapped: false },
  { label: 'Tokyo→JGD2011 SWAPPED', src: 'EPSG:4301', dst: 'EPSG:6668', x: 35.6812, y: 139.7671, swapped: true },
  { label: 'Geoid correct',        src: 'EPSG:6667', dst: 'EPSG:6697', x: 139.7671, y: 35.6812, z: 76, swapped: false },
  { label: 'Geoid SWAPPED',        src: 'EPSG:6667', dst: 'EPSG:6697', x: 35.6812, y: 139.7671, z: 76, swapped: true },
  { label: 'JPGEO2024 correct',    src: 'EPSG:6667', dst: 'EPSG:6695', x: 139.7671, y: 35.6812, z: 76, swapped: false },
  { label: 'JPGEO2024 SWAPPED',    src: 'EPSG:6667', dst: 'EPSG:6695', x: 35.6812, y: 139.7671, z: 76, swapped: true },
  { label: 'JGD2024 correct',      src: 'EPSG:4979', dst: 'CZM:JGD2024', x: 139.7671, y: 35.6812, z: 76, swapped: false },
  { label: 'JGD2024 SWAPPED',      src: 'EPSG:4979', dst: 'CZM:JGD2024', x: 35.6812, y: 139.7671, z: 76, swapped: true },
];

async function runAxisTests(proj) {
  const results = [];
  for (const c of AXIS_CASES) {
    try {
      const r = await proj.transform(c.src, c.dst, c.x, c.y, c.z || 0);
      const isNanInf = !isFinite(r.x) || !isFinite(r.y);

      // For swapped input: should either fail, return NaN, or give clearly wrong result
      // For correct input: should return a reasonable Japanese coordinate
      let pass;
      if (c.swapped) {
        // Expect failure or obviously wrong result (lat 35.68 used as lon → outside Japan)
        pass = isNanInf || r.x === undefined;
        // If it "succeeds", mark as WARN — it returned a result for swapped input
        if (!pass) {
          results.push({
            label: c.label, src: c.src, dst: c.dst,
            input: `(${c.x}, ${c.y})`,
            output: `(${r.x.toFixed(4)}, ${r.y.toFixed(4)}, ${r.z.toFixed(4)})`,
            pass: false, warn: true, note: 'accepted swapped input (expected fail/NaN)',
          });
          continue;
        }
      } else {
        pass = isFinite(r.x) && isFinite(r.y);
      }

      results.push({
        label: c.label, src: c.src, dst: c.dst,
        input: `(${c.x}, ${c.y})`,
        output: isNanInf ? 'NaN/Inf' : `(${r.x.toFixed(4)}, ${r.y.toFixed(4)}, ${r.z.toFixed(4)})`,
        pass, note: c.swapped ? (isNanInf ? 'correctly rejected' : '') : 'OK',
      });
    } catch (e) {
      results.push({
        label: c.label, src: c.src, dst: c.dst,
        input: `(${c.x}, ${c.y})`,
        output: 'ERROR',
        pass: c.swapped,  // error on swapped input = correct behavior
        note: c.swapped ? 'correctly rejected' : e.message,
      });
    }
  }
  return results;
}

function renderAxisTests(results) {
  const container = document.getElementById('axis-results');
  const passCount = results.filter(r => r.pass).length;
  const total = results.length;

  document.getElementById('axis-summary').innerHTML =
    `<span class="${passCount === total ? 'pass' : 'fail'}">${passCount}/${total} passed</span>`;

  let html = `<table>
    <tr><th></th><th>Label</th><th>CRS</th><th>Input</th><th>Output</th><th>Note</th></tr>`;

  for (const r of results) {
    const cls = r.pass ? 'pass' : (r.warn ? 'warn' : 'fail');
    const status = r.pass ? 'PASS' : (r.warn ? 'WARN' : 'FAIL');
    html += `<tr class="${cls}">
      <td class="status">${status}</td>
      <td>${r.label}</td>
      <td class="nowrap">${r.src}→${r.dst}</td>
      <td class="nowrap">${r.input}</td>
      <td class="nowrap">${r.output}</td>
      <td>${r.note || ''}</td>
    </tr>`;
  }
  html += '</table>';
  container.innerHTML = html;
}

// ── Robustness tests (invalid / extreme inputs) ─────────────────────────────

const ROBUSTNESS_CASES = [
  // Out-of-range coordinates
  { label: 'lat > 90',             src: 'EPSG:4326', dst: 'EPSG:6677', x: 139.77, y: 95.0,    z: 0 },
  { label: 'lat = -90',            src: 'EPSG:4326', dst: 'EPSG:6677', x: 139.77, y: -90.0,   z: 0 },
  { label: 'lon > 180',            src: 'EPSG:4326', dst: 'EPSG:6677', x: 200.0,  y: 35.68,   z: 0 },
  { label: 'lon = -180',           src: 'EPSG:4326', dst: 'EPSG:6677', x: -180.0, y: 35.68,   z: 0 },

  // NaN / Infinity
  { label: 'NaN lat',              src: 'EPSG:4326', dst: 'EPSG:6677', x: 139.77, y: NaN,     z: 0 },
  { label: 'NaN lon',              src: 'EPSG:4326', dst: 'EPSG:6677', x: NaN,    y: 35.68,   z: 0 },
  { label: 'Inf lon',              src: 'EPSG:4326', dst: 'EPSG:6677', x: Infinity, y: 35.68, z: 0 },
  { label: 'NaN z',                src: 'EPSG:4326', dst: 'EPSG:6677', x: 139.77, y: 35.68,   z: NaN },

  // Outside Japan → Japan Plane Rectangular
  { label: 'London→IX',            src: 'EPSG:4326', dst: 'EPSG:6677', x: -0.1278, y: 51.5074, z: 0 },
  { label: 'New York→IX',          src: 'EPSG:4326', dst: 'EPSG:6677', x: -74.006, y: 40.7128, z: 0 },
  { label: 'Sydney→IX',            src: 'EPSG:4326', dst: 'EPSG:6677', x: 151.209, y: -33.868, z: 0 },

  // Zero coordinates
  { label: 'Origin(0,0)→IX',       src: 'EPSG:4326', dst: 'EPSG:6677', x: 0,      y: 0,       z: 0 },

  // Invalid CRS
  { label: 'Invalid src CRS',      src: 'EPSG:9999999', dst: 'EPSG:6677', x: 139.77, y: 35.68, z: 0 },
  { label: 'Invalid dst CRS',      src: 'EPSG:4326', dst: 'EPSG:9999999', x: 139.77, y: 35.68, z: 0 },
  { label: 'Empty src CRS',        src: '',           dst: 'EPSG:6677',   x: 139.77, y: 35.68, z: 0 },
  { label: 'Garbage CRS',          src: 'not_a_crs',  dst: 'EPSG:6677',  x: 139.77, y: 35.68, z: 0 },

  // Negative height
  { label: 'Negative Z=-100',      src: 'EPSG:4326', dst: 'EPSG:6677', x: 139.77, y: 35.68,   z: -100 },

  // Very large Z
  { label: 'Z=100000m (100km)',    src: 'EPSG:4326', dst: 'EPSG:6677', x: 139.77, y: 35.68,   z: 100000 },
];

async function runRobustnessTests(proj) {
  const results = [];
  for (const c of ROBUSTNESS_CASES) {
    try {
      const r = await proj.transform(c.src, c.dst, c.x, c.y, c.z);
      const isNanInf = !isFinite(r.x) || !isFinite(r.y) || !isFinite(r.z);
      results.push({
        label: c.label,
        input: `(${c.x}, ${c.y}, ${c.z})`,
        output: isNanInf ? 'NaN/Inf' : `(${r.x.toFixed(4)}, ${r.y.toFixed(4)}, ${r.z.toFixed(4)})`,
        status: isNanInf ? 'NaN/Inf' : 'returned',
        isError: false,
      });
    } catch (e) {
      results.push({
        label: c.label,
        input: `(${c.x}, ${c.y}, ${c.z})`,
        output: `ERROR: ${e.message}`,
        status: 'error',
        isError: true,
      });
    }
  }
  return results;
}

function renderRobustness(results) {
  const container = document.getElementById('robust-results');

  let html = `<table>
    <tr><th>Label</th><th>Input</th><th>Status</th><th>Output</th></tr>`;

  for (const r of results) {
    const cls = r.isError ? 'error' : (r.status === 'NaN/Inf' ? 'warn' : '');
    html += `<tr class="${cls}">
      <td>${r.label}</td>
      <td class="nowrap">${r.input}</td>
      <td class="status">${r.status}</td>
      <td class="nowrap">${r.output}</td>
    </tr>`;
  }
  html += '</table>';
  container.innerHTML = html;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function fmt(v) {
  if (v === undefined || v === null || v === '' || v === '-') return '-';
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isNaN(n) ? String(v) : n.toFixed(6);
}

function fmtDiff(v, tol) {
  if (v === undefined || v === null) return '-';
  const s = v.toExponential(2);
  return Math.abs(v) > tol ? `<b>${s}</b>` : s;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function run() {
  const statusEl = document.getElementById('status');
  statusEl.textContent = 'Loading PROJ runtime...';

  let proj;
  try {
    const { worker } = await initProjRuntime({
      dataUrl: '/assets/proj-data.tar.gz',
      dataVersion: '2026-02-04',
      dataDirName: 'proj-data',
      wasmUrl: '/dist/proj_wasm.wasm',
    });
    proj = createProjApi(worker);
  } catch (e) {
    statusEl.textContent = `Init failed: ${e.message}`;
    return;
  }

  // 1. CSV comparison
  statusEl.textContent = 'Running CSV comparison...';
  const csvResults = await runCsvComparison(proj);
  renderCsvTable(csvResults);

  // 2. Round-trip
  statusEl.textContent = 'Running round-trip tests...';
  const rtResults = await runRoundTrips(proj);
  renderRoundTrips(rtResults);

  // 3. Axis-order
  statusEl.textContent = 'Running axis-order tests...';
  const axisResults = await runAxisTests(proj);
  renderAxisTests(axisResults);

  // 4. Robustness
  statusEl.textContent = 'Running robustness tests...';
  const robustResults = await runRobustnessTests(proj);
  renderRobustness(robustResults);

  const totalPass = csvResults.filter(r => r.pass).length
    + rtResults.filter(r => r.pass).length
    + axisResults.filter(r => r.pass).length;
  const totalTests = csvResults.length + rtResults.length + axisResults.length;
  statusEl.textContent = `Done. ${totalPass}/${totalTests} passed (+ ${robustResults.length} robustness cases)`;
}
