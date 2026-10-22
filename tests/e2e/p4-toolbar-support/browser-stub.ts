// TEST-ONLY stand-in for `wxt/browser` in the a11y bundle: serves the real English catalog,
// including `$NAME$` placeholders, exactly as browser.i18n.getMessage would.
type Entry = { message: string; placeholders?: Record<string, { content: string }> };

export const browser = {
  i18n: {
    getMessage(key: string, substitutions?: string | string[]): string {
      const catalog = (globalThis as unknown as { __clavisMessages: Record<string, Entry> })
        .__clavisMessages;
      const entry = catalog[key];
      if (entry === undefined) return '';
      const subs =
        substitutions === undefined
          ? []
          : Array.isArray(substitutions)
            ? substitutions
            : [substitutions];
      return entry.message.replace(/\$([A-Z0-9_]+)\$/gi, (_match, name: string) => {
        const content =
          entry.placeholders?.[name.toLowerCase()]?.content ?? entry.placeholders?.[name]?.content;
        const index = Number(/^\$(\d)$/.exec(content ?? '')?.[1] ?? 0) - 1;
        return subs[index] ?? '';
      });
    },
  },
};
