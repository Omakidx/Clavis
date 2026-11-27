const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const numFmt = new Intl.NumberFormat();

export const formatDate = (ms: number): string => dateFmt.format(new Date(ms));
export const formatCount = (n: number): string => numFmt.format(n);

/** 1024-based sizes, labelled KB/MB like the extension and the 15 MB / 100 MB limits users are told about. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Only http(s) URLs are ever offered as links (a saved URL is untrusted text). */
export function safeHttpUrl(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}
