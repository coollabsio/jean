import type { MdastNode } from './remark-fix-interrupted-lists'

const WEB_URL = /^https?:\/\/\S+$/i

/**
 * remark plugin: wrap inline code that holds only a web URL (`https://...`)
 * in a link, so it opens like a plain URL. GFM autolinks skip code spans.
 * Code that is already inside a link is left alone (no nested anchors).
 */
export function linkInlineCodeUrls(node: MdastNode): void {
  if (node.type === 'link' || !node.children) return
  node.children = node.children.map(child => {
    const url = typeof child.value === 'string' ? child.value.trim() : ''
    if (child.type === 'inlineCode' && WEB_URL.test(url)) {
      return { type: 'link', url, title: null, children: [child] }
    }
    linkInlineCodeUrls(child)
    return child
  })
}

export function remarkLinkInlineCodeUrls() {
  return (tree: MdastNode) => linkInlineCodeUrls(tree)
}
