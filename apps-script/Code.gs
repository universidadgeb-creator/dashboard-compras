/**
 * Write-back endpoint for the Dashboard Compras static site.
 *
 * Lets the public dashboard update Estatus, Prioridad and "Notas de
 * seguimiento" for one existing row of the "Control de pedidos 2026
 * whatsapp" sheet, gated by a shared PIN kept in Script Properties
 * (never in this source or in the dashboard's client-side code).
 *
 * SETUP (one time, done by a human in the Google account that owns the sheet):
 *   1. Open the sheet -> Extensions -> Apps Script.
 *   2. Replace the default Code.gs contents with this whole file.
 *   3. Project Settings (gear icon) -> Script Properties -> Add property:
 *        name: EDIT_PIN
 *        value: <a PIN you choose and share only with the compras team>
 *   4. Deploy -> New deployment -> select type "Web app".
 *        - Description: anything, e.g. "dashboard write-back"
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Click Deploy, authorize the requested permissions (it needs to edit
 *      this spreadsheet), then copy the "Web app URL" (ends in /exec).
 *   5. Give that URL to Claude so it can be wired into index.html.
 *
 * Whenever you edit this file after the first deploy, use
 * Deploy -> Manage deployments -> edit (pencil) -> New version, otherwise
 * the live /exec URL keeps serving the old code.
 */

// The gid of the "Respuestas de formulario 1" response tab — looked up by
// id (not by name) so a future tab rename doesn't break this script.
const RESPONSES_GID = 1407992280;
const HEADER_ROW = 1;

function doPost(e) {
  try {
    if (!e || !e.postData) return jsonOut({ ok: false, error: 'Sin cuerpo en la solicitud' });
    const body = JSON.parse(e.postData.contents);

    const pin = PropertiesService.getScriptProperties().getProperty('EDIT_PIN');
    if (!pin) return jsonOut({ ok: false, error: 'El script no tiene EDIT_PIN configurado (Project Settings > Script Properties)' });
    if (body.pin !== pin) return jsonOut({ ok: false, error: 'PIN incorrecto' });

    const sheet = getResponsesSheet();
    if (!sheet) return jsonOut({ ok: false, error: 'No se encontró la hoja de respuestas' });

    const sheetRow = Number(body.sheetRow);
    if (!sheetRow || sheetRow < 1) return jsonOut({ ok: false, error: 'sheetRow inválido' });
    const row = sheetRow + HEADER_ROW; // header occupies row 1, data starts at row 2

    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0].map((h) => String(h).trim());
    const colFor = (name) => {
      const idx = headers.indexOf(name);
      return idx === -1 ? null : idx + 1;
    };

    // Sanity check: refuse to write if this row no longer looks like the one
    // the dashboard had loaded (e.g. rows were inserted/deleted since then).
    const folioExpected = 'REQ-' + String(sheetRow).padStart(4, '0');
    if (body.folio && body.folio !== folioExpected) {
      return jsonOut({ ok: false, error: 'La fila ya no corresponde a esa solicitud (folio no coincide) — recarga la página e intenta de nuevo' });
    }
    const tsCol = colFor('Marca temporal');
    if (tsCol && !sheet.getRange(row, tsCol).getValue()) {
      return jsonOut({ ok: false, error: 'La fila ya no corresponde a esa solicitud (¿se movió o se borró?) — recarga la página e intenta de nuevo' });
    }

    const fieldToColumn = { estatus: 'Estatus', prioridad: 'Prioridad', notas: 'Notas de seguimiento' };
    const missingColumns = [];
    let wrote = 0;
    Object.keys(fieldToColumn).forEach((field) => {
      if (typeof body[field] !== 'string') return;
      const col = colFor(fieldToColumn[field]);
      if (col == null) { missingColumns.push(fieldToColumn[field]); return; }
      sheet.getRange(row, col).setValue(body[field]);
      wrote++;
    });

    if (missingColumns.length) {
      return jsonOut({ ok: false, error: 'Columnas no encontradas en la hoja: ' + missingColumns.join(', ') });
    }
    if (!wrote) return jsonOut({ ok: false, error: 'No se envió ningún campo para actualizar' });

    return jsonOut({ ok: true });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

// Lets you open the /exec URL directly in a browser to confirm the
// deployment is live (it won't write anything).
function doGet() {
  return jsonOut({ ok: true, info: 'Dashboard Compras write-back endpoint is running. POST to update a row.' });
}

function getResponsesSheet() {
  const sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === RESPONSES_GID) return sheets[i];
  }
  return null;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
