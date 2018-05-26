import {Change} from "../../state/src/state"
//import {ChangedRange} from "../../doc/src/diff"

export interface DecorationRangeSpec {
  inclusiveStart?: boolean;
  inclusiveEnd?: boolean;
  attributes?: {[key: string]: string};
  lineAttributes?: {[key: string]: string};
  tagName?: string;
  collapsed?: boolean;
}

export interface DecorationPointSpec {
  side?: number;
  lineAttributes?: {[key: string]: string};
}

type DecorationSpec = DecorationRangeSpec | DecorationPointSpec

abstract class DecorationDesc {
  constructor(readonly spec: DecorationSpec, readonly bias: number) {}
  abstract map(deco: Decoration, changes: A<Change>): Decoration | null;
}

const BIG_BIAS = 2e9

type A<T> = ReadonlyArray<T>

class RangeDesc extends DecorationDesc {
  endBias: number;
  affectsSpans: boolean;

  constructor(spec: DecorationRangeSpec) {
    super(spec, spec.inclusiveStart === true ? -BIG_BIAS : BIG_BIAS)
    this.endBias = spec.inclusiveEnd == true ? BIG_BIAS : -BIG_BIAS
    this.affectsSpans = !!(spec.attributes || spec.tagName || spec.collapsed)
  }

  map(deco: Decoration, changes: A<Change>): Decoration | null {
    let from = mapPos(deco.from, changes, this.bias), to = mapPos(deco.to, changes, this.endBias)
    return from < to ? new Decoration(from, to, this) : null
  }
}

class PointDesc extends DecorationDesc {
  constructor(spec: DecorationPointSpec) {
    super(spec, spec.side || 0)
  }

  map(deco: Decoration, changes: A<Change>): Decoration | null {
    let pos = mapPos(deco.from, changes, this.bias)
    return new Decoration(pos, pos, this)
  }
}

export class Decoration {
  /** @internal */
  constructor(
    public readonly from: number,
    public readonly to: number,
    /** @internal */
    public readonly desc: DecorationDesc
  ) {}

  get spec(): DecorationSpec { return this.desc.spec }

  map(changes: Change[]): Decoration | null { return this.desc.map(this, changes) }

  /** @internal */
  move(offset: number): Decoration {
    return offset ? new Decoration(this.from + offset, this.to + offset, this.desc) : this
  }

  static range(from: number, to: number, spec: DecorationRangeSpec): Decoration {
    if (from >= to) throw new RangeError("Range decorations may not be empty")
    return new Decoration(from, to, new RangeDesc(spec))
  }

  static point(pos: number, spec: DecorationPointSpec): Decoration {
    return new Decoration(pos, pos, new PointDesc(spec))
  }
  
  /** @internal Here so that we can put active decorations on a heap
   * and take then off at their end */
  get heapPos() { return this.to }
}

// FIXME use a mapping abstraction defined in the state module
function mapPos(pos: number, changes: A<Change>, assoc: number) {
  for (let i = 0; i < changes.length; i++) pos = changes[i].mapPos(pos, assoc)
  return pos
}

const noDecorations: A<Decoration> = []
const noChildren: A<DecorationSet> = []

const BASE_NODE_SIZE_SHIFT = 5, BASE_NODE_SIZE = 1 << BASE_NODE_SIZE_SHIFT

type DecorationFilter = (from: number, to: number, spec: DecorationSpec) => boolean

export class DecorationSet {
  /** @internal */
  constructor(
    /** @internal The text length covered by this set */
    public length: number,
    /** The number of decorations in the set */
    public size: number,
    /** @internal The locally stored decorations—which are all of them
     * for leaf nodes, and the ones that don't fit in child sets for
     * non-leaves. Sorted by start position, then end position, then startAssoc. */
    public local: A<Decoration>,
    /** @internal The child sets, in position order */
    public children: A<DecorationSet>
  ) {}

