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
    https.get(url, (res) => {
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
    }).on('error', reject);
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
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

const UNIDAD_INFER = {
  NACIONES: { unidad: 'Vivo 47', sucursal: 'Naciones Unidas' },
  GOURMETERIA: { unidad: 'Vivo 47', sucursal: 'Gourmetería' },
};

async function main() {
  const csv = await fetchCSV(CSV_URL);
  const rows = parseCSV(csv);

  const seen = {};
  const header = rows[0].map((h) => {
    const base = h.trim();
    if (seen[base] == null) { seen[base] = 0; return base; }
    seen[base]++;
    return base + '_' + (seen[base] + 1);
  });

  const raw = rows
    .slice(1)
    .filter((r) => (r[0] || '').trim() !== '')
    .map((r) => {
      const o = {};
      header.forEach((h, i) => (o[h] = (r[i] || '').trim()));
      return o;
    });

  const out = raw.map((r, idx) => {
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
    let estatusSinDefinir = false;
    if (!estatus) { estatus = 'Pendiente'; estatusSinDefinir = true; }
    // A recorded receipt date closes the cycle, regardless of the Estatus cell.
    if (r['Fecha de recepción real']) { estatus = 'Entregado'; estatusSinDefinir = false; }

    const cantidadNum = parseInt(r['Cantidad'], 10);

    return {
      folio: 'REQ-' + String(idx + 1).padStart(3, '0'),
      fechaSolicitud: parseDT(r['Marca temporal']),
      solicitante: r['Escribe tu nombre'] || 'Sin nombre',
      correo: r['Escribe tu correo electrónico'] || '',
      unidad: unidad || '',
      unidadInferida,
      sucursal: sucursal || '',
      departamento: departamento || 'Sin especificar',
      articulo: r['Nombre del articulo'] || '(sin descripción)',
      cantidad: isNaN(cantidadNum) ? 1 : cantidadNum,
      prioridad: r['Prioridad'] || 'Normal',
      comentarios: r['Comentarios'] || '',
      estatus,
      estatusSinDefinir,
      fechaEstimada: parseDT(r['Fecha estimada de entrega']),
      // Populated once the sheet has these two columns (compras team fills them in directly).
      fechaRecibido: parseDT(r['Fecha de recepción real']),
      notas: r['Notas de seguimiento'] || '',
    };
  });

  const payload = { rows: out, sourceRowCount: out.length, updatedAt: new Date().toISOString() };
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${out.length} rows to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('generate-data failed:', err.message);
  process.exit(1);
});
