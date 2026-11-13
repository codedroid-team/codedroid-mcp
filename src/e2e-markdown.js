// A small Markdown-to-HTML formatter for the e2e pages. It handles ATX headings, paragraphs, lists (one level
// of nesting), tables, fenced code, inline code and bold. Links are shown as "text (url)" and never become
// anchors. Anything else is escaped text. Raw HTML in the source is never passed through.
import { splitCells } from "./e2e-model.js";

/** Escape a value for HTML text or a double- or single-quoted attribute. */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Inline code, bold, and links as plain text. */
export function inline(raw) {
  return String(raw).split(/(`[^`]+`)/).map((seg, i) => {
    if (i % 2) return `<code>${esc(seg.slice(1, -1))}</code>`;
    const text = seg.replace(/!?\[([^\]]*)\]\(([^)\s]*)\)/g, "$1 ($2)");
    return esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }).join("");
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isRow = (l) => l !== undefined && l.trim().startsWith("|");

function list(items) {
  const tag = /^\d/.test(items[0].mark) ? "ol" : "ul";
  return `<${tag}>${items.map((it) => `<li>${inline(it.text)}${it.kids.length ? list(it.kids) : ""}</li>`).join("")}</${tag}>`;
}

/** `base` shifts heading levels so a source `#` can sit under the page's own h1. */
export function md(text, { base = 0 } = {}) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if (FENCE.test(line)) {
      const code = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      i++; // the closing fence; an unclosed one runs to the end
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if ((m = line.match(HEADING))) {
      const n = Math.min(6, m[1].length + base);
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      i++;
    } else if (isRow(line) && RULE.test(lines[i + 1] ?? "x")) {
      const head = splitCells(line);
      const rows = [];
      for (i += 2; isRow(lines[i]); i++) rows.push(splitCells(lines[i]));
      const cell = (tag, c) => `<${tag}>${inline(c ?? "")}</${tag}>`;
      out.push(`<div class="scroll"><table><thead><tr>${head.map((c) => cell("th", c)).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${head.map((_, k) => cell("td", r[k])).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (ITEM.test(line)) {
      const top = line.match(ITEM)[1].length;
      const items = [];
      while (i < lines.length) {
        const it = lines[i].match(ITEM);
        if (it) {
          if (items.length && it[1].length <= top && /^\d/.test(it[2]) !== /^\d/.test(items[0].mark)) break; // another kind of list
          const item = { mark: it[2], text: it[3], kids: [] };
          if (it[1].length > top && items.length) items.at(-1).kids.push(item); else items.push(item);
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          const last = items.at(-1);
          const tgt = last.kids.at(-1) ?? last;
          tgt.text += ` ${lines[i].trim()}`;
        } else if (!(!lines[i].trim() && ITEM.test(lines[i + 1] ?? ""))) break;
        i++;
      }
      out.push(list(items));
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !ITEM.test(lines[i])
        && !(isRow(lines[i]) && RULE.test(lines[i + 1] ?? "x"))) para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}
