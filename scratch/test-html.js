import Parser from 'tree-sitter';
import HTML from 'tree-sitter-html';

const htmlCode = `
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="style.css">
  <link rel="stylesheet" href='theme.css'>
  <link rel=stylesheet href=unquoted.css>
</head>
<body>
  <div id="main-container" class="container">
    <h1 id='title'>Hello World</h1>
    <p id=para>Text here</p>
  </div>
  <script src="index.js"></script>
  <script src='app.js'></script>
  <script src=unquoted.js></script>
</body>
</html>
`;

const parser = new Parser();
parser.setLanguage(HTML);
const tree = parser.parse(htmlCode);

const queries = `
(attribute
  (attribute_name) @attr_name
  (quoted_attribute_value
    (attribute_value) @name)
  (#eq? @attr_name "id")) @definition.variable

(attribute
  (attribute_name) @attr_name
  (attribute_value) @name
  (#eq? @attr_name "id")) @definition.variable

(script_element
  (start_tag
    (attribute
      (attribute_name) @attr_name
      (quoted_attribute_value
        (attribute_value) @name))
    (#eq? @attr_name "src"))) @import

(script_element
  (start_tag
    (attribute
      (attribute_name) @attr_name
      (attribute_value) @name)
    (#eq? @attr_name "src"))) @import

(element
  (start_tag
    (tag_name) @tag_name
    (attribute
      (attribute_name) @attr_name
      (quoted_attribute_value
        (attribute_value) @name)))
  (#eq? @tag_name "link")
  (#eq? @attr_name "href")) @import

(element
  (start_tag
    (tag_name) @tag_name
    (attribute
      (attribute_name) @attr_name
      (attribute_value) @name))
  (#eq? @tag_name "link")
  (#eq? @attr_name "href")) @import
`;

const query = new Parser.Query(HTML, queries);
const matches = query.matches(tree.rootNode);
console.log("Found " + matches.length + " matches:");
for (const match of matches) {
  const tagCapture = match.captures.find(c => c.name !== 'name');
  const nameCapture = match.captures.find(c => c.name === 'name');
  console.log("- tag: " + tagCapture?.name + ", name: " + nameCapture?.node.text);
}
