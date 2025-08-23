import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import * as TypeScript from "tree-sitter-typescript";

type TSLanguage = unknown;
const TSLang = (TypeScript as any).typescript as TSLanguage;

export type SymbolContext = {
  language: "ts" | "js" | "unknown";
  symbolName: string | null;
  symbolType: "function" | "method" | "class" | "unknown";
  snippet: string;
  snippetStartLine: number; // 1-based
  snippetEndLine: number;   // 1-based
};

export function detectLang(path: string): "ts" | "js" | "unknown" {
  if (/\.(ts|tsx)$/.test(path)) return "ts";
  if (/\.(m?js|jsx)$/.test(path)) return "js";
  return "unknown";
}

export function extractContextForRange(
  filePath: string,
  sourceCode: string,
  startLine: number,
  endLine: number
): SymbolContext {
  const lang = detectLang(filePath);
  const parser = new Parser();
  if (lang === "ts") parser.setLanguage(TSLang);
  else if (lang === "js") parser.setLanguage(JavaScript);
  else {
    const s = sliceWindow(sourceCode, startLine, endLine, 30);
    return { language: "unknown", symbolName: null, symbolType: "unknown", ...s };
  }

  const tree = parser.parse(sourceCode);
  const startIndex = positionToIndex(sourceCode, startLine, 1);
  const endIndex = positionToIndex(sourceCode, endLine + 1, 1) - 1;

  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForIndex(startIndex, endIndex);
  let symbolName: string | null = null;
  let symbolType: "function" | "method" | "class" | "unknown" = "unknown";

  while (node) {
    if (isFunction(node)) { symbolType = "function"; symbolName = nameFor(node); break; }
    if (isMethod(node))   { symbolType = "method";   symbolName = nameFor(node); break; }
    if (isClass(node))    { symbolType = "class";    symbolName = nameFor(node); break; }
    node = node.parent;
  }

  const window = sliceWindow(sourceCode, startLine, endLine, 30);
  return { language: lang, symbolName, symbolType, ...window };
}

/* helpers */
function isFunction(n: Parser.SyntaxNode) {
  return ["function_declaration", "function", "arrow_function", "function_expression"].includes(n.type);
}
function isMethod(n: Parser.SyntaxNode) {
  return ["method_definition"].includes(n.type);
}
function isClass(n: Parser.SyntaxNode) {
  return ["class_declaration", "class"].includes(n.type);
}

function nameFor(n: Parser.SyntaxNode): string | null {
  const id = (n as any).childForFieldName?.("name");
  if (id?.text) return id.text;
  const ident = n.children.find(c => /identifier/.test(c.type));
  return ident?.text ?? null;
}

function positionToIndex(text: string, line: number, column: number) {
  const lines = text.split("\n");
  const targetLine = Math.max(1, Math.min(line, lines.length));
  let idx = 0;
  for (let i = 0; i < targetLine - 1; i++) idx += lines[i].length + 1; // +1 for \n
  idx += Math.max(0, column - 1);
  return idx;
}

function sliceWindow(source: string, startLine: number, endLine: number, pad: number) {
  const lines = source.split("\n");
  const L = lines.length;
  const from = Math.max(1, startLine - pad);
  const to = Math.min(L, endLine + pad);
  const snippet = lines.slice(from - 1, to).join("\n");
  return { snippet, snippetStartLine: from, snippetEndLine: to };
}