import {Decoration, DecorationSet, themeClass, WidgetType, EditorView, keymap} from "@codemirror/next/view"
import {StateField, StateEffect, ChangeDesc, EditorState, EditorSelection,
        Transaction, TransactionSpec, Text, StateCommand, precedence} from "@codemirror/next/state"
import {baseTheme} from "./theme"
import {AutocompleteContext} from "./index"

class Field {
  constructor(readonly seq: number | null,
              readonly name: string | null,
              readonly positions: {line: number, from: number, to: number}[]) {}
}

class FieldRange {
  constructor(readonly field: number, readonly from: number, readonly to: number) {}

  map(changes: ChangeDesc) {
    return new FieldRange(this.field, changes.mapPos(this.from, -1), changes.mapPos(this.to, 1))
  }
}

class Snippet {
  constructor(readonly lines: readonly string[],
              readonly fields: readonly Field[]) {}

  instantiate(state: EditorState, pos: number) {
    let text = [], lineStart = [pos]
    let lineObj = state.doc.lineAt(pos), baseIndent = /^\s*/.exec(lineObj.slice(0, Math.min(100, lineObj.length)))![0]
    for (let line of this.lines) {
      if (text.length) {
        let indent = baseIndent, tabs = /^\t*/.exec(line)![0].length
        for (let i = 0; i < tabs; i++) indent += state.facet(EditorState.indentUnit)
        lineStart.push(pos + indent.length - tabs)
        line = indent + line.slice(tabs)
      }
      text.push(line)
      pos += line.length + 1
    }
    let ranges = []
    for (let i = 0; i < this.fields.length; i++) {
      for (let pos of this.fields[i].positions)
        ranges.push(new FieldRange(i, lineStart[pos.line] + pos.from, lineStart[pos.line] + pos.to))
    }
    return {text, ranges}
  }

  static parse(template: string) {
    let fields: Field[] = [], lines = [], m
    for (let line of template.split(/\r\n?|\n/)) {
      while (m = /[#$]\{(?:(\d+)(?::([^}]*))?|([^}]*))\}/.exec(line)) {
        let seq = m[1] ? +m[1] : null, name = m[2] || m[3], found = null
        for (let f of fields) if (name ? f.name == name : seq != null && f.seq == seq) found = f
        if (!found) {
          found = new Field(seq, name || null, [])
          let i = 0
          while (i < fields.length && (seq == null || (fields[i].seq != null && fields[i].seq! < seq))) i++
          fields.splice(i, 0, found)
        }
        found.positions.push({line: lines.length, from: m.index, to: m.index + name.length})
        line = line.slice(0, m.index) + name + line.slice(m.index + m[0].length)
      }
      lines.push(line)
    }
    return new Snippet(lines, fields)
  }
}

class FieldMarker extends WidgetType<null> {
  toDOM() {
    let span = document.createElement("span")
    span.className = themeClass("snippetFieldPosition")
    return span
  }
}

let fieldMarker = Decoration.widget({widget: new FieldMarker(null)})
let fieldRange = Decoration.mark({class: themeClass("snippetField")})

class ActiveSnippet {
  deco: DecorationSet

  constructor(readonly ranges: readonly FieldRange[],
              readonly active: number) {
    this.deco = Decoration.set(ranges.map(r => (r.from == r.to ? fieldMarker : fieldRange).range(r.from, r.to)))
  }

  map(changes: ChangeDesc) {
    return new ActiveSnippet(this.ranges.map(r => r.map(changes)), this.active)
  }

