const fs = require('fs');
const path = require('path');
const {
    Document, Packer, Paragraph, TextRun, AlignmentType,
    Table, TableRow, TableCell, WidthType, BorderStyle,
} = require('docx');

// ---- palette / fonts (to match the HRIS proposal) ----
const BLUE = '2E74B5';   // section headings + title
const LBLUE = '5B9BD5';  // subsection headings
const BODY = 'Cambria';  // serif body
const HEAD = 'Calibri';  // sans headings
const NONE = { style: BorderStyle.NONE };

// ---- helpers ----
const P = (text, o = {}) => new Paragraph({
    spacing: { after: o.after ?? 120 },
    alignment: o.align,
    children: [new TextRun({ text, bold: o.bold, italics: o.italics, font: BODY, size: o.size ?? 22, color: o.color })],
});

const labelVal = (label, val) => new Paragraph({
    spacing: { after: 120 },
    children: [
        new TextRun({ text: label + ' ', font: BODY, size: 22 }),
        new TextRun({ text: val, font: BODY, size: 22, underline: {} }),
    ],
});

const H1 = (text) => new Paragraph({
    spacing: { before: 280, after: 100 },
    children: [new TextRun({ text, bold: true, font: HEAD, size: 26, color: BLUE })],
});

const H2 = (text) => new Paragraph({
    spacing: { before: 180, after: 60 },
    children: [new TextRun({ text, bold: true, font: HEAD, size: 20, color: LBLUE })],
});

const B = (text) => new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 40 },
    children: [new TextRun({ text, font: BODY, size: 22 })],
});

const tcell = (text, o = {}) => new TableCell({
    width: { size: o.width ?? 50, type: WidthType.PERCENTAGE },
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE },
    margins: { top: 40, bottom: 40, left: 0, right: 80 },
    children: [new Paragraph({
        alignment: o.align,
        children: [new TextRun({ text, bold: o.bold, italics: o.italics, font: BODY, size: 22, color: o.color })],
    })],
});

const children = [];

// ---- title ----
children.push(new Paragraph({
    spacing: { after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: BLUE, space: 4 } },
    children: [new TextRun({ text: 'PROPOSAL & QUOTATION', font: HEAD, size: 56, color: BLUE })],
}));
children.push(P('Prescription & Pharmacy Demand Tracking System (RX-System)', { align: AlignmentType.CENTER, after: 220 }));

children.push(labelVal('Prepared By:', 'Ken Lloyd Billones'));
children.push(labelVal('Prepared For:', 'Tagum Medical City'));
children.push(labelVal('Date:', 'June 15, 2026'));

// ---- 1. Overview ----
children.push(H1('1. Project Overview'));
children.push(P('A web-based system that lets nurses generate and print prescriptions at their stations — even for out-of-stock or not-yet-listed medicines — while automatically tracking that demand. The pharmacist head then reviews, confirms, and stocks the most-requested items using a supply-versus-demand dashboard, turning unmet demand into a clear purchasing plan.'));

// ---- 2. Objectives ----
children.push(H1('2. Objectives'));
children.push(B('Let nurses print standard prescriptions quickly, including out-of-stock and new medicines'));
children.push(B('Capture demand for medicines not yet in the database so nothing is lost'));
children.push(B('Give the pharmacist head one view of the most in-demand and low-stock items'));
children.push(B('Provide a supply-vs-demand priority score to guide what to stock next'));
children.push(B('Keep edits controlled and accountable through role-based access and an audit trail'));

// ---- 3. System Features / Modules ----
children.push(H1('3. System Features / Modules'));

children.push(H2('3.1 User Roles & Access'));
children.push(B('Superadmin'));
children.push(B('Subadmin'));
children.push(B('Staff (pharmacy)'));
children.push(B('Nurse stations (no login required)'));

children.push(H2('3.2 Nurse Rx Generator'));
children.push(B('Search medicines and build a prescription per station/department'));
children.push(B('Set quantities for each medicine'));
children.push(B('Remembers or locks the station per device'));

children.push(H2('3.3 New & Out-of-Stock Medicine Handling'));
children.push(B('Add medicines even when out of stock'));
children.push(B('Adding a medicine not in the database shows a warning and queues it for pharmacy review'));
children.push(B('All demand is recorded, including unfilled requests'));

children.push(H2('3.4 Prescription Printing'));
children.push(B('Prints a standard quarter-sheet (¼ paper) prescription slip'));
children.push(B('Clinic header, station, patient, medicines, and prescriber line'));

