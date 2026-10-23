import { ALLOWED_ANNOTATION_TYPES, MAX_ANNOTATIONS_PER_PAGE } from './limits';

/** Numeric `AnnotationType` values the reader draws, from PDF.js's own enum (names in limits.ts). */
export function allowedAnnotationTypes(
  AnnotationType: Readonly<Record<string, number>>,
): ReadonlySet<number> {
  const values = new Set<number>();
  for (const name of ALLOWED_ANNOTATION_TYPES) {
    const value = AnnotationType[name];
    if (typeof value === 'number') values.add(value);
  }
  return values;
}

/** The slice of PDFPageProxy / PDFDocumentProxy this module wraps. */
interface PageLike {
  pageNumber: number;
  getAnnotations(params?: unknown): Promise<Array<{ annotationType?: number | undefined }>>;
}
interface DocLike {
  getPage(pageNumber: number): Promise<PageLike>;
}

export interface AnnotationGuardOptions {
  allowed: ReadonlySet<number>;
  /** Cap per page (defaults to MAX_ANNOTATIONS_PER_PAGE). */
  max?: number;
  /** Some annotations of `pageNumber` were dropped for being over the cap (not for their type). */
  onTruncated?: (pageNumber: number) => void;
}

/**
 * Keep only drawable annotations of a page, and at most `max` of them. Pure; used by the guard.
 * `truncated` is true only when the cap cut something that was otherwise allowed.
 */
export function filterAnnotations<T extends { annotationType?: number | undefined }>(
  annotations: readonly T[],
  allowed: ReadonlySet<number>,
  max: number = MAX_ANNOTATIONS_PER_PAGE,
): { kept: T[]; truncated: boolean } {
  const kept: T[] = [];
  let truncated = false;
  for (const annotation of annotations) {
    if (annotation.annotationType === undefined || !allowed.has(annotation.annotationType))
      continue;
    if (kept.length >= max) {
      truncated = true;
      break;
    }
    kept.push(annotation);
  }
  return { kept, truncated };
}

/**
 * Wrap a PDFDocumentProxy so that EVERY page the viewer gets from it answers `getAnnotations()`
 * with an allowlisted, capped list (Phase 7 security review MEDIUM-2 and LOW-1). PDFViewer reaches
 * pages through `pdfDocument.getPage()` only, and PDFPageView / AnnotationLayerBuilder call
 * `pdfPage.getAnnotations()` on that object, so this is the one place both limits take effect.
 *
 * Everything else is forwarded unchanged with `this` bound to the real object (PDF.js classes use
 * private fields, which break on a Proxy receiver). Wrapped pages are cached per page so the
 * viewer sees a stable object.
 */
export function guardAnnotations<D extends DocLike>(doc: D, options: AnnotationGuardOptions): D {
  const max = options.max ?? MAX_ANNOTATIONS_PER_PAGE;
  const pages = new WeakMap<object, PageLike>();

  const guardPage = (page: PageLike): PageLike => {
    let guarded = pages.get(page);
    if (guarded === undefined) {
      guarded = new Proxy(page, {
        get(target, prop) {
          if (prop === 'getAnnotations') {
            return async (params?: unknown) => {
              const all = await target.getAnnotations(params);
              const { kept, truncated } = filterAnnotations(all, options.allowed, max);
              if (truncated) options.onTruncated?.(target.pageNumber);
              return kept;
            };
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      pages.set(page, guarded);
    }
    return guarded;
  };

  return new Proxy(doc, {
    get(target, prop) {
      if (prop === 'getPage') {
        return async (pageNumber: number) => guardPage(await target.getPage(pageNumber));
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
