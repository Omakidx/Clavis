import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SidePanelApp } from '../../components/sidepanel/SidePanelApp';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <SidePanelApp />
    </StrictMode>,
  );
}
