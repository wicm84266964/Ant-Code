import zlib from "node:zlib";

export function createOfficeZip(files) {
  const fileEntries = Object.entries(files).map(([name, content]) => ({
    name,
    content: Buffer.from(content, "utf8")
  }));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of fileEntries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = zlib.deflateRawSync(entry.content);
    const crc = crc32(entry.content);
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(fileEntries.length, 8);
  end.writeUInt16LE(fileEntries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

export function createDocxBuffer(text = "报告标题\n正文内容") {
  const paragraphs = String(text).split(/\r?\n/).map((line) => `<w:p><w:r><w:t>${escapeXml(line)}</w:t></w:r></w:p>`).join("");
  return createOfficeZip({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`
  });
}

export function createXlsxBuffer(rows = [["姓名", "分数"], ["张三", "98"]]) {
  const shared = [];
  const sharedIndex = new Map();
  const cells = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      const text = String(value);
      if (!sharedIndex.has(text)) {
        sharedIndex.set(text, shared.length);
        shared.push(text);
      }
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
      cells.push(`<c r="${ref}" t="s"><v>${sharedIndex.get(text)}</v></c>`);
    });
  });
  return createOfficeZip({
    "xl/sharedStrings.xml": `<sst>${shared.map((value) => `<si><t>${escapeXml(value)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${cells.join("")}</sheetData></worksheet>`
  });
}

function columnName(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
