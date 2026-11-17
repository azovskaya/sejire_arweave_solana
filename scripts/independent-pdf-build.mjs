/** Remove jsPDF's unused external-viewer loader from the independent build only. */
const ENTRY = /(?:^|\/)node_modules\/jspdf\/dist\/jspdf\.es(?:\.min)?\.js$/;
const VIEWER = 'pdfobjectnewwindow';

export function disableExternalPdfViewer(code, ts) {
  const source = ts.createSourceFile('jspdf.es.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw Error('independent_pdf_source_invalid');
  const matches = [];
  function visit(node) {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === VIEWER) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  // An upstream change needs review; never silently leave a remote script loader.
  if (matches.length !== 1) throw Error('independent_pdf_viewer_shape_changed');
  const clause = matches[0];
  const replacement = 'case "pdfobjectnewwindow": throw new Error("External PDF viewers are disabled in this build; download the PDF instead.");';
  return code.slice(0, clause.getStart(source)) + replacement + code.slice(clause.end);
}

export function independentPdfPlugin(ts) {
  let transformed = 0;
  return {
    name: 'sejire-independent-pdf',
    enforce: 'pre',
    transform(code, id) {
      if (!ENTRY.test(id.replaceAll('\\', '/').split('?')[0])) return null;
      if (++transformed !== 1) throw Error('independent_pdf_entry_ambiguous');
      return { code: disableExternalPdfViewer(code, ts), map: null };
    },
    buildEnd(error) {
      if (!error && transformed !== 1) throw Error('independent_pdf_entry_missing');
    },
  };
}