  update(decorations: A<Decoration> = noDecorations,
         filter: DecorationFilter | null = null,
         filterFrom: number = 0,
         filterTo: number = this.length): DecorationSet {
    let maxLen = decorations.reduce((l, d) => Math.max(l, d.to), this.length)
    return this.updateInner(decorations.length ? decorations.slice().sort(byPos) : decorations,
                            filter, filterFrom, filterTo, 0, maxLen)
  }

  /** @internal */
  updateInner(decorations: A<Decoration>,
              filter: DecorationFilter | null,
              filterFrom: number, filterTo: number,
              offset: number, length: number): DecorationSet {
    // The new local decorations. Null means no changes were made yet
    let local: Decoration[] | null = filterDecorations(this.local, filter, filterFrom, filterTo, offset)
    // The new array of child sets, if changed
    let children: DecorationSet[] | null = null

    let size = 0
    let decI = 0, pos = offset
    // Iterate over the child sets, applying filters and pushing added
    // decorations into them
    for (let i = 0; i < this.children.length; i++) {
      let child = this.children[i], endPos = pos + child.length, localDeco: Decoration[] | null = null
      while (decI < decorations.length) {
        let next = decorations[decI]
        if (next.from >= endPos) break
        decI++
        if (next.to > endPos) {
          if (!local) local = this.local.slice()
          insertSorted(local, next.move(-offset))
        } else {
          (localDeco || (localDeco = [])).push(next)
        }
      }
      let newChild = child
      if (localDeco || filter && filterFrom <= endPos && filterTo >= pos)
        newChild = newChild.updateInner(localDeco || noDecorations, filter, filterFrom, filterTo,
                                        pos, newChild.length)
      if (newChild != child)
        (children || (children = this.children.slice(0, i))).push(newChild)
      else if (children)
        children.push(newChild)
      size += newChild.size
      pos = endPos
    }

    // If nothing was actually updated, return the existing object
    if (!local && !children && decI == decorations.length) return this

    // Compute final size and length
    size += (local || this.local).length + decorations.length - decI

    // This is a small node—turn it into a flat leaf
    if (size <= BASE_NODE_SIZE)
      return collapseSet(children || this.children, local || this.local.slice(),
                         decorations, decI, offset, length)


    let childSize = Math.max(BASE_NODE_SIZE, size >> BASE_NODE_SIZE_SHIFT)
    if (decI < decorations.length) {
      if (!children) children = this.children.slice()
      if (!local) local = this.local.slice()
      appendDecorations(local, children, decorations, decI, offset, length, pos, childSize)
    }

    if (children) {
      if (!local) local = this.local.slice()
      rebalanceChildren(local, children, childSize)
    }

    return new DecorationSet(length, size, local || this.local, children || this.children)
  }

  grow(length: number): DecorationSet {
    return new DecorationSet(this.length + length, this.size, this.local, this.children)
  }

  // Collect all decorations in this set into the target array,
  // offsetting them by `offset`
  collect(target: Decoration[], offset: number) {
    for (let i = 0; i < this.local.length; i++)
      target.push(this.local[i].move(offset))
    for (let i = 0; i < this.children.length; i++) {
      let child = this.children[i]
      child.collect(target, offset)
      offset += child.length
    }
  }

  map(changes: Change[]): DecorationSet {
    if (changes.length == 0 || this == DecorationSet.empty) return this
    return this.mapInner(changes, 0, 0, mapPos(this.length, changes, 1)).set
  }

