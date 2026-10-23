// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PdfHelp } from '../../../components/settings/PdfHelp';
import { StateMessage } from '../../../components/reader/StateMessage';
import { SETTINGS_SECTION_ANCHORS } from '../../../lib/config/constants';
import { installCatalog } from '../ui-client/support';

afterEach(() => cleanup());

// The reader's empty state and the popup both link to the PDF help by its anchor.
describe('PDF help anchor', () => {
  it('is the id of the help block that the reader links to', () => {
    installCatalog();
    render(
      <>
        <StateMessage state={{ phase: 'empty' }} dragging={false} />
        <PdfHelp />
      </>,
    );
    const link = screen.getByRole('link', {
      name: /Why doesn't Clavis work in Chrome's PDF viewer/,
    });
    expect(link).toHaveAttribute('href', `/options.html#${SETTINGS_SECTION_ANCHORS.pdfHelp}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(document.getElementById(SETTINGS_SECTION_ANCHORS.pdfHelp)).not.toBeNull();
  });
});
