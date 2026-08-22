import Parser from 'tree-sitter';
import HTML from 'tree-sitter-html';
import { normalizeCaptures } from '../src/stage2-extract/capture-normalizer.js';
import { runTreeSitterQuery } from '../src/stage2-extract/query-runner.js';
import { HTML_QUERIES } from '../src/stage2-extract/queries/html-queries.js';
import { ContextTracker } from '../src/stage2-extract/context-tracker.js';

const htmlCode = `
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app-root">
    <h1 id="header-title">Welcome</h1>
  </div>
  <script src="app.js"></script>
</body>
</html>
`;

const parser = new Parser();
parser.setLanguage(HTML);
const tree = parser.parse(htmlCode);

const captures = runTreeSitterQuery(tree, 'html', HTML_QUERIES);

// Replicate the sorting and normalization loop from capture-normalizer.ts
const sorted = [...captures].sort((a, b) => {
  const startA = a.node.startPosition;
  const startB = b.node.startPosition;
  if (startA.row !== startB.row) {
    return startA.row - startB.row;
  }
  if (startA.column !== startB.column) {
    return startA.column - startB.column;
  }
  const endA = a.node.endPosition;
  const endB = b.node.endPosition;
  if (endA.row !== endB.row) {
    return endB.row - endA.row;
  }
  return endB.column - endA.column;
});

const tracker = new ContextTracker('index.html');
const rootRange = {
  start: { line: tree.rootNode.startPosition.row, column: tree.rootNode.startPosition.column },
  end: { line: tree.rootNode.endPosition.row, column: tree.rootNode.endPosition.column }
};
const fileSymbol = {
  id: 'index.html',
  kind: 'file',
  name: 'index.html',
  qualifiedName: 'index.html',
  filePath: 'index.html',
  range: rootRange,
  exported: true,
  visibility: 'public',
  metadata: {}
};

tracker.enterSymbol(fileSymbol);

function getRange(node) {
  return {
    start: { line: node.startPosition.row, column: node.startPosition.column },
    end: { line: node.endPosition.row, column: node.endPosition.column }
  };
}

function isRangeContained(inner, outer) {
  if (inner.start.line < outer.start.line) return false;
  if (inner.start.line === outer.start.line && inner.start.column < outer.start.column) return false;
  if (inner.end.line > outer.end.line) return false;
  if (inner.end.line === outer.end.line && inner.end.column > outer.end.column) return false;
  return true;
}

function syncContext(node) {
  const nodeRange = getRange(node);
  while (tracker.currentParentSymbol) {
    const parentSym = tracker.currentParentSymbol;
    if (parentSym.kind === 'file' || parentSym.kind === 'project') {
      break;
    }
    if (isRangeContained(nodeRange, parentSym.range)) {
      break;
    }
    console.log("Popping parent symbol:", parentSym.id);
    tracker.exitSymbol();
  }
}

for (const cap of sorted) {
  syncContext(cap.node);
  console.log("Capture:", cap.tag, cap.name);
  console.log("Current parent symbol kind:", tracker.currentParentSymbol?.kind);
  console.log("Current parent symbol ID:", tracker.currentParentSymbol?.id);
  
  if (cap.tag.startsWith('definition.')) {
    const kind = cap.tag.substring('definition.'.length);
    if (kind === 'variable') {
      const parentKind = tracker.currentParentSymbol?.kind;
      const isTopOrClassLevel =
        parentKind === 'file' || parentKind === 'class' || parentKind === 'interface';
      console.log("isTopOrClassLevel:", isTopOrClassLevel, "parentKind:", parentKind);
    }
  }
}