  private mapInner(changes: Change[],
                   oldStart: number, newStart: number,
                   newEnd: number): {set: DecorationSet, escaped: Decoration[] | null} {
    let newLocal: Decoration[] | null = null
    let escaped: Decoration[] | null = null
    let newLength = newEnd - newStart, newSize = 0

    for (let i = 0; i < this.local.length; i++) {
      let deco = this.local[i], mapped = deco.map(changes)
      let escape = mapped != null && (mapped.from < 0 || mapped.to > newLength)
      if (newLocal == null && (deco != mapped || escaped)) newLocal = this.local.slice(0, i)
      if (escape) (escaped || (escaped = [])).push(mapped!)
      else if (newLocal && mapped) newLocal.push(mapped)
    }

    let newChildren: DecorationSet[] | null = null
    for (let i = 0, oldPos = oldStart, newPos = newStart; i < this.children.length; i++) {
      let child = this.children[i], newChild = child
      let oldChildEnd = oldPos + child.length
      let newChildEnd = mapPos(oldPos + child.length, changes, 1)
      if (touchesChange(oldPos, oldChildEnd, changes)) {
        let inner = child.mapInner(changes, oldPos, newPos, newChildEnd)
        newChild = inner.set
        if (inner.escaped) for (let j = 0; j < inner.escaped.length; j++) {
          let deco = inner.escaped[j].move(newPos - newStart)
          if (deco.from < 0 || deco.to > newLength) {
            ;(escaped || (escaped = [])).push(deco)
          } else {
            if (newLocal == null) newLocal = this.local.slice()
            insertSorted(newLocal, deco)
          }
        }
      } else if (newChildEnd - newPos != oldChildEnd - oldPos) {
        newChild = new DecorationSet(newChildEnd - newPos, child.size, child.local, child.children)
      }
      if (newChild != child) {
        if (newChildren == null) newChildren = this.children.slice(0, i)
        // If the node's content was completely deleted by mapping,
        // drop the node—which is complicated by the need to
        // distribute its length to another child when it's not the
        // last child
        if (newChild.size == 0 && (newChild.length == 0 || i > 0 || i == this.children.length)) {
          if (newChild.length > 0 && i > 0) {
            let last = newChildren[i - 1]
            newChildren[i - 1] = new DecorationSet(last.length + newChild.length, last.size, last.local, last.children)
          }
        } else {
          newChildren.push(newChild)
        }
      } else if (newChildren) {
        newChildren.push(newChild)
      }
      newSize += newChild.size
      oldPos = oldChildEnd
      newPos = newChildEnd
    }

    let set = newLength == this.length && newChildren == null && newLocal == null
      ? this
      : new DecorationSet(newLength, newSize + (newLocal || this.local).length,
                          newLocal || this.local, newChildren || this.children)
    return {set, escaped}
  }

  /*
  changedRanges(other: DecorationSet, textDiff: ChangedRange[]): number[] {
    let result: number[] = []
    changedRanges(this, 0, noDecorations, other, 0, noDecorations, textDiff, result)
    return result
  }
  */

  static of(decorations: Decoration[] | Decoration): DecorationSet {
    let set = DecorationSet.empty
    if (decorations instanceof Decoration) set = set.update([decorations])
    else if (decorations.length) set = set.update(decorations)
    return set
  }

  static empty = new DecorationSet(0, 0, noDecorations, noChildren);
}

// Cursor into a node-local set of decorations
class LocalSet {
  public index: number = 0;
  constructor(public offset: number,
              public decorations: A<Decoration>,
              public next: DecorationSetIterator | null) {}

  // Used to make this conform to Heapable
  get heapPos(): number { return this.decorations[this.index].from + this.offset }
  get desc(): DecorationDesc { return this.decorations[this.index].desc }
}

// Stack element for DecorationSetIterator
class IteratedSet {
  // Index == -1 means the set's locals have not been yielded yet.
  // Otherwise this is an index in the set's child array.
  index: number = -1;
  constructor(public offset: number,
              public set: DecorationSet) {}
}

class DecorationSetIterator {
  stack: IteratedSet[];

  constructor(set: DecorationSet, offset: number = 0) {
    this.stack = [new IteratedSet(offset, set)]
  }

  next(skip: number): LocalSet | null {
    for (;;) {
      if (this.stack.length == 0) return null
      let top = this.stack[this.stack.length - 1]
      if (top.index < 0) {
        top.index = 0
        if (top.set.local.length > 0)
          return new LocalSet(top.offset, top.set.local, top.set.children.length ? null : this)
      }
      if (top.index == top.set.children.length) {
        this.stack.pop()
      } else {
        let next = top.set.children[top.index], start = top.offset
        top.index++
        top.offset += next.length
        if (skip > next.length) skip -= next.length
        else this.stack.push(new IteratedSet(start, next))
      }
    }
  }
}

