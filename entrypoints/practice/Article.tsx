import { t } from '../../lib/i18n';
import css from './article.css?inline';

/**
 * The practice text, rendered into the frame's document. The bank-by-the-river and
 * bank-for-money sentences and "She finally broke the ice." are the requirements' examples
 * (UJ-02, UJ-03); the English text lives in the message catalog like every other string.
 */
export function Article() {
  return (
    <>
      <style>{css}</style>
      <article>
        <h1>{t('practiceArticleTitle')}</h1>
        <p>{t('practiceArticleP1')}</p>
        <p>{t('practiceArticleP2')}</p>
        <p>{t('practiceArticleP3')}</p>
      </article>
    </>
  );
}
