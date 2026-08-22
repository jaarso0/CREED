import Parser from 'tree-sitter';
import HTML from 'tree-sitter-html';

const htmlCode = `
<!DOCTYPE html>
<html>
<body>
  <script src="index.js"></script>
</body>
</html>
`;

const parser = new Parser();
parser.setLanguage(HTML);
const tree = parser.parse(htmlCode);

function dump(node, depth = 0) {
  const indent = ' '.repeat(depth * 2);
  console.log(indent + node.type + " [" + node.text.replace(/\n/g, '\\n') + "]");
  for (let i = 0; i < node.childCount; i++) {
    dump(node.child(i), depth + 1);
  }
}

dump(tree.rootNode);