interface Heapable { heapPos: number; desc: DecorationDesc }

class DecoratedRange {
  constructor(readonly from: number,
              readonly to: number,
              readonly tagName: string | null,
              readonly attrs: {[key: string]: string} | null) {}

  static build(from: number, to: number, ranges: Decoration[]): DecoratedRange {
    let tagName = null
    let attrs: {[key: string]: string} | null = null
    for (let i = 0; i < ranges.length; i++) {
      let spec = ranges[i].spec as DecorationRangeSpec
      if (spec.tagName) tagName = spec.tagName
      if (spec.attributes) for (let name in spec.attributes) {
        let value = spec.attributes[name]
        if (value == null) continue
        if (!attrs) attrs = {}
        if (name == "style" && attrs.style)
          value = attrs.style + ";" + value
        else if (name == "class" && attrs.class)
          value = attrs.class + " " + value
        attrs[name] = value
      }
    }
    return new DecoratedRange(from, to, tagName, attrs)
  }
}

export function decoratedSpansInRange(sets: A<DecorationSet>, from: number, to: number): DecoratedRange[] {
  let heap: Heapable[] = []

  for (let i = 0; i < sets.length; i++) {
    let set = sets[i]
    if (set.size > 0) addIterToHeap(heap, new DecorationSetIterator(set), from)
  }

  let result: DecoratedRange[] = []
  let active: Decoration[] = []
  let pos = from

  while (heap.length > 0) {
    let next = takeFromHeap(heap)
    if (next instanceof LocalSet) {
      let deco = next.decorations[next.index]
      if (++next.index < next.decorations.length) addToHeap(heap, next)
      else if (next.next) addIterToHeap(heap, next.next)

      if (deco.to + next.offset < from) continue
      if (deco.from + next.offset > to) break
      // FIXME handle widgets, collapsing
      if (deco.desc instanceof RangeDesc) {
        if (!deco.desc.affectsSpans) continue
        deco = deco.move(next.offset)
        if (deco.from > pos) {
          result.push(DecoratedRange.build(pos, deco.from, active))
          pos = deco.from
        }
        active.push(deco)
        addToHeap(heap, deco)
      }
    } else { // It is a decoration that ends here
      let deco = next as Decoration
      if (deco.to >= to) break
      if (deco.to > pos) {
        result.push(DecoratedRange.build(pos, deco.to, active))
        pos = deco.to
      }
      active.splice(active.indexOf(deco), 1)
    }
  }
  if (pos < to) result.push(DecoratedRange.build(pos, to, active))
  return result
}

function compareHeapable(a: Heapable, b: Heapable): number {
  return a.heapPos - b.heapPos || a.desc.bias - b.desc.bias
}

function addIterToHeap(heap: Heapable[], iter: DecorationSetIterator, skip: number = 0) {
  for (;;) {
    let next = iter.next(skip)
    if (next == null) break
    addToHeap(heap, next)
    if (next.next != null) break
  }
}

function addToHeap(heap: Heapable[], elt: Heapable) {
  let index = heap.push(elt) - 1
  while (index > 0) {
    let parentIndex = index >> 1, parent = heap[parentIndex]
    if (compareHeapable(elt, parent) >= 0) break
    heap[index] = parent
    heap[parentIndex] = elt
    index = parentIndex
  }
}

function takeFromHeap(heap: Heapable[]): Heapable {
  let elt = heap[0], replacement = heap.pop()!
  if (heap.length == 0) return elt
  heap[0] = replacement
  for (let index = 0;;) {
    let childIndex = (index << 1) + 1
    if (childIndex >= heap.length) break
    let child = heap[childIndex]
    if (childIndex + 1 < heap.length && compareHeapable(child, heap[childIndex + 1]) >= 0) {
      child = heap[childIndex + 1]
      childIndex++
    }
    if (compareHeapable(replacement, child) < 0) break
    heap[childIndex] = replacement
    heap[index] = child
    index = childIndex
  }
  return elt
}

function byPos(a: Decoration, b: Decoration): number {
  return a.from - b.from || a.desc.bias - b.desc.bias
}

