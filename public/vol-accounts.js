/*
 * 봉사자 계정 일괄 발급: 표 읽기와 엑셀(.xlsx) 만들기. 화면(app.js)과 검사(tools/accounts-sheet-test.mjs)가 같이 씀
 *   - 이름·세례명·소속·아이디·로그인 구분 칸만 읽음. 연락처 같은 다른 칸은 읽지 않음
 *   - 엑셀은 브라우저 안에서만 만듦 (외부 라이브러리 없음). 모든 칸은 글자로 넣어 수식으로 실행되지 않음
 */
(function (root) {
  "use strict";
  const tidy = (v) => String(v ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  const head = (v) => tidy(v).replace(/[\s*()]/g, "").toLowerCase();
  const COLS = { name: /^(?:이름|성명|성함|봉사자이름|봉사자명|봉사자성명)$/, baptism: /^세례명$/, affiliation: /^(?:소속|소속본당|소속성당|본당|소속교구본당)$/, login: /^(?:아이디|id|로그인아이디)$/, kind: /^(?:로그인구분|봉사자구분|로그인종류)$/ };
  const PHONE = /\d{2,4}[-.\s)]*\d{3,4}[-.\s]*\d{4}/;

  // '팀 봉사자'·'부서'·'둘 다' → ["team"] … 비우면 팀, 모르는 말이면 []
  function kindsOf(v) {
    const t = tidy(v).replace(/\s/g, "");
    if (!t) return ["team"];
    if (/둘다|모두/.test(t)) return ["dept", "team"];
    return [/부서|물류/.test(t) && "dept", /팀/.test(t) && "team"].filter(Boolean);
  }
  const kindLabel = (k) => (k.length === 2 ? "팀 봉사자 · 부서 봉사자" : k[0] === "dept" ? "부서 봉사자" : "팀 봉사자");

  // 2차원 배열 → [{ name, baptism, affiliation, login, kinds }]
  function parseRows(grid) {
    const rows = (grid || []).map((r) => (r || []).map(tidy)).filter((r) => r.some(Boolean));
    if (!rows.length) throw new Error("표가 비어 있어요.");
    const hi = rows.slice(0, 10).findIndex((r) => r.some((c) => COLS.name.test(head(c))));
    let col = null, start = 0;
    if (hi >= 0) {
      col = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, rows[hi].findIndex((c) => re.test(head(c)))]));
      start = hi + 1;
    } else if (rows.every((r) => r.filter(Boolean).length === 1)) col = { name: -2, baptism: -1, affiliation: -1, login: -1, kind: -1 }; // 이름만 한 줄에 하나
    else throw new Error("머리줄에서 '이름' 칸을 찾지 못했어요. 머리줄(이름, 세례명, 소속, 아이디, 로그인 구분)을 함께 붙여 넣어 주세요.");
    const at = (r, i) => (i === -2 ? r.find(Boolean) : i >= 0 ? r[i] || "" : "");
    const safe = (v) => (PHONE.test(v) ? "" : v.slice(0, 100)); // 전화번호가 섞여 있으면 버림
    return rows.slice(start).map((r) => ({ name: at(r, col.name), baptism: safe(at(r, col.baptism)), affiliation: safe(at(r, col.affiliation)), login: at(r, col.login), kinds: kindsOf(at(r, col.kind)) }))
      .filter((r) => r.name || r.baptism || r.affiliation || r.login);
  }

  /* ----- 엑셀 만들기 (압축하지 않는 zip) ----- */
  const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    for (const [name, text] of files) {
      const n = enc.encode(name), d = enc.encode(text), crc = crc32(d);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 0x21, true);
      h.setUint32(14, crc, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, n.length, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 0x21, true);
      c.setUint32(16, crc, true); c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
      parts.push(new Uint8Array(h.buffer), n, d); central.push(new Uint8Array(c.buffer), n);
      off += 30 + n.length + d.length;
    }
    const size = central.reduce((s, x) => s + x.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
    return [...parts, ...central, new Uint8Array(e.buffer)];
  }
  const esc = (v) => String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // 수식으로 읽힐 수 있는 값은 앞에 ' 를 붙임 (다른 프로그램으로 옮겨도 실행되지 않게)
  const guard = (v) => { const s = String(v ?? ""); return /^[\s]*[=+\-@＝＋－＠\t\r]/.test(s) ? "'" + s : s; };
  const colName = (i) => { let s = ""; for (let n = i + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

  // sheets: [{ name, widths, rows: [[값 | { link }]], head: 머리줄 있음 }] → Uint8Array 조각들
  function makeXlsx(sheets) {
    const files = [
      ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
      ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      // 서식 0 글자 · 1 머리줄 · 2 링크 · 3 줄 바꿈
      ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font><font><u/><sz val="11"/><color rgb="FF1155CC"/><name val="맑은 고딕"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7EDFF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFCCD2E0"/></left><right style="thin"><color rgb="FFCCD2E0"/></right><top style="thin"><color rgb="FFCCD2E0"/></top><bottom style="thin"><color rgb="FFCCD2E0"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="49" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf><xf numFmtId="49" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`]
    ];
    sheets.forEach((s, si) => {
      const links = [];
      const rows = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
        const ref = colName(ci) + (ri + 1), link = v && typeof v === "object" ? v.link : null;
        if (link) links.push({ ref, link });
        return `<c r="${ref}" t="inlineStr" s="${s.head === false ? (link ? 2 : 3) : ri === 0 ? 1 : link ? 2 : 0}"><is><t xml:space="preserve">${esc(guard(link || v))}</t></is></c>`;
      }).join("")}</row>`).join("");
      files.push([`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ""}>${s.head === false ? "" : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'}</sheetView></sheetViews><cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${rows}</sheetData>${links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join("")}</hyperlinks>` : ""}<pageSetup paperSize="9" orientation="landscape" fitToHeight="0"/></worksheet>`]);
      if (links.length) files.push([`xl/worksheets/_rels/sheet${si + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map((l, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(l.link)}" TargetMode="External"/>`).join("")}</Relationships>`]);
    });
    return zip(files);
  }

  // 발급 결과 엑셀. withPassword: 관리자용 / 아니면 공유용(비밀번호 칸 없음)
  function accountSheets(rows, site, withPassword) {
    const header = ["번호", "이름", "세례명", "소속", "아이디", ...(withPassword ? ["임시 비밀번호"] : []), "로그인 구분", "사이트 주소"];
    const body = rows.map((r, i) => [String(i + 1), r.name, r.baptism || "", r.affiliation || "", r.login, ...(withPassword ? [r.password || "(이미 쓰는 비밀번호)"] : []), kindLabel(r.kinds), { link: site }]);
    const guide = [
      ["P-Schedule 봉사자 로그인 안내"],
      ["1. 사이트 주소를 눌러 엽니다."], [{ link: site }],
      ["2. '로그인 구분'에 적힌 것(팀 봉사자 또는 부서 봉사자)을 고릅니다."],
      ["3. 아이디와 따로 받은 임시 비밀번호를 적습니다. 아이디는 한글 그대로 적습니다."],
      ["4. 처음 로그인하면 나만 아는 비밀번호로 바꿉니다."],
      ["비밀번호를 잊었거나 로그인이 안 되면 관리자에게 알려 주세요."],
      ...(withPassword ? [["※ 이 파일에는 비밀번호가 들어 있습니다. 단체방에 올리지 말고 한 명씩 전달해 주세요. 다 쓴 파일은 지워 주세요."]] : [])
    ];
    return [{ name: "계정", widths: [6, 14, 14, 26, 18, ...(withPassword ? [18] : []), 24, 32], rows: [header, ...body] }, { name: "안내", widths: [80], rows: guide, head: false }];
  }

  root.PSAccounts = { parseRows, kindsOf, kindLabel, makeXlsx, accountSheets, guard };
})(globalThis);
