import type { Block } from '../explanation/model';

/**
 * A result as plain text (D-10, FR-041): every model-written string is a text child, nothing is
 * interpreted as HTML or Markdown, no link or attribute is built from it. Each piece of model text
 * chooses its own direction (`dir="auto"`), so an Arabic answer with an English example, or the
 * reverse, reads correctly; the labels are our own interface text and keep the interface direction.
 */
export function ResultBlocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <div className="sp-result" data-testid="panel-result">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'title':
            return (
              <p key={index} className="sp-result__title" dir="auto">
                {block.text}
              </p>
            );
          case 'paragraph':
            return (
              <p key={index} dir="auto">
                {block.text}
              </p>
            );
          case 'field':
          case 'note':
            return (
              <div
                key={index}
                className={block.kind === 'note' ? 'sp-field sp-field--note' : 'sp-field'}
              >
                <p className="sp-label">{block.label}</p>
                <p dir="auto">{block.text}</p>
              </div>
            );
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <div key={index} className="sp-field">
                <p className="sp-label">{block.label}</p>
                <List className="sp-list" dir="auto">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex} dir="auto">
                      {item}
                    </li>
                  ))}
                </List>
              </div>
            );
          }
        }
      })}
    </div>
  );
}