function insertSorted(target: Decoration[], deco: Decoration) {
  let i = target.length
  while (i > 0 && byPos(target[i - 1], deco) >= 0) i--
  target.splice(i, 0, deco)
}

function filterDecorations(decorations: A<Decoration>,
                           filter: DecorationFilter | null,
                           filterFrom: number, filterTo: number,
                           offset: number): Decoration[] | null {
  if (!filter) return null
  let copy: Decoration[] | null = null
  for (let i = 0; i < decorations.length; i++) {
    let deco = decorations[i], from = deco.from + offset, to = deco.to + offset
    if (filterFrom > to || filterTo < from || filter(from, to, deco.spec)) {
      if (copy != null) copy.push(deco)
    } else {
      if (copy == null) copy = decorations.slice(0, i)
    }
  }
  return copy
}

function touchesChange(from: number, to: number, changes: Change[]): boolean {
  for (let i = 0; i < changes.length; i++) {
    let change = changes[i]
    if (change.to >= from && change.from <= to) return true
    let diff = change.text.length - (change.to - change.from)
    if (from > change.from) from += diff
    if (to > change.to) to += diff
  }
  return false
}

function collapseSet(children: A<DecorationSet>, local: Decoration[],
                     add: A<Decoration>, start: number, offset: number, length: number): DecorationSet {
  let wasEmpty = local.length == 0
  for (let i = 0, off = 0; i < children.length; i++) {
    let child = children[i]
    child.collect(local, -off)
    off += child.length
  }
  if (!wasEmpty) local.sort(byPos)
  for (let i = start; i < add.length; i++) local.push(add[i].move(-offset))
  return new DecorationSet(length, local.length, local, noChildren)
}

function appendDecorations(local: Decoration[], children: DecorationSet[],
                           decorations: A<Decoration>, start: number,
                           offset: number, length: number, pos: number, childSize: number) {
  // Group added decorations after the current children into new
  // children (will usually only happen when initially creating a
  // node or adding stuff to the top-level node)
  for (let i = start; i < decorations.length;) {
    let add: Decoration[] = []
    let end = Math.min(i + childSize, decorations.length)
    let endPos = end == decorations.length ? offset + length : decorations[end].from
    for (; i < end; i++) {
      let deco = decorations[i]
      if (deco.to > endPos) insertSorted(local, deco.move(-offset))
      else add.push(deco)
    }
    if (add.length) {
      children.push(DecorationSet.empty.updateInner(add, null, 0, 0, pos, endPos - pos))
      pos = endPos
    }
  }
}

// FIXME try to clean this up
function rebalanceChildren(local: Decoration[], children: DecorationSet[], childSize: number) {
  for (let i = 0, off = 0; i < children.length;) {
    let child = children[i], next
    if (child.size == 0 && (i > 0 || children.length == 1)) {
      // Drop empty node
      children.splice(i--, 1)
      if (i >= 0) children[i] = children[i].grow(child.length)
    } else if (child.size > (childSize << 1) && child.local.length < (child.length >> 1)) {
      // Unwrap an overly big node
      for (let j = 0; j < child.local.length; j++) insertSorted(local, child.local[j].move(off))
      children.splice(i, 1, ...child.children)
    } else if (child.children.length == 0 && i < children.length - 1 &&
               (next = children[i + 1]).size + child.size <= BASE_NODE_SIZE &&
               next.children.length == 0) {
      // Join two small leaf nodes
      children.splice(i, 2, new DecorationSet(child.length + next.length,
                                              child.size + next.size,
                                              child.local.concat(next.local.map(d => d.move(child.length))),
                                              noChildren))
      off += child.length + next.length
    } else {
      // Join a number of nodes into a wrapper node
      let joinTo = i + 1, size = child.size, length = child.length
      if (child.size < (childSize >> 1)) {
        for (; joinTo < children.length; joinTo++) {
          let next = children[joinTo], totalSize = size + next.size
          if (totalSize > childSize) break
          size = totalSize
          length += next.length
        }
      }
      if (joinTo > i + 1) {
        let joined = new DecorationSet(length, size, noDecorations, children.slice(i, joinTo))
        let joinedLocals = []
        for (let j = 0; j < local.length; j++) {
          let deco = local[j]
          if (deco.from >= off && deco.to <= off + length) {
            local.splice(j--, 1)
            if (local.length == 0) local = noDecorations as Decoration[]
            joinedLocals.push(deco.move(-off))
          }
        }
        if (joinedLocals.length) joined = joined.update(joinedLocals.sort(byPos))
        children.splice(i, joinTo - i, joined)
        i = joinTo
        off += length
      } else {
        i++
        off += child.length
      }
    }
  }
}

