import type { Route } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CircleAlert, Info, Lightbulb, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import { getT } from '@/i18n/server';
import { docs as messages } from '@/i18n/messages/docs';
import { plainText, type Block, type CalloutTone, type Inline } from '@/lib/docs/markdown';
import { CopyCode } from './copy-code';

/**
 * A chapter's tree (`lib/docs/markdown.ts`), in React. No HTML from a file
 * reaches the page: each node becomes a component of the design system.
 */

const CALLOUT_ICON: Record<CalloutTone, LucideIcon> = {
  note: Info,
  tip: Lightbulb,
  important: CircleAlert,
  warning: TriangleAlert,
  caution: OctagonAlert,
};

/** What a link may point to: the panel, an anchor, the web, an address. */
function safeHref(href: string): string | null {
  if (href.startsWith('/') || href.startsWith('#')) return href;
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}

function InlineNodes({ nodes }: { nodes: readonly Inline[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'code':
        return <code key={index}>{node.text}</code>;
      case 'strong':
        return (
          <strong key={index}>
            <InlineNodes nodes={node.children} />
          </strong>
        );
      case 'em':
        return (
          <em key={index}>
            <InlineNodes nodes={node.children} />
          </em>
        );
      case 'link': {
        const href = safeHref(node.href);
        const children = <InlineNodes nodes={node.children} />;
        if (href === null) return <span key={index}>{children}</span>;
        if (href.startsWith('/')) {
          return (
            <Link key={index} href={href as Route}>
              {children}
            </Link>
          );
        }
        if (href.startsWith('#')) {
          return (
            <a key={index} href={href}>
              {children}
            </a>
          );
        }
        return (
          <a key={index} href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      }
    }
  });
}

type Labels = {
  anchor: string;
  callout: Record<CalloutTone, string>;
};

function BlockNode({ block, labels }: { block: Block; labels: Labels }): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = (`h${block.level}` as const);
      return (
        <Tag id={block.id}>
          <InlineNodes nodes={block.inline} />
          {block.level > 1 ? (
            <a className="doc-anchor" href={`#${block.id}`} aria-label={labels.anchor}>
              #
            </a>
          ) : null}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p>
          <InlineNodes nodes={block.inline} />
        </p>
      );
    case 'code':
      return (
        <div className="doc-code">
          <div className="doc-code-head">
            <span className="doc-code-lang">{block.lang ?? ''}</span>
            <CopyCode text={block.text} />
          </div>
          <pre className="codeblock">
            <code>{block.text}</code>
          </pre>
        </div>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <Blocks blocks={item} labels={labels} />
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start === 1 ? undefined : block.start}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case 'callout': {
      const Icon = CALLOUT_ICON[block.tone];
      return (
        <aside className="doc-callout" data-tone={block.tone}>
          <span className="doc-callout-title">
            <Icon aria-hidden className="size-4" />
            {labels.callout[block.tone]}
          </span>
          <Blocks blocks={block.blocks} labels={labels} />
        </aside>
      );
    }
    case 'table':
      return (
        <div className="doc-table">
          <table>
            {/* `| | |`: a key/value table, whose header would only be an empty bar. */}
            {block.header.every((cell) => plainText(cell).trim() === '') ? null : (
              <thead>
                <tr>
                  {block.header.map((cell, index) => (
                    <th key={index} style={block.align[index] ? { textAlign: block.align[index]! } : undefined}>
                      <InlineNodes nodes={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} style={block.align[index] ? { textAlign: block.align[index]! } : undefined}>
                      <InlineNodes nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr />;
  }
}

function Blocks({ blocks, labels }: { blocks: readonly Block[]; labels: Labels }): ReactNode {
  return blocks.map((block, index) => <BlockNode key={index} block={block} labels={labels} />);
}

export async function MarkdownView({ blocks }: { blocks: readonly Block[] }) {
  const t = await getT(messages);
  const labels: Labels = {
    anchor: t('anchor.label'),
    callout: {
      note: t('callout.note'),
      tip: t('callout.tip'),
      important: t('callout.important'),
      warning: t('callout.warning'),
      caution: t('callout.caution'),
    },
  };
  return (
    <article className="doc">
      <Blocks blocks={blocks} labels={labels} />
    </article>
  );
}