  selectionInsideField(sel: EditorSelection) {
    return sel.ranges.every(
      range => this.ranges.some(r => r.field == this.active && r.from <= range.from && r.to >= range.to))
  }
}

const setActive = StateEffect.define<ActiveSnippet | null>({
  map(value, changes) { return value && value.map(changes) }
})

const moveToField = StateEffect.define<number>()

const snippetState = StateField.define<ActiveSnippet | null>({
  create() { return null },

  update(value, tr) {
    for (let effect of tr.effects) {
      if (effect.is(setActive)) return effect.value
      if (effect.is(moveToField) && value) return new ActiveSnippet(value.ranges, effect.value)
    }
    if (value && tr.docChanged) value = value.map(tr.changes)
    if (value && tr.selection && !value.selectionInsideField(tr.selection)) value = null
    return value
  },

  provide: [EditorView.decorations.from(val => val ? val.deco : Decoration.none)]
})

const tag = typeof Symbol == "undefined" ? "__snippet" : Symbol("snippet")

function fieldSelection(ranges: readonly FieldRange[], field: number) {
  return EditorSelection.create(ranges.filter(r => r.field == field).map(r => EditorSelection.range(r.from, r.to)))
}

/// Convert a snippet template to a function that can apply it.
/// Snippets are written using syntax like this:
///
///     "for (let ${index} = 0; ${index} < ${end}; ${index}++) {\n\t${}\n}"
///
/// Each `${}` placeholder (you may also use `#{}`) indicates a field
/// that the user can fill in. Its name, if any, will be the default
/// content for the field.
///
/// When the snippet is activated by calling the returned function,
/// the code is inserted at the given position. Newlines in the
/// template are indented by the indentation of the start line, plus
/// one [indent unit](#state.EditorState^indentUnit) per tab character
/// after the newline.
///
/// On activation, (all instances of) the first field are selected.
/// The user can move between fields with Tab and Shift-Tab as long as
/// the fields are active. Moving to the last field or moving the
/// cursor out of the current field deactivates the fields.
///
/// The order of fields defaults to textual order, but you can add
/// numbers to placeholders (`${1}` or `${1:defaultText}`) to provide
/// a custom order.
export function snippet(template: string) {
  let snippet = Snippet.parse(template)
  return (editor: {state: EditorState, dispatch: (tr: Transaction) => void}, range: {from: number, to?: number}) => {
    let {text, ranges} = snippet.instantiate(editor.state, range.from)
    let spec: TransactionSpec = {changes: {from: range.from, to: range.to, insert: Text.of(text)}}
    if (ranges.length) spec.selection = fieldSelection(ranges, 0)
    if (ranges.length > 1) {
      spec.effects = setActive.of(new ActiveSnippet(ranges, 0))
      if (editor.state.field(snippetState, false) === undefined)
        spec.replaceExtensions = {[tag]: [snippetState, snippetKeymap, baseTheme]}
    }
    editor.dispatch(editor.state.update(spec))
  }
}

function moveField(dir: 1 | -1): StateCommand {
  return ({state, dispatch}) => {
    let active = state.field(snippetState, false)
    if (!active || dir < 0 && active.active == 0) return false
    let next = active.active + dir, last = dir > 0 && !active.ranges.some(r => r.field == next + dir)
    dispatch(state.update({
      selection: fieldSelection(active.ranges, next),
      effects: setActive.of(last ? null : new ActiveSnippet(active.ranges, next))
    }))
    return true
  }
}

const snippetKeymap = precedence(keymap([
  {key: "Tab", run: moveField(1), shift: moveField(-1)}
]), "override")

/// Languages can export arrays of snippets using this format.
/// [`completeSnippets`](#autocomplete.completeSnippets) can be used
/// to turn them into a completion source.
export type SnippetSpec = {
  /// The word to match when completing.
  keyword: string,
  /// The user-readable label for the completion. Defaults to
  /// `keyword` when not given.
  name?: string,
  /// The [snippet template](#autocomplete.snippet) to use.
  snippet: string
}

/// Create a completion source from an array of snippet specs.
export function completeSnippets(snippets: readonly SnippetSpec[]) {
  let parsed = snippets.map(s => snippet(s.snippet))
  return (context: AutocompleteContext) => {
    let token = context.state.tree.resolve(context.pos, -1), tokenText = ""
    let isAlpha = !token.firstChild && /[\w\u00a1-\uffff]/.test(tokenText = context.state.sliceDoc(token.start, token.end))
    if (!isAlpha && !context.explicit) return []
    let from = isAlpha ? token.start : context.pos, text = isAlpha ? tokenText.slice(0, context.pos - token.start) : ""
    let found = []
    for (let i = 0; i < snippets.length; i++) {
      let candidate = snippets[i]
      if (!text || context.filter(candidate.keyword, text)) found.push({
        label: candidate.name || candidate.keyword,
        from, to: context.pos,
        apply: parsed[i]
      })
    }
    return found
  }
}
