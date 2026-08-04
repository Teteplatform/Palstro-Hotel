import { useState, type ReactNode } from 'react';
import type { Block, Inline } from '../../lib/markdown';

// THE MARKDOWN RENDERER — parsed blocks in, React elements out.
//
// NO dangerouslySetInnerHTML ANYWHERE. Every node becomes a real element, so
// there is no HTML string in the pipeline and nothing that could inject markup —
// today's content is ours, and the next person to edit the guide should not have
// to think about it either.
//
// STYLING IS EXPLICIT, NOT A PROSE PLUGIN. Each element carries the app's own
// design tokens (charcoal / sand / primary — never a literal colour, rule 17), so
// the guide reads like the rest of the admin instead of like a README dropped
// into a page. Text is sized for reading rather than for a dense table: this is
// the one screen in the product somebody reads a paragraph on.
//
// AT 360px: tables scroll inside their own container (the page body never
// scrolls sideways), lists keep their indent, and every tap target in a table of
// contents is a full-width row.

export function Markdown({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map((block, i) => renderBlock(block, i))}</>;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'heading':
      return <Heading key={key} block={block} />;

    case 'paragraph':
      return (
        <p key={key} className="mt-3 text-[15px] leading-relaxed text-charcoal">
          <InlineRun nodes={block.children} />
        </p>
      );

    case 'list':
      return block.ordered ? (
        <ol
          key={key}
          start={block.start}
          className="mt-3 list-decimal space-y-2 pl-6 text-[15px] leading-relaxed text-charcoal marker:font-semibold marker:text-primary"
        >
          {block.items.map((item, i) => (
            <li key={i} className="[&>p:first-child]:mt-0">
              <Markdown blocks={item.blocks} />
            </li>
          ))}
        </ol>
      ) : (
        <ul
          key={key}
          className="mt-3 list-disc space-y-2 pl-6 text-[15px] leading-relaxed text-charcoal marker:text-charcoal-muted"
        >
          {block.items.map((item, i) => (
            <li key={i} className="[&>p:first-child]:mt-0">
              <Markdown blocks={item.blocks} />
            </li>
          ))}
        </ul>
      );

    case 'table':
      return (
        // The scroll container is the table's own, so a wide permission table
        // never pushes the page sideways on a phone.
        <div
          key={key}
          className="mt-4 overflow-x-auto rounded-2xl border border-sand-border bg-white/60"
        >
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-sand-border bg-sand/40">
                {block.head.map((cell, i) => (
                  <th
                    key={i}
                    scope="col"
                    className="px-3 py-2.5 align-top font-semibold text-charcoal"
                  >
                    <InlineRun nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-sand-border/60">
              {block.rows.map((row, r) => (
                <tr key={r} className="align-top">
                  {row.map((cell, c) => (
                    <td key={c} className="px-3 py-2.5 text-charcoal">
                      <InlineRun nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'quote':
      return (
        <blockquote
          key={key}
          className="mt-4 rounded-r-xl border-l-4 border-primary/50 bg-primary/5 px-4 py-3 [&>p:first-child]:mt-0"
        >
          <Markdown blocks={block.blocks} />
        </blockquote>
      );

    case 'code':
      return (
        <pre
          key={key}
          className="mt-4 overflow-x-auto rounded-xl border border-sand-border bg-sand/40 px-4 py-3 text-xs text-charcoal"
        >
          <code>{block.value}</code>
        </pre>
      );

    case 'rule':
      return <hr key={key} className="mt-8 border-sand-border" />;
  }
}

// Headings carry the anchor the contents list links to. scroll-mt keeps the
// target clear of the admin's sticky header when a link jumps to it — without it
// the heading lands underneath the bar and reads as "the link went to the wrong
// place".
function Heading({ block }: { block: Extract<Block, { kind: 'heading' }> }) {
  const content = <InlineRun nodes={block.children} />;
  const common = 'scroll-mt-24 font-bold tracking-tight text-charcoal';

  if (block.level <= 2) {
    return (
      <h2 id={block.id} className={`mt-10 text-xl ${common} first:mt-0`}>
        {content}
      </h2>
    );
  }
  if (block.level === 3) {
    return (
      <h3 id={block.id} className={`mt-8 text-lg ${common}`}>
        {content}
      </h3>
    );
  }
  return (
    <h4 id={block.id} className={`mt-6 text-base ${common}`}>
      {content}
    </h4>
  );
}

function InlineRun({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.kind) {
          case 'text':
            return <span key={i}>{node.value}</span>;
          case 'strong':
            return (
              <strong key={i} className="font-semibold text-charcoal">
                <InlineRun nodes={node.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <InlineRun nodes={node.children} />
              </em>
            );
          case 'code':
            return (
              <code
                key={i}
                className="rounded bg-sand px-1.5 py-0.5 text-[0.9em] text-charcoal"
              >
                {node.value}
              </code>
            );
          case 'link':
            return <MarkdownLink key={i} href={node.href} nodes={node.children} />;
          case 'image':
            return <Screenshot key={i} src={node.src} alt={node.alt} />;
        }
      })}
    </>
  );
}

// An in-document jump (#anchor) stays a plain anchor so the browser does the
// scrolling; anything external opens in a new tab, severed from this one.
function MarkdownLink({ href, nodes }: { href: string; nodes: Inline[] }) {
  const internal = href.startsWith('#');
  return (
    <a
      href={href}
      {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
      className="font-medium text-primary underline underline-offset-2 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
    >
      <InlineRun nodes={nodes} />
    </a>
  );
}

// A GUIDE SCREENSHOT — and the reason the guide can ship before any of them
// exist.
//
// The image is rendered for real. If the file is not there yet (or fails to
// load), it is replaced by a labelled placeholder carrying the alt text, so the
// page never shows a broken-image icon and a reader always learns what the
// picture WOULD have shown. Dropping the PNG into `public/help/` later makes it
// appear with no change to the markdown — the guide's own "About this guide"
// section says so.
function Screenshot({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const label = alt.replace(/^screenshot:\s*/i, '');

  if (failed) {
    return (
      <span className="mt-4 flex flex-col gap-1 rounded-2xl border-2 border-dashed border-sand-border bg-sand/30 px-4 py-6 text-center">
        <span className="text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
          Screenshot to be added
        </span>
        <span className="text-sm text-charcoal">{label}</span>
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="mt-4 block w-full max-w-full rounded-2xl border border-sand-border"
    />
  );
}
