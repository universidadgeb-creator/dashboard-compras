// Fetches the "Control de pedidos 2026 whatsapp" Google Sheet, cleans it up,
// and writes data.json for the static dashboard. No npm dependencies.
const https = require('https');
const fs = require('fs');
const path = require('path');

const SHEET_ID = '1eBcCWswIe12wv-26kwAw83Hh7pwax9Ip6PxisUq14Jg';
const GID = '1407992280'; // "Respuestas de formulario 1"
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
const OUT_PATH = path.join(__dirname, '..', 'data.json');

function fetchCSV(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(fetchCSV(res.headers.location, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Unexpected status ${res.statusCode} fetching sheet`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('Timed out fetching sheet')));
    req.on('error', reject);
  });
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseDT(s) {
  if (!s) return null;
  const [datePart] = s.split(' ');
  const [d, m, y] = datePart.split('/').map(Number);
  if (!d || !m || !y) return null;
  if (d < 1 || d > 31 || m < 1 || m > 12 || y < 2000 || y > 2100) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

const UNIDAD_INFER = {
  NACIONES: { unidad: 'Vivo 47', sucursal: 'Naciones Unidas' },
  GOURMETERIA: { unidad: 'Vivo 47', sucursal: 'Gourmetería' },
};

// Known branches per business unit, kept even when a branch has zero requests
// so far (e.g. Valle Real) — add new ones here as the org grows.
const SUCURSALES_CONOCIDAS = {
  'EasyFit': ['Aleira', 'ITESO', 'Cañadas', 'Ávila Camacho'],
  'GEB': ['Universidad'],
  'Vivo 47': ['Naciones Unidas', 'Gourmetería', 'Valle Real'],
};

async function main() {
  const csv = await fetchCSV(CSV_URL);
  const rows = parseCSV(csv);

  // A 200 response can still be the wrong body (Google interstitial/consent
  // page, a moved sheet, etc.) — bail out loudly instead of writing garbage.
  if (!rows.length || !rows[0].some((h) => h.trim() === 'Marca temporal')) {
    throw new Error('Unexpected sheet shape: "Marca temporal" header not found — refusing to overwrite data.json');
  }

  const seen = {};
  const header = rows[0].map((h) => {
    const base = h.trim();
    if (seen[base] == null) { seen[base] = 0; return base; }
    seen[base]++;
    return base + '_' + (seen[base] + 1);
  });

  // Keep each row's original position in the sheet (1-based, header excluded)
  // as its folio's numeric source, so folios stay stable across regenerations
  // even if an earlier row's first cell is briefly blank or later filled in.
  const raw = rows
    .slice(1)
    .map((r, i) => ({ r, sheetRow: i + 1 }))
    .filter(({ r }) => (r[0] || '').trim() !== '')
    .map(({ r, sheetRow }) => {
      const o = { sheetRow };
      header.forEach((h, i) => (o[h] = (r[i] || '').trim()));
      return o;
    });

  const out = raw.map((r) => {
    const oldSucursal = r['SUCURSAL'];
    const unidadExplicit = r['Unidad de Negocio'] || '';
    const sucursalExplicit = r['Selecciona tu sucursal'] || r['Selecciona Sucursal'] || r['Sucursal en la que laboras'] || '';
    const departamento = r['Departamento'] || r['Departamento_2'] || '';

    let unidad = unidadExplicit;
    let sucursal = sucursalExplicit;
    let unidadInferida = false;
    if (!unidad && !sucursal && oldSucursal && UNIDAD_INFER[oldSucursal]) {
      unidad = UNIDAD_INFER[oldSucursal].unidad;
      sucursal = UNIDAD_INFER[oldSucursal].sucursal;
      unidadInferida = true;
    }

    let estatus = r['Estatus'] || '';
    if (!estatus) estatus = 'Pendiente';
    // A recorded receipt date closes the cycle, regardless of the Estatus cell.
    if (r['Fecha de recepción real']) estatus = 'Entregado';

    const cantidadNum = parseInt(r['Cantidad'], 10);

    return {
      folio: 'REQ-' + String(r.sheetRow).padStart(4, '0'),
      // The row's 1-based position among data rows (header excluded) — lets
      // the dashboard tell the Apps Script write-back endpoint exactly which
      // sheet row to edit.
      sheetRow: r.sheetRow,
      fechaSolicitud: parseDT(r['Marca temporal']),
      solicitante: r['Escribe tu nombre'] || 'Sin nombre',
      correo: r['Escribe tu correo electrónico'] || '',
      // 'Sin especificar' (not '') for a legacy row whose old SUCURSAL value
      // isn't in UNIDAD_INFER — makes an unmapped row visible/filterable
      // instead of silently blank, consistent with departamento below.
      unidad: unidad || 'Sin especificar',
      unidadInferida,
      sucursal: sucursal || 'Sin especificar',
      departamento: departamento || 'Sin especificar',
      articulo: r['Nombre del articulo'] || '(sin descripción)',
      cantidad: isNaN(cantidadNum) ? 1 : cantidadNum,
      prioridad: r['Prioridad'] || 'Normal',
      comentarios: r['Comentarios'] || '',
      estatus,
      fechaEstimada: parseDT(r['Fecha estimada de entrega']),
      // Populated once the sheet has these two columns (compras team fills them in directly).
      fechaRecibido: parseDT(r['Fecha de recepción real']),
      notas: r['Notas de seguimiento'] || '',
    };
  });

  const payload = {
    rows: out,
    sourceRowCount: out.length,
    updatedAt: new Date().toISOString(),
    catalog: { sucursalesPorUnidad: SUCURSALES_CONOCIDAS },
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${out.length} rows to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('generate-data failed:', err.message);
  process.exit(1);
});