/*
function mapThroughRanges(pos: number, ranges: A<ChangedRange>): number {
  for (let i = ranges.length - 1; i >= 0; i--) {
    let range = ranges[i]
    if (range.fromA <= pos)
      return range.toB + (range.toA < pos ? pos - range.toA : 0)
  }
  return pos
}

function changedRanges(a: DecorationSet, aOffset: number, aExtra: A<Decoration>,
                       b: DecorationSet, bOffset: number, bExtra: A<Decoration>,
                       textDiff: A<ChangedRange>, changes: number[]) {
  if (a == b && aOffset == bOffset) return

  // FIXME match locals

  let iA = 0, iB = 0
  let posA = aOffset, mappedPosA = mapThroughRanges(posA, textDiff), posB = bOffset
  for (; iA < a.children.length || iB < b.children.length;) {
    let startA = iA, startB = iB
    let endA = posA, mappedEndA = mappedPosA, endB = posB
    while (iA == startA || iB == startB || mappedEndA != endB) {
      if (mappedEndA < endB) {
        if (iA < a.children.length) {
          endA += a.children[iA++].length
          mappedEndA = mapThroughRanges(posA, textDiff)
        } else {
          iB = b.children.length
          break
        }
      } else {
        if (iB < b.children.length) {
          endB += b.children[iB++].length
        } else {
          iA = a.children.length
          break
        }
      }
    }

    if (iA == startA + 1 && iB == startB + 1 && mappedEndA == endB) {
      changedRanges(a.children[startA], posA, noDecorations, // FIXME
                    b.children[startB], posB, noDecorations,
                    textDiff, changes)
    } else {
      changedRangesFlat(a.children, posA, startA, iA, noDecorations,
                        b.children, posB, startB, iB, noDecorations,
                        textDiff, changes)
    }
    posA = endA
    mappedPosA = mappedEndA
    posB = endB
  }
}

function takeDecoration(heap: LocalSet[]): Decoration | null {
  if (heap.length == 0) return null
  let next = takeFromHeap(heap) as LocalSet
  let deco = next.decorations[next.index++].move(next.offset)
  if (next.index < next.decorations.length)
    addToHeap(heap, next)
  else if (next.next)
    addIterToHeap(heap, next.next)
  return deco
}

function changedRangesFlat(setsA: A<DecorationSet>, aOffset: number, fromA: number, toA: number,
                           aExtra: A<Decoration>,
                           setsB: A<DecorationSet>, bOffset: number, fromB: number, toB: number,
                           bExtra: A<Decoration>,
                           textDiff: A<ChangedRange>, changes: number[]) {
  let heapA: LocalSet[] = [], heapB: LocalSet[] = []
  for (let i = fromA; i < toA; i++) addIterToHeap(heapA, new DecorationSetIterator(setsA[i], aOffset))
  for (let i = fromB; i < toB; i++) addIterToHeap(heapB, new DecorationSetIterator(setsB[i], bOffset))

  for (let nextA = takeDecoration(heapA), nextB = takeDecoration(heapB); nextA || nextB;) {
    if (nextA == null) {
      changes.push(nextB.from, nextB.to)
      nextB = takeDecoration(heapB)
    } else if (nextB == null) {
      changes.push(mapThroughRanges(nextA.from, textDiff), mapThroughRanges(nextA.to, textDiff))
      nextA = takeDecoration(heapA)
    } else {
      
    }
  }
}
*/
