// ==UserScript==
// @name         Google Flights Extractor
// @namespace    https://example.com/google-flights-extractor
// @version      1.8.0
// @description  Extract flights, times, prices, durations, stops, airlines, cabin class, aircraft type, flight number, operating carrier, legroom, wifi/USB/power, emissions and contrail info from a Google Flights search results page. Export as JSON, CSV, a printable/PDF-ready HTML report, or a Word (.doc) file. Includes a dry-run toggle scanner and a confirmed "Expand All" action. On the Explore map, colors price pins cheapest-to-most-expensive as a green-to-red heatmap. Trusted-Types / CSP safe.
// @author       you
// @match        https://www.google.com/travel/flights*
// @match        https://www.google.com/travel/explore*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const LOG = (...args) => console.log('[GFE]', ...args);
  const ERR = (...args) => console.error('[GFE]', ...args);

  const BTN_ID = 'gfe-extract-btn';
  const SCAN_BTN_ID = 'gfe-scan-btn';
  const EXPAND_BTN_ID = 'gfe-expand-btn';
  const PANEL_ID = 'gfe-panel';
  const SCAN_PANEL_ID = 'gfe-scan-panel';

  const isFlightsPage = () => location.pathname.startsWith('/travel/flights');
  const isExplorePage = () => location.pathname.startsWith('/travel/explore');

  /* ---------------------------------------------------------
   * DOM helper — NEVER uses innerHTML/outerHTML on the Google
   * Flights page itself, so it works even under a Trusted Types
   * CSP (Google properties commonly enforce one). All styling on
   * THIS page is applied via the CSSOM (el.style.prop = value)
   * rather than a <style> tag, since injected <style> elements
   * are frequently blocked by strict style-src CSP without a
   * nonce. (The printable report opens in a brand-new blank tab,
   * which carries none of Google's CSP, so document.write with a
   * full HTML string is fine there — see openPrintableReport.)
   * ------------------------------------------------------- */
  function el(tag, styles, attrs) {
    const node = document.createElement(tag);
    if (styles) Object.assign(node.style, styles);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v);
      }
    }
    return node;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ---------------------------------------------------------
   * Core flight extraction — relies on aria-label text (stable,
   * screen-reader oriented) rather than Google's ever-changing
   * generated CSS class names.
   * ------------------------------------------------------- */

  function collectCandidateNodes() {
    const all = Array.from(document.querySelectorAll('[aria-label]'));
    return all.filter((node) => {
      const label = node.getAttribute('aria-label') || '';
      return /total duration/i.test(label) && /stop/i.test(label) && label.length > 40;
    });
  }

  function dedupeByLabel(nodes) {
    const seen = new Set();
    const out = [];
    for (const n of nodes) {
      const label = n.getAttribute('aria-label').trim();
      if (!seen.has(label)) {
        seen.add(label);
        out.push(n);
      }
    }
    return out;
  }

  function parsePrice(label) {
    let m = label.match(/From\s+([\d,]+)\s*([A-Za-z]{2,}(?:\s?dollars?)?)/i);
    if (m) return { amount: m[1].replace(/,/g, ''), currency: m[2].trim() };

    m = label.match(/([€£$]|AU\$|US\$|CA\$)\s?([\d,]+)/);
    if (m) return { amount: m[2].replace(/,/g, ''), currency: m[1] };

    m = label.match(/([\d,]+)\s*(US dollars|Australian dollars|euros|pounds)/i);
    if (m) return { amount: m[1].replace(/,/g, ''), currency: m[2] };

    return { amount: '', currency: '' };
  }

  function parseStops(label) {
    if (/non-?stop flight/i.test(label)) return 0;
    const m = label.match(/(\d+)\s+stop/i);
    if (m) return parseInt(m[1], 10);
    return null;
  }

  function parseAirline(label) {
    const m = label.match(/flight with ([^.]+?)\./i);
    return m ? m[1].trim() : '';
  }

  function parseLeg(label, verb) {
    const re = new RegExp(
      verb + '\\s+(?:at\\s+)?([^.]+?)\\s+at\\s+([\\d:apAPM\\s]+?)\\s+on\\s+([A-Za-z]+,\\s*[A-Za-z]+\\s+\\d{1,2})',
      'i'
    );
    const m = label.match(re);
    if (!m) return { location: '', time: '', date: '' };
    return { location: m[1].trim(), time: m[2].trim(), date: m[3].trim() };
  }

  function parseDuration(label) {
    const m = label.match(/Total duration\s+(?:(\d+)\s*hrs?)?\s*(?:(\d+)\s*min)?/i);
    if (!m) return { text: '', minutes: null };
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    const parts = [];
    if (h) parts.push(`${h} hr`);
    if (mins) parts.push(`${mins} min`);
    return { text: parts.join(' '), minutes: h * 60 + mins };
  }

  function parseStopoverSummary(label) {
    const re = /Stopover \(\d+ of \d+\) is a ([^.]+?) stopover at ([^.]+?)\./gi;
    const summaries = [];
    let m;
    while ((m = re.exec(label)) !== null) {
      const durText = m[1].trim();
      const locText = m[2].trim();
      const cityMatch = locText.match(/in ([A-Za-z .'-]+)$/);
      const city = cityMatch ? cityMatch[1].trim() : locText;
      summaries.push(`${city} (${durText})`);
    }
    return summaries.join(' · ');
  }

  function parseLayover(label) {
    const m = label.match(/Layover[^.]*\./gi);
    return m ? m.join(' ') : '';
  }

  function emptyDetails() {
    return {
      cabin_class: '',
      aircraft_type: '',
      flight_number: '',
      operated_by: '',
      legroom: '',
      wifi: '',
      in_seat_power: false,
      in_seat_usb: false,
      stream_media: false,
      emissions_estimate: '',
      emissions_comparison: '',
      contrail_warming_potential: '',
    };
  }

  function extractCoreFlights() {
    const nodes = dedupeByLabel(collectCandidateNodes());
    LOG(`Found ${nodes.length} candidate flight node(s)`);
    return nodes.map((n, i) => {
      const label = n.getAttribute('aria-label').trim();
      const price = parsePrice(label);
      const departure = parseLeg(label, 'Leaves');
      const arrival = parseLeg(label, 'arrives');
      const duration = parseDuration(label);
      const stops = parseStops(label);
      return {
        index: i + 1,
        airline: parseAirline(label),
        stops,
        price_amount: price.amount,
        price_currency: price.currency,
        departure_location: departure.location,
        departure_time: departure.time,
        departure_date: departure.date,
        arrival_location: arrival.location,
        arrival_time: arrival.time,
        arrival_date: arrival.date,
        duration: duration.text,
        duration_minutes: duration.minutes,
        stopover: stops ? parseStopoverSummary(label) : '',
        layover_info: parseLayover(label),
        ...emptyDetails(),
        raw_label: label,
        _node: n,
      };
    });
  }

  /* ---------------------------------------------------------
   * Expanded-details-panel extraction (amenities + aircraft info)
   * ------------------------------------------------------- */

  function findInnermostMatches(regex) {
    const all = Array.from(document.querySelectorAll('body *')).filter((n) => regex.test(n.textContent || ''));
    return all.filter((n) => !all.some((other) => other !== n && n.contains(other)));
  }

  function getLeafTexts(root) {
    const out = [];
    const all = root.querySelectorAll('*');
    for (const elm of all) {
      if (elm.children.length === 0) {
        const t = (elm.textContent || '').trim();
        if (t) out.push(t);
      }
    }
    const deduped = [];
    for (const t of out) {
      if (deduped.length === 0 || deduped[deduped.length - 1] !== t) deduped.push(t);
    }
    return deduped;
  }

  function parseAircraftLineFromText(text) {
    const m = text.match(
      /([A-Za-z][A-Za-z0-9&.\-\s]{1,40}?)\s*[·•]\s*(Economy|Premium economy|Premium Economy|Business|First)\s*[·•]\s*([^·•\n]{2,40}?)\s*[·•]\s*([A-Z]{1,3}\s?\d{1,5})/
    );
    if (!m) return null;
    return {
      cabin_class: m[2].trim(),
      aircraft_type: m[3].trim(),
      flight_number: m[4].replace(/\s+/g, ' ').trim(),
    };
  }

  function parseAircraftLineFromLeaves(container) {
    const leaves = getLeafTexts(container);
    const cabinRe = /^(Economy|Premium economy|Premium Economy|Business|First)$/i;
    const flightNoRe = /^[A-Z]{1,3}\s?\d{1,5}$/;

    const cabinIdx = leaves.findIndex((l) => cabinRe.test(l));
    const flightIdx = leaves.findIndex((l) => flightNoRe.test(l));

    if (cabinIdx === -1 && flightIdx === -1) return null;

    const out = {};
    if (cabinIdx !== -1) out.cabin_class = leaves[cabinIdx];
    if (flightIdx !== -1) out.flight_number = leaves[flightIdx].replace(/\s+/g, ' ').trim();

    if (cabinIdx !== -1 && flightIdx !== -1 && flightIdx > cabinIdx + 1) {
      out.aircraft_type = leaves.slice(cabinIdx + 1, flightIdx).join(' ').trim();
    } else if (flightIdx > 0) {
      const candidate = leaves[flightIdx - 1];
      if (candidate && !cabinRe.test(candidate)) out.aircraft_type = candidate;
    }
    LOG('Structural aircraft-line parse from leaves:', leaves, '->', out);
    return out;
  }

  function parseDetailBlockText(text, container) {
    const out = emptyDetails();

    const aircraftLine = parseAircraftLineFromText(text) || parseAircraftLineFromLeaves(container);
    if (aircraftLine) Object.assign(out, aircraftLine);

    let m = text.match(/Plane and crew by ([^.\n]+?)\s+for\s+[^.\n]+/i);
    if (m) {
      out.operated_by = m[1].trim();
    } else {
      m = text.match(/Operated by ([^.\n]+)/i);
      if (m) out.operated_by = m[1].trim();
    }

    m = text.match(/(?:Average|Below average|Above average)?\s*[Ll]egroom\s*\(([^)]+)\)/);
    if (m) out.legroom = m[1].trim();

    if (/wifi/i.test(text)) {
      m = text.match(/wifi[^.]*?(available for a fee|available|for a fee)/i);
      out.wifi = m ? m[1].trim() : 'mentioned';
    }

    out.in_seat_power = /in-seat power outlet/i.test(text);
    out.in_seat_usb = /in-seat usb outlet/i.test(text);
    out.stream_media = /stream media to your device/i.test(text);

    m = text.match(/Emissions estimate:?\s*([\d,]+\s*kg\s*CO2e?)/i);
    if (m) out.emissions_estimate = m[1].trim();

    m = text.match(/([+-]\s?\d+%)\s*emissions/i);
    if (m) out.emissions_comparison = m[1].replace(/\s+/g, '');

    m = text.match(/Contrail warming potential:?\s*(Low|Moderate|High)/i);
    if (m) out.contrail_warming_potential = m[1].trim();

    return out;
  }

  function findContainerAndFlightNode(anchor, candidateNodes) {
    let node = anchor;
    for (let i = 0; i < 25 && node; i += 1, node = node.parentElement) {
      const found = candidateNodes.find((c) => node.contains(c));
      if (found) return { container: node, flightNode: found };
    }
    return null;
  }

  function enrichWithExpandedDetails(flights) {
    const candidateNodes = flights.map((f) => f._node);
    const anchors = findInnermostMatches(/Emissions estimate/i);
    LOG(`Found ${anchors.length} expanded details panel(s)`);

    anchors.forEach((anchor) => {
      const match = findContainerAndFlightNode(anchor, candidateNodes);
      if (!match) return;
      const { container, flightNode } = match;
      const flight = flights.find((f) => f._node === flightNode);
      if (!flight) return;
      const details = parseDetailBlockText(container.textContent || '', container);
      Object.assign(flight, details);
    });

    return flights.map(({ _node, ...rest }) => rest);
  }

  function extractFlights() {
    const core = extractCoreFlights();
    return enrichWithExpandedDetails(core);
  }

  /* ---------------------------------------------------------
   * "Expand details" toggle handling
   * ------------------------------------------------------- */

  function findRowContainer(flightNode) {
    let node = flightNode;
    for (let i = 0; i < 10 && node; i += 1, node = node.parentElement) {
      if (node.getAttribute && node.getAttribute('role') === 'listitem') return node;
      if (node.tagName === 'LI') return node;
    }
    return flightNode.parentElement || flightNode;
  }

  function describeElement(elm) {
    return {
      tag: elm.tagName,
      role: elm.getAttribute('role') || '',
      ariaLabel: elm.getAttribute('aria-label') || '',
      ariaExpanded: elm.hasAttribute('aria-expanded') ? elm.getAttribute('aria-expanded') : null,
      classSnippet: (elm.className && elm.className.toString ? elm.className.toString() : '').slice(0, 60),
      textSnippet: (elm.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50),
      element: elm,
    };
  }

  function findExpandToggleCandidates(container, flightNode) {
    const seen = new Set();
    const results = [];

    const addIfValid = (elm) => {
      if (!elm || elm === flightNode) return;
      if (elm.contains(flightNode)) return;
      if (seen.has(elm)) return;
      seen.add(elm);
      results.push(describeElement(elm));
    };

    container.querySelectorAll('[aria-expanded]').forEach(addIfValid);
    container.querySelectorAll('[role="button"], button').forEach(addIfValid);

    results.sort((a, b) => (b.ariaExpanded !== null) - (a.ariaExpanded !== null));
    return results;
  }

  function findDetailsToggleButton(container, flightNode) {
    const buttons = container.querySelectorAll('button[aria-expanded]');
    for (const b of buttons) {
      if (b === flightNode || b.contains(flightNode)) continue;
      const label = b.getAttribute('aria-label') || '';
      if (/^Flight details\./i.test(label)) return b;
    }
    return null;
  }

  function runToggleScan() {
    const core = extractCoreFlights();
    LOG(`Scanning ${core.length} flight row(s) for expand-toggle candidates (dry run — nothing will be clicked)`);

    const summary = [];
    core.forEach((flight) => {
      const container = findRowContainer(flight._node);
      const candidates = findExpandToggleCandidates(container, flight._node);
      console.groupCollapsed(
        `[GFE] Row ${flight.index}: ${flight.airline} — ${flight.price_amount} ${flight.price_currency} — ${candidates.length} candidate(s)`
      );
      candidates.forEach((c, idx) => {
        console.log(
          `#${idx + 1}`,
          `<${c.tag.toLowerCase()}>`,
          'role=' + JSON.stringify(c.role),
          'aria-expanded=' + JSON.stringify(c.ariaExpanded),
          'aria-label=' + JSON.stringify(c.ariaLabel),
          'text=' + JSON.stringify(c.textSnippet),
          c.element
        );
      });
      if (!candidates.length) console.log('(no candidates found in this row)');
      console.groupEnd();

      const best = candidates.find((c) => c.ariaExpanded !== null) || candidates[0] || null;
      summary.push({ flight, candidateCount: candidates.length, best });
    });

    return summary;
  }

  async function expandAllFlights({ delayMs = 250 } = {}) {
    const core = extractCoreFlights();
    let clicked = 0;
    let alreadyExpanded = 0;
    let notFound = 0;

    for (const flight of core) {
      const container = findRowContainer(flight._node);
      const toggle = findDetailsToggleButton(container, flight._node);

      if (!toggle) {
        notFound += 1;
        LOG(`Row ${flight.index}: no "Flight details." toggle found — skipping`);
        continue;
      }

      if (toggle.getAttribute('aria-expanded') === 'true') {
        alreadyExpanded += 1;
        continue;
      }

      LOG(`Row ${flight.index}: clicking details toggle`, toggle);
      toggle.click();
      clicked += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    }

    return { total: core.length, clicked, alreadyExpanded, notFound };
  }

  /* ---------------------------------------------------------
   * Export helpers — JSON / CSV
   * ------------------------------------------------------- */

  function csvEscape(v) {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(flights) {
    const cols = [
      'index', 'airline', 'stops', 'price_amount', 'price_currency',
      'departure_location', 'departure_time', 'departure_date',
      'arrival_location', 'arrival_time', 'arrival_date',
      'duration', 'duration_minutes', 'stopover', 'layover_info',
      'cabin_class', 'aircraft_type', 'flight_number', 'operated_by',
      'legroom', 'wifi', 'in_seat_power', 'in_seat_usb', 'stream_media',
      'emissions_estimate', 'emissions_comparison', 'contrail_warming_potential',
    ];
    const rows = [cols.join(',')];
    for (const f of flights) rows.push(cols.map((c) => csvEscape(f[c])).join(','));
    return rows.join('\n');
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', null, { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ---------------------------------------------------------
   * Export helpers — printable HTML report / Word (.doc)
   *
   * This HTML is built as a plain string, not injected into the
   * Google Flights page itself — it's either written into a
   * brand-new blank tab (which carries none of Google's CSP, so
   * document.write with a full HTML string works fine there) or
   * downloaded as a standalone file. Word opens .doc files whose
   * content is actually HTML — a long-standing, reliable trick
   * that avoids needing a real docx-generation library (which we
   * couldn't load from a CDN under Google's CSP anyway).
   * ------------------------------------------------------- */

  function buildReportRowsHtml(flights) {
    const sorted = [...flights].sort((a, b) => (parseInt(a.price_amount, 10) || 0) - (parseInt(b.price_amount, 10) || 0));
    return sorted
      .map((f) => {
        const stopsLabel =
          !f.stops
            ? 'Nonstop'
            : `${f.stops} stop${f.stops > 1 ? 's' : ''}` + (f.stopover ? ` via ${escapeHtml(f.stopover)}` : '');

        const notesParts = [];
        if (f.aircraft_type) notesParts.push(escapeHtml(f.aircraft_type));
        if (f.flight_number) notesParts.push(escapeHtml(f.flight_number));
        if (f.legroom) notesParts.push(`Legroom ${escapeHtml(f.legroom)}`);
        if (f.emissions_estimate) {
          notesParts.push(
            escapeHtml(f.emissions_estimate) + (f.emissions_comparison ? ` (${escapeHtml(f.emissions_comparison)})` : '')
          );
        }
        if (f.contrail_warming_potential) notesParts.push(`Contrail: ${escapeHtml(f.contrail_warming_potential)}`);
        const notes = notesParts.join(' &middot; ');

        const operatedBy = f.operated_by ? `<div class="sub">operated by ${escapeHtml(f.operated_by)}</div>` : '';

        return `
      <tr>
        <td>${escapeHtml(f.airline)}${operatedBy}</td>
        <td class="price">${escapeHtml(f.price_amount)} ${escapeHtml(f.price_currency)}</td>
        <td>${escapeHtml(f.departure_time)} &rarr; ${escapeHtml(f.arrival_time)}<div class="sub">${escapeHtml(f.departure_location)} to ${escapeHtml(f.arrival_location)}</div></td>
        <td>${escapeHtml(f.duration)}</td>
        <td>${stopsLabel}</td>
        <td class="notes">${notes}</td>
      </tr>`;
      })
      .join('');
  }

  function buildReportDocument(flights, { includePrintBar }) {
    const rowsHtml = buildReportRowsHtml(flights);
    const generatedAt = new Date().toLocaleString();
    const routeGuess = flights[0] ? `${escapeHtml(flights[0].departure_location)} &rarr; ${escapeHtml(flights[0].arrival_location)}` : '';
    const printBar = includePrintBar
      ? `<div class="print-bar"><button onclick="window.print()">Print / Save as PDF</button></div>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Flight Search Results</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; margin:0; padding:28px; max-width: 960px; }
  .page { max-width: 960px; margin: 0 auto; }
  h1 { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 22px; margin: 0 0 4px 0; letter-spacing: -0.01em; }
  .route { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 14px; color:#555; margin-bottom: 2px; }
  .meta { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 11px; color:#888; margin-bottom: 20px; }
  hr.accent { border:none; border-top: 3px solid #1a73e8; margin: 10px 0 20px 0; width: 64px; }
  table { width:100%; border-collapse: collapse; font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 12.5px; }
  thead th { text-align:left; border-bottom: 2px solid #1a1a1a; padding: 8px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color:#333; }
  tbody td { padding: 9px 8px; border-bottom: 1px solid #e2e2e2; vertical-align: top; }
  tbody tr:nth-child(even) { background: #fafafa; }
  .price { font-weight: 700; white-space: nowrap; }
  .sub { font-size: 10.5px; color:#888; margin-top: 2px; }
  .notes { color:#444; font-size: 11.5px; }
  footer { margin-top: 18px; font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 10px; color:#999; }
  .print-bar { text-align:right; margin-bottom: 12px; }
  .print-bar button { font-family:-apple-system, 'Segoe UI', Arial, sans-serif; font-size:13px; font-weight:600; padding:8px 16px; border-radius: 20px; border:1px solid #1a73e8; background:#1a73e8; color:#fff; cursor:pointer; }
  @media print {
    .print-bar { display:none; }
    body { padding:0; }
    tbody tr:nth-child(even) { background: #f3f3f3 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <div class="page">
    ${printBar}
    <h1>Flight Search Results</h1>
    <div class="route">${routeGuess}</div>
    <div class="meta">${flights.length} flights &middot; sorted by price &middot; generated ${escapeHtml(generatedAt)}</div>
    <hr class="accent">
    <table>
      <thead><tr><th>Airline</th><th>Price</th><th>Depart &rarr; Arrive</th><th>Duration</th><th>Stops</th><th>Notes</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <footer>Generated by Google Flights Extractor userscript. Prices as shown at time of search — verify before booking.</footer>
  </div>
</body>
</html>`;
  }

  // DOM helper for building content in ANOTHER window/document (the new
  // report tab), mirroring `el()` above but targeting an arbitrary `doc`.
  function elIn(doc, tag, styles, attrs) {
    const node = doc.createElement(tag);
    if (styles) Object.assign(node.style, styles);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v);
      }
    }
    return node;
  }

  function buildReportRowNodes(doc, flights) {
    const sorted = [...flights].sort((a, b) => (parseInt(a.price_amount, 10) || 0) - (parseInt(b.price_amount, 10) || 0));
    return sorted.map((f) => {
      const stopsLabel =
        !f.stops
          ? 'Nonstop'
          : `${f.stops} stop${f.stops > 1 ? 's' : ''}` + (f.stopover ? ` via ${f.stopover}` : '');

      const notesParts = [];
      if (f.aircraft_type) notesParts.push(f.aircraft_type);
      if (f.flight_number) notesParts.push(f.flight_number);
      if (f.legroom) notesParts.push(`Legroom ${f.legroom}`);
      if (f.emissions_estimate) notesParts.push(f.emissions_estimate + (f.emissions_comparison ? ` (${f.emissions_comparison})` : ''));
      if (f.contrail_warming_potential) notesParts.push(`Contrail: ${f.contrail_warming_potential}`);
      const notes = notesParts.join(' · ');

      const cellStyle = { padding: '9px 8px', borderBottom: '1px solid #e2e2e2', verticalAlign: 'top' };
      const subStyle = { fontSize: '10.5px', color: '#888', marginTop: '2px' };

      const tr = elIn(doc, 'tr');

      const airlineCell = elIn(doc, 'td', cellStyle);
      airlineCell.appendChild(doc.createTextNode(f.airline));
      if (f.operated_by) {
        const sub = elIn(doc, 'div', subStyle, { text: `operated by ${f.operated_by}` });
        airlineCell.appendChild(sub);
      }
      tr.appendChild(airlineCell);

      tr.appendChild(elIn(doc, 'td', { ...cellStyle, fontWeight: '700', whiteSpace: 'nowrap' }, {
        text: `${f.price_amount} ${f.price_currency}`,
      }));

      const timeCell = elIn(doc, 'td', cellStyle);
      timeCell.appendChild(doc.createTextNode(`${f.departure_time} \u2192 ${f.arrival_time}`));
      timeCell.appendChild(elIn(doc, 'div', subStyle, { text: `${f.departure_location} to ${f.arrival_location}` }));
      tr.appendChild(timeCell);

      tr.appendChild(elIn(doc, 'td', cellStyle, { text: f.duration }));
      tr.appendChild(elIn(doc, 'td', cellStyle, { text: stopsLabel }));
      tr.appendChild(elIn(doc, 'td', { ...cellStyle, color: '#444', fontSize: '11.5px' }, { text: notes }));

      return tr;
    });
  }

  function buildReportInto(win, flights, { includePrintBar }) {
    const doc = win.document;
    doc.title = 'Flight Search Results';

    const style = doc.createElement('style');
    // Assigning to a <style> element's textContent is a plain text
    // assignment, not an HTML-string sink, so it's unaffected by
    // Trusted Types even on a CSP-inheriting document.
    style.textContent = `
      @page { size: A4; margin: 16mm; }
      * { box-sizing: border-box; }
      body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; margin:0; padding:28px; }
      .page { max-width: 960px; margin: 0 auto; }
      h1 { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 22px; margin: 0 0 4px 0; }
      .route { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 14px; color:#555; margin-bottom: 2px; }
      .meta { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 11px; color:#888; margin-bottom: 20px; }
      hr.accent { border:none; border-top: 3px solid #1a73e8; margin: 10px 0 20px 0; width: 64px; }
      table { width:100%; border-collapse: collapse; font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 12.5px; }
      thead th { text-align:left; border-bottom: 2px solid #1a1a1a; padding: 8px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color:#333; }
      tbody tr:nth-child(even) { background: #fafafa; }
      footer { margin-top: 18px; font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 10px; color:#999; }
      .print-bar { text-align:right; margin-bottom: 12px; }
      .print-bar button { font-family:-apple-system, 'Segoe UI', Arial, sans-serif; font-size:13px; font-weight:600; padding:8px 16px; border-radius: 20px; border:1px solid #1a73e8; background:#1a73e8; color:#fff; cursor:pointer; }
      @media print {
        .print-bar { display:none; }
        body { padding:0; }
        tbody tr:nth-child(even) { background: #f3f3f3 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      }
    `;
    doc.head.appendChild(style);

    const page = elIn(doc, 'div', null, { class: 'page' });

    if (includePrintBar) {
      const bar = elIn(doc, 'div', null, { class: 'print-bar' });
      const printBtn = elIn(doc, 'button', null, { text: 'Print / Save as PDF' });
      printBtn.addEventListener('click', () => win.print());
      bar.appendChild(printBtn);
      page.appendChild(bar);
    }

    page.appendChild(elIn(doc, 'h1', null, { text: 'Flight Search Results' }));

    const routeGuess = flights[0] ? `${flights[0].departure_location} \u2192 ${flights[0].arrival_location}` : '';
    page.appendChild(elIn(doc, 'div', null, { class: 'route', text: routeGuess }));

    const generatedAt = new Date().toLocaleString();
    page.appendChild(elIn(doc, 'div', null, {
      class: 'meta', text: `${flights.length} flights · sorted by price · generated ${generatedAt}`,
    }));

    page.appendChild(elIn(doc, 'hr', null, { class: 'accent' }));

    const table = elIn(doc, 'table');
    const thead = elIn(doc, 'thead');
    const headRow = elIn(doc, 'tr');
    ['Airline', 'Price', 'Depart \u2192 Arrive', 'Duration', 'Stops', 'Notes'].forEach((h) => {
      headRow.appendChild(elIn(doc, 'th', null, { text: h }));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = elIn(doc, 'tbody');
    buildReportRowNodes(doc, flights).forEach((tr) => tbody.appendChild(tr));
    table.appendChild(tbody);
    page.appendChild(table);

    page.appendChild(elIn(doc, 'footer', null, {
      text: 'Generated by Google Flights Extractor userscript. Prices as shown at time of search — verify before booking.',
    }));

    doc.body.appendChild(page);
  }

  function openPrintableReport(flights) {
    if (!flights || !flights.length) {
      alert('No flights to include yet — click "Extract Flights" first.');
      return;
    }
    const w = window.open('', '_blank');
    if (!w) {
      alert('The popup was blocked — please allow popups for this site and try again.');
      return;
    }
    try {
      // IMPORTANT: this new tab is about:blank, which inherits the CSP of
      // the page that opened it (a documented behavior for "initial empty
      // documents") — including Google's Trusted Types requirement. That
      // means document.write()/innerHTML with a plain string would throw
      // here too, exactly like on the Flights page itself, silently
      // leaving the tab blank. So it's built with createElement/
      // appendChild/textContent instead, same as everything else in this
      // script — no HTML-string sink involved at all.
      buildReportInto(w, flights, { includePrintBar: true });
    } catch (e) {
      ERR('Failed to build printable report:', e);
      alert('Could not build the printable report — open the browser console (F12) and look for [GFE] messages, then share that with me.');
    }
  }

  function downloadWordDoc(flights) {
    if (!flights || !flights.length) {
      alert('No flights to include yet — click "Extract Flights" first.');
      return;
    }
    const htmlStr = buildReportDocument(flights, { includePrintBar: false });
    // Leading BOM improves encoding detection when Word opens the file.
    download('google-flights-report.doc', '\ufeff' + htmlStr, 'application/msword');
  }

  /* ---------------------------------------------------------
   * Explore map price heatmap — colors the price pins on
   * google.com/travel/explore (the "map" search) from cheapest
   * (green) to most expensive (red), relative to whatever pins
   * are currently rendered on screen. Re-normalizes on every
   * pan/zoom/date/filter change since the observer re-runs it.
   *
   * Google's explore map draws each price pin as plain overlay
   * DOM (not canvas), but the class names are obfuscated and
   * change often, so instead of hardcoding a selector we find
   * the price *text* leaf directly (its content is stable: a
   * currency symbol plus digits) and then walk up to whichever
   * ancestor is actually painting the pill's background.
   * ------------------------------------------------------- */

  const EXPLORE_PRICE_RE = /^[$€£¥]\s?\d[\d,]*$/;
  const EXPLORE_HEAT_ATTR = 'data-gfe-heat';

  function findExplorePriceLabelNodes() {
    const all = Array.from(document.querySelectorAll('body *'));
    return all.filter((n) => {
      if (n.children.length > 0) return false;
      return EXPLORE_PRICE_RE.test((n.textContent || '').trim());
    });
  }

  function findPillContainer(priceNode) {
    let node = priceNode;
    for (let i = 0; i < 6 && node && node !== document.body; i += 1, node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return node;
    }
    return priceNode.parentElement || priceNode;
  }

  function priceHeatColor(norm) {
    // norm: 0 (cheapest) -> 1 (most expensive). Hue 120 (green) -> 0 (red),
    // i.e. a traffic-light gradient that passes through yellow at the midpoint.
    const hue = 120 - 120 * norm;
    return {
      background: `hsl(${hue}, 80%, 90%)`,
      text: `hsl(${hue}, 85%, 25%)`,
    };
  }

  function colorizeExploreMap() {
    const priceNodes = findExplorePriceLabelNodes();
    if (!priceNodes.length) return;

    const parsed = priceNodes
      .map((node) => ({ node, amount: parseInt((node.textContent || '').replace(/[^\d]/g, ''), 10) }))
      .filter((p) => Number.isFinite(p.amount));
    if (!parsed.length) return;

    const min = Math.min(...parsed.map((p) => p.amount));
    const max = Math.max(...parsed.map((p) => p.amount));
    const range = max - min;

    parsed.forEach(({ node, amount }) => {
      const norm = range > 0 ? (amount - min) / range : 0.5;
      const { background, text } = priceHeatColor(norm);
      const pill = findPillContainer(node);
      pill.style.setProperty('background-color', background, 'important');
      pill.style.setProperty('color', text, 'important');
      node.style.setProperty('color', text, 'important');
      pill.setAttribute(EXPLORE_HEAT_ATTR, '1');
    });

    LOG(`Colorized ${parsed.length} explore map price pin(s), range $${min}-$${max}`);
  }

  let explorePaintScheduled = false;
  function scheduleColorizeExploreMap() {
    if (explorePaintScheduled) return;
    explorePaintScheduled = true;
    requestAnimationFrame(() => {
      explorePaintScheduled = false;
      try {
        colorizeExploreMap();
      } catch (e) {
        ERR('colorizeExploreMap failed:', e);
      }
    });
  }

  /* ---------------------------------------------------------
   * UI — built entirely with createElement/appendChild, no
   * innerHTML anywhere on the Google Flights page itself, so it
   * survives Trusted Types CSP.
   * ------------------------------------------------------- */

  let lastFlights = [];

  function buildTable(flights) {
    const wrap = el('div', { overflow: 'auto', flex: '1' });

    if (!flights.length) {
      wrap.appendChild(el('div', { padding: '8px 16px', color: '#555' }, {
        text: 'No flight results detected. Make sure the results list has finished loading, then click Extract again. (Check the browser console for [GFE] debug logs.)',
      }));
      return wrap;
    }

    const table = el('table', { width: '100%', borderCollapse: 'collapse', fontSize: '12px' });
    const thead = el('thead');
    const headRow = el('tr');
    ['#', 'Airline', 'Stops', 'Price', 'Depart', 'Arrive', 'Duration', 'Aircraft', 'Flight#', 'Legroom', 'Emissions', 'Contrail'].forEach((h) => {
      headRow.appendChild(el('th', {
        borderBottom: '1px solid #eee', padding: '6px 8px', textAlign: 'left', whiteSpace: 'nowrap',
        position: 'sticky', top: '0', background: '#f8f9fa',
      }, { text: h }));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    flights.forEach((f) => {
      const tr = el('tr');
      const cellStyle = { borderBottom: '1px solid #eee', padding: '6px 8px', verticalAlign: 'top', whiteSpace: 'nowrap' };

      tr.appendChild(el('td', cellStyle, { text: String(f.index) }));
      tr.appendChild(el('td', cellStyle, { text: f.airline }));
      tr.appendChild(el('td', cellStyle, { text: f.stops === null ? '?' : String(f.stops) }));
      tr.appendChild(el('td', cellStyle, { text: f.price_amount ? `${f.price_amount} ${f.price_currency}` : '' }));

      const departCell = el('td', cellStyle);
      departCell.appendChild(document.createTextNode(f.departure_location));
      departCell.appendChild(el('br'));
      departCell.appendChild(document.createTextNode(`${f.departure_time} · ${f.departure_date}`));
      tr.appendChild(departCell);

      const arriveCell = el('td', cellStyle);
      arriveCell.appendChild(document.createTextNode(f.arrival_location));
      arriveCell.appendChild(el('br'));
      arriveCell.appendChild(document.createTextNode(`${f.arrival_time} · ${f.arrival_date}`));
      tr.appendChild(arriveCell);

      tr.appendChild(el('td', cellStyle, { text: f.duration }));
      tr.appendChild(el('td', cellStyle, { text: f.aircraft_type }));
      tr.appendChild(el('td', cellStyle, { text: f.flight_number }));
      tr.appendChild(el('td', cellStyle, { text: f.legroom }));
      tr.appendChild(el('td', cellStyle, { text: f.emissions_estimate }));
      tr.appendChild(el('td', cellStyle, { text: f.contrail_warming_potential }));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function openPanel(flights) {
    lastFlights = flights;
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    const panel = el('div', {
      position: 'fixed', top: '0', right: '0', width: '720px', maxWidth: '95vw',
      height: '100vh', background: '#fff', zIndex: '2147483647',
      boxShadow: '-2px 0 12px rgba(0,0,0,.35)', display: 'flex', flexDirection: 'column',
      fontFamily: 'Arial, sans-serif', fontSize: '12px',
    }, { id: PANEL_ID });

    const header = el('div', {
      padding: '12px 16px', background: '#1a73e8', color: '#fff',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: '14px', fontWeight: '600',
    });
    header.appendChild(el('span', null, { text: 'Extracted Flights' }));
    const closeBtn = el('button', {
      background: 'transparent', border: 'none', color: '#fff', fontSize: '18px', cursor: 'pointer',
    }, { text: '\u00D7' });
    closeBtn.addEventListener('click', () => panel.remove());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const toolbar = el('div', {
      padding: '8px 16px', display: 'flex', flexWrap: 'wrap', gap: '8px', borderBottom: '1px solid #eee',
    });
    const mkToolBtn = (label, handler) => {
      const b = el('button', {
        flex: '1 1 30%', minWidth: '120px', padding: '8px', border: '1px solid #1a73e8', background: '#fff',
        color: '#1a73e8', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: '600',
      }, { text: label });
      b.addEventListener('click', handler);
      return b;
    };
    toolbar.appendChild(mkToolBtn('Copy JSON', () => {
      navigator.clipboard.writeText(JSON.stringify(lastFlights, null, 2))
        .then(() => LOG('Copied JSON to clipboard'))
        .catch((e) => ERR('Clipboard copy failed', e));
    }));
    toolbar.appendChild(mkToolBtn('Download JSON', () => download('google-flights.json', JSON.stringify(lastFlights, null, 2), 'application/json')));
    toolbar.appendChild(mkToolBtn('Download CSV', () => download('google-flights.csv', toCSV(lastFlights), 'text/csv')));
    toolbar.appendChild(mkToolBtn('Printable Report (PDF)', () => openPrintableReport(lastFlights)));
    toolbar.appendChild(mkToolBtn('Download Word (.doc)', () => downloadWordDoc(lastFlights)));
    panel.appendChild(toolbar);

    const detailCount = flights.filter((f) => f.emissions_estimate || f.legroom || f.flight_number).length;
    panel.appendChild(el('div', { padding: '8px 16px', color: '#555' }, {
      text: `${flights.length} flight(s) found · ${detailCount} with expanded details captured`,
    }));
    panel.appendChild(buildTable(flights));

    document.body.appendChild(panel);
    LOG('Panel opened with', flights.length, 'flights');
  }

  function buildScanTable(summary) {
    const wrap = el('div', { overflow: 'auto', flex: '1' });
    const table = el('table', { width: '100%', borderCollapse: 'collapse', fontSize: '12px' });
    const thead = el('thead');
    const headRow = el('tr');
    ['#', 'Airline', 'Price', '# Candidates', 'Best guess (aria-expanded / aria-label)'].forEach((h) => {
      headRow.appendChild(el('th', {
        borderBottom: '1px solid #eee', padding: '6px 8px', textAlign: 'left', whiteSpace: 'nowrap',
        position: 'sticky', top: '0', background: '#f8f9fa',
      }, { text: h }));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    summary.forEach(({ flight, candidateCount, best }) => {
      const tr = el('tr');
      const cellStyle = { borderBottom: '1px solid #eee', padding: '6px 8px', verticalAlign: 'top' };
      tr.appendChild(el('td', cellStyle, { text: String(flight.index) }));
      tr.appendChild(el('td', cellStyle, { text: flight.airline }));
      tr.appendChild(el('td', cellStyle, { text: `${flight.price_amount} ${flight.price_currency}` }));
      tr.appendChild(el('td', cellStyle, { text: String(candidateCount) }));
      const bestText = best
        ? `<${best.tag.toLowerCase()}> expanded=${best.ariaExpanded} label="${best.ariaLabel}" text="${best.textSnippet}"`
        : '(none found)';
      tr.appendChild(el('td', cellStyle, { text: bestText }));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function openScanPanel(summary) {
    const existing = document.getElementById(SCAN_PANEL_ID);
    if (existing) existing.remove();

    const panel = el('div', {
      position: 'fixed', top: '0', left: '0', width: '760px', maxWidth: '95vw',
      height: '100vh', background: '#fff', zIndex: '2147483647',
      boxShadow: '2px 0 12px rgba(0,0,0,.35)', display: 'flex', flexDirection: 'column',
      fontFamily: 'Arial, sans-serif', fontSize: '12px',
    }, { id: SCAN_PANEL_ID });

    const header = el('div', {
      padding: '12px 16px', background: '#5f6368', color: '#fff',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: '14px', fontWeight: '600',
    });
    header.appendChild(el('span', null, { text: 'Expand-Toggle Scan (dry run — nothing was clicked)' }));
    const closeBtn = el('button', {
      background: 'transparent', border: 'none', color: '#fff', fontSize: '18px', cursor: 'pointer',
    }, { text: '\u00D7' });
    closeBtn.addEventListener('click', () => panel.remove());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    panel.appendChild(el('div', { padding: '8px 16px', color: '#555' }, {
      text: `Full details (including clickable element references) are also in the browser console — open DevTools (F12) and look for [GFE] groups. Nothing on this page was clicked.`,
    }));
    panel.appendChild(buildScanTable(summary));
    document.body.appendChild(panel);
  }

  function addButtons() {
    if (!document.getElementById(BTN_ID)) {
      const btn = el('button', {
        position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483647',
        background: '#1a73e8', color: '#fff', border: 'none', borderRadius: '24px',
        padding: '12px 18px', fontFamily: 'Arial, sans-serif', fontSize: '14px',
        fontWeight: '600', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.3)',
      }, { id: BTN_ID, text: 'Extract Flights' });

      btn.addEventListener('click', () => {
        try {
          const flights = extractFlights();
          openPanel(flights);
        } catch (e) {
          ERR('Extraction failed:', e);
          alert('Google Flights Extractor hit an error — open the browser console (F12) and look for [GFE] messages, then share that with me.');
        }
      });

      document.body.appendChild(btn);
    }

    if (!document.getElementById(SCAN_BTN_ID)) {
      const scanBtn = el('button', {
        position: 'fixed', bottom: '68px', right: '20px', zIndex: '2147483647',
        background: '#5f6368', color: '#fff', border: 'none', borderRadius: '24px',
        padding: '12px 18px', fontFamily: 'Arial, sans-serif', fontSize: '14px',
        fontWeight: '600', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.3)',
      }, { id: SCAN_BTN_ID, text: 'Scan Toggles (dry run)' });

      scanBtn.addEventListener('click', () => {
        try {
          const summary = runToggleScan();
          openScanPanel(summary);
        } catch (e) {
          ERR('Toggle scan failed:', e);
          alert('Toggle scan hit an error — open the browser console (F12) and look for [GFE] messages, then share that with me.');
        }
      });

      document.body.appendChild(scanBtn);
    }

    if (!document.getElementById(EXPAND_BTN_ID)) {
      const expandBtn = el('button', {
        position: 'fixed', bottom: '116px', right: '20px', zIndex: '2147483647',
        background: '#188038', color: '#fff', border: 'none', borderRadius: '24px',
        padding: '12px 18px', fontFamily: 'Arial, sans-serif', fontSize: '14px',
        fontWeight: '600', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.3)',
      }, { id: EXPAND_BTN_ID, text: 'Expand All' });

      expandBtn.addEventListener('click', async () => {
        const proceed = confirm(
          'This will click the "Flight details" toggle on every visible flight row (already-expanded rows are skipped). ' +
          'It only clicks buttons confirmed to be the details disclosure, never a "Select flight" row. Continue?'
        );
        if (!proceed) return;

        const originalText = expandBtn.textContent;
        expandBtn.textContent = 'Expanding…';
        expandBtn.disabled = true;
        expandBtn.style.opacity = '0.7';
        expandBtn.style.cursor = 'default';

        try {
          const result = await expandAllFlights({ delayMs: 250 });
          LOG('Expand All finished:', result);
          alert(
            `Expand All finished.\n\nClicked: ${result.clicked}\nAlready expanded: ${result.alreadyExpanded}\n` +
            `No toggle found: ${result.notFound}\nTotal rows: ${result.total}\n\n` +
            `Now click "Extract Flights" to capture the newly expanded details.`
          );
        } catch (e) {
          ERR('Expand All failed:', e);
          alert('Expand All hit an error — open the browser console (F12) and look for [GFE] messages, then share that with me.');
        } finally {
          expandBtn.textContent = originalText;
          expandBtn.disabled = false;
          expandBtn.style.opacity = '1';
          expandBtn.style.cursor = 'pointer';
        }
      });

      document.body.appendChild(expandBtn);
    }

    LOG('Buttons injected');
  }

  const observer = new MutationObserver(() => {
    if (isFlightsPage()) {
      try { addButtons(); } catch (e) { ERR('addButtons failed:', e); }
    }
    if (isExplorePage()) {
      scheduleColorizeExploreMap();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (isFlightsPage()) {
    try {
      addButtons();
    } catch (e) {
      ERR('Initial addButtons failed:', e);
    }
  }

  if (isExplorePage()) {
    scheduleColorizeExploreMap();
  }

  LOG('Script loaded');
})();