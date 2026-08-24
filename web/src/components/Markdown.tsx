import type React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

export function Markdown({ children, highlight }: { children: string; highlight?: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: props => <a {...props} target="_blank" rel="noreferrer" />,
          // Search highlighting has to happen at the leaf, after Markdown has
          // parsed — highlighting the raw source would corrupt the syntax.
          p: ({ children }) => <p>{mark(children, highlight)}</p>,
          li: ({ children }) => <li>{mark(children, highlight)}</li>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function mark(children: React.ReactNode, needle?: string): React.ReactNode {
  if (!needle || needle.length < 2) return children
  const lower = needle.toLowerCase()
  const walk = (node: React.ReactNode): React.ReactNode => {
    if (typeof node === 'string') {
      const parts: React.ReactNode[] = []
      let i = 0
      for (;;) {
        const at = node.toLowerCase().indexOf(lower, i)
        if (at === -1) { parts.push(node.slice(i)); break }
        parts.push(node.slice(i, at))
        parts.push(<mark key={at}>{node.slice(at, at + needle.length)}</mark>)
        i = at + needle.length
      }
      return parts
    }
    if (Array.isArray(node)) return node.map((n, i) => <span key={i}>{walk(n)}</span>)
    return node
  }
  return walk(children)
}
