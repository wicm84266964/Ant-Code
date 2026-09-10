// Synthetic PDF with vector graphics, text, and two distinct embedded images per page.
export function visualPdf(pageCount = 5, text = true) {
  const objects: string[] = ["", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const pages: number[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const pageId = objects.length + 1;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    pages.push(pageId);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> /XObject << /Red ${imageId} 0 R /Blue ${imageId + 1} 0 R >> >> /Contents ${contentId} 0 R >>`);
    const content = `0 0.7 0 rg 20 200 260 100 re f\nq 80 0 0 80 20 60 cm /Red Do Q\nq 80 0 0 80 180 60 cm /Blue Do Q\n${text ? `0 0 0 rg BT /F1 24 Tf 20 350 Td (Page ${page} - PDF vision) Tj ET` : ""}`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    for (const pixel of ["FF0000>", "0000FF>"]) {
      objects.push(`<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${pixel.length} >>\nstream\n${pixel}\nendstream`);
    }
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
