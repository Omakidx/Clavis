/** The random suffix of the delimiter tags in a built user message. */
export function nonceOf(user: string): string {
  const nonce = /<selected_text_([0-9a-f]{16})>/.exec(user)?.[1];
  if (nonce === undefined) throw new Error('no selected_text tag with a nonce in the message');
  return nonce;
}

/** Our three tag names for a user message, plus open/close helpers. */
export function tagsOf(user: string) {
  const nonce = nonceOf(user);
  const name = (base: string) => `${base}_${nonce}`;
  return {
    nonce,
    open: (base: 'selected_text' | 'context_before' | 'context_after') => `<${name(base)}>`,
    close: (base: 'selected_text' | 'context_before' | 'context_after') => `</${name(base)}>`,
  };
}

/** Everything between our own selection tags. */
export function quotedBlock(user: string): string {
  const tags = tagsOf(user);
  const start = user.indexOf(tags.open('selected_text')) + tags.open('selected_text').length;
  return user.slice(start, user.lastIndexOf(tags.close('selected_text')));
}

/** The text after the last context/selection block: only our reminder may follow it. */
export function afterQuoted(user: string): string {
  const tags = tagsOf(user);
  const last = user.includes(tags.close('context_after'))
    ? tags.close('context_after')
    : tags.close('selected_text');
  return user.slice(user.lastIndexOf(last) + last.length);
}

/** How many of OUR tags (open and close) the message holds. */
export function ourTagCount(user: string): number {
  const { nonce } = tagsOf(user);
  return (
    user.match(new RegExp(`</?(selected_text|context_before|context_after)_${nonce}>`, 'g')) ?? []
  ).length;
}