children.push(H2('3.5 Pharmacy Review & Confirmation'));
children.push(B('Review new not-in-database medicines submitted by nurses'));
children.push(B('Confirm or edit details before adding them to the system'));
children.push(B('Set starting stock on confirmation'));

children.push(H2('3.6 Pharmacy Dashboard & Analytics'));
children.push(B('Most in-demand medicines not yet in the database'));
children.push(B('Low-stock alerts'));
children.push(B('Overall view plus per-station / per-department localized views'));

children.push(H2('3.7 Supply vs Demand Scoring'));
children.push(B('Priority score combining demand and unmet demand'));
children.push(B('Fulfillment rate per medicine to prioritize purchasing'));

children.push(H2('3.8 Security & Audit Trail'));
children.push(B('Staff may view freely; edits require superadmin or subadmin authorization'));
children.push(B('24-hour login session for pharmacy users'));
children.push(B('All confirmations and edits recorded in an audit log'));
children.push(B('Handling aligned with the Data Privacy Act (RA 10173)'));

// ---- 4. Deployment Setup ----
children.push(H1('4. Deployment Setup'));
children.push(P('Hosted on the hospital’s local server or cloud, accessible via the internal network. Includes a production database and automated backups. Hosting and domain costs are shouldered by the hospital.'));

// ---- 5. Project Timeline ----
children.push(H1('5. Project Timeline'));
children.push(B('Planning & requirements: 1–2 weeks'));
children.push(B('Development: 4–5 weeks'));
children.push(B('Testing: 1–2 weeks'));
children.push(B('Deployment & training: 1–2 weeks'));

// ---- 6. Project Cost ----
children.push(H1('6. Project Cost'));
children.push(P('Total: PHP 150,000', { bold: true }));
children.push(P('Introductory founding-client rate, discounted from the standard development value of PHP 400,000, offered in exchange for a project testimonial and referrals.', { italics: true, size: 20, color: '555555' }));

children.push(H2('6.1 Payment Terms'));
children.push(B('50% Initial Payment Upon Contract Signing — PHP 75,000'));
children.push(B('25% Mid Development — PHP 37,500'));
children.push(B('25% Upon Completion — PHP 37,500'));

// ---- 7. Formal Quotation ----
children.push(H1('7. Formal Quotation'));
children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
    rows: [
        new TableRow({ children: [tcell('Description', { width: 70, bold: true }), tcell('Amount', { width: 30, bold: true })] }),
        new TableRow({ children: [tcell('RX-System Development & Deployment', { width: 70 }), tcell('PHP 150,000', { width: 30 })] }),
    ],
}));
children.push(P('Total Project Cost: PHP 150,000', { bold: true, after: 40 }));

// ---- 8. Maintenance & Support ----
children.push(H1('8. Maintenance & Support'));
children.push(P('Free support for 75 days after deployment. Optional annual maintenance available at PHP 30,000 / year.'));

// ---- 9. Validity ----
children.push(H1('9. Validity'));
children.push(P('Valid for 30 days from issuance.'));

// ---- 10. Acknowledgement ----
children.push(H1('10. Acknowledgement'));
children.push(P('This document serves as a proposal and quotation for review and approval.'));
children.push(P('A formal contract agreement will be provided upon acceptance of this proposal.', { after: 360 }));

// ---- signature block ----
children.push(new Paragraph({ spacing: { after: 360 }, children: [new TextRun({ text: 'Prepared By:', font: HEAD, size: 24, color: LBLUE })] }));
children.push(P('______________________________', { after: 40 }));
children.push(P('KEN LLOYD L. BILLONES', { bold: true, after: 20 }));
children.push(P('System Developer', { italics: true, after: 20 }));
children.push(P('Contact No.: 09384319457', { italics: true, after: 20 }));
children.push(P('Email: Billones.KenLloyd@gmail.com', { italics: true }));

// ---- write ----
const doc = new Document({
    creator: 'Ken Lloyd Billones',
    title: 'RX-System Proposal & Quotation',
    sections: [{
        properties: { page: { margin: { top: 1200, bottom: 1200, left: 1200, right: 1200 } } },
        children,
    }],
});

const out = path.join(__dirname, '..', 'RX-System_Proposal_and_Quotation.docx');
Packer.toBuffer(doc).then((buf) => {
    fs.writeFileSync(out, buf);
    console.log('Wrote', out, '(' + buf.length + ' bytes)');
});
