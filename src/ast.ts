// src/ast.ts
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScriptMod from "tree-sitter-typescript";
import Python from "tree-sitter-python";

export type SymbolContext = {
  language: "ts" | "js" | "py" | "unknown";
  symbolName: string | null;
  symbolType: "function" | "method" | "class" | "unknown";
  snippet: string;
  snippetStartLine: number; // 1-based
  snippetEndLine: number;   // 1-based
};

export type Chunk = {
  symbolType: "function" | "method" | "class" | "unknown";
  symbolName: string | null;
  startLine: number;
  endLine: number;
  snippet: string;
};

export function detectLang(path: string): "ts" | "js" | "py" | "unknown" {
  if (/\.(ts|tsx)$/.test(path)) return "ts";
  if (/\.(m?js|jsx)$/.test(path)) return "js";
  if (/\.py$/.test(path)) return "py";
  return "unknown";
}

// Handle CJS/ESM variants of tree-sitter-typescript
function getTypeScriptLanguage(): any | null {
  const m = TypeScriptMod as any;
  return m?.typescript ?? m?.default?.typescript ?? null;
}

export function extractContextForRange(
  filePath: string,
  sourceCode: string,
  startLine: number,
  endLine: number
): SymbolContext {
  const lang = detectLang(filePath);
  const parser = new Parser();

  if (lang === "ts") {
    const tsLang = getTypeScriptLanguage();
    try {
      parser.setLanguage(tsLang ?? JavaScript);
    } catch {
      // Fail-open to JS grammar if the TS language object is incompatible at runtime
      parser.setLanguage(JavaScript);
    }
  } else if (lang === "js") {
    parser.setLanguage(JavaScript);
  } else if (lang === "py") {
    try {
      parser.setLanguage(Python as any);
    } catch {
      // Fail-open to JS grammar; still provides basic structure for snippet windowing
      parser.setLanguage(JavaScript);
    }
  } else {
    const s = sliceWindow(sourceCode, startLine, endLine, 30);
    return { language: "unknown", symbolName: null, symbolType: "unknown", ...s };
  }

  const tree = parser.parse(sourceCode);
  const startIndex = positionToIndex(sourceCode, startLine, 1);
  const endIndex = positionToIndex(sourceCode, endLine + 1, 1) - 1;

  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForIndex(startIndex, endIndex);
  let symbolName: string | null = null;
  let symbolType: "function" | "method" | "class" | "unknown" = "unknown";

  // Walk up until we find a function/method/class
  while (node) {
    if (isFunction(node)) { symbolType = "function"; symbolName = nameFor(node); break; }
    if (isMethod(node))   { symbolType = "method";   symbolName = nameFor(node); break; }
    if (isClass(node))    { symbolType = "class";    symbolName = nameFor(node); break; }
    node = node.parent;
  }

  const window = sliceWindow(sourceCode, startLine, endLine, 30);
  return { language: lang, symbolName, symbolType, ...window };
}

export function chunkFileByAst(filePath: string, sourceCode: string): Chunk[] {
  const lang = detectLang(filePath);
  const parser = new Parser();

  if (lang === "ts") {
    const tsLang = getTypeScriptLanguage();
    try { parser.setLanguage(tsLang ?? JavaScript); }
    catch { parser.setLanguage(JavaScript); }
  } else if (lang === "js") {
    parser.setLanguage(JavaScript);
  } else if (lang === "py") {
    try { parser.setLanguage(Python as any); }
    catch { parser.setLanguage(JavaScript); }
  } else {
    return []; // unsupported
  }

  const root = parser.parse(sourceCode).rootNode;
  const chunks: Chunk[] = [];

  function visit(n: Parser.SyntaxNode) {
    if (isFunction(n) || isMethod(n) || isClass(n)) {
      const symbolType = isFunction(n) ? "function" : isMethod(n) ? "method" : "class";
      const symbolName = nameFor(n);
      const startLine = n.startPosition.row + 1;
      const endLine = n.endPosition.row + 1;
      const snippet = sourceCode.split("\n").slice(startLine - 1, endLine).join("\n");
      chunks.push({ symbolType, symbolName, startLine, endLine, snippet });
    }
    for (const c of n.children) visit(c);
  }
  visit(root);

  // Fallback: if no symbols detected, index whole file as one chunk
  if (chunks.length === 0) {
    const lines = sourceCode.split("\n");
    chunks.push({
      symbolType: "unknown",
      symbolName: null,
      startLine: 1,
      endLine: lines.length,
      snippet: sourceCode
    });
  }
  return chunks;
}

function isFunction(n: Parser.SyntaxNode) {
  // JS/TS + Python
  return [
    "function_declaration", "function", "arrow_function", "function_expression", // JS/TS
    "function_definition"                                                       // Python
  ].includes(n.type);
}

function isMethod(n: Parser.SyntaxNode) {
  // JS: method_definition
  if (n.type === "method_definition") return true;
  // Python: a function_definition nested under a class_definition
  if (n.type === "function_definition") {
    let p = n.parent;
    while (p) {
      if (p.type === "class_definition") return true;
      p = p.parent;
    }
  }
  return false;
}

function isClass(n: Parser.SyntaxNode) {
  return ["class_declaration", "class", "class_definition"].includes(n.type);
}

function nameFor(n: Parser.SyntaxNode): string | null {
  // Works across grammars: try field 'name', else first identifier-like child
  const id = (n as any).childForFieldName?.("name");
  if (id?.text) return id.text;
  const ident = n.children.find(c => /identifier|name/.test(c.type));
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