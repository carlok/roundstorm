/**
 * LaTeX-preserving copy (plan §2.3).
 *
 * The CSS-only trick — hide the rendered tree from selection so the MathML
 * annotation gets picked up — does not work: Range.toString() ignores
 * `user-select`, so ⌘C still yields glyph soup like "𝑓𝑛" instead of `f_n`.
 *
 * So intercept the copy event and rewrite the payload: clone the selection,
 * swap every KaTeX node for its original TeX source, and put that on the
 * clipboard. Pasting an equation into a paper or a notebook then gives you
 * something that compiles.
 */
export function installMathCopy(): () => void {
  const onCopy = (e: ClipboardEvent) => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return

    const range = sel.getRangeAt(0)
    const container = range.commonAncestorContainer
    const el = container.nodeType === 3 ? container.parentElement : (container as Element)
    // Only rewrite inside the transcript; leave inputs and the rest alone.
    if (!el?.closest?.('.transcript')) return

    // Selecting *inside* a single equation clones the KaTeX node's children,
    // not the node, so the fragment has no `.katex` to swap. Handle that case
    // from the ancestor instead — otherwise a click-drag over one equation
    // still yields glyph soup.
    const inside = el.closest('.katex')
    if (inside) {
      const tex = inside.querySelector('annotation[encoding="application/x-tex"]')?.textContent
      if (!tex) return
      e.clipboardData?.setData('text/plain', `$${tex}$`)
      e.preventDefault()
      return
    }

    const frag = range.cloneContents()
    const maths = frag.querySelectorAll('.katex')
    if (!maths.length) return

    for (const node of maths) {
      const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent
      if (!tex) continue
      const display = !!node.parentElement?.classList.contains('katex-display')
      node.replaceWith(document.createTextNode(display ? `\n$$${tex}$$\n` : `$${tex}$`))
    }

    const text = (frag.textContent ?? '').replace(/​/g, '').trim()
    if (!text) return
    e.clipboardData?.setData('text/plain', text)
    e.preventDefault()
  }

  document.addEventListener('copy', onCopy)
  return () => document.removeEventListener('copy', onCopy)
}

